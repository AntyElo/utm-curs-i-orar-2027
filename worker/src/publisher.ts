/**
 * Split candidate-snapshot publication.
 *
 * One Worker invocation is not allowed to fetch every upstream PDF and close the snapshot: on the
 * Free plan that reliably costs more than the 10 ms CPU budget. Publication is therefore four
 * bounded stages, each in its own invocation, connected by a Cloudflare Queue:
 *
 *   TRIGGER -> DISCOVERY -> PDF INGEST JOBS -> FINALIZE -> current.json CAS
 *
 * The ordering guarantees are unchanged from the monolithic publisher and are what make a
 * half-built snapshot harmless: every child object is created with `If-None-Match: *`, the
 * manifest is written only once every expected PDF is proven present, and `current.json` is
 * compare-and-swapped last against the ETag discovery observed. A snapshot that never finishes
 * simply stays out of `current.json` forever.
 *
 * The broker stays a transport. It mirrors every strictly-valid official timetable PDF the
 * authoritative page references and never tries to read a course year, semester or revision out
 * of a filename — `discoverPdf()` on Render remains the only thing that decides what a timetable
 * means.
 */

import { extractOfficialPdfUrls, getPdfFilename } from "./extractor";
import { buildFinalizeJob, buildIngestJob, fileIdForIndex, qualifiedPdfFilename, validateJob } from "./jobs";
import { isOfficialTimetablePdfUrl } from "../../worker-shared/fcim-policy";
import {
  PENDING_MAX_AGE_MS, RECONCILE_PAGE_SIZE, RECONCILE_SCAN_PAGES,
  readScanCursor, writeScanCursor, runRetention, snapshotIdInstant, snapshotWorkExpired,
} from "./maintenance";
import {
  CURRENT_KEY,
  PENDING_PREFIX,
  pendingCompletionKey,
  pendingDescriptorKey,
  snapshotManifestKey,
  snapshotPageApiKey,
  snapshotPdfKey,
} from "./keys";
import { fetchPageApi, readPageApiDocument, resolvePageApiUrl } from "./page-api";
import { isRetryableUpstreamFailure, isRetryableUpstreamStatus, validatorOrNull } from "./http";
import { fetchOfficialPdf, MAX_PDF_BYTES, PdfFetchError } from "./pdf-fetch";
import {
  buildCurrentPointer,
  normalizePageModifiedGmt,
  parseCurrentPointer,
} from "./pointer";
import { contentLengthOrNull, isPayloadTooLarge, putLimitedStream } from "./stream-limit";
import type {
  CompletionMarker,
  DiscoveryResult,
  Env,
  FinalizeResult,
  IngestPdfJob,
  IngestResult,
  PendingDescriptor,
  PendingFile,
  ParsedCurrentPointer,
  PublicationJob,
  ReconcileResult,
  SnapshotFile,
  SnapshotManifest,
} from "./types";

const IF_NONE_MATCH_COND = { etagDoesNotMatch: "*" };

/** Backstop finalize, in case every ingest's own finalize raced ahead of the last completion. */
const FINALIZE_BACKSTOP_DELAY_SECONDS = 30;

/** How many unfinished snapshots one reconcile invocation will re-drive. */
const MAX_RECONCILED_SNAPSHOTS = 3;

/** Leave a freshly scheduled snapshot alone; its own ingest jobs are still in flight. */
const PENDING_MIN_AGE_MS = 5 * 60 * 1000;

/**
 * Generate a collision-safe snapshot identifier.
 * Format: YYYY-MM-DDTHH-mm-ss-sssZ-<random-8>
 */
export function generateSnapshotId(now = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const randomSuffix = crypto.randomUUID().slice(0, 8);
  return `${iso}-${randomSuffix}`;
}

/* ------------------------------------------------------------------ *
 * Stage 1: discovery
 * ------------------------------------------------------------------ */

async function loadPreviousManifest(
  env: Env,
  pointer: ParsedCurrentPointer,
): Promise<SnapshotManifest | null> {
  const obj = await env.R2_BUCKET.get(pointer.manifest_r2_key);
  if (!obj) return null;
  try {
    const manifest = (await obj.json()) as SnapshotManifest;
    return manifest.snapshot_id === pointer.snapshot_id ? manifest : null;
  } catch {
    return null;
  }
}

/**
 * Conditionally revalidate the PDFs of the previous snapshot.
 *
 * Bodies are never read — a 304 means unchanged, a 200 means the upstream replaced a document
 * in place under the same URL, and anything else is an error rather than a quiet "unchanged".
 */
async function anyPreviousPdfChanged(env: Env, manifest: SnapshotManifest): Promise<boolean> {
  const checks = manifest.files.map(async (file) => {
    const headers: Record<string, string> = {};
    if (file.upstream_etag) headers["If-None-Match"] = file.upstream_etag;
    if (file.upstream_last_modified) headers["If-Modified-Since"] = file.upstream_last_modified;

    const res = await fetchOfficialPdf(env, file.source_url, headers);
    // We only need the status; releasing the body keeps the subrequest from being held open.
    await res.body?.cancel().catch(() => {});

    if (res.status === 304) return false;
    if (res.status === 200) return true;
    throw new PdfFetchError(
      `Conditional check for ${file.source_url} returned HTTP ${res.status}`,
      res.status,
    );
  });

  const results = await Promise.all(checks);
  return results.some(Boolean);
}

/**
 * Give every mirrored PDF its own object name.
 *
 * WordPress uploads are grouped by year and month, so two different documents can legitimately
 * share a basename across two folders. Mirroring everything makes that collision reachable, and
 * two files competing for one create-only key would deadlock the snapshot, so a colliding name is
 * qualified with its upload month. The name stays a plain basename, which is what the manifest
 * publishes and what `/snapshots/:id/pdfs/:filename` serves.
 */
export function planSnapshotFiles(snapshotId: string, pdfUrls: readonly string[]): PendingFile[] {
  const taken = new Set<string>();
  return pdfUrls.map((sourceUrl, index) => {
    if (!isOfficialTimetablePdfUrl(sourceUrl)) throw new Error(`Invalid official PDF URL: ${sourceUrl}`);
    const basename = getPdfFilename(sourceUrl);
    let filename = basename;
    if (taken.has(filename)) {
      filename = qualifiedPdfFilename(sourceUrl);
    }
    if (taken.has(filename)) filename = qualifiedPdfFilename(sourceUrl, fileIdForIndex(index));
    if (taken.has(filename)) throw new Error(`Cannot assign a unique PDF filename for ${sourceUrl}`);
    const checked = validateJob(buildIngestJob({ snapshotId, fileId: fileIdForIndex(index), filename, sourceUrl }));
    if (!checked.ok) throw new Error(`Invalid planned ingest: ${checked.error}`);
    taken.add(filename);
    return {
      file_id: fileIdForIndex(index),
      filename,
      source_url: sourceUrl,
      r2_key: snapshotPdfKey(snapshotId, filename),
    };
  });
}

function sameUrlSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((url) => set.has(url));
}

/**
 * Discovery: decide whether a new snapshot is warranted, and if so fix its complete expected
 * file set in an immutable descriptor and schedule one bounded ingest job per PDF.
 *
 * It never downloads a PDF body, never writes a manifest and never touches `current.json`.
 */
export async function runDiscovery(
  env: Env,
  options: { force?: boolean } = {},
): Promise<DiscoveryResult> {
  let pageApiUrl: string;
  try {
    pageApiUrl = resolvePageApiUrl(env.FCIM_PAGE_API_URL);
  } catch (err) {
    return { outcome: "error", error: (err as Error).message };
  }

  const currentObj = await env.R2_BUCKET.get(CURRENT_KEY);
  const currentEtag = currentObj?.etag ?? null;

  let previousPointer: ParsedCurrentPointer | null = null;
  if (currentObj) {
    const parsed = parseCurrentPointer(await currentObj.text());
    if (parsed.ok) {
      previousPointer = parsed.pointer;
    } else {
      // No field is salvaged from an unusable pointer. The ETag is still honoured, so a
      // concurrent well-formed publisher can never be overwritten by this cycle.
      console.warn(`current.json rejected by strict pointer validation: ${parsed.error}`);
    }
  }

  const previousManifest = previousPointer ? await loadPreviousManifest(env, previousPointer) : null;

  let pageBytes: Uint8Array;
  let pageEtag: string | null = null;
  let pageLastModified: string | null = null;
  try {
    const first = await fetchPageApi(env, pageApiUrl, {
      etag: previousManifest?.source.etag,
      lastModified: previousManifest?.source.last_modified,
    });

    if (first.notModified) {
      if (!options.force && previousManifest) {
        if (!(await anyPreviousPdfChanged(env, previousManifest))) {
          return {
            outcome: "unchanged",
            previous_snapshot_id: previousPointer?.snapshot_id ?? null,
            reason: "page 304 and every mirrored PDF 304",
          };
        }
      }
      // Something moved (or a forced run): we need the full body to rebuild the catalogue.
      const full = await fetchPageApi(env, pageApiUrl);
      if (full.notModified || !full.bytes) {
        return { outcome: "error", error: "Page API answered 304 to an unconditional request" };
      }
      pageBytes = full.bytes;
      pageEtag = full.etag;
      pageLastModified = full.lastModified;
    } else {
      if (!first.bytes) {
        return { outcome: "error", error: "Page API returned no body" };
      }
      pageBytes = first.bytes;
      pageEtag = first.etag;
      pageLastModified = first.lastModified;
    }
  } catch (err) {
    // Every failure means the upstream state is unknown, never "unchanged". The result also
    // distinguishes transient network/403/429/5xx failures from deterministic policy/schema
    // failures so the queue does not burn retries on a job that cannot recover.
    return {
      outcome: "error",
      error: (err as Error).message,
      retryable: isRetryableUpstreamFailure(err),
    };
  }

  const rawText = new TextDecoder().decode(pageBytes);
  let pageId: number | null;
  let pageModifiedGmt: string | null;
  let renderedHtml: string;
  try {
    const doc = readPageApiDocument(rawText);
    pageId = doc.pageId;
    pageModifiedGmt = normalizePageModifiedGmt(doc.pageModifiedGmt);
    renderedHtml = doc.renderedHtml;
  } catch (err) {
    return { outcome: "error", error: (err as Error).message };
  }

  // Transport catalogue: every strictly-valid official timetable PDF the page references.
  // No filename is interpreted; Render selects the timetable that matters for a course year.
  const pdfUrls = extractOfficialPdfUrls(renderedHtml);
  if (pdfUrls.length === 0) {
    return { outcome: "error", error: "No official timetable PDF URLs found in Page API content" };
  }

  if (!options.force && previousPointer && previousManifest) {
    // Legacy pointers do not carry Page API metadata. The immutable manifest is authoritative
    // for both legacy and strict pointers, so no compatibility value has to be invented.
    const previousPageModifiedGmt = previousManifest.source.page_modified_gmt;
    const pageUnchanged =
      previousPageModifiedGmt !== null && previousPageModifiedGmt === pageModifiedGmt;
    const catalogueUnchanged = sameUrlSet(
      pdfUrls,
      previousManifest.files.map((f) => f.source_url),
    );

    if (pageUnchanged && catalogueUnchanged) {
      try {
        if (!(await anyPreviousPdfChanged(env, previousManifest))) {
          return {
            outcome: "unchanged",
            previous_snapshot_id: previousPointer.snapshot_id,
            reason: "page modified_gmt and PDF catalogue unchanged, every mirrored PDF 304",
          };
        }
      } catch (err) {
        return {
          outcome: "error",
          error: (err as Error).message,
          retryable: isRetryableUpstreamFailure(err),
        };
      }
    }
  }

  const snapshotId = generateSnapshotId();
  const createdAt = new Date().toISOString();

  let files: PendingFile[];
  try { files = planSnapshotFiles(snapshotId, pdfUrls); }
  catch (err) { return { outcome: "error", error: (err as Error).message, retryable: false }; }

  const pageApiWritten = await env.R2_BUCKET.put(snapshotPageApiKey(snapshotId), pageBytes, {
    onlyIf: IF_NONE_MATCH_COND,
    httpMetadata: { contentType: "application/json" },
  });
  if (!pageApiWritten) {
    return {
      outcome: "error",
      snapshot_id: snapshotId,
      error: `Collision: ${snapshotPageApiKey(snapshotId)} already exists under an immutable snapshot`,
    };
  }

  const descriptor: PendingDescriptor = {
    schema_version: 1,
    snapshot_id: snapshotId,
    previous_snapshot_id: previousPointer?.snapshot_id ?? null,
    created_at: createdAt,
    current_etag: currentEtag,
    source: {
      page_api_url: pageApiUrl,
      page_id: pageId,
      page_modified_gmt: pageModifiedGmt,
      retrieved_at: createdAt,
      etag: pageEtag,
      last_modified: pageLastModified,
    },
    files,
  };

  const descriptorWritten = await env.R2_BUCKET.put(
    pendingDescriptorKey(snapshotId),
    JSON.stringify(descriptor),
    { onlyIf: IF_NONE_MATCH_COND, httpMetadata: { contentType: "application/json" } },
  );
  if (!descriptorWritten) {
    return {
      outcome: "error",
      snapshot_id: snapshotId,
      error: `Collision: pending descriptor for ${snapshotId} already exists`,
    };
  }

  const messages: { body: PublicationJob; delaySeconds?: number }[] = files.map((file) => ({
    body: buildIngestJob({
      snapshotId,
      fileId: file.file_id,
      filename: file.filename,
      sourceUrl: file.source_url,
    }),
  }));
  messages.push({
    body: buildFinalizeJob(snapshotId),
    delaySeconds: FINALIZE_BACKSTOP_DELAY_SECONDS,
  });

  await env.PUBLICATION_QUEUE.sendBatch(messages);

  return {
    outcome: "scheduled",
    snapshot_id: snapshotId,
    previous_snapshot_id: previousPointer?.snapshot_id ?? null,
    files: files.length,
  };
}

/* ------------------------------------------------------------------ *
 * Stage 2: one PDF per invocation
 * ------------------------------------------------------------------ */

async function readDescriptor(env: Env, snapshotId: string): Promise<PendingDescriptor | null> {
  const obj = await env.R2_BUCKET.get(pendingDescriptorKey(snapshotId));
  if (!obj) return null;
  try {
    const descriptor = (await obj.json()) as PendingDescriptor;
    return descriptor.snapshot_id === snapshotId ? descriptor : null;
  } catch {
    return null;
  }
}

/** Deterministic descriptor failures never generate poison ingest work or reach publication. */
function descriptorJobError(descriptor: PendingDescriptor): string | null {
  if (!Array.isArray(descriptor.files) || descriptor.files.length === 0) return "Invalid descriptor file set";
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const file of descriptor.files) {
    if (!file || typeof file !== "object") return "Invalid descriptor file entry";
    const checked = validateJob({ schema_version: 1, kind: "ingest_pdf", snapshot_id: descriptor.snapshot_id,
      file_id: file.file_id, filename: file.filename, source_url: file.source_url, r2_key: file.r2_key });
    if (!checked.ok) return `Descriptor cannot produce valid ingest job: ${checked.error}`;
    if (ids.has(file.file_id) || keys.has(file.r2_key)) return "Duplicate descriptor file ID or key";
    ids.add(file.file_id);
    keys.add(file.r2_key);
  }
  return null;
}

function markerFor(
  job: IngestPdfJob,
  meta: { contentType: string | null; size: number | null; etag: string | null; lastModified: string | null },
): CompletionMarker {
  return {
    schema_version: 1,
    snapshot_id: job.snapshot_id,
    file_id: job.file_id,
    filename: job.filename,
    source_url: job.source_url,
    r2_key: job.r2_key,
    content_type: meta.contentType,
    size: meta.size,
    upstream_etag: meta.etag,
    upstream_last_modified: meta.lastModified,
    completed_at: new Date().toISOString(),
  };
}

/**
 * Ingest exactly one PDF into its immutable snapshot object.
 *
 * It parses nothing, hashes nothing, selects no course and never touches `current.json`: it
 * streams one body into one create-only key and records an immutable completion marker.
 * Re-running the same job is safe — an object that already exists with the metadata this job
 * would have written is a success, and one that exists with different provenance is a failure.
 */
export async function runPdfIngest(env: Env, job: IngestPdfJob): Promise<IngestResult> {
  if (snapshotWorkExpired(job.snapshot_id)) {
    return { outcome: "error", snapshot_id: job.snapshot_id, file_id: job.file_id,
      error: "Snapshot publication window expired", retryable: false };
  }
  const descriptor = await readDescriptor(env, job.snapshot_id);
  if (!descriptor) {
    return {
      outcome: "error",
      snapshot_id: job.snapshot_id,
      file_id: job.file_id,
      error: `No pending descriptor for snapshot ${job.snapshot_id}`,
    };
  }

  const descriptorError = descriptorJobError(descriptor);
  if (descriptorError) return { outcome: "error", snapshot_id: job.snapshot_id, file_id: job.file_id,
    error: descriptorError, retryable: false };
  const expected = descriptor.files.find((f) => f.file_id === job.file_id);
  if (
    !expected ||
    expected.filename !== job.filename ||
    expected.source_url !== job.source_url ||
    expected.r2_key !== job.r2_key
  ) {
    return {
      outcome: "error",
      snapshot_id: job.snapshot_id,
      file_id: job.file_id,
      error: `Job does not match the pending descriptor entry for ${job.file_id}`,
    };
  }

  const completionKey = pendingCompletionKey(job.snapshot_id, job.file_id);

  const existing = await env.R2_BUCKET.head(job.r2_key);
  if (existing) {
    if (existing.customMetadata?.source_url !== job.source_url) {
      return {
        outcome: "conflict",
        snapshot_id: job.snapshot_id,
        file_id: job.file_id,
        error: `Unexpected collision: ${job.r2_key} exists with different provenance`,
      };
    }
    await env.R2_BUCKET.put(
      completionKey,
      JSON.stringify(
        markerFor(job, {
          contentType: existing.httpMetadata?.contentType ?? null,
          size: existing.size,
          etag: existing.customMetadata?.upstream_etag ?? null,
          lastModified: existing.customMetadata?.upstream_last_modified ?? null,
        }),
      ),
      { onlyIf: IF_NONE_MATCH_COND, httpMetadata: { contentType: "application/json" } },
    );
    await env.PUBLICATION_QUEUE.send(buildFinalizeJob(job.snapshot_id));
    return {
      outcome: "already_ingested",
      snapshot_id: job.snapshot_id,
      file_id: job.file_id,
      r2_key: job.r2_key,
      size: existing.size,
    };
  }

  let response: Response;
  try {
    response = await fetchOfficialPdf(env, job.source_url);
  } catch (err) {
    return {
      outcome: "error",
      snapshot_id: job.snapshot_id,
      file_id: job.file_id,
      error: (err as Error).message,
      retryable: isRetryableUpstreamFailure(err),
    };
  }

  if (response.status !== 200) {
    return {
      outcome: "error",
      snapshot_id: job.snapshot_id,
      file_id: job.file_id,
      error: `PDF ${job.source_url} returned HTTP ${response.status}`,
      retryable: isRetryableUpstreamStatus(response.status),
    };
  }
  if (!response.body) {
    return {
      outcome: "error",
      snapshot_id: job.snapshot_id,
      file_id: job.file_id,
      error: `PDF ${job.source_url} returned an empty body`,
    };
  }

  const contentType = response.headers.get("Content-Type") || "application/pdf";
  const upstreamEtag = validatorOrNull(response.headers.get("ETag"));
  const upstreamLastModified = validatorOrNull(response.headers.get("Last-Modified"));
  const declaredLength = response.headers.get("Content-Length");
  const declaredSize = contentLengthOrNull(declaredLength);
  if (declaredSize !== null && declaredSize > MAX_PDF_BYTES) {
    return {
      outcome: "error",
      snapshot_id: job.snapshot_id,
      file_id: job.file_id,
      error: `PDF ${job.source_url} declares ${declaredSize} bytes, over the ${MAX_PDF_BYTES} byte limit`,
    };
  }

  const customMetadata: Record<string, string> = {
    snapshot_id: job.snapshot_id,
    file_id: job.file_id,
    source_url: job.source_url,
  };
  if (upstreamEtag) customMetadata.upstream_etag = upstreamEtag;
  if (upstreamLastModified) customMetadata.upstream_last_modified = upstreamLastModified;

  let written: Awaited<ReturnType<Env["R2_BUCKET"]["put"]>>;
  try {
    written = await putLimitedStream(
      response.body as ReadableStream<Uint8Array>,
      MAX_PDF_BYTES,
      declaredSize,
      (body) =>
        env.R2_BUCKET.put(job.r2_key, body, {
          onlyIf: IF_NONE_MATCH_COND,
          httpMetadata: { contentType },
          customMetadata,
        }),
    );
  } catch (err) {
    return {
      outcome: "error",
      snapshot_id: job.snapshot_id,
      file_id: job.file_id,
      error: isPayloadTooLarge(err)
        ? `PDF ${job.source_url} exceeds the ${MAX_PDF_BYTES} byte limit`
        : (err as Error).message,
      retryable: !isPayloadTooLarge(err),
    };
  }

  if (!written) {
    // A concurrent delivery of the same job won the create race; that is still success as long
    // as the object it created is the one this job was asked to produce.
    const raced = await env.R2_BUCKET.head(job.r2_key);
    if (!raced || raced.customMetadata?.source_url !== job.source_url) {
      return {
        outcome: "conflict",
        snapshot_id: job.snapshot_id,
        file_id: job.file_id,
        error: `Unexpected collision: ${job.r2_key} already exists under an immutable snapshot`,
      };
    }
    await env.PUBLICATION_QUEUE.send(buildFinalizeJob(job.snapshot_id));
    return {
      outcome: "already_ingested",
      snapshot_id: job.snapshot_id,
      file_id: job.file_id,
      r2_key: job.r2_key,
      size: raced.size,
    };
  }

  await env.R2_BUCKET.put(
    completionKey,
    JSON.stringify(
      markerFor(job, {
        contentType,
        size: written.size,
        etag: upstreamEtag,
        lastModified: upstreamLastModified,
      }),
    ),
    { onlyIf: IF_NONE_MATCH_COND, httpMetadata: { contentType: "application/json" } },
  );

  await env.PUBLICATION_QUEUE.send(buildFinalizeJob(job.snapshot_id));

  return {
    outcome: "ingested",
    snapshot_id: job.snapshot_id,
    file_id: job.file_id,
    r2_key: job.r2_key,
    size: written.size,
  };
}

/* ------------------------------------------------------------------ *
 * Stage 3: finalize
 * ------------------------------------------------------------------ */

async function currentPointsAt(env: Env, snapshotId: string): Promise<boolean> {
  const obj = await env.R2_BUCKET.get(CURRENT_KEY);
  if (!obj) return false;
  const parsed = parseCurrentPointer(await obj.text());
  return parsed.ok && parsed.pointer.snapshot_id === snapshotId;
}

/**
 * Finalize: prove the snapshot is complete, then publish it.
 *
 * A snapshot may become current only when its page-api payload, every descriptor file, every
 * completion marker and the manifest all exist and agree. Anything less returns `incomplete`,
 * which is a normal state and not an error — the missing ingest jobs are still in flight or will
 * be re-driven by reconciliation.
 */
export async function runFinalize(env: Env, snapshotId: string): Promise<FinalizeResult> {
  if (await currentPointsAt(env, snapshotId)) {
    return { outcome: "already_current", snapshot_id: snapshotId };
  }

  if (snapshotWorkExpired(snapshotId)) {
    return { outcome: "error", snapshot_id: snapshotId, error: "Snapshot publication window expired", retryable: false };
  }

  const descriptor = await readDescriptor(env, snapshotId);
  if (!descriptor) {
    return {
      outcome: "error",
      snapshot_id: snapshotId,
      error: `No pending descriptor for snapshot ${snapshotId}`,
    };
  }

  const descriptorError = descriptorJobError(descriptor);
  if (descriptorError) return { outcome: "error", snapshot_id: snapshotId, error: descriptorError, retryable: false };
  const pageApi = await env.R2_BUCKET.head(snapshotPageApiKey(snapshotId));
  if (!pageApi) {
    return {
      outcome: "error",
      snapshot_id: snapshotId,
      error: `Snapshot ${snapshotId} has no page-api.json`,
    };
  }

  const missing: string[] = [];
  const files: SnapshotFile[] = [];

  const inspected = await Promise.all(
    descriptor.files.map(async (file) => ({
      file,
      object: await env.R2_BUCKET.head(file.r2_key),
      marker: await env.R2_BUCKET.get(pendingCompletionKey(snapshotId, file.file_id)),
    })),
  );

  for (const { file, object, marker } of inspected) {
    if (!object) {
      missing.push(file.r2_key);
      continue;
    }
    if (!marker) {
      missing.push(pendingCompletionKey(snapshotId, file.file_id));
      continue;
    }

    let parsedMarker: CompletionMarker;
    try {
      parsedMarker = (await marker.json()) as CompletionMarker;
    } catch {
      return {
        outcome: "error",
        snapshot_id: snapshotId,
        error: `Completion marker for ${file.file_id} is not valid JSON`,
      };
    }

    if (
      parsedMarker.snapshot_id !== snapshotId ||
      parsedMarker.file_id !== file.file_id ||
      parsedMarker.filename !== file.filename ||
      parsedMarker.source_url !== file.source_url ||
      parsedMarker.r2_key !== file.r2_key
    ) {
      return {
        outcome: "error",
        snapshot_id: snapshotId,
        error: `Completion marker for ${file.file_id} disagrees with the pending descriptor`,
      };
    }

    files.push({
      filename: file.filename,
      source_url: file.source_url,
      r2_key: file.r2_key,
      content_type: parsedMarker.content_type,
      size: object.size,
      upstream_etag: parsedMarker.upstream_etag,
      upstream_last_modified: parsedMarker.upstream_last_modified,
    });
  }

  if (missing.length > 0) {
    return { outcome: "incomplete", snapshot_id: snapshotId, missing };
  }

  const manifest: SnapshotManifest = {
    schema_version: 1,
    snapshot_id: snapshotId,
    previous_snapshot_id: descriptor.previous_snapshot_id,
    created_at: descriptor.created_at,
    source: descriptor.source,
    files,
  };
  const manifestKey = snapshotManifestKey(snapshotId);

  const manifestWritten = await env.R2_BUCKET.put(manifestKey, JSON.stringify(manifest), {
    onlyIf: IF_NONE_MATCH_COND,
    httpMetadata: { contentType: "application/json" },
  });

  if (!manifestWritten) {
    // A concurrent finalize wrote it first. That is fine as long as it describes this snapshot.
    const existing = await env.R2_BUCKET.get(manifestKey);
    let existingSnapshotId: string | null = null;
    if (existing) {
      try {
        existingSnapshotId = ((await existing.json()) as SnapshotManifest).snapshot_id;
      } catch {
        existingSnapshotId = null;
      }
    }
    if (existingSnapshotId !== snapshotId) {
      return {
        outcome: "error",
        snapshot_id: snapshotId,
        error: `Collision: ${manifestKey} already exists and does not describe this snapshot`,
      };
    }
  }

  const publishedAt = new Date().toISOString();
  const pointer = buildCurrentPointer({
    snapshotId,
    publishedAt,
    pageModifiedGmt: descriptor.source.page_modified_gmt,
    pageId: descriptor.source.page_id,
    pdfCount: files.length,
  });

  if (snapshotWorkExpired(snapshotId)) {
    return { outcome: "error", snapshot_id: snapshotId, error: "Snapshot publication window expired", retryable: false };
  }
  const casResult = await env.R2_BUCKET.put(CURRENT_KEY, JSON.stringify(pointer), {
    onlyIf: descriptor.current_etag
      ? { etagMatches: descriptor.current_etag }
      : IF_NONE_MATCH_COND,
    httpMetadata: { contentType: "application/json" },
  });

  if (!casResult) {
    if (await currentPointsAt(env, snapshotId)) {
      return { outcome: "already_current", snapshot_id: snapshotId };
    }
    console.warn(`CAS conflict on current.json; snapshot ${snapshotId} remains harmless history`);
    return { outcome: "superseded", snapshot_id: snapshotId };
  }

  return { outcome: "published", snapshot_id: snapshotId };
}

/* ------------------------------------------------------------------ *
 * Stage 4: reconciliation
 * ------------------------------------------------------------------ */

/**
 * Re-drive recent pending snapshots whose ingest jobs never finished — the safety net for a
 * job that exhausted its queue retries and landed in the dead-letter queue.
 */
export async function runReconcile(env: Env): Promise<ReconcileResult> {
  const bucket = env.R2_BUCKET;
  let current;
  let nextCursor: string | undefined;
  const scanned: string[] = [];
  try {
    current = await bucket.head(CURRENT_KEY);
    nextCursor = await readScanCursor(bucket, "reconcile");
    for (let page = 0; page < RECONCILE_SCAN_PAGES; page++) {
      const listing = await bucket.list({
        prefix: PENDING_PREFIX, delimiter: "/", limit: RECONCILE_PAGE_SIZE, cursor: nextCursor,
      });
      scanned.push(...listing.delimitedPrefixes);
      if (listing.truncated && !listing.cursor) throw new Error("R2 pending listing truncated without cursor");
      nextCursor = listing.truncated ? listing.cursor : undefined;
      if (!listing.truncated) break;
    }
  } catch (err) {
    return {
      outcome: "error", pending_examined: 0, requeued_ingests: 0, requeued_finalizes: 0,
      error: (err as Error).message, retryable: true,
    };
  }

  const now = Date.now();
  const candidates = [...new Set(scanned)]
    .map((prefix) => prefix.slice(PENDING_PREFIX.length).replace(/\/$/, ""))
    .filter((id) => {
      const created = snapshotIdInstant(id);
      if (created === null) return false;
      const age = now - created;
      return age >= PENDING_MIN_AGE_MS && age <= PENDING_MAX_AGE_MS;
    })
    .sort()
    .reverse();

  let requeuedIngests = 0;
  let requeuedFinalizes = 0;

  for (const snapshotId of candidates) {
    if (requeuedFinalizes >= MAX_RECONCILED_SNAPSHOTS) break;
    if (await env.R2_BUCKET.head(snapshotManifestKey(snapshotId))) {
      continue; // already finalized
    }
    const descriptor = await readDescriptor(env, snapshotId);
    if (!descriptor) continue;

    // A descriptor can only win the CAS while current.json still has exactly the ETag it observed
    // at discovery. Once that changes, fetching its missing PDFs would create load for a snapshot
    // that is already provably superseded, so leave it as harmless immutable history.
    if (descriptor.current_etag !== (current?.etag ?? null)) continue;
    const descriptorError = descriptorJobError(descriptor);
    if (descriptorError) {
      console.error(`Snapshot ${snapshotId} deterministically failed: ${descriptorError}`);
      continue;
    }

    const pending: { body: PublicationJob }[] = [];
    for (const file of descriptor.files) {
      const marker = await env.R2_BUCKET.head(pendingCompletionKey(snapshotId, file.file_id));
      if (!marker) {
        pending.push({
          body: buildIngestJob({
            snapshotId,
            fileId: file.file_id,
            filename: file.filename,
            sourceUrl: file.source_url,
          }),
        });
      }
    }

    pending.push({ body: buildFinalizeJob(snapshotId) });
    await env.PUBLICATION_QUEUE.sendBatch(pending);
    requeuedIngests += pending.length - 1;
    requeuedFinalizes += 1;
  }

  // Persist only after repair dispatch succeeds: a crash repeats idempotent repair, never skips it.
  await writeScanCursor(bucket, "reconcile", nextCursor);
  await runRetention(env);

  return {
    outcome: requeuedIngests + requeuedFinalizes > 0 ? "requeued" : "idle",
    pending_examined: candidates.length,
    requeued_ingests: requeuedIngests,
    requeued_finalizes: requeuedFinalizes,
  };
}
