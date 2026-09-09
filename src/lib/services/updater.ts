/**
 * Schedule update loop, per course year:
 *   discovery or an authenticated official PDF URL
 *   → download → sha256 → parse → validate → atomic replace.
 * Any failure keeps that course's previous known-good schedule, and never touches
 * another course. A bundled real FCIM PDF is also used for cold starts and
 * conservative promotion of older seed data — for the courses that have one.
 */
import { readFile } from "node:fs/promises";
import { config } from "@/lib/config";
import { isSupportedCourse, courseSeed, SUPPORTED_COURSE_YEARS, UnsupportedCourseError, type CourseSeed } from "@/lib/courses";
import { Deadline, DeadlineExceededError } from "@/lib/deadline";
import { errorMessage, getLogger } from "@/lib/logger";
import type { Schedule, ScheduleMetadata, SourceState } from "@/lib/models";
import { parsePdf, sha256, type Provenance } from "@/lib/parser";
import { validateSchedule } from "@/lib/parser/validator";
import { discoverPdf, type DiscoveredPdf, type SemesterSource } from "@/lib/source/discovery";
import {
  fetchOfficialTimetablePdf,
  fetchPdf,
  fetchSchedulePage,
  fetchWordPressSchedulePage,
  SourceFetchError,
  waybackUrl,
  type FetchedResource,
} from "@/lib/source/downloader";
import { splitPdfRevision } from "@/lib/source/revision";
import {
  fetchAcceptedPointer,
  fetchAcceptedSchedule,
  fetchCandidatePdf,
  fetchCurrentPointer,
  fetchSnapshotManifest,
  fetchSnapshotPageApi,
  putAcceptedSchedule,
} from "@/lib/source/broker-client";
import type { SnapshotFile, SnapshotManifest } from "@/lib/models";
import { getCurrentSchedule, getSourceState, replaceCurrentSchedule, saveSourceState } from "@/lib/storage";

const log = getLogger("updater");

export type CheckOutcome = SourceState["last_result"];

export interface CheckResult {
  course_year: number;
  outcome: CheckOutcome;
  message: string;
  pdf_url?: string;
  source_pdf_hash?: string;
  groups?: number;
  lessons?: number;
}

interface ExplicitRefreshOptions {
  pdfUrl: string;
  force?: boolean;
}

interface PdfUpdateSource {
  pdfUrl: string;
  downloadUrl: string;
  kind: Extract<ScheduleMetadata["source_kind"], "live" | "wayback" | "manual">;
  fetchMode: "discovered" | "explicit";
  extraHosts?: string[];
  academicYear?: string | null;
  semester?: string | null;
  semesterSource?: SemesterSource | null;
  parityNote?: string | null;
}

type UpdateMode = "automatic" | "explicit";

interface ApplyResult {
  result: CheckResult;
  schedule?: Schedule;
}

/**
 * Ordinary checks coalesce per course: two scheduler ticks for Anul I share one run,
 * while an Anul I and an Anul II check are always distinct operations with their own
 * results. Actual downloads and storage writes still run one at a time through the
 * shared tail — update frequency is low, and serialising keeps the parser and the
 * atomic file replacements free of races without any distributed machinery.
 *
 * The coordinator lives on globalThis, not in module scope. Next.js bundles the
 * instrumentation hook and the route handlers separately, so this module is evaluated
 * more than once inside a single process; module-local state would give the scheduler
 * and the API their own queues, and the serialisation this relies on would be a
 * fiction. The deployment stays single-process — this is not a distributed lock.
 */
interface UpdateCoordinator {
  /** Tail of the one serialization queue every update joins. */
  tail: Promise<void>;
  /** Ordinary (non-forced) runs that may still be joined, keyed by course. */
  inFlightByCourse: Map<number, Promise<CheckResult>>;
}

const globalRef = globalThis as typeof globalThis & { __fcimUpdateCoordinator?: UpdateCoordinator };
const coordinator: UpdateCoordinator = (globalRef.__fcimUpdateCoordinator ??= {
  tail: Promise.resolve(),
  inFlightByCourse: new Map(),
});

/** Serialize automatic and administrative updates so two atomic replacements cannot race. */
function enqueueUpdate(run: () => Promise<CheckResult>): Promise<CheckResult> {
  const result = coordinator.tail.then(run, run);
  coordinator.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Run an automatic check for one course; concurrent ordinary callers for it share the run. */
export function checkForUpdates(courseYear: number, options: { force?: boolean } = {}): Promise<CheckResult> {
  // Rejected rather than thrown: this returns a promise, so a `void checkForUpdates(x)`
  // caller must get a handleable rejection instead of a synchronous crash.
  if (!isSupportedCourse(courseYear)) return Promise.reject(new UnsupportedCourseError(courseYear));
  // A force request is a distinct operation. It still joins the serialization queue,
  // but must run after (rather than inherit) an ordinary in-flight scheduler check.
  if (options.force) return enqueueUpdate(() => runAutomaticCheck(courseYear, options));
  const pending = coordinator.inFlightByCourse.get(courseYear);
  if (pending) return pending;
  const task = enqueueUpdate(() => runAutomaticCheck(courseYear, options));
  coordinator.inFlightByCourse.set(courseYear, task);
  // Both settlements clear the slot: a rejected run must not leave a poisoned promise
  // that every later ordinary caller for this course would join.
  const clear = () => {
    if (coordinator.inFlightByCourse.get(courseYear) === task) coordinator.inFlightByCourse.delete(courseYear);
  };
  void task.then(clear, clear);
  return task;
}

/** Authenticated callers use this path after the API route validates their request. */
export function refreshFromExplicitPdf(courseYear: number, options: ExplicitRefreshOptions): Promise<CheckResult> {
  if (!isSupportedCourse(courseYear)) return Promise.reject(new UnsupportedCourseError(courseYear));
  return enqueueUpdate(() => runExplicitRefresh(courseYear, options));
}

/** Test helper: observe the process-global coordinator this module instance is bound to. */
export function updateCoordinatorState(): { inFlightCourses: number[]; shared: boolean } {
  return {
    inFlightCourses: [...coordinator.inFlightByCourse.keys()],
    shared: globalRef.__fcimUpdateCoordinator === coordinator,
  };
}

interface Discovery {
  pdf: DiscoveredPdf;
  kind: "live" | "wayback";
}

async function discoverCurrentPdf(courseYear: number): Promise<Discovery> {
  const failures: string[] = [];
  try {
    const html = await fetchSchedulePage(config.schedulePageUrl);
    return { pdf: discoverPdf(html, courseYear), kind: "live" };
  } catch (liveError) {
    failures.push(errorMessage(liveError));
    log.warn("live schedule page unavailable", { courseYear, error: errorMessage(liveError) });
  }

  if (config.wordpressFallbackEnabled) {
    try {
      const html = await fetchWordPressSchedulePage(config.wordpressApiUrl);
      return { pdf: discoverPdf(html, courseYear), kind: "live" };
    } catch (wordpressError) {
      failures.push(`WordPress API: ${errorMessage(wordpressError)}`);
      log.warn("official WordPress API unavailable", { courseYear, error: errorMessage(wordpressError) });
    }
  }

  if (!config.waybackFallbackEnabled) throw new Error(failures.join("; "));
  log.warn("official schedule sources unavailable, trying archive mirror", { courseYear });
  try {
    const html = await fetchSchedulePage(waybackUrl(config.schedulePageUrl), [config.waybackHost]);
    return { pdf: discoverPdf(html, courseYear), kind: "wayback" };
  } catch (archiveError) {
    failures.push(`archive mirror: ${errorMessage(archiveError)}`);
    throw new Error(failures.join("; "));
  }
}

export function selectCandidateFromSnapshot(
  snapshotPageApi: unknown,
  manifest: SnapshotManifest,
  courseYear: number,
  now: Date = new Date(),
): { candidateFile: SnapshotFile; discovered: DiscoveredPdf } {
  if (!snapshotPageApi) {
    throw new Error(`Cannot select candidate: snapshot ${manifest.snapshot_id} has no page-api payload`);
  }

  const pageItem = Array.isArray(snapshotPageApi) ? snapshotPageApi[0] : snapshotPageApi;
  const renderedContent =
    typeof pageItem === "object" && pageItem && "content" in pageItem
      ? (pageItem as { content?: { rendered?: unknown } }).content?.rendered
      : null;

  if (typeof renderedContent !== "string") {
    throw new Error(`Snapshot ${manifest.snapshot_id} page-api has no rendered HTML content`);
  }

  const discovered = discoverPdf(renderedContent, courseYear, now);
  const candidateFile = manifest.files.find((f) => f.source_url === discovered.pdf_url);

  if (!candidateFile) {
    throw new Error(
      `Discovered PDF ${discovered.pdf_url} for course ${courseYear} is absent from snapshot manifest ${manifest.snapshot_id}`,
    );
  }

  return { candidateFile, discovered };
}

export function selectCandidateFile(manifest: SnapshotManifest, courseYear: number): SnapshotFile | null {
  const romanMap: Record<number, string> = { 1: "i", 2: "ii", 3: "iii", 4: "iv" };
  const roman = romanMap[courseYear] ?? String(courseYear);
  const pattern = new RegExp(`anul[_-]${roman}(?:[^a-z0-9]|$)`, "i");

  const matches = manifest.files.filter((f) => pattern.test(f.filename) || pattern.test(f.source_url));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  let best = matches[0];
  let bestRev = splitPdfRevision(best.filename).revision;
  for (const m of matches.slice(1)) {
    const rev = splitPdfRevision(m.filename).revision;
    if (rev > bestRev) {
      best = m;
      bestRev = rev;
    }
  }
  return best;
}

async function runBrokerAutomaticCheck(
  courseYear: number,
  options: { force?: boolean; startedAt: string },
): Promise<CheckResult> {
  let current = await getCurrentSchedule(courseYear);

  // Synchronize local state if durable accepted state is ahead or different
  let durableAccepted: import("@/lib/models").AcceptedRecord | null = null;
  try {
    durableAccepted = await fetchAcceptedSchedule(courseYear, { timeoutMs: config.brokerTimeoutMs });
    if (durableAccepted && durableAccepted.schedule) {
      const mismatch = courseYearMismatch(durableAccepted.schedule, courseYear);
      if (!mismatch) {
        if (!current || current.metadata.source_pdf_hash !== durableAccepted.source_pdf_hash) {
          log.warn("local schedule out of sync with durable accepted state; synchronizing local state", {
            courseYear,
            localHash: current?.metadata.source_pdf_hash ?? null,
            durableHash: durableAccepted.source_pdf_hash,
          });
          try {
            await replaceCurrentSchedule(courseYear, durableAccepted.schedule);
            await saveSourceState(courseYear, {
              current_pdf_url: durableAccepted.source_pdf_url,
              current_pdf_hash: durableAccepted.source_pdf_hash,
              etag: durableAccepted.schedule.metadata.etag,
              last_modified: durableAccepted.schedule.metadata.last_modified,
              last_success_at: durableAccepted.accepted_at,
              last_result: "updated",
              academic_year: durableAccepted.schedule.metadata.academic_year,
              semester: durableAccepted.schedule.metadata.semester,
            });
            current = durableAccepted.schedule;
          } catch (resyncErr) {
            // HARD GATE (E-04): Stop that course's update run immediately.
            // Do NOT evaluate new candidates, do NOT validate against old local state.
            const errorMsg = `Durable to local resync failed: ${errorMessage(resyncErr)}`;
            log.error(errorMsg, { courseYear });
            await saveSourceState(courseYear, {
              last_check_at: options.startedAt,
              last_result: "error",
              last_error: errorMsg,
              last_error_at: options.startedAt,
            });
            return {
              course_year: courseYear,
              outcome: "error",
              message: errorMsg,
            };
          }
        }
      }
    }
  } catch (syncErr) {
    log.warn("durable accepted state check failed during sync", { courseYear, error: errorMessage(syncErr) });
  }

  const pointer = await fetchCurrentPointer({ timeoutMs: config.brokerTimeoutMs });
  if (!pointer) {
    throw new Error("Could not fetch current snapshot pointer from broker");
  }

  const manifest = await fetchSnapshotManifest(pointer.snapshot_id, { timeoutMs: config.brokerTimeoutMs });
  if (!manifest) {
    throw new Error(`Could not fetch snapshot manifest for ${pointer.snapshot_id} from broker`);
  }

  const pageApi = await fetchSnapshotPageApi(pointer.snapshot_id, { timeoutMs: config.brokerTimeoutMs });
  if (!pageApi) {
    throw new Error(`Could not fetch snapshot page-api.json for ${pointer.snapshot_id} from broker`);
  }

  // Authoritative candidate selection using discoverPdf()
  const { candidateFile, discovered } = selectCandidateFromSnapshot(pageApi, manifest, courseYear, new Date());

  const staleParser = current !== null && current.metadata.parser_version !== config.parserVersion;
  const sourceUpgrade = current !== null && current.metadata.source_transport !== "broker";
  const sourceUrlChanged = current !== null && current.metadata.source_pdf_url !== discovered.pdf_url;
  const mustApply = Boolean(options.force || staleParser || sourceUpgrade || sourceUrlChanged);

  if (!mustApply && current && candidateFile.upstream_etag && current.metadata.etag === candidateFile.upstream_etag) {
    await saveSourceState(courseYear, {
      last_check_at: options.startedAt,
      last_result: "unchanged",
    });
    return {
      course_year: courseYear,
      outcome: "unchanged",
      message: "Candidate PDF unchanged (ETag match)",
      pdf_url: discovered.pdf_url,
      source_pdf_hash: current.metadata.source_pdf_hash,
      groups: current.groups.length,
      lessons: current.lessons.length,
    };
  }

  const resource = await fetchCandidatePdf(pointer.snapshot_id, candidateFile.filename, {
    timeoutMs: config.httpTimeoutMs,
  });

  const hash = sha256(resource.bytes);

  if (!mustApply && current && hash === current.metadata.source_pdf_hash) {
    await saveSourceState(courseYear, {
      current_pdf_url: discovered.pdf_url,
      current_pdf_hash: hash,
      etag: candidateFile.upstream_etag,
      last_modified: candidateFile.upstream_last_modified,
      last_check_at: options.startedAt,
      last_result: "unchanged",
    });
    return {
      course_year: courseYear,
      outcome: "unchanged",
      message: "Candidate PDF hash unchanged",
      pdf_url: discovered.pdf_url,
      source_pdf_hash: hash,
      groups: current.groups.length,
      lessons: current.lessons.length,
    };
  }

  const provenance: Provenance = {
    source_page_url: manifest.source.page_api_url,
    source_pdf_url: discovered.pdf_url,
    source_kind: "live",
    source_transport: "broker",
    source_snapshot_id: pointer.snapshot_id,
    downloaded_at: options.startedAt,
    etag: candidateFile.upstream_etag,
    last_modified: candidateFile.upstream_last_modified,
    academic_year: discovered.academic_year,
    semester: discovered.semester,
    semester_source: discovered.semester_source,
    course_year: courseYear,
  };

  const built = await buildValidatedSchedule(courseYear, resource.bytes, provenance, current);
  if (!built.schedule) {
    await saveSourceState(courseYear, {
      last_check_at: options.startedAt,
      last_result: "rejected",
      last_error: built.result.message,
      last_error_at: options.startedAt,
    });
    return built.result;
  }

  const validatedSchedule = built.schedule;

  // CRITICAL TRANSACTION ORDERING (Section 13):
  // 1. Write durable accepted state to R2 with CAS FIRST
  let expectedPreviousAcceptedId = durableAccepted?.accepted_id ?? null;
  if (!expectedPreviousAcceptedId && config.brokerUrl) {
    const existingPointer = await fetchAcceptedPointer(courseYear, { timeoutMs: config.brokerTimeoutMs });
    expectedPreviousAcceptedId = existingPointer?.accepted_id ?? null;
  }
  const putResult = await putAcceptedSchedule(
    courseYear,
    expectedPreviousAcceptedId,
    {
      schedule: validatedSchedule,
      snapshot_id: pointer.snapshot_id,
      source_pdf_url: discovered.pdf_url,
      source_pdf_hash: hash,
      accepted_at: options.startedAt,
    },
  );

  if (!putResult.ok) {
    const errorMsg = `Durable accepted write failed (status ${putResult.status}): ${putResult.message ?? "unknown error"}`;
    log.error(errorMsg, { courseYear, conflict: putResult.conflict });
    await saveSourceState(courseYear, {
      last_check_at: options.startedAt,
      last_result: "error",
      last_error: errorMsg,
      last_error_at: options.startedAt,
    });
    return {
      course_year: courseYear,
      outcome: "error",
      message: errorMsg,
    };
  }

  // 2. ONLY AFTER durable success: replaceCurrentSchedule() locally
  await replaceCurrentSchedule(courseYear, validatedSchedule);

  await saveSourceState(courseYear, {
    current_pdf_url: discovered.pdf_url,
    current_pdf_hash: hash,
    etag: candidateFile.upstream_etag,
    last_modified: candidateFile.upstream_last_modified,
    last_check_at: options.startedAt,
    last_success_at: options.startedAt,
    last_result: "updated",
    academic_year: validatedSchedule.metadata.academic_year,
    semester: validatedSchedule.metadata.semester,
  });

  log.info("schedule updated via broker", {
    courseYear,
    pdf: discovered.pdf_url,
    hash,
    snapshot_id: pointer.snapshot_id,
    groups: validatedSchedule.groups.length,
    lessons: validatedSchedule.lessons.length,
  });

  return {
    ...built.result,
    pdf_url: discovered.pdf_url,
    source_pdf_hash: hash,
  };
}

async function runAutomaticCheck(courseYear: number, options: { force?: boolean }): Promise<CheckResult> {
  const startedAt = new Date().toISOString();

  if (config.brokerUrl) {
    try {
      return await runBrokerAutomaticCheck(courseYear, { ...options, startedAt });
    } catch (brokerError) {
      const message = errorMessage(brokerError);
      log.error("broker schedule check failed", { courseYear, error: message });
      await saveSourceState(courseYear, {
        last_check_at: startedAt,
        last_result: "error",
        last_error: message,
        last_error_at: startedAt,
      });

      if (!(await getCurrentSchedule(courseYear))) {
        try {
          return await seedFromBundledPdf(courseYear);
        } catch (seedError) {
          const fallbackMessage = `seed fallback failed: ${errorMessage(seedError)}`;
          const combinedMessage = `${message}; ${fallbackMessage}`;
          await saveSourceState(courseYear, {
            last_check_at: startedAt,
            last_result: "error",
            last_error: combinedMessage,
            last_error_at: startedAt,
          });
          return { course_year: courseYear, outcome: "error", message: combinedMessage };
        }
      }
      return { course_year: courseYear, outcome: "error", message };
    }
  }

  try {
    await promoteBundledSeedIfNewer(courseYear);
    const { pdf, kind } = await discoverCurrentPdf(courseYear);
    return await updateFromPdfSource(
      courseYear,
      {
        pdfUrl: pdf.pdf_url,
        downloadUrl: kind === "wayback" ? waybackUrl(pdf.pdf_url) : pdf.pdf_url,
        kind,
        fetchMode: "discovered",
        extraHosts: kind === "wayback" ? [config.waybackHost] : [],
        academicYear: pdf.academic_year,
        semester: pdf.semester,
        semesterSource: pdf.semester_source,
        parityNote: pdf.parity_note,
      },
      { force: options.force, mode: "automatic", startedAt },
    );
  } catch (error) {
    const message = errorMessage(error);
    const kind = error instanceof SourceFetchError ? error.kind : "unknown";
    log.error("schedule check failed", { courseYear, error: message, kind });
    await saveSourceState(courseYear, {
      last_check_at: startedAt,
      last_result: "error",
      last_error: message,
      last_error_at: startedAt,
    });

    if (!(await getCurrentSchedule(courseYear))) {
      try {
        return await seedFromBundledPdf(courseYear);
      } catch (seedError) {
        const fallbackMessage = `seed fallback failed: ${errorMessage(seedError)}`;
        const combinedMessage = `${message}; ${fallbackMessage}`;
        log.warn("seed fallback failed after automatic discovery error", {
          courseYear,
          error: errorMessage(seedError),
          mirror: courseSeed(courseYear)?.mirrorUrl ?? null,
        });
        await saveSourceState(courseYear, {
          last_check_at: startedAt,
          last_result: "error",
          last_error: combinedMessage,
          last_error_at: startedAt,
        });
        return { course_year: courseYear, outcome: "error", message: combinedMessage };
      }
    }
    return { course_year: courseYear, outcome: "error", message };
  }
}

async function runExplicitRefresh(courseYear: number, options: ExplicitRefreshOptions): Promise<CheckResult> {
  const startedAt = new Date().toISOString();
  try {
    return await updateFromPdfSource(
      courseYear,
      {
        pdfUrl: options.pdfUrl,
        downloadUrl: options.pdfUrl,
        kind: "manual",
        fetchMode: "explicit",
      },
      { force: options.force, mode: "explicit", startedAt },
    );
  } catch (error) {
    const message = errorMessage(error);
    const kind = error instanceof SourceFetchError ? error.kind : "unknown";
    log.error("explicit PDF refresh failed, keeping previous version", {
      courseYear,
      error: message,
      kind,
      pdf: options.pdfUrl,
    });
    // Automatic discovery health remains untouched. The authenticated response and
    // logs report this recovery failure without erasing the last discovery diagnostic.
    return { course_year: courseYear, outcome: "error", message, pdf_url: options.pdfUrl };
  }
}

async function updateFromPdfSource(
  courseYear: number,
  source: PdfUpdateSource,
  options: { force?: boolean; mode: UpdateMode; startedAt: string },
): Promise<CheckResult> {
  const [state, current] = await Promise.all([getSourceState(courseYear), getCurrentSchedule(courseYear)]);
  const staleParser = current !== null && current.metadata.parser_version !== config.parserVersion;
  const sourceUpgrade = source.kind === "live" && current !== null && current.metadata.source_kind !== "live";
  const sourceUrlChanged = current !== null && current.metadata.source_pdf_url !== source.pdfUrl;
  const mustFetchBody = Boolean(options.force || staleParser || sourceUpgrade || sourceUrlChanged);
  const sameUrl = state.current_pdf_url === source.pdfUrl && current !== null;
  // Explicit recovery always downloads a complete body. Besides making the operation
  // deterministic, this ensures redirect targets and PDF magic are revalidated.
  const conditional =
    source.fetchMode === "discovered" && sameUrl && !mustFetchBody
      ? { etag: state.etag, lastModified: state.last_modified }
      : {};

  const resource = await fetchSourcePdf(source, conditional);
  if (resource.notModified) {
    await recordResult(courseYear, options.mode, {
      startedAt: options.startedAt,
      outcome: "unchanged",
      message: "PDF not modified (304)",
      source,
    });
    return { course_year: courseYear, outcome: "unchanged", message: "PDF not modified (304)", pdf_url: source.pdfUrl };
  }

  const canonicalPdfUrl = source.fetchMode === "explicit" ? resource.finalUrl : source.pdfUrl;
  const hash = sha256(resource.bytes);
  const provenanceChanged =
    current !== null &&
    (current.metadata.source_pdf_url !== canonicalPdfUrl ||
      (source.kind === "live" && current.metadata.source_kind !== "live"));
  const mustApply = Boolean(options.force || staleParser || provenanceChanged);

  if (!mustApply && current && hash === current.metadata.source_pdf_hash) {
    const message = "PDF hash unchanged";
    await recordResult(courseYear, options.mode, {
      startedAt: options.startedAt,
      outcome: "unchanged",
      message,
      source,
      canonicalPdfUrl,
      hash,
      resource,
      schedule: current,
    });
    return {
      course_year: courseYear,
      outcome: "unchanged",
      message,
      pdf_url: canonicalPdfUrl,
      source_pdf_hash: hash,
      groups: current.groups.length,
      lessons: current.lessons.length,
    };
  }

  const provenance: Provenance = {
    source_page_url: config.schedulePageUrl,
    source_pdf_url: canonicalPdfUrl,
    source_kind: source.kind,
    downloaded_at: options.startedAt,
    etag: resource.etag,
    last_modified: resource.lastModified,
    academic_year: source.academicYear,
    semester: source.semester,
    semester_source: source.semesterSource,
    course_year: courseYear,
  };
  if (staleParser) {
    log.info("re-parsing the cached PDF with the new parser", {
      courseYear,
      from: current?.metadata.parser_version,
      to: config.parserVersion,
    });
  }

  const applied = await parseAndApply(courseYear, resource.bytes, provenance, current);
  await recordResult(courseYear, options.mode, {
    startedAt: options.startedAt,
    outcome: applied.result.outcome,
    message: applied.result.message,
    source,
    canonicalPdfUrl,
    hash,
    resource,
    schedule: applied.schedule,
  });
  return {
    ...applied.result,
    pdf_url: canonicalPdfUrl,
    source_pdf_hash: applied.schedule?.metadata.source_pdf_hash,
    groups: applied.schedule?.groups.length,
  };
}

async function fetchSourcePdf(
  source: PdfUpdateSource,
  conditional: { etag?: string | null; lastModified?: string | null },
): Promise<FetchedResource> {
  return source.fetchMode === "explicit"
    ? fetchOfficialTimetablePdf(source.downloadUrl, conditional)
    : fetchPdf(source.downloadUrl, conditional, source.extraHosts);
}

async function recordResult(
  courseYear: number,
  mode: UpdateMode,
  details: {
    startedAt: string;
    outcome: CheckOutcome;
    message: string;
    source: PdfUpdateSource;
    canonicalPdfUrl?: string;
    hash?: string;
    resource?: FetchedResource;
    schedule?: Schedule;
  },
): Promise<void> {
  const currentFields =
    details.canonicalPdfUrl && details.hash && details.resource
      ? {
          current_pdf_url: details.canonicalPdfUrl,
          current_pdf_hash: details.hash,
          etag: details.resource.etag,
          last_modified: details.resource.lastModified,
        }
      : {};

  if (mode === "explicit") {
    if (details.outcome === "updated") {
      await saveSourceState(courseYear, {
        ...currentFields,
        last_success_at: details.startedAt,
        academic_year: details.schedule?.metadata.academic_year ?? null,
        semester: details.schedule?.metadata.semester ?? null,
      });
    } else if (details.outcome === "unchanged") {
      await saveSourceState(courseYear, currentFields);
    }
    return;
  }

  const rejected = details.outcome === "rejected";
  await saveSourceState(courseYear, {
    last_check_at: details.startedAt,
    last_result: details.outcome,
    last_error: rejected ? details.message : null,
    ...(rejected ? { last_error_at: details.startedAt } : {}),
    ...(details.outcome === "updated"
      ? {
          ...currentFields,
          last_success_at: details.startedAt,
          academic_year: details.schedule?.metadata.academic_year ?? details.source.academicYear ?? null,
          semester: details.schedule?.metadata.semester ?? details.source.semester ?? null,
        }
      : details.outcome === "unchanged"
        ? currentFields
        : {}),
    parity_note: details.source.parityNote ?? null,
  });
}

async function parseAndApply(
  courseYear: number,
  bytes: Uint8Array,
  provenance: Provenance,
  current: Schedule | null,
): Promise<ApplyResult> {
  const built = await buildValidatedSchedule(courseYear, bytes, provenance, current);
  if (!built.schedule) return { result: built.result };

  await replaceCurrentSchedule(courseYear, built.schedule);
  log.info("schedule updated", {
    courseYear,
    pdf: provenance.source_pdf_url,
    hash: built.schedule.metadata.source_pdf_hash,
    groups: built.schedule.groups.length,
    lessons: built.schedule.lessons.length,
    source_kind: provenance.source_kind,
  });
  return { result: built.result, schedule: built.schedule };
}

/**
 * Each course slot holds exactly one course year's timetable. A parsed schedule that
 * belongs to another one — the bundled Anul I seed offered to Anul II, say — must never
 * be installed, however healthy it looks otherwise. This is the single gate every
 * candidate passes: live, wayback, manual, packaged seed, image seed, repository mirror
 * seed and seed promotion alike.
 */
function courseYearMismatch(schedule: Schedule, courseYear: number): string | null {
  const parsed = schedule.metadata.course_year;
  if (parsed === courseYear) return null;
  const title = schedule.metadata.pdf_title;
  return (
    `course year mismatch: the PDF belongs to course year ${parsed}` +
    `${title ? ` ("${title}")` : ""}, but this update was requested for course year ${courseYear}`
  );
}

async function buildValidatedSchedule(
  courseYear: number,
  bytes: Uint8Array,
  provenance: Provenance,
  current: Schedule | null,
): Promise<ApplyResult> {
  let schedule: Schedule;
  try {
    ({ schedule } = await parsePdf(bytes, provenance));
  } catch (error) {
    const message = `parser failed: ${errorMessage(error)}`;
    log.error(message, { courseYear, pdf: provenance.source_pdf_url });
    return { result: { course_year: courseYear, outcome: "rejected", message } };
  }

  const mismatch = courseYearMismatch(schedule, courseYear);
  if (mismatch) {
    log.error("candidate schedule rejected: wrong course year", {
      courseYear,
      message: mismatch,
      pdf: provenance.source_pdf_url,
      source_kind: provenance.source_kind,
    });
    return { result: { course_year: courseYear, outcome: "rejected", message: mismatch } };
  }

  const validation = validateSchedule(schedule, { previousLessonCount: current?.lessons.length ?? null });
  if (!validation.ok) {
    const message = `validation failed: ${validation.errors.join("; ")}`;
    log.error("new schedule rejected, keeping previous version", {
      courseYear,
      errors: validation.errors,
      pdf: provenance.source_pdf_url,
    });
    return { result: { course_year: courseYear, outcome: "rejected", message } };
  }
  for (const warning of validation.warnings) log.warn("validation warning", { courseYear, warning });

  return {
    result: {
      course_year: courseYear,
      outcome: "updated",
      message: `parsed ${schedule.lessons.length} lessons for ${schedule.groups.length} groups`,
      lessons: schedule.lessons.length,
      groups: schedule.groups.length,
      source_pdf_hash: schedule.metadata.source_pdf_hash,
    },
    schedule,
  };
}

async function readBundledSeed(seed: CourseSeed): Promise<{ bytes: Uint8Array; path: string } | null> {
  const paths = [...new Set([seed.pdfPath, seed.imagePdfPath])];
  for (const filePath of paths) {
    try {
      return { bytes: new Uint8Array(await readFile(filePath)), path: filePath };
    } catch {
      // Try the immutable image copy next. The writable data directory may be a mounted volume.
    }
  }
  return null;
}

/**
 * A deployment may contain a newer packaged seed while its persistent volume still
 * holds an older seed. Promote only when URL revision ordering and parsed metadata
 * prove this is a forward move within the exact same academic context.
 */
async function promoteBundledSeedIfNewer(courseYear: number): Promise<void> {
  const seed = courseSeed(courseYear);
  if (!seed) return;
  const current = await getCurrentSchedule(courseYear);
  if (!current || current.metadata.source_kind !== "seed") return;

  const bundled = await readBundledSeed(seed);
  if (!bundled) return;
  const bundledHash = sha256(bundled.bytes);
  if (
    bundledHash === current.metadata.source_pdf_hash ||
    seed.originalUrl === current.metadata.source_pdf_url ||
    !isNewerPackagedSeedUrl(current.metadata.source_pdf_url, seed.originalUrl)
  ) {
    return;
  }

  const now = new Date().toISOString();
  const built = await buildValidatedSchedule(
    courseYear,
    bundled.bytes,
    {
      source_page_url: config.schedulePageUrl,
      source_pdf_url: seed.originalUrl,
      source_kind: "seed",
      downloaded_at: now,
      course_year: courseYear,
    },
    current,
  );
  if (!built.schedule) {
    log.warn("newer bundled seed was invalid; keeping persisted seed", {
      courseYear,
      path: bundled.path,
      error: built.result.message,
    });
    return;
  }
  if (!sameAcademicContext(current, built.schedule, courseYear)) {
    log.warn("bundled seed academic context differs; keeping persisted seed", {
      courseYear,
      current: academicContext(current),
      bundled: academicContext(built.schedule),
    });
    return;
  }

  await replaceCurrentSchedule(courseYear, built.schedule);
  await saveSourceState(courseYear, {
    current_pdf_url: seed.originalUrl,
    current_pdf_hash: bundledHash,
    etag: null,
    last_modified: null,
    last_success_at: now,
    last_result: "seeded",
    academic_year: built.schedule.metadata.academic_year,
    semester: built.schedule.metadata.semester,
  });
  log.warn("promoted obsolete persisted seed to newer packaged baseline", {
    courseYear,
    from: current.metadata.source_pdf_url,
    to: seed.originalUrl,
    hash: bundledHash,
    groups: built.schedule.groups.length,
    lessons: built.schedule.lessons.length,
  });
}

function academicContext(schedule: Schedule) {
  return {
    academicYear: schedule.metadata.academic_year,
    semester: schedule.metadata.semester,
    courseYear: schedule.metadata.course_year,
  };
}

function sameAcademicContext(current: Schedule, bundled: Schedule, courseYear: number): boolean {
  const left = academicContext(current);
  const right = academicContext(bundled);
  return (
    left.academicYear !== null &&
    left.academicYear === right.academicYear &&
    left.semester !== null &&
    left.semester === right.semester &&
    left.courseYear === right.courseYear &&
    right.courseYear === courseYear
  );
}

interface SeedPublication {
  year: number;
  month: number;
  basename: string;
  revision: number;
}

function seedPublication(rawUrl: string): SeedPublication | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "fcim.utm.md") return null;
  const match = /^\/wp-content\/uploads\/sites\/24\/(\d{4})\/(\d{2})\/([^/]+\.pdf)$/i.exec(url.pathname);
  if (!match) return null;
  const { family, revision } = splitPdfRevision(match[3]);
  return { year: Number(match[1]), month: Number(match[2]), basename: family, revision };
}

function isNewerPackagedSeedUrl(currentUrl: string, bundledUrl: string): boolean {
  const current = seedPublication(currentUrl);
  const bundled = seedPublication(bundledUrl);
  if (!current || !bundled || current.basename !== bundled.basename) return false;
  const currentPeriod = current.year * 12 + current.month;
  const bundledPeriod = bundled.year * 12 + bundled.month;
  return bundledPeriod > currentPeriod || (bundledPeriod === currentPeriod && bundled.revision > current.revision);
}

function verifySeedMirrorHash(bytes: Uint8Array, seed: CourseSeed): void {
  const expected = seed.sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("SCHEDULE_SEED_PDF_SHA256 must contain a 64-character hexadecimal SHA-256");
  }
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`seed mirror SHA-256 mismatch: expected ${expected}, received ${actual}`);
  }
}

/**
 * Last resort for a cold start without network: a real, previously published FCIM PDF.
 * Throws when no seed can be installed — including for a course that simply has none —
 * so the caller reports the failure instead of appearing healthy; storage is left
 * untouched in that case, and the course stays unavailable until the source returns.
 */
async function seedFromBundledPdf(courseYear: number): Promise<CheckResult> {
  const seed = courseSeed(courseYear);
  if (!seed) throw new Error(`no bundled seed PDF is available for course year ${courseYear}`);

  const bundled = await readBundledSeed(seed);
  let bytes = bundled?.bytes ?? null;
  if (!bytes) {
    try {
      const mirror = await fetchPdf(seed.mirrorUrl, {}, ["raw.githubusercontent.com"]);
      verifySeedMirrorHash(mirror.bytes, seed);
      bytes = mirror.bytes;
      log.warn("loaded seed PDF from the repository mirror", { courseYear, url: seed.mirrorUrl });
    } catch (error) {
      log.warn("no seed PDF available", {
        courseYear,
        paths: [...new Set([seed.pdfPath, seed.imagePdfPath])],
        mirror: seed.mirrorUrl,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  const now = new Date().toISOString();
  const applied = await parseAndApply(
    courseYear,
    bytes,
    {
      source_page_url: config.schedulePageUrl,
      source_pdf_url: seed.originalUrl,
      source_kind: "seed",
      downloaded_at: now,
      course_year: courseYear,
    },
    null,
  );
  if (applied.result.outcome !== "updated" || !applied.schedule) throw new Error(applied.result.message);
  await saveSourceState(courseYear, {
    current_pdf_url: seed.originalUrl,
    current_pdf_hash: applied.schedule.metadata.source_pdf_hash,
    etag: null,
    last_modified: null,
    last_success_at: now,
    last_result: "seeded",
    academic_year: applied.schedule.metadata.academic_year,
    semester: applied.schedule.metadata.semester,
  });
  log.warn("served bundled seed PDF because the live source is unreachable and no cache exists", { courseYear });
  return {
    course_year: courseYear,
    outcome: "seeded",
    message: "bootstrapped from bundled seed PDF",
    pdf_url: seed.originalUrl,
    source_pdf_hash: applied.schedule.metadata.source_pdf_hash,
    groups: applied.schedule.groups.length,
    lessons: applied.schedule.lessons.length,
  };
}

/**
 * Parsing a bundled seed is CPU-bound, and CPU-bound work cannot be preempted by a timer: once
 * `parsePdf` starts, the deadline can only be observed after it returns. So the seed fallback is
 * gated on having enough budget to plausibly finish, rather than merely on the deadline not having
 * passed yet. A course skipped here is picked up by the first scheduler tick instead.
 */
const MIN_SEED_RESTORE_BUDGET_MS = 1_500;

/**
 * Restore one course's state under a shared deadline.
 *
 * Every step — the local read, the broker pointer, the broker payload, the local write and the
 * seed fallback — is either given the remaining budget or raced against it, so no single stalled
 * operation can push the caller past `totalTimeoutMs`.
 */
async function restoreCourseOnColdStart(courseYear: number, deadline: Deadline): Promise<void> {
  const existing = await deadline.race(getCurrentSchedule(courseYear));
  if (existing) {
    log.info("cold-start bootstrap: local schedule already present", { courseYear });
    return;
  }

  let restoredFromBroker = false;

  if (config.brokerUrl && !deadline.expired) {
    try {
      const accepted = await fetchAcceptedSchedule(courseYear, {
        timeoutMs: config.brokerTimeoutMs,
        deadlineAt: deadline.deadlineAt,
        signal: deadline.signal,
      });

      if (accepted && accepted.schedule) {
        const mismatch = courseYearMismatch(accepted.schedule, courseYear);
        if (mismatch) {
          log.warn("cold-start bootstrap: broker accepted schedule rejected due to course year mismatch", {
            courseYear,
            mismatch,
          });
        } else {
          await deadline.race(replaceCurrentSchedule(courseYear, accepted.schedule));
          await deadline.race(
            saveSourceState(courseYear, {
              current_pdf_url: accepted.source_pdf_url,
              current_pdf_hash: accepted.source_pdf_hash,
              etag: accepted.schedule.metadata.etag,
              last_modified: accepted.schedule.metadata.last_modified,
              last_success_at: accepted.accepted_at,
              last_result: "updated",
              academic_year: accepted.schedule.metadata.academic_year,
              semester: accepted.schedule.metadata.semester,
            }),
          );
          log.info("cold-start bootstrap: restored schedule from broker durable accepted state", {
            courseYear,
            hash: accepted.source_pdf_hash,
            lessons: accepted.schedule.lessons.length,
          });
          restoredFromBroker = true;
        }
      }
    } catch (brokerError) {
      if (brokerError instanceof DeadlineExceededError) throw brokerError;
      log.warn("cold-start bootstrap: broker restoration failed", {
        courseYear,
        error: errorMessage(brokerError),
      });
    }
  }

  if (restoredFromBroker) return;

  if (deadline.remaining() < MIN_SEED_RESTORE_BUDGET_MS) {
    log.warn("cold-start bootstrap: not enough budget left for bundled seed restoration", {
      courseYear,
      remainingMs: deadline.remaining(),
      requiredMs: MIN_SEED_RESTORE_BUDGET_MS,
    });
    return;
  }

  try {
    await deadline.race(seedFromBundledPdf(courseYear));
    log.info("cold-start bootstrap: restored bundled seed", { courseYear });
  } catch (seedError) {
    if (seedError instanceof DeadlineExceededError) throw seedError;
    log.warn("cold-start bootstrap: bundled seed restoration failed", {
      courseYear,
      error: errorMessage(seedError),
    });
  }
}

/**
 * Cold-start bootstrap: bounded restoration of initial schedule state before candidate validation.
 *
 * Runs supported courses concurrently under one shared wall-clock deadline: `totalTimeoutMs` is
 * measured from the moment bootstrap starts, and every operation underneath receives what is left
 * of it. A course whose broker pointer or payload stalls is abandoned at the deadline instead of
 * holding startup open, and the other courses still get their own restoration.
 *
 * - If a local accepted schedule exists: keep it.
 * - Otherwise, if the broker is configured: restore the durable accepted state for the course
 *   (schema-validated, course-guarded, atomically installed).
 * - If the broker is unavailable, 404s, returns something invalid, or there is no budget left:
 *   fall back to the bundled seed.
 */
export async function bootstrapScheduleState(options: { totalTimeoutMs?: number } = {}): Promise<void> {
  const totalTimeoutMs = options.totalTimeoutMs ?? config.brokerTimeoutMs * 2;
  const deadline = new Deadline(totalTimeoutMs);

  try {
    await Promise.allSettled(
      SUPPORTED_COURSE_YEARS.map(async (courseYear) => {
        try {
          await restoreCourseOnColdStart(courseYear, deadline);
        } catch (error) {
          if (error instanceof DeadlineExceededError) {
            log.warn("cold-start bootstrap: total deadline elapsed before this course finished", {
              courseYear,
              totalTimeoutMs,
              elapsedMs: deadline.elapsed(),
            });
            return;
          }
          log.error("cold-start bootstrap failed for course", { courseYear, error: errorMessage(error) });
        }
      }),
    );
  } finally {
    deadline.dispose();
  }
}

/**
 * One tick refreshes every supported course, one after another. A course that fails
 * keeps its own last-known-good schedule and its own error state; the next course is
 * checked regardless, so one broken timetable never stops the other from updating.
 */
export async function refreshAllCourses(options: { force?: boolean } = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const courseYear of SUPPORTED_COURSE_YEARS) {
    try {
      results.push(await checkForUpdates(courseYear, options));
    } catch (error) {
      const message = errorMessage(error);
      log.error("scheduled check failed", { courseYear, error: message });
      results.push({ course_year: courseYear, outcome: "error", message });
    }
  }
  return results;
}

/** Bootstraps the caches (if needed) and starts the periodic refresh loop. Idempotent. */
export function startScheduler(): void {
  const globalRef = globalThis as typeof globalThis & { __fcimScheduler?: NodeJS.Timeout };
  if (globalRef.__fcimScheduler) return;

  const tick = () => {
    void refreshAllCourses();
  };
  globalRef.__fcimScheduler = setInterval(tick, config.refreshIntervalMs);
  globalRef.__fcimScheduler.unref?.();
  log.info("scheduler started", {
    intervalMinutes: config.refreshIntervalMs / 60_000,
    courses: [...SUPPORTED_COURSE_YEARS],
  });
  // Initial bootstrap runs immediately but does not block server startup.
  setTimeout(tick, 0);
}
