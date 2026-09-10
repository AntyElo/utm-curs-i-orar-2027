/**
 * Candidate-snapshot publication.
 *
 * Gate F moved acquisition out of the broker entirely. The Moldova laptop (the "MD Publisher")
 * is the only thing that talks to FCIM; it hands the broker raw Page API bytes and raw PDF bytes
 * over an authenticated transport credential, and nothing else. The broker still decides
 * everything that matters:
 *
 *   PUBLISHER BYTES -> OPEN (broker derives the plan) -> UPLOADS -> COMPLETE -> current.json CAS
 *
 * The publisher cannot choose a snapshot id, an R2 key, a filename, a PDF source URL, the
 * manifest, or the current pointer. It supplies bytes and an attempt identity; the broker
 * re-derives the catalogue from those bytes with the same code the old discovery stage used.
 *
 * The ordering guarantees are unchanged from the queue-driven publisher and are what make a
 * half-built snapshot harmless: every child object is created with `If-None-Match: *`, the
 * manifest is written only once every expected PDF is proven present, and `current.json` is
 * compare-and-swapped last against the ETag the publication observed when it opened. A
 * publication that never finishes simply stays out of `current.json` forever.
 *
 * The broker stays a transport. It mirrors every strictly-valid official timetable PDF the
 * authoritative page references and never tries to read a course year, semester or revision out
 * of a filename — `discoverPdf()` on Render remains the only thing that decides what a timetable
 * means.
 */

import { extractOfficialPdfUrls, getPdfFilename } from "./extractor";
import { buildFinalizeJob, fileIdForIndex, qualifiedPdfFilename, validatePendingFile } from "./jobs";
import { isOfficialTimetablePdfUrl } from "../../worker-shared/fcim-policy";
import {
  PENDING_MAX_AGE_MS, RECONCILE_PAGE_SIZE, RECONCILE_SCAN_PAGES,
  readScanCursor, writeScanCursor, runRetention, snapshotIdInstant, snapshotWorkExpired,
} from "./maintenance";
import {
  CURRENT_KEY,
  PENDING_PREFIX,
  operationKey,
  pendingCompletionKey,
  pendingDescriptorKey,
  snapshotManifestKey,
  snapshotPageApiKey,
  snapshotPdfKey,
} from "./keys";
import { readPageApiDocument, resolvePageApiUrl } from "./page-api";
import {
  buildCurrentPointer,
  normalizePageModifiedGmt,
  parseCurrentPointer,
  WP_GMT_REGEX,
} from "./pointer";
import type {
  CompletionMarker,
  Env,
  FinalizeResult,
  OpenPublicationResult,
  OperationRecord,
  PendingDescriptor,
  PendingFile,
  ParsedCurrentPointer,
  PublicationPlan,
  PublicationPlanFile,
  PublicationJob,
  ReconcileResult,
  SnapshotFile,
  SnapshotManifest,
} from "./types";

const IF_NONE_MATCH_COND = { etagDoesNotMatch: "*" };

/** How many unfinished snapshots one reconcile invocation will re-drive. */
const MAX_RECONCILED_SNAPSHOTS = 3;

/** Leave a freshly opened publication alone; its own uploads are still in flight. */
const PENDING_MIN_AGE_MS = 5 * 60 * 1000;

/** Default DF-03 tolerance for a Page API timestamp that leads broker time. */
export const DEFAULT_MAX_PAGE_FUTURE_SKEW_HOURS = 26;

/** How many publications may be open at once before the broker refuses to open another. */
export const MAX_OPEN_PUBLICATIONS = 8;

/** Bounded prefix scan used by the open-publication cap. */
const OPEN_SCAN_PREFIX_LIMIT = 32;

export const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;

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
 * Planning
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
    const fileId = fileIdForIndex(index);
    const entry: PendingFile = {
      file_id: fileId,
      filename,
      source_url: sourceUrl,
      r2_key: snapshotPdfKey(snapshotId, filename),
    };
    const checked = validatePendingFile({ snapshot_id: snapshotId, ...entry });
    if (!checked.ok) throw new Error(`Invalid planned file: ${checked.error}`);
    taken.add(filename);
    return entry;
  });
}

/* ------------------------------------------------------------------ *
 * DF-03: temporal guards
 * ------------------------------------------------------------------ */

/** Parse a WordPress naive-GMT stamp, rejecting impossible calendar dates. */
export function wpGmtInstant(value: string | null): number | null {
  if (typeof value !== "string" || !WP_GMT_REGEX.test(value)) return null;
  const ms = Date.parse(`${value}Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString() === `${value}.000Z` ? ms : null;
}

export type TemporalVerdict =
  | { ok: true }
  | { ok: false; status: 400 | 409; code: "stale_page" | "future_page"; error: string };

/**
 * Decide whether an incoming Page API timestamp may open a publication.
 *
 * Equal timestamps stay valid on purpose: FCIM replaces a PDF in place under an unchanged URL
 * without touching the page, and refusing an equal stamp would make that change unpublishable.
 * There is no bypass — no force flag, no header, no operator override on this path.
 */
export function evaluatePageTimestamp(
  incoming: string | null,
  baseline: string | null,
  now: number,
  maxFutureSkewMs: number,
): TemporalVerdict {
  const incomingMs = wpGmtInstant(incoming);

  if (incomingMs !== null && incomingMs > now + maxFutureSkewMs) {
    return {
      ok: false,
      status: 400,
      code: "future_page",
      error: "Page API modified_gmt leads broker time by more than the permitted skew",
    };
  }

  const baselineMs = wpGmtInstant(baseline);
  if (baselineMs === null) {
    // No usable baseline: nothing can be proven stale against it.
    return { ok: true };
  }

  if (incomingMs === null) {
    return {
      ok: false,
      status: 409,
      code: "stale_page",
      error: "Page API payload has no usable modified_gmt but the current snapshot does",
    };
  }

  if (incomingMs < baselineMs) {
    return {
      ok: false,
      status: 409,
      code: "stale_page",
      error: "Page API modified_gmt is older than the current snapshot's",
    };
  }

  return { ok: true };
}

export function maxPageFutureSkewMs(env: Env): number {
  const raw = env.MAX_PAGE_FUTURE_SKEW_HOURS;
  if (typeof raw === "string" && /^(?:0|[1-9]\d{0,3})$/.test(raw)) {
    return Number(raw) * 60 * 60 * 1000;
  }
  return DEFAULT_MAX_PAGE_FUTURE_SKEW_HOURS * 60 * 60 * 1000;
}

/* ------------------------------------------------------------------ *
 * Descriptors
 * ------------------------------------------------------------------ */

export async function readDescriptor(env: Env, snapshotId: string): Promise<PendingDescriptor | null> {
  const obj = await env.R2_BUCKET.get(pendingDescriptorKey(snapshotId));
  if (!obj) return null;
  try {
    const descriptor = (await obj.json()) as PendingDescriptor;
    return descriptor.snapshot_id === snapshotId ? descriptor : null;
  } catch {
    return null;
  }
}

/** Deterministic descriptor failures never generate poison work or reach publication. */
export function descriptorFileError(descriptor: PendingDescriptor): string | null {
  if (!Array.isArray(descriptor.files) || descriptor.files.length === 0) return "Invalid descriptor file set";
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const file of descriptor.files) {
    if (!file || typeof file !== "object") return "Invalid descriptor file entry";
    const checked = validatePendingFile({ snapshot_id: descriptor.snapshot_id, ...file });
    if (!checked.ok) return `Descriptor holds an invalid file entry: ${checked.error}`;
    if (ids.has(file.file_id) || keys.has(file.r2_key)) return "Duplicate descriptor file ID or key";
    ids.add(file.file_id);
    keys.add(file.r2_key);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Stage 1: open a publication
 * ------------------------------------------------------------------ */

function planFrom(descriptor: PendingDescriptor, stored: ReadonlySet<string>): PublicationPlan {
  const files: PublicationPlanFile[] = descriptor.files.map((file) => ({
    file_id: file.file_id,
    filename: file.filename,
    source_url: file.source_url,
    upload_path: `/publications/${descriptor.snapshot_id}/files/${file.file_id}`,
    status: stored.has(file.file_id) ? "stored" : "needed",
  }));
  const created = snapshotIdInstant(descriptor.snapshot_id);
  return {
    snapshot_id: descriptor.snapshot_id,
    operation_id: descriptor.operation_id,
    page_api_sha256: descriptor.page_api_sha256,
    created_at: descriptor.created_at,
    expires_at: new Date((created ?? Date.now()) + PENDING_MAX_AGE_MS).toISOString(),
    files,
  };
}

/** Which planned files already have a completion marker, so a resumed run can skip them. */
export async function storedFileIds(env: Env, descriptor: PendingDescriptor): Promise<Set<string>> {
  const found = await Promise.all(
    descriptor.files.map(async (file) => ({
      fileId: file.file_id,
      present: (await env.R2_BUCKET.head(pendingCompletionKey(descriptor.snapshot_id, file.file_id))) !== null,
    })),
  );
  return new Set(found.filter((entry) => entry.present).map((entry) => entry.fileId));
}

async function readOperation(env: Env, operationId: string): Promise<OperationRecord | null> {
  const obj = await env.R2_BUCKET.get(operationKey(operationId));
  if (!obj) return null;
  try {
    const record = (await obj.json()) as OperationRecord;
    return record && record.operation_id === operationId ? record : null;
  } catch {
    return null;
  }
}

/**
 * Resume, refuse or expire an attempt whose operation record already exists (DF-01 / DF-06).
 *
 * A mismatched payload hash never mutates anything and never reveals which snapshot the original
 * attempt created: a client that is confused about its own identity must not be handed a handle
 * to somebody else's publication.
 */
async function resumeOperation(
  env: Env,
  record: OperationRecord,
  pageApiSha256: string,
): Promise<OpenPublicationResult> {
  if (record.page_api_sha256 !== pageApiSha256) {
    return {
      ok: false,
      status: 409,
      code: "operation_payload_mismatch",
      error: "This operation id was already used with different Page API bytes",
    };
  }

  const descriptor = await readDescriptor(env, record.snapshot_id);
  if (!descriptor) {
    return {
      ok: false,
      status: 410,
      code: "operation_expired",
      error: "The publication this operation opened is no longer available",
    };
  }

  if (
    descriptor.operation_id !== record.operation_id ||
    descriptor.page_api_sha256 !== record.page_api_sha256
  ) {
    return {
      ok: false,
      status: 409,
      code: "operation_state_corrupt",
      error: "Operation record and publication descriptor disagree",
    };
  }

  const descriptorError = descriptorFileError(descriptor);
  if (descriptorError) {
    return { ok: false, status: 409, code: "operation_state_corrupt", error: descriptorError };
  }

  return {
    ok: true,
    status: "resumed",
    plan: planFrom(descriptor, await storedFileIds(env, descriptor)),
  };
}

/**
 * Count publications that are open right now.
 *
 * Snapshot ids are ISO-prefixed and a publication may only live for six hours, so every open
 * publication is under today's or yesterday's date prefix. Scanning exactly those two prefixes
 * keeps the check bounded and — unlike a plain `pending/` listing, which returns the oldest keys
 * first — actually looks at the publications that could still be open.
 */
export async function countOpenPublications(env: Env, now: number): Promise<number> {
  const days = [new Date(now), new Date(now - 24 * 60 * 60 * 1000)].map(
    (date) => date.toISOString().slice(0, 10),
  );
  const ids = new Set<string>();
  for (const day of days) {
    const listing = await env.R2_BUCKET.list({
      prefix: `${PENDING_PREFIX}${day}`,
      delimiter: "/",
      limit: OPEN_SCAN_PREFIX_LIMIT,
    });
    for (const prefix of listing.delimitedPrefixes) {
      const id = prefix.slice(PENDING_PREFIX.length).replace(/\/$/, "");
      const created = snapshotIdInstant(id);
      if (created === null || now - created > PENDING_MAX_AGE_MS) continue;
      ids.add(id);
    }
  }

  let open = 0;
  for (const id of ids) {
    if (await env.R2_BUCKET.head(snapshotManifestKey(id))) continue; // already closed
    open++;
  }
  return open;
}

export interface OpenPublicationInput {
  operationId: string;
  pageApiSha256: string;
  pageBytes: Uint8Array;
  now?: Date;
}

/**
 * Open a publication from publisher-supplied Page API bytes.
 *
 * The broker independently re-reads the document, re-extracts the official PDF catalogue and
 * plans the snapshot. The publisher's only inputs are the bytes and its own attempt id.
 */
export async function openPublication(
  env: Env,
  input: OpenPublicationInput,
): Promise<OpenPublicationResult> {
  if (!UUID_V4_REGEX.test(input.operationId)) {
    return { ok: false, status: 400, code: "invalid_operation_id", error: "Operation id must be a UUIDv4" };
  }
  if (!SHA256_HEX_REGEX.test(input.pageApiSha256)) {
    return { ok: false, status: 400, code: "invalid_page_hash", error: "Page hash must be lowercase SHA-256 hex" };
  }

  const existing = await readOperation(env, input.operationId);
  if (existing) {
    return resumeOperation(env, existing, input.pageApiSha256);
  }

  let pageApiUrl: string;
  try {
    pageApiUrl = resolvePageApiUrl(env.FCIM_PAGE_API_URL);
  } catch (err) {
    return { ok: false, status: 500, code: "broker_misconfigured", error: (err as Error).message };
  }

  let pageId: number | null;
  let pageModifiedGmt: string | null;
  let renderedHtml: string;
  try {
    const doc = readPageApiDocument(new TextDecoder().decode(input.pageBytes));
    pageId = doc.pageId;
    pageModifiedGmt = normalizePageModifiedGmt(doc.pageModifiedGmt);
    renderedHtml = doc.renderedHtml;
  } catch (err) {
    return { ok: false, status: 400, code: "invalid_page_payload", error: (err as Error).message };
  }

  const pdfUrls = extractOfficialPdfUrls(renderedHtml);
  if (pdfUrls.length === 0) {
    return {
      ok: false,
      status: 400,
      code: "no_official_pdfs",
      error: "No official timetable PDF URLs found in the Page API content",
    };
  }

  const currentObj = await env.R2_BUCKET.get(CURRENT_KEY);
  const currentEtag = currentObj?.etag ?? null;
  let previousPointer: ParsedCurrentPointer | null = null;
  if (currentObj) {
    const parsed = parseCurrentPointer(await currentObj.text());
    if (!parsed.ok) {
      // Fail closed. A pointer the broker cannot read is also a pointer it cannot prove a new
      // publication is newer than, and retention and reconciliation are already stalled on it.
      console.error(`current.json rejected by strict pointer validation: ${parsed.error}`);
      return {
        ok: false,
        status: 503,
        code: "broker_state_unreadable",
        error: "The broker cannot read its own current pointer",
      };
    }
    previousPointer = parsed.pointer;
  }

  let baseline: string | null = null;
  if (previousPointer) {
    baseline = previousPointer.page_modified_gmt ?? null;
    if (baseline === null) {
      // A legacy four-field pointer carries no Page API metadata; the immutable manifest does.
      const manifest = await loadPreviousManifest(env, previousPointer);
      baseline = manifest?.source.page_modified_gmt ?? null;
    }
  }

  const now = input.now ?? new Date();
  const verdict = evaluatePageTimestamp(pageModifiedGmt, baseline, now.getTime(), maxPageFutureSkewMs(env));
  if (!verdict.ok) {
    return { ok: false, status: verdict.status, code: verdict.code, error: verdict.error };
  }

  if ((await countOpenPublications(env, now.getTime())) >= MAX_OPEN_PUBLICATIONS) {
    return {
      ok: false,
      status: 429,
      code: "too_many_open_publications",
      error: `At most ${MAX_OPEN_PUBLICATIONS} publications may be open at once`,
    };
  }

  const snapshotId = generateSnapshotId(now);
  const createdAt = now.toISOString();

  let files: PendingFile[];
  try {
    files = planSnapshotFiles(snapshotId, pdfUrls);
  } catch (err) {
    return { ok: false, status: 400, code: "unplannable_catalogue", error: (err as Error).message };
  }

  // The operation record is written before any snapshot state so the mapping from attempt to
  // snapshot is durable first. A crash after this point and before the descriptor lands leaves
  // the attempt expired rather than ambiguous, which the publisher recovers from with a new id.
  const record: OperationRecord = {
    schema_version: 1,
    operation_id: input.operationId,
    snapshot_id: snapshotId,
    page_api_sha256: input.pageApiSha256,
    created_at: createdAt,
  };
  const recordWritten = await env.R2_BUCKET.put(
    operationKey(input.operationId),
    JSON.stringify(record),
    { onlyIf: IF_NONE_MATCH_COND, httpMetadata: { contentType: "application/json" } },
  );
  if (!recordWritten) {
    const raced = await readOperation(env, input.operationId);
    if (!raced) {
      return {
        ok: false,
        status: 409,
        code: "operation_state_corrupt",
        error: "Operation record exists but cannot be read",
      };
    }
    return resumeOperation(env, raced, input.pageApiSha256);
  }

  const pageApiWritten = await env.R2_BUCKET.put(snapshotPageApiKey(snapshotId), input.pageBytes, {
    onlyIf: IF_NONE_MATCH_COND,
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      snapshot_id: snapshotId,
      operation_id: input.operationId,
      page_api_sha256: input.pageApiSha256,
    },
  });
  if (!pageApiWritten) {
    return {
      ok: false,
      status: 409,
      code: "snapshot_collision",
      error: `Collision: ${snapshotPageApiKey(snapshotId)} already exists under an immutable snapshot`,
    };
  }

  const descriptor: PendingDescriptor = {
    schema_version: 1,
    snapshot_id: snapshotId,
    previous_snapshot_id: previousPointer?.snapshot_id ?? null,
    created_at: createdAt,
    current_etag: currentEtag,
    operation_id: input.operationId,
    page_api_sha256: input.pageApiSha256,
    origin: "md_publisher",
    source: {
      page_api_url: pageApiUrl,
      page_id: pageId,
      page_modified_gmt: pageModifiedGmt,
      retrieved_at: createdAt,
      // DF-02: a publisher-observed HTTP validator never becomes a trusted one.
      etag: null,
      last_modified: null,
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
      ok: false,
      status: 409,
      code: "snapshot_collision",
      error: `Collision: pending descriptor for ${snapshotId} already exists`,
    };
  }

  return { ok: true, status: "created", plan: planFrom(descriptor, new Set()) };
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
 * which is a normal state and not an error — the missing uploads are still in flight, or the
 * publisher will resume them.
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

  const descriptorError = descriptorFileError(descriptor);
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
  const publisherAuthored = descriptor.origin === "md_publisher";

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
      // DF-02: for publisher-authored snapshots the trusted validators are unconditionally null,
      // whatever a marker claims. Render's ETag fast-path must stay unreachable for these files.
      upstream_etag: publisherAuthored ? null : parsedMarker.upstream_etag,
      upstream_last_modified: publisherAuthored ? null : parsedMarker.upstream_last_modified,
      publisher_observed_etag: parsedMarker.publisher_observed_etag ?? null,
      publisher_observed_last_modified: parsedMarker.publisher_observed_last_modified ?? null,
      content_sha256: parsedMarker.content_sha256 ?? null,
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
 * Re-drive recent publications whose finalize never ran, and run bounded retention.
 *
 * Gate F narrowed this stage hard: it never fetches FCIM and never asks for a PDF body. A
 * publication that is still missing uploads is left alone — only the publisher can supply those
 * bytes, and it is the publisher's own retry that will do so. Re-driving finalize is safe because
 * finalize reads storage and nothing else.
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
      outcome: "error", pending_examined: 0, requeued_finalizes: 0,
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

  let requeuedFinalizes = 0;

  for (const snapshotId of candidates) {
    if (requeuedFinalizes >= MAX_RECONCILED_SNAPSHOTS) break;
    if (await env.R2_BUCKET.head(snapshotManifestKey(snapshotId))) {
      continue; // already finalized
    }
    const descriptor = await readDescriptor(env, snapshotId);
    if (!descriptor) continue;

    // A descriptor can only win the CAS while current.json still has exactly the ETag it observed
    // when the publication opened. Once that changes, re-driving it would create load for a
    // snapshot that is already provably superseded, so leave it as harmless immutable history.
    if (descriptor.current_etag !== (current?.etag ?? null)) continue;
    const descriptorError = descriptorFileError(descriptor);
    if (descriptorError) {
      console.error(`Snapshot ${snapshotId} deterministically failed: ${descriptorError}`);
      continue;
    }

    const jobs: { body: PublicationJob }[] = [{ body: buildFinalizeJob(snapshotId) }];
    await env.PUBLICATION_QUEUE.sendBatch(jobs);
    requeuedFinalizes += 1;
  }

  // Persist only after repair dispatch succeeds: a crash repeats idempotent repair, never skips it.
  await writeScanCursor(bucket, "reconcile", nextCursor);
  await runRetention(env);

  return {
    outcome: requeuedFinalizes > 0 ? "requeued" : "idle",
    pending_examined: candidates.length,
    requeued_finalizes: requeuedFinalizes,
  };
}
