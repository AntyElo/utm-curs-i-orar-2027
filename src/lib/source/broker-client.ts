/**
 * Hardened client for the Cloudflare Worker + R2 schedule broker.
 *
 * Provides bounded, typed access to:
 * - Candidate snapshot pointers and manifests
 * - Snapshot WordPress Page API payload
 * - Immutable candidate timetable PDFs
 * - Authoritative accepted schedule states (split streamed payload + CAS pointer)
 * - Strict URL origin checking and path token sanitization
 * - Active timeout covering headers + stream consumption
 */

import { config } from "@/lib/config";
import { errorMessage, getLogger } from "@/lib/logger";
import {
  AcceptedPointerSchema,
  AcceptedRecordSchema,
  CurrentPointerSchema,
  ScheduleSchema,
  SnapshotManifestSchema,
  type AcceptedPointer,
  type AcceptedRecord,
  type CurrentPointer,
  type SnapshotManifest,
} from "@/lib/models";
import { sha256 } from "@/lib/parser";
import { assertLooksLikePdf, SourceFetchError, type FetchedResource } from "@/lib/source/downloader";

const log = getLogger("broker-client");

export interface PutAcceptedResult {
  ok: boolean;
  status: number;
  message?: string;
  conflict?: boolean;
}

const TRAVERSAL_PATTERN = /(?:%25|%2e|%2f|%5c|\.\.|\\)/i;
const SAFE_TOKEN_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * A caller that is itself working against a wall-clock deadline passes it down here, so a
 * multi-request operation spends the budget it was given rather than `timeoutMs` per request.
 */
export interface BrokerDeadlineOptions {
  timeoutMs?: number;
  /** Absolute epoch-ms deadline shared by every step of the calling operation. */
  deadlineAt?: number;
  /** Aborts every in-flight request the moment that deadline passes. */
  signal?: AbortSignal;
}

/** Milliseconds still available: the smaller of the per-request timeout and the shared deadline. */
export function remainingBudgetMs(options: BrokerDeadlineOptions): number {
  const perRequest = options.timeoutMs ?? config.brokerTimeoutMs;
  if (options.deadlineAt === undefined) return perRequest;
  return Math.min(perRequest, options.deadlineAt - Date.now());
}

/**
 * Validate that a URL path token (snapshot ID, accepted ID, etc.) contains no traversal or forbidden characters.
 */
export function validatePathToken(token: string, name = "token"): string {
  if (!token || typeof token !== "string") {
    throw new Error(`Invalid ${name}: empty`);
  }
  if (TRAVERSAL_PATTERN.test(token) || !SAFE_TOKEN_PATTERN.test(token)) {
    throw new Error(`Invalid ${name} contains forbidden characters: ${token}`);
  }
  return token;
}

/**
 * Validate that a filename is a clean basename ending in .pdf.
 */
export function validatePdfFilename(filename: string): string {
  validatePathToken(filename, "filename");
  if (!filename.toLowerCase().endsWith(".pdf")) {
    throw new Error(`Invalid PDF filename does not end in .pdf: ${filename}`);
  }
  return filename;
}

/**
 * Every broker URL is exactly `https://HOST`, optionally with one trailing slash.
 * `new URL()` will not tell you that: it happily reports `https://host/a/../` as pathname `/`,
 * which is why the raw configured string is inspected first.
 */
const BROKER_ORIGIN_PATTERN =
  /^https:\/\/[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\/?$/;

/**
 * Parse and validate SCHEDULE_BROKER_URL as a single fixed HTTPS origin without credentials,
 * port, path, query or fragment.
 *
 * Validation happens on the raw configured value *before* URL normalisation. `new URL()`
 * resolves `https://broker.example/..` to pathname `/`, so a check that ran after parsing would
 * accept a value whose text says something else entirely; percent-encoded and doubly-encoded
 * traversal is rejected here for the same reason.
 */
export function parseAndValidateBrokerUrl(rawUrl: string): URL {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new Error("SCHEDULE_BROKER_URL is not configured");
  }

  // --- Raw-text rules, all applied before the string is ever normalised. ---
  if (TRAVERSAL_PATTERN.test(rawUrl)) {
    throw new Error(`SCHEDULE_BROKER_URL must not contain path traversal: ${rawUrl}`);
  }
  if (!rawUrl.startsWith("https://")) {
    const scheme = rawUrl.slice(0, Math.max(rawUrl.indexOf(":") + 1, 1));
    throw new Error(`SCHEDULE_BROKER_URL must use https: protocol, got ${scheme || rawUrl}`);
  }
  const authorityAndRest = rawUrl.slice("https://".length);
  if (authorityAndRest.includes("@")) {
    throw new Error("SCHEDULE_BROKER_URL must not contain credentials");
  }
  if (authorityAndRest.includes("?") || authorityAndRest.includes("#")) {
    throw new Error("SCHEDULE_BROKER_URL must not contain query parameters or fragments");
  }
  if (authorityAndRest.includes(":")) {
    throw new Error("SCHEDULE_BROKER_URL must not specify a port");
  }
  if (!BROKER_ORIGIN_PATTERN.test(rawUrl)) {
    throw new Error("SCHEDULE_BROKER_URL must be origin only");
  }

  // --- Same rules again on the parsed URL, so neither layer can be the only one. ---
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid SCHEDULE_BROKER_URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`SCHEDULE_BROKER_URL must use https: protocol, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("SCHEDULE_BROKER_URL must not contain credentials");
  }
  if (url.port) {
    throw new Error("SCHEDULE_BROKER_URL must not specify a port");
  }
  if (url.hash || url.search) {
    throw new Error("SCHEDULE_BROKER_URL must not contain query parameters or fragments");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("SCHEDULE_BROKER_URL must be origin only");
  }
  return url;
}

function resolveUrl(path: string): string {
  if (!config.brokerUrl) {
    throw new Error("SCHEDULE_BROKER_URL is not configured");
  }
  const base = parseAndValidateBrokerUrl(config.brokerUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base.origin}${normalizedPath}`;
}

/**
 * Bounded stream reader that consumes a ReadableStream up to maxBytes under an active deadline.
 */
export async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!stream) {
    return new Uint8Array(0);
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      if (signal?.aborted) {
        const err = new Error("Stream read aborted by timeout");
        err.name = "AbortError";
        throw err;
      }

      let done = false;
      let value: Uint8Array | undefined;

      if (signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          const onAbort = () => {
            const err = new Error("Stream read aborted by timeout");
            err.name = "AbortError";
            reject(err);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
        const res = await Promise.race([reader.read(), abortPromise]);
        done = res.done;
        value = res.value;
      } else {
        const res = await reader.read();
        done = res.done;
        value = res.value;
      }

      if (done) break;

      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          throw new SourceFetchError(`Response body exceeded limit of ${maxBytes} bytes`, "too_large");
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader might be closed
    }
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Hardened HTTP fetch where one deadline covers connect, headers, AND full body consumption.
 * Redirects are blocked (redirect: "error").
 *
 * An outer `signal` — the caller's own wall-clock deadline — aborts this request too, so a
 * per-request timeout can never outlive the budget the caller was given.
 */
export async function fetchBrokerBounded(
  url: string,
  init: RequestInit = {},
  maxBytes: number,
  timeoutMs: number = config.brokerTimeoutMs,
  outerSignal?: AbortSignal,
): Promise<{ status: number; headers: Headers; bytes: Uint8Array }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromOuter = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener("abort", abortFromOuter, { once: true });
  }

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "error",
    });

    const bytes = await readStreamWithLimit(
      response.body as ReadableStream<Uint8Array> | null,
      maxBytes,
      controller.signal,
    );

    return {
      status: response.status,
      headers: response.headers,
      bytes,
    };
  } catch (error) {
    if ((error as Error).name === "AbortError" || controller.signal.aborted) {
      throw new SourceFetchError(`Broker request timed out after ${timeoutMs}ms: ${url}`, "network");
    }
    if (error instanceof SourceFetchError) {
      throw error;
    }
    throw new SourceFetchError(`Broker network error for ${url}: ${errorMessage(error)}`, "network");
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", abortFromOuter);
  }
}

/**
 * Fetch latest candidate snapshot pointer from the broker.
 */
export async function fetchCurrentPointer(options: { timeoutMs?: number } = {}): Promise<CurrentPointer | null> {
  if (!config.brokerUrl) return null;
  const url = resolveUrl("/current");

  try {
    const res = await fetchBrokerBounded(
      url,
      { method: "GET", headers: { Accept: "application/json" } },
      64 * 1024,
      options.timeoutMs ?? config.brokerTimeoutMs,
    );
    if (res.status === 404) return null;
    if (res.status !== 200) {
      log.warn("broker GET /current returned non-ok status", { status: res.status });
      return null;
    }

    const text = new TextDecoder().decode(res.bytes);
    const payload = JSON.parse(text);
    const parsed = CurrentPointerSchema.safeParse(payload);
    if (!parsed.success) {
      log.warn("broker GET /current returned schema-invalid pointer", { errors: parsed.error.format() });
      return null;
    }
    return parsed.data;
  } catch (error) {
    log.warn("failed to fetch current pointer from broker", { error: errorMessage(error) });
    return null;
  }
}

/**
 * Fetch immutable snapshot manifest from the broker.
 */
export async function fetchSnapshotManifest(
  snapshotId: string,
  options: { timeoutMs?: number } = {},
): Promise<SnapshotManifest | null> {
  if (!config.brokerUrl) return null;
  validatePathToken(snapshotId, "snapshot_id");
  const url = resolveUrl(`/snapshots/${snapshotId}/manifest.json`);

  try {
    const res = await fetchBrokerBounded(
      url,
      { method: "GET", headers: { Accept: "application/json" } },
      1024 * 1024,
      options.timeoutMs ?? config.brokerTimeoutMs,
    );
    if (res.status === 404) return null;
    if (res.status !== 200) {
      log.warn("broker GET manifest returned non-ok status", { snapshotId, status: res.status });
      return null;
    }

    const text = new TextDecoder().decode(res.bytes);
    const payload = JSON.parse(text);
    const parsed = SnapshotManifestSchema.safeParse(payload);
    if (!parsed.success) {
      log.warn("broker returned schema-invalid snapshot manifest", { snapshotId, errors: parsed.error.format() });
      return null;
    }
    return parsed.data;
  } catch (error) {
    log.warn("failed to fetch snapshot manifest from broker", { snapshotId, error: errorMessage(error) });
    return null;
  }
}

/**
 * Fetch immutable snapshot page-api.json from the broker.
 */
export async function fetchSnapshotPageApi(
  snapshotId: string,
  options: { timeoutMs?: number } = {},
): Promise<unknown | null> {
  if (!config.brokerUrl) return null;
  validatePathToken(snapshotId, "snapshot_id");
  const url = resolveUrl(`/snapshots/${snapshotId}/page-api.json`);

  try {
    const res = await fetchBrokerBounded(
      url,
      { method: "GET", headers: { Accept: "application/json" } },
      5 * 1024 * 1024,
      options.timeoutMs ?? config.brokerTimeoutMs,
    );
    if (res.status === 404) return null;
    if (res.status !== 200) {
      log.warn("broker GET page-api.json returned non-ok status", { snapshotId, status: res.status });
      return null;
    }

    const text = new TextDecoder().decode(res.bytes);
    return JSON.parse(text);
  } catch (error) {
    log.warn("failed to fetch page-api.json from broker", { snapshotId, error: errorMessage(error) });
    return null;
  }
}

/**
 * Fetch candidate timetable PDF from the broker with bounded reading and %PDF- verification.
 */
export async function fetchCandidatePdf(
  snapshotId: string,
  filename: string,
  options: {
    timeoutMs?: number;
    etag?: string | null;
    lastModified?: string | null;
  } = {},
): Promise<FetchedResource> {
  if (!config.brokerUrl) {
    throw new Error("SCHEDULE_BROKER_URL is not configured");
  }
  validatePathToken(snapshotId, "snapshot_id");
  validatePdfFilename(filename);

  const url = resolveUrl(`/snapshots/${snapshotId}/pdfs/${filename}`);
  const headers: Record<string, string> = {
    Accept: "application/pdf,*/*;q=0.8",
  };
  if (options.etag) headers["If-None-Match"] = options.etag;
  if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;

  const res = await fetchBrokerBounded(
    url,
    { method: "GET", headers },
    config.maxPdfBytes,
    options.timeoutMs ?? config.httpTimeoutMs,
  );

  const notModified = res.status === 304;
  const status = res.status;
  const responseEtag = res.headers.get("ETag");
  const responseLastModified = res.headers.get("Last-Modified");
  const contentType = res.headers.get("Content-Type");

  if (notModified) {
    return {
      url,
      finalUrl: url,
      status,
      bytes: new Uint8Array(0),
      contentType,
      etag: responseEtag,
      lastModified: responseLastModified,
      notModified: true,
    };
  }

  if (status !== 200) {
    throw new SourceFetchError(`Failed to fetch candidate PDF from broker: HTTP ${status}`, "http", status);
  }

  const resource: FetchedResource = {
    url,
    finalUrl: url,
    status,
    bytes: res.bytes,
    contentType,
    etag: responseEtag,
    lastModified: responseLastModified,
    notModified: false,
  };

  assertLooksLikePdf(resource);
  return resource;
}

/**
 * Generate a deterministic accepted identity token for a validated schedule.
 */
export function generateAcceptedId(
  sourcePdfHash: string,
  parserVersion: string,
  payloadSha256: string,
): string {
  const safeParser = parserVersion.replace(/[^a-zA-Z0-9]/g, "_");
  return `${sourcePdfHash.slice(0, 16)}-p${safeParser}-${payloadSha256.slice(0, 16)}`;
}

/**
 * Fetch accepted pointer for a course from the broker.
 */
export async function fetchAcceptedPointer(
  courseYear: number,
  options: BrokerDeadlineOptions = {},
): Promise<AcceptedPointer | null> {
  if (!config.brokerUrl) return null;
  const pointerUrl = resolveUrl(`/accepted/course-${courseYear}`);
  const budget = () => remainingBudgetMs(options);

  try {
    if (budget() <= 0) {
      log.warn("broker accepted-state fetch skipped: no time left in the caller's deadline", { courseYear });
      return null;
    }

    const pointerRes = await fetchBrokerBounded(
      pointerUrl,
      { method: "GET", headers: { Accept: "application/json" } },
      64 * 1024,
      budget(),
      options.signal,
    );

    if (pointerRes.status === 404) return null;
    if (pointerRes.status !== 200) {
      log.warn("broker GET /accepted/course returned non-ok status", { courseYear, status: pointerRes.status });
      return null;
    }

    const pointerText = new TextDecoder().decode(pointerRes.bytes);
    const pointerPayload = JSON.parse(pointerText);
    const parsedPointer = AcceptedPointerSchema.safeParse(pointerPayload);
    if (!parsedPointer.success) {
      log.warn("broker returned schema-invalid accepted pointer", { courseYear, errors: parsedPointer.error.format() });
      return null;
    }

    const pointer = parsedPointer.data;
    if (pointer.course_year !== courseYear) {
      log.error("broker accepted pointer course_year mismatch", {
        requestedCourse: courseYear,
        pointerCourse: pointer.course_year,
      });
      return null;
    }

    return pointer;
  } catch (error) {
    log.warn("failed to fetch accepted pointer from broker", { courseYear, error: errorMessage(error) });
    return null;
  }
}

/**
 * Fetch durable accepted schedule from the broker via split architecture:
 * 1. GET small pointer from /accepted/course-:courseYear
 * 2. GET immutable payload from /accepted-payloads/course-:courseYear/:acceptedId
 * 3. Verify payload SHA-256 and metadata consistency
 */
export async function fetchAcceptedSchedule(
  courseYear: number,
  options: BrokerDeadlineOptions = {},
): Promise<AcceptedRecord | null> {
  if (!config.brokerUrl) return null;

  const pointer = await fetchAcceptedPointer(courseYear, options);
  if (!pointer) return null;

  /** Each request gets what is left of the caller's budget, not a fresh copy of it. */
  const budget = () => remainingBudgetMs(options);

  try {
    // 2. Fetch immutable payload
    validatePathToken(pointer.accepted_id, "accepted_id");
    if (budget() <= 0) {
      log.warn("broker accepted-payload fetch abandoned: caller's deadline elapsed", { courseYear });
      return null;
    }
    const payloadUrl = resolveUrl(`/accepted-payloads/course-${courseYear}/${pointer.accepted_id}`);
    const payloadRes = await fetchBrokerBounded(
      payloadUrl,
      { method: "GET", headers: { Accept: "application/json" } },
      5 * 1024 * 1024,
      budget(),
      options.signal,
    );

    if (payloadRes.status !== 200) {
      log.error("broker GET accepted payload returned non-200 status", {
        courseYear,
        acceptedId: pointer.accepted_id,
        status: payloadRes.status,
      });
      return null;
    }

    if (budget() <= 0) {
      log.warn("broker accepted-payload validation abandoned: caller's deadline elapsed", { courseYear });
      return null;
    }

    // 3. Verify payload SHA-256
    const computedPayloadHash = sha256(payloadRes.bytes);
    if (computedPayloadHash.toLowerCase() !== pointer.payload_sha256.toLowerCase()) {
      log.error("broker accepted payload SHA-256 mismatch with pointer", {
        courseYear,
        expected: pointer.payload_sha256,
        actual: computedPayloadHash,
      });
      return null;
    }

    // 4. Parse Schedule
    const scheduleText = new TextDecoder().decode(payloadRes.bytes);
    const scheduleJson = JSON.parse(scheduleText);
    const parsedSchedule = ScheduleSchema.safeParse(scheduleJson);
    if (!parsedSchedule.success) {
      log.error("broker accepted payload failed ScheduleSchema validation", {
        courseYear,
        errors: parsedSchedule.error.format(),
      });
      return null;
    }

    const schedule = parsedSchedule.data;

    // 5. Course guard
    if (schedule.metadata.course_year !== courseYear) {
      log.error("broker accepted schedule metadata course_year mismatch", {
        requestedCourse: courseYear,
        scheduleCourse: schedule.metadata.course_year,
      });
      return null;
    }

    // 6. Cross-check schedule metadata against pointer
    if (
      schedule.metadata.source_pdf_hash !== pointer.source_pdf_hash ||
      schedule.metadata.source_pdf_url !== pointer.source_pdf_url ||
      schedule.metadata.parser_version !== pointer.parser_version ||
      schedule.metadata.source_snapshot_id !== pointer.source_snapshot_id
    ) {
      log.error("broker accepted schedule metadata mismatch with pointer fields", {
        courseYear,
        pointerHash: pointer.source_pdf_hash,
        scheduleHash: schedule.metadata.source_pdf_hash,
      });
      return null;
    }

    return {
      schema_version: 1,
      course_year: courseYear,
      accepted_id: pointer.accepted_id,
      snapshot_id: pointer.source_snapshot_id,
      source_pdf_url: pointer.source_pdf_url,
      source_pdf_hash: pointer.source_pdf_hash,
      parser_version: pointer.parser_version,
      payload_sha256: pointer.payload_sha256,
      accepted_at: pointer.accepted_at,
      schedule,
    };
  } catch (error) {
    log.warn("failed to fetch accepted schedule from broker", { courseYear, error: errorMessage(error) });
    return null;
  }
}

/**
 * Persist durable accepted schedule to the broker via split architecture:
 * 1. Stream immutable payload to /accepted-payloads/course-:year/:acceptedId
 * 2. Perform conditional CAS on pointer /accepted/course-:year
 */
export async function putAcceptedSchedule(
  courseYear: number,
  expectedPreviousAcceptedId: string | null,
  record: {
    schedule: import("@/lib/models").Schedule;
    snapshot_id: string;
    source_pdf_url: string;
    source_pdf_hash: string;
    accepted_at?: string;
    accepted_id?: string;
  },
  options: { timeoutMs?: number } = {},
): Promise<PutAcceptedResult> {
  if (!config.brokerUrl) {
    return { ok: false, status: 500, message: "SCHEDULE_BROKER_URL not configured" };
  }

  const parserVersion = record.schedule.metadata.parser_version || config.parserVersion;
  const payloadBytes = new TextEncoder().encode(JSON.stringify(record.schedule));
  const payloadSha256 = sha256(payloadBytes);
  const acceptedId =
    record.accepted_id ??
    generateAcceptedId(record.source_pdf_hash, parserVersion, payloadSha256);
  validatePathToken(acceptedId, "accepted_id");
  // One instant for both the payload metadata and the pointer: the broker cross-checks them,
  // and two `new Date()` calls would occasionally disagree by a millisecond.
  const acceptedAt = record.accepted_at ?? new Date().toISOString();

  // Step 1: Upload immutable payload
  const payloadUrl = resolveUrl(`/accepted-payloads/course-${courseYear}/${acceptedId}`);
  const payloadHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(payloadBytes.byteLength),
    "x-course-year": String(courseYear),
    "x-source-pdf-hash": record.source_pdf_hash,
    "x-source-pdf-url": record.source_pdf_url,
    "x-payload-sha256": payloadSha256,
    "x-snapshot-id": record.snapshot_id,
    "x-parser-version": parserVersion,
    "x-accepted-at": acceptedAt,
  };
  if (config.brokerSecret) {
    payloadHeaders.Authorization = `Bearer ${config.brokerSecret}`;
  }

  try {
    const payloadRes = await fetchBrokerBounded(
      payloadUrl,
      {
        method: "PUT",
        headers: payloadHeaders,
        body: payloadBytes,
      },
      64 * 1024,
      options.timeoutMs ?? config.httpTimeoutMs,
    );

    if (payloadRes.status !== 200) {
      const body = new TextDecoder().decode(payloadRes.bytes);
      log.error("failed to upload accepted payload to broker", { courseYear, status: payloadRes.status, body });
      return { ok: false, status: payloadRes.status, message: body };
    }
  } catch (error) {
    const message = errorMessage(error);
    log.error("exception uploading accepted payload to broker", { courseYear, error: message });
    return { ok: false, status: 500, message };
  }

  // Step 2: Write small CAS pointer
  const pointerUrl = resolveUrl(`/accepted/course-${courseYear}`);
  const pointerHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.brokerSecret) {
    pointerHeaders.Authorization = `Bearer ${config.brokerSecret}`;
  }

  const pointer: AcceptedPointer = {
    schema_version: 1,
    course_year: courseYear,
    accepted_id: acceptedId,
    payload_key: `accepted-payloads/course-${courseYear}/${acceptedId}.json`,
    payload_sha256: payloadSha256,
    source_snapshot_id: record.snapshot_id,
    source_pdf_url: record.source_pdf_url,
    source_pdf_hash: record.source_pdf_hash,
    parser_version: parserVersion,
    accepted_at: acceptedAt,
  };

  const pointerBody = JSON.stringify({
    expected_previous_accepted_id: expectedPreviousAcceptedId,
    pointer,
  });

  try {
    const pointerRes = await fetchBrokerBounded(
      pointerUrl,
      {
        method: "PUT",
        headers: pointerHeaders,
        body: pointerBody,
      },
      64 * 1024,
      options.timeoutMs ?? config.httpTimeoutMs,
    );

    if (pointerRes.status === 409) {
      const body = new TextDecoder().decode(pointerRes.bytes);
      log.warn("CAS conflict persisting accepted pointer to broker", { courseYear, body });
      return { ok: false, status: 409, conflict: true, message: body };
    }

    if (pointerRes.status !== 200) {
      const body = new TextDecoder().decode(pointerRes.bytes);
      log.error("failed to persist accepted pointer to broker", { courseYear, status: pointerRes.status, body });
      return { ok: false, status: pointerRes.status, message: body };
    }

    return { ok: true, status: pointerRes.status };
  } catch (error) {
    const message = errorMessage(error);
    log.error("exception persisting accepted pointer to broker", { courseYear, error: message });
    return { ok: false, status: 500, message };
  }
}

