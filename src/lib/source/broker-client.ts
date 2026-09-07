/**
 * Hardened client for the Cloudflare Worker + R2 schedule broker.
 *
 * Provides bounded, typed access to:
 * - Candidate snapshot pointers and manifests
 * - Immutable candidate timetable PDFs
 * - Authoritative accepted schedule states
 * - Stale-safe conditional accepted-state persistence
 */

import { config } from "@/lib/config";
import { errorMessage, getLogger } from "@/lib/logger";
import {
  AcceptedRecordSchema,
  CurrentPointerSchema,
  SnapshotManifestSchema,
  type AcceptedRecord,
  type CurrentPointer,
  type SnapshotManifest,
} from "@/lib/models";
import { assertLooksLikePdf, SourceFetchError, type FetchedResource } from "@/lib/source/downloader";

const log = getLogger("broker-client");

export interface PutAcceptedResult {
  ok: boolean;
  status: number;
  message?: string;
  conflict?: boolean;
}

function resolveUrl(path: string): string {
  if (!config.brokerUrl) {
    throw new Error("SCHEDULE_BROKER_URL is not configured");
  }
  return `${config.brokerUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = config.brokerTimeoutMs,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new SourceFetchError(`Broker request timed out after ${timeoutMs}ms: ${url}`, "network");
    }
    throw new SourceFetchError(`Broker network error for ${url}: ${errorMessage(error)}`, "network");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch latest candidate snapshot pointer from the broker.
 */
export async function fetchCurrentPointer(options: { timeoutMs?: number } = {}): Promise<CurrentPointer | null> {
  if (!config.brokerUrl) return null;
  const url = resolveUrl("/current");

  try {
    const response = await fetchWithTimeout(url, { method: "GET" }, options.timeoutMs);
    if (response.status === 404) return null;
    if (!response.ok) {
      log.warn("broker GET /current returned non-ok status", { status: response.status });
      return null;
    }

    const payload = await response.json();
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
  const url = resolveUrl(`/snapshots/${encodeURIComponent(snapshotId)}/manifest.json`);

  try {
    const response = await fetchWithTimeout(url, { method: "GET" }, options.timeoutMs);
    if (response.status === 404) return null;
    if (!response.ok) {
      log.warn("broker GET manifest returned non-ok status", { snapshotId, status: response.status });
      return null;
    }

    const payload = await response.json();
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

  const url = resolveUrl(`/snapshots/${encodeURIComponent(snapshotId)}/pdfs/${encodeURIComponent(filename)}`);
  const headers: Record<string, string> = {
    Accept: "application/pdf,*/*;q=0.8",
  };
  if (options.etag) headers["If-None-Match"] = options.etag;
  if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;

  const response = await fetchWithTimeout(
    url,
    { method: "GET", headers },
    options.timeoutMs ?? config.httpTimeoutMs,
  );

  const notModified = response.status === 304;
  const status = response.status;
  const responseEtag = response.headers.get("ETag");
  const responseLastModified = response.headers.get("Last-Modified");
  const contentType = response.headers.get("Content-Type");

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

  if (!response.ok) {
    throw new SourceFetchError(`Failed to fetch candidate PDF from broker: HTTP ${status}`, "http", status);
  }

  // Bounded buffer reading
  const contentLength = response.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > config.maxPdfBytes) {
    throw new SourceFetchError(`Candidate PDF exceeds ${config.maxPdfBytes} bytes`, "too_large");
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > config.maxPdfBytes) {
    throw new SourceFetchError(`Candidate PDF exceeds ${config.maxPdfBytes} bytes`, "too_large");
  }

  const bytes = new Uint8Array(arrayBuffer);
  const resource: FetchedResource = {
    url,
    finalUrl: url,
    status,
    bytes,
    contentType,
    etag: responseEtag,
    lastModified: responseLastModified,
    notModified: false,
  };

  assertLooksLikePdf(resource);
  return resource;
}

/**
 * Fetch durable accepted schedule from the broker.
 */
export async function fetchAcceptedSchedule(
  courseYear: number,
  options: { timeoutMs?: number } = {},
): Promise<AcceptedRecord | null> {
  if (!config.brokerUrl) return null;
  const url = resolveUrl(`/accepted/course-${courseYear}`);

  try {
    const response = await fetchWithTimeout(url, { method: "GET" }, options.timeoutMs);
    if (response.status === 404) return null;
    if (!response.ok) {
      log.warn("broker GET /accepted/course returned non-ok status", { courseYear, status: response.status });
      return null;
    }

    const payload = await response.json();
    const parsed = AcceptedRecordSchema.safeParse(payload);
    if (!parsed.success) {
      log.warn("broker returned schema-invalid accepted record", { courseYear, errors: parsed.error.format() });
      return null;
    }

    const record = parsed.data;
    if (record.course_year !== courseYear || record.schedule.metadata.course_year !== courseYear) {
      log.error("broker accepted record course_year mismatch", {
        requestedCourse: courseYear,
        recordCourse: record.course_year,
        metadataCourse: record.schedule.metadata.course_year,
      });
      return null;
    }

    return record;
  } catch (error) {
    log.warn("failed to fetch accepted schedule from broker", { courseYear, error: errorMessage(error) });
    return null;
  }
}

/**
 * Persist durable accepted schedule to the broker with conditional CAS.
 */
export async function putAcceptedSchedule(
  courseYear: number,
  expectedPreviousHash: string | null,
  state: AcceptedRecord,
  options: { timeoutMs?: number } = {},
): Promise<PutAcceptedResult> {
  if (!config.brokerUrl) {
    return { ok: false, status: 500, message: "SCHEDULE_BROKER_URL not configured" };
  }

  const url = resolveUrl(`/accepted/course-${courseYear}`);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.brokerSecret) {
    headers.Authorization = `Bearer ${config.brokerSecret}`;
  }

  const payload = {
    expected_previous_hash: expectedPreviousHash,
    state,
  };

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "PUT",
        headers,
        body: JSON.stringify(payload),
      },
      options.timeoutMs ?? config.httpTimeoutMs,
    );

    if (response.status === 409) {
      const body = await response.text();
      log.warn("CAS conflict persisting accepted state to broker", { courseYear, body });
      return { ok: false, status: 409, conflict: true, message: body };
    }

    if (!response.ok) {
      const body = await response.text();
      log.error("failed to persist accepted state to broker", { courseYear, status: response.status, body });
      return { ok: false, status: response.status, message: body };
    }

    return { ok: true, status: response.status };
  } catch (error) {
    const message = errorMessage(error);
    log.error("exception persisting accepted state to broker", { courseYear, error: message });
    return { ok: false, status: 500, message };
  }
}
