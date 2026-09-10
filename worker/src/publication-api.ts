/**
 * MD Publisher ingestion API.
 *
 * Six authenticated routes, one credential, and one rule: the publisher supplies bytes and an
 * attempt identity, and the broker derives everything else. No request field on any of these
 * routes becomes an R2 key, a filename, a source URL, a snapshot id or a pointer value — those
 * are all re-derived from the broker's own plan, which was itself derived from the Page API bytes
 * with the same code the retired discovery stage used.
 *
 *   POST /publications                        open (or resume) one publication
 *   GET  /publications/:snapshot_id           the broker's plan and per-file upload state
 *   PUT  /publications/:snapshot_id/files/:id one PDF body, checksum-validated by R2
 *   POST /publications/:snapshot_id/complete  close the snapshot; may advance current.json
 *   PUT  /publisher/heartbeat                 bounded liveness, broker-stamped
 *   GET  /publication-status                  bounded operational state
 *
 * Every mutation stays create-only except `current.json` (compare-and-swap) and the heartbeat.
 */

import { SUPPORTED_COURSE_YEARS } from "./courses";
import {
  PUBLISHER_HEARTBEAT_KEY,
  acceptedPointerKey,
  pendingCompletionKey,
  snapshotPageApiKey,
} from "./keys";
import { FILE_ID_REGEX } from "./jobs";
import { PENDING_MAX_AGE_MS, snapshotIdInstant, snapshotWorkExpired } from "./maintenance";
import { MAX_PDF_BYTES } from "./pdf-fetch";
import { SNAPSHOT_ID_REGEX, parseCurrentPointer } from "./pointer";
import { authorizePublisher } from "./publisher-auth";
import {
  SHA256_HEX_REGEX,
  UUID_V4_REGEX,
  countOpenPublications,
  descriptorFileError,
  openPublication,
  readDescriptor,
  runFinalize,
  storedFileIds,
} from "./publisher";
import {
  PDF_MAGIC,
  PayloadTooLargeError,
  contentLengthOrNull,
  isContentPrefixError,
  isPayloadTooLarge,
  putLimitedStream,
  requirePrefix,
} from "./stream-limit";
import type {
  AcceptedPointer,
  CompletionMarker,
  Env,
  PendingDescriptor,
  PublisherHeartbeat,
} from "./types";

/** WordPress page payloads are a few hundred kilobytes; 1 MiB is the contract's hard ceiling. */
export const MAX_PAGE_API_UPLOAD_BYTES = 1024 * 1024;

/** A heartbeat is a status line, not a log sink. */
export const MAX_HEARTBEAT_BYTES = 8 * 1024;

const MAX_HEARTBEAT_FIELD_LENGTH = 256;
const MAX_HEARTBEAT_ERROR_LENGTH = 512;

const IF_NONE_MATCH_COND = { etagDoesNotMatch: "*" };

const NO_CACHE_JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: NO_CACHE_JSON_HEADERS });
}

function errorResponse(status: number, code: string, error: string, extra?: Record<string, unknown>): Response {
  return jsonResponse({ ok: false, code, error, ...extra }, status);
}

/** Read a request body into memory under a hard byte cap. */
async function readBodyWithin(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0);
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/* ------------------------------------------------------------------ *
 * POST /publications
 * ------------------------------------------------------------------ */

export async function handleOpenPublication(request: Request, env: Env): Promise<Response> {
  const auth = await authorizePublisher(request, env);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.error);

  const operationId = request.headers.get("X-Publication-Operation-Id");
  if (!operationId || !UUID_V4_REGEX.test(operationId)) {
    return errorResponse(400, "invalid_operation_id", "Header X-Publication-Operation-Id must be a UUIDv4");
  }

  const declaredHash = request.headers.get("X-Page-Sha256")?.toLowerCase();
  if (!declaredHash || !SHA256_HEX_REGEX.test(declaredHash)) {
    return errorResponse(400, "invalid_page_hash", "Header X-Page-Sha256 must be 64-character SHA-256 hex");
  }

  const contentType = request.headers.get("Content-Type");
  if (!contentType || !contentType.toLowerCase().includes("application/json")) {
    return errorResponse(415, "invalid_content_type", "Content-Type must be application/json");
  }

  const declaredLength = contentLengthOrNull(request.headers.get("Content-Length"));
  if (declaredLength !== null && declaredLength > MAX_PAGE_API_UPLOAD_BYTES) {
    return errorResponse(413, "page_too_large", `Page API payload exceeds ${MAX_PAGE_API_UPLOAD_BYTES} bytes`);
  }

  let pageBytes: Uint8Array;
  try {
    pageBytes = await readBodyWithin(request, MAX_PAGE_API_UPLOAD_BYTES);
  } catch (err) {
    if (isPayloadTooLarge(err)) {
      return errorResponse(413, "page_too_large", `Page API payload exceeds ${MAX_PAGE_API_UPLOAD_BYTES} bytes`);
    }
    return errorResponse(400, "page_read_failed", `Could not read the Page API payload: ${(err as Error).message}`);
  }

  if (pageBytes.byteLength === 0) {
    return errorResponse(400, "empty_page_payload", "Page API payload is empty");
  }
  if (declaredLength !== null && declaredLength !== pageBytes.byteLength) {
    return errorResponse(400, "length_mismatch", "Body length did not match the declared Content-Length");
  }

  const actualHash = await sha256Hex(pageBytes);
  if (actualHash !== declaredHash) {
    return errorResponse(400, "page_hash_mismatch", "Page API body does not match the declared SHA-256");
  }

  const result = await openPublication(env, {
    operationId,
    pageApiSha256: actualHash,
    pageBytes,
  });

  if (!result.ok) {
    // A payload mismatch must not disclose which snapshot the original attempt created.
    return errorResponse(result.status, result.code, result.error);
  }

  return jsonResponse(
    { ok: true, status: result.status, ...result.plan },
    result.status === "created" ? 201 : 200,
  );
}

/* ------------------------------------------------------------------ *
 * GET /publications/:snapshot_id
 * ------------------------------------------------------------------ */

async function loadOpenDescriptor(
  env: Env,
  snapshotId: string,
): Promise<{ ok: true; descriptor: PendingDescriptor } | { ok: false; response: Response }> {
  if (!SNAPSHOT_ID_REGEX.test(snapshotId)) {
    return { ok: false, response: errorResponse(404, "publication_not_found", "No such publication") };
  }
  if (snapshotWorkExpired(snapshotId)) {
    return {
      ok: false,
      response: errorResponse(410, "operation_expired", "The publication window for this snapshot has closed"),
    };
  }
  const descriptor = await readDescriptor(env, snapshotId);
  if (!descriptor) {
    return { ok: false, response: errorResponse(404, "publication_not_found", "No such publication") };
  }
  const descriptorError = descriptorFileError(descriptor);
  if (descriptorError) {
    return {
      ok: false,
      response: errorResponse(409, "operation_state_corrupt", descriptorError),
    };
  }
  return { ok: true, descriptor };
}

export async function handleGetPublication(
  request: Request,
  env: Env,
  snapshotId: string,
): Promise<Response> {
  const auth = await authorizePublisher(request, env);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.error);

  const loaded = await loadOpenDescriptor(env, snapshotId);
  if (!loaded.ok) return loaded.response;
  const descriptor = loaded.descriptor;

  const stored = await storedFileIds(env, descriptor);
  const created = snapshotIdInstant(snapshotId);
  return jsonResponse({
    ok: true,
    status: "open",
    snapshot_id: descriptor.snapshot_id,
    operation_id: descriptor.operation_id,
    page_api_sha256: descriptor.page_api_sha256,
    created_at: descriptor.created_at,
    expires_at: new Date((created ?? Date.now()) + PENDING_MAX_AGE_MS).toISOString(),
    files: descriptor.files.map((file) => ({
      file_id: file.file_id,
      filename: file.filename,
      source_url: file.source_url,
      upload_path: `/publications/${descriptor.snapshot_id}/files/${file.file_id}`,
      status: stored.has(file.file_id) ? "stored" : "needed",
    })),
  });
}

/* ------------------------------------------------------------------ *
 * PUT /publications/:snapshot_id/files/:file_id
 * ------------------------------------------------------------------ */

function markerFor(
  descriptorSnapshotId: string,
  file: { file_id: string; filename: string; source_url: string; r2_key: string },
  meta: {
    size: number | null;
    contentSha256: string;
    observedEtag: string | null;
    observedLastModified: string | null;
  },
): CompletionMarker {
  return {
    schema_version: 1,
    snapshot_id: descriptorSnapshotId,
    file_id: file.file_id,
    filename: file.filename,
    source_url: file.source_url,
    r2_key: file.r2_key,
    content_type: "application/pdf",
    size: meta.size,
    // DF-02: the trusted validators stay null for every publisher-authored file.
    upstream_etag: null,
    upstream_last_modified: null,
    publisher_observed_etag: meta.observedEtag,
    publisher_observed_last_modified: meta.observedLastModified,
    content_sha256: meta.contentSha256,
    completed_at: new Date().toISOString(),
  };
}

/** Keep an informational publisher observation short and free of control characters. */
function boundedObservation(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_HEARTBEAT_FIELD_LENGTH) return null;
  return /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : null;
}

export async function handleUploadPublicationFile(
  request: Request,
  env: Env,
  snapshotId: string,
  fileId: string,
): Promise<Response> {
  const auth = await authorizePublisher(request, env);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.error);

  if (!FILE_ID_REGEX.test(fileId)) {
    return errorResponse(400, "invalid_file_id", "file_id is not a valid publication file identifier");
  }

  const loaded = await loadOpenDescriptor(env, snapshotId);
  if (!loaded.ok) return loaded.response;
  const descriptor = loaded.descriptor;

  // The client names a file id and nothing else. Everything used to address storage — the key,
  // the filename, the source URL — comes from the broker's own descriptor entry.
  const file = descriptor.files.find((entry) => entry.file_id === fileId);
  if (!file) {
    return errorResponse(404, "unknown_file_id", "This publication has no such file");
  }

  const contentType = request.headers.get("Content-Type");
  if (!contentType || !contentType.toLowerCase().includes("application/pdf")) {
    return errorResponse(415, "invalid_content_type", "Content-Type must be application/pdf");
  }

  const declaredSha256 = request.headers.get("X-Content-Sha256")?.toLowerCase();
  if (!declaredSha256 || !SHA256_HEX_REGEX.test(declaredSha256)) {
    return errorResponse(400, "invalid_content_hash", "Header X-Content-Sha256 must be 64-character SHA-256 hex");
  }

  const declaredSize = contentLengthOrNull(request.headers.get("Content-Length"));
  if (declaredSize === null) {
    return errorResponse(411, "length_required", "Content-Length is required for a PDF upload");
  }
  if (declaredSize === 0) {
    return errorResponse(400, "empty_body", "PDF body is empty");
  }
  if (declaredSize > MAX_PDF_BYTES) {
    return errorResponse(413, "pdf_too_large", `PDF exceeds the ${MAX_PDF_BYTES} byte limit`);
  }

  const observedEtag = boundedObservation(request.headers.get("X-Publisher-Observed-Etag"));
  const observedLastModified = boundedObservation(request.headers.get("X-Publisher-Observed-Last-Modified"));

  const alreadyStored = await env.R2_BUCKET.head(file.r2_key);
  if (alreadyStored) {
    return finishStoredFile(env, descriptor, file, alreadyStored.customMetadata, alreadyStored.size, declaredSha256, {
      observedEtag,
      observedLastModified,
    });
  }

  if (!request.body) {
    return errorResponse(400, "empty_body", "PDF body is empty");
  }

  const customMetadata: Record<string, string> = {
    snapshot_id: descriptor.snapshot_id,
    file_id: file.file_id,
    source_url: file.source_url,
    content_sha256: declaredSha256,
  };
  if (observedEtag) customMetadata.publisher_observed_etag = observedEtag;
  if (observedLastModified) customMetadata.publisher_observed_last_modified = observedLastModified;

  let written: Awaited<ReturnType<Env["R2_BUCKET"]["put"]>>;
  try {
    written = await putLimitedStream(
      requirePrefix(request.body as ReadableStream<Uint8Array>, PDF_MAGIC, "PDF"),
      MAX_PDF_BYTES,
      declaredSize,
      (body) =>
        env.R2_BUCKET.put(file.r2_key, body, {
          onlyIf: IF_NONE_MATCH_COND,
          httpMetadata: { contentType: "application/pdf" },
          customMetadata,
          // DF-05: R2 validates the digest server-side. Bytes that do not hash to the declared
          // value are rejected by the store itself, so an unverified body never becomes an object.
          sha256: declaredSha256,
        }),
    );
  } catch (err) {
    if (isPayloadTooLarge(err)) {
      return errorResponse(413, "pdf_too_large", `PDF exceeds the ${MAX_PDF_BYTES} byte limit`);
    }
    if (isContentPrefixError(err)) {
      return errorResponse(400, "invalid_pdf_magic", "Body does not begin with a %PDF- signature");
    }
    const message = (err as Error).message ?? "upload failed";
    if (/checksum|sha-?256|digest/i.test(message)) {
      return errorResponse(400, "content_hash_mismatch", "Uploaded bytes do not match the declared SHA-256");
    }
    if (/did not match the declared Content-Length|length/i.test(message)) {
      return errorResponse(400, "length_mismatch", "Body length did not match the declared Content-Length");
    }
    return errorResponse(400, "upload_failed", message);
  }

  if (!written) {
    // A concurrent delivery of the same upload won the create race.
    const raced = await env.R2_BUCKET.head(file.r2_key);
    if (!raced) {
      return errorResponse(409, "file_conflict", "Upload lost a create race but no object is present");
    }
    return finishStoredFile(env, descriptor, file, raced.customMetadata, raced.size, declaredSha256, {
      observedEtag,
      observedLastModified,
    });
  }

  await env.R2_BUCKET.put(
    pendingCompletionKey(descriptor.snapshot_id, file.file_id),
    JSON.stringify(
      markerFor(descriptor.snapshot_id, file, {
        size: written.size,
        contentSha256: declaredSha256,
        observedEtag,
        observedLastModified,
      }),
    ),
    { onlyIf: IF_NONE_MATCH_COND, httpMetadata: { contentType: "application/json" } },
  );

  return jsonResponse({
    ok: true,
    status: "stored",
    snapshot_id: descriptor.snapshot_id,
    file_id: file.file_id,
    filename: file.filename,
    size: written.size,
    content_sha256: declaredSha256,
  });
}

/**
 * Settle an upload whose object already exists.
 *
 * An identical retry — the normal outcome after a network timeout on a request the broker
 * actually completed — is a success and (re)writes the completion marker. Anything else is a
 * conflict: an immutable object is never rewritten to match a newer claim.
 */
async function finishStoredFile(
  env: Env,
  descriptor: PendingDescriptor,
  file: { file_id: string; filename: string; source_url: string; r2_key: string },
  metadata: Record<string, string> | undefined,
  size: number,
  declaredSha256: string,
  observations: { observedEtag: string | null; observedLastModified: string | null },
): Promise<Response> {
  const storedHash = metadata?.content_sha256?.toLowerCase() ?? null;
  const storedSource = metadata?.source_url ?? null;

  if (storedSource !== file.source_url || storedHash !== declaredSha256) {
    return errorResponse(409, "file_conflict", `Immutable object ${file.r2_key} already exists with different content`, {
      snapshot_id: descriptor.snapshot_id,
      file_id: file.file_id,
    });
  }

  await env.R2_BUCKET.put(
    pendingCompletionKey(descriptor.snapshot_id, file.file_id),
    JSON.stringify(
      markerFor(descriptor.snapshot_id, file, {
        size,
        contentSha256: declaredSha256,
        observedEtag: observations.observedEtag,
        observedLastModified: observations.observedLastModified,
      }),
    ),
    { onlyIf: IF_NONE_MATCH_COND, httpMetadata: { contentType: "application/json" } },
  );

  return jsonResponse({
    ok: true,
    status: "already_stored",
    snapshot_id: descriptor.snapshot_id,
    file_id: file.file_id,
    filename: file.filename,
    size,
    content_sha256: declaredSha256,
  });
}

/* ------------------------------------------------------------------ *
 * POST /publications/:snapshot_id/complete
 * ------------------------------------------------------------------ */

export async function handleCompletePublication(
  request: Request,
  env: Env,
  snapshotId: string,
): Promise<Response> {
  const auth = await authorizePublisher(request, env);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.error);

  const loaded = await loadOpenDescriptor(env, snapshotId);
  if (!loaded.ok) return loaded.response;
  const descriptor = loaded.descriptor;

  if (
    typeof descriptor.operation_id !== "string" ||
    !UUID_V4_REGEX.test(descriptor.operation_id) ||
    typeof descriptor.page_api_sha256 !== "string" ||
    !SHA256_HEX_REGEX.test(descriptor.page_api_sha256)
  ) {
    return errorResponse(409, "operation_state_corrupt", "Publication descriptor has no usable operation identity");
  }

  // The immutable page object was stamped with the operation and payload hash when the
  // publication opened. If storage and the descriptor disagree now, something rewrote one of
  // them, and finalize must not run on a snapshot whose provenance cannot be proven.
  const pageObject = await env.R2_BUCKET.head(snapshotPageApiKey(snapshotId));
  if (!pageObject) {
    return errorResponse(409, "operation_state_corrupt", "Publication has no stored Page API object");
  }
  if (
    pageObject.customMetadata?.page_api_sha256 !== descriptor.page_api_sha256 ||
    pageObject.customMetadata?.operation_id !== descriptor.operation_id
  ) {
    return errorResponse(
      409,
      "operation_state_corrupt",
      "Stored Page API provenance disagrees with the publication descriptor",
    );
  }

  const result = await runFinalize(env, snapshotId);

  switch (result.outcome) {
    case "published":
    case "already_current":
      return jsonResponse({ ok: true, status: result.outcome, snapshot_id: snapshotId });
    case "superseded":
      // A newer publication won the pointer. Normal, terminal, and not an error for the client.
      return jsonResponse({ ok: true, status: "superseded", snapshot_id: snapshotId });
    case "incomplete":
      return errorResponse(409, "publication_incomplete", "Publication is missing uploads", {
        snapshot_id: snapshotId,
        missing: result.missing,
      });
    default:
      return errorResponse(500, "finalize_failed", result.error ?? "Finalize failed", {
        snapshot_id: snapshotId,
        retryable: result.retryable !== false,
      });
  }
}

/* ------------------------------------------------------------------ *
 * PUT /publisher/heartbeat
 * ------------------------------------------------------------------ */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function boundedString(value: unknown, max = MAX_HEARTBEAT_FIELD_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Control characters would make the stored record unreadable in a log viewer.
  return trimmed.replace(CONTROL_CHARS, " ").slice(0, max);
}

function boundedInteger(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return Math.min(value, max);
}

export async function handlePublisherHeartbeat(request: Request, env: Env): Promise<Response> {
  const auth = await authorizePublisher(request, env);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.error);

  let body: unknown;
  try {
    const bytes = await readBodyWithin(request, MAX_HEARTBEAT_BYTES);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    if (isPayloadTooLarge(err)) {
      return errorResponse(413, "heartbeat_too_large", `Heartbeat exceeds ${MAX_HEARTBEAT_BYTES} bytes`);
    }
    return errorResponse(400, "invalid_heartbeat", "Heartbeat body must be a JSON object");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(400, "invalid_heartbeat", "Heartbeat body must be a JSON object");
  }

  const input = body as Record<string, unknown>;
  const snapshotId = boundedString(input.snapshot_id);
  const operationId = boundedString(input.operation_id);

  const heartbeat: PublisherHeartbeat = {
    schema_version: 1,
    // The broker's own clock is the only one that decides how old a heartbeat is.
    received_at: new Date().toISOString(),
    client_reported_at: boundedString(input.client_reported_at, 64),
    // Anything that is not an explicit "ok" reads as a failure: the broker never upgrades an
    // unrecognised status into a claim that the last publisher run was fine.
    status: input.status === "ok" ? "ok" : "error",
    outcome: boundedString(input.outcome, 64),
    operation_id: operationId && UUID_V4_REGEX.test(operationId) ? operationId : null,
    snapshot_id: snapshotId && SNAPSHOT_ID_REGEX.test(snapshotId) ? snapshotId : null,
    page_modified_gmt: boundedString(input.page_modified_gmt, 32),
    pdf_count: boundedInteger(input.pdf_count, 1000),
    saw_drift: typeof input.saw_drift === "boolean" ? input.saw_drift : null,
    duration_ms: boundedInteger(input.duration_ms, 24 * 60 * 60 * 1000),
    error: boundedString(input.error, MAX_HEARTBEAT_ERROR_LENGTH),
    logon_model: boundedString(input.logon_model, 32),
    publisher_version: boundedString(input.publisher_version, 32),
  };

  await env.R2_BUCKET.put(PUBLISHER_HEARTBEAT_KEY, JSON.stringify(heartbeat), {
    httpMetadata: { contentType: "application/json" },
  });

  return jsonResponse({ ok: true, received_at: heartbeat.received_at });
}

/* ------------------------------------------------------------------ *
 * GET /publication-status
 * ------------------------------------------------------------------ */

function ageSeconds(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.round((now - ms) / 1000)) : null;
}

export async function handlePublicationStatus(request: Request, env: Env): Promise<Response> {
  const auth = await authorizePublisher(request, env);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.error);

  const now = Date.now();
  const warnings: string[] = [];

  let current: { snapshot_id: string; published_at: string; page_modified_gmt: string | null; pdf_count: number | null } | null = null;
  const currentObj = await env.R2_BUCKET.get("current.json");
  if (!currentObj) {
    warnings.push("no_current_snapshot");
  } else {
    const parsed = parseCurrentPointer(await currentObj.text());
    if (!parsed.ok) {
      warnings.push("current_pointer_unreadable");
    } else {
      current = {
        snapshot_id: parsed.pointer.snapshot_id,
        published_at: parsed.pointer.published_at,
        page_modified_gmt: parsed.pointer.page_modified_gmt ?? null,
        pdf_count: parsed.pointer.pdf_count ?? null,
      };
    }
  }

  let heartbeat: PublisherHeartbeat | null = null;
  const heartbeatObj = await env.R2_BUCKET.get(PUBLISHER_HEARTBEAT_KEY);
  if (heartbeatObj) {
    try {
      heartbeat = (await heartbeatObj.json()) as PublisherHeartbeat;
    } catch {
      warnings.push("heartbeat_unreadable");
    }
  } else {
    warnings.push("no_publisher_heartbeat");
  }

  const accepted: { course_year: number; accepted_id: string | null; accepted_at: string | null; source_snapshot_id: string | null }[] = [];
  for (const courseYear of SUPPORTED_COURSE_YEARS) {
    const obj = await env.R2_BUCKET.get(acceptedPointerKey(courseYear));
    if (!obj) {
      accepted.push({ course_year: courseYear, accepted_id: null, accepted_at: null, source_snapshot_id: null });
      continue;
    }
    try {
      const pointer = (await obj.json()) as AcceptedPointer;
      accepted.push({
        course_year: courseYear,
        accepted_id: pointer.accepted_id ?? null,
        accepted_at: pointer.accepted_at ?? null,
        source_snapshot_id: pointer.source_snapshot_id ?? null,
      });
    } catch {
      warnings.push(`accepted_pointer_unreadable_course_${courseYear}`);
      accepted.push({ course_year: courseYear, accepted_id: null, accepted_at: null, source_snapshot_id: null });
    }
  }

  const openPublications = await countOpenPublications(env, now);

  const heartbeatAge = ageSeconds(heartbeat?.received_at ?? null, now);
  if (heartbeat && heartbeat.status === "error") warnings.push("last_publisher_run_failed");
  if (heartbeatAge !== null && heartbeatAge > 6 * 60 * 60) warnings.push("publisher_heartbeat_stale");

  return jsonResponse({
    ok: true,
    broker_time: new Date(now).toISOString(),
    current: current
      ? { ...current, age_seconds: ageSeconds(current.published_at, now) }
      : null,
    open_publications: openPublications,
    publisher_heartbeat: heartbeat
      ? {
          received_at: heartbeat.received_at,
          age_seconds: heartbeatAge,
          status: heartbeat.status,
          outcome: heartbeat.outcome,
          snapshot_id: heartbeat.snapshot_id,
          page_modified_gmt: heartbeat.page_modified_gmt,
          pdf_count: heartbeat.pdf_count,
          saw_drift: heartbeat.saw_drift,
          duration_ms: heartbeat.duration_ms,
          error: heartbeat.error,
          logon_model: heartbeat.logon_model,
          publisher_version: heartbeat.publisher_version,
        }
      : null,
    accepted,
    warnings,
  });
}
