/**
 * Accepted-state gateway.
 *
 * Accepted state is the durable answer to "what did Render actually validate", so the broker
 * stores it in two pieces: a large immutable payload, streamed straight into R2 and never
 * buffered, and a small compare-and-swapped pointer. The Worker performs no timetable semantics
 * on either — it checks identity, provenance and size, and refuses anything whose pointer and
 * payload do not describe the same thing.
 */

import { isOfficialTimetablePdfUrl } from "./extractor";
import { acceptedPayloadKey, acceptedPointerKey } from "./keys";
import { parseSupportedCourseYear, SUPPORTED_COURSE_YEARS } from "./courses";
import { SNAPSHOT_ID_REGEX } from "./pointer";
import { contentLengthOrNull, isPayloadTooLarge, putLimitedStream } from "./stream-limit";
import type { AcceptedPointer, AcceptedPointerWriteRequest, Env, R2PutOptions } from "./types";

const SAFE_ID_REGEX = /^[a-zA-Z0-9._-]+$/;
const HEX_64_REGEX = /^[a-f0-9]{64}$/i;
const PARSER_VERSION_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;
const ISO_INSTANT_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** A serialized Schedule is ~200 KB; 10 MB is generous headroom, not a target. */
export const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

const MAX_ACCEPTED_ID_LENGTH = 128;
const IF_NONE_MATCH_COND = { etagDoesNotMatch: "*" };

const NO_CACHE_JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-cache",
};

function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: headers ? { ...NO_CACHE_JSON_HEADERS, ...headers } : NO_CACHE_JSON_HEADERS,
  });
}

function unsupportedCourse(raw: string): Response {
  return jsonResponse(
    {
      error: `Unsupported course year ${JSON.stringify(raw)}`,
      supported_course_years: SUPPORTED_COURSE_YEARS,
    },
    400,
  );
}

function verifyAuth(request: Request, env: Env): boolean {
  if (!env.SCHEDULE_BROKER_SECRET) {
    console.error("SCHEDULE_BROKER_SECRET is not configured in worker environment");
    return false;
  }
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;
  return authHeader.trim() === `Bearer ${env.SCHEDULE_BROKER_SECRET}`;
}

/**
 * Handle PUT /accepted-payloads/course-:courseYear/:acceptedId
 * Streams the serialized Schedule directly into R2 under create-only semantics.
 */
export async function handlePutAcceptedPayload(
  request: Request,
  env: Env,
  courseYearStr: string,
  acceptedId: string,
): Promise<Response> {
  if (!verifyAuth(request, env)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const courseYear = parseSupportedCourseYear(courseYearStr);
  if (courseYear === null) {
    return unsupportedCourse(courseYearStr);
  }

  if (!SAFE_ID_REGEX.test(acceptedId) || acceptedId.length > MAX_ACCEPTED_ID_LENGTH) {
    return jsonResponse({ error: "Invalid accepted_id syntax" }, 400);
  }

  const contentType = request.headers.get("Content-Type");
  if (!contentType || !contentType.toLowerCase().includes("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json" }, 400);
  }

  // Content-Length is an early hint only; the real limit is enforced on the counted stream below.
  const contentLengthHeader = request.headers.get("Content-Length");
  const declaredSize = contentLengthOrNull(contentLengthHeader);
  if (declaredSize !== null && declaredSize > MAX_PAYLOAD_BYTES) {
    return jsonResponse({ error: `Payload exceeds size limit of ${MAX_PAYLOAD_BYTES} bytes` }, 413);
  }

  const sourcePdfHash = request.headers.get("x-source-pdf-hash");
  const sourcePdfUrl = request.headers.get("x-source-pdf-url");
  const payloadSha256 = request.headers.get("x-payload-sha256");
  const snapshotId = request.headers.get("x-snapshot-id");
  const parserVersion = request.headers.get("x-parser-version");
  const acceptedAt = request.headers.get("x-accepted-at");
  const declaredCourseYear = request.headers.get("x-course-year");

  if (!sourcePdfHash || !HEX_64_REGEX.test(sourcePdfHash)) {
    return jsonResponse({ error: "Header x-source-pdf-hash must be 64-char SHA-256 hex" }, 400);
  }
  if (!payloadSha256 || !HEX_64_REGEX.test(payloadSha256)) {
    return jsonResponse({ error: "Header x-payload-sha256 must be 64-char SHA-256 hex" }, 400);
  }
  if (!snapshotId || !SNAPSHOT_ID_REGEX.test(snapshotId)) {
    return jsonResponse({ error: "Header x-snapshot-id must be a valid snapshot identifier" }, 400);
  }
  if (!sourcePdfUrl || !isOfficialTimetablePdfUrl(sourcePdfUrl)) {
    return jsonResponse({ error: "Header x-source-pdf-url must be an official FCIM timetable PDF URL" }, 400);
  }
  if (!parserVersion || !PARSER_VERSION_REGEX.test(parserVersion)) {
    return jsonResponse({ error: "Header x-parser-version is required" }, 400);
  }
  if (!acceptedAt || !ISO_INSTANT_REGEX.test(acceptedAt)) {
    return jsonResponse({ error: "Header x-accepted-at must be an ISO-8601 UTC instant" }, 400);
  }
  if (declaredCourseYear !== null && declaredCourseYear !== String(courseYear)) {
    return jsonResponse({ error: "Header x-course-year disagrees with the request path" }, 400);
  }

  if (!request.body) {
    return jsonResponse({ error: "Request body is empty" }, 400);
  }

  const payloadKey = acceptedPayloadKey(courseYear, acceptedId);
  const customMetadata: Record<string, string> = {
    course_year: String(courseYear),
    source_pdf_hash: sourcePdfHash.toLowerCase(),
    source_pdf_url: sourcePdfUrl,
    payload_sha256: payloadSha256.toLowerCase(),
    snapshot_id: snapshotId,
    parser_version: parserVersion,
    accepted_at: acceptedAt,
  };

  const existing = await env.R2_BUCKET.head(payloadKey);
  if (existing) {
    const meta = existing.customMetadata;
    const identical =
      meta?.course_year === String(courseYear) &&
      meta?.source_pdf_hash?.toLowerCase() === sourcePdfHash.toLowerCase() &&
      meta?.source_pdf_url === sourcePdfUrl &&
      meta?.payload_sha256?.toLowerCase() === payloadSha256.toLowerCase() &&
      meta?.parser_version === parserVersion &&
      meta?.snapshot_id === snapshotId;

    if (identical) {
      return jsonResponse({
        ok: true,
        status: "idempotent",
        message: "Payload already accepted with identical metadata",
        accepted_id: acceptedId,
        payload_key: payloadKey,
      });
    }

    return jsonResponse(
      {
        error: `Conflict: immutable payload ${payloadKey} already exists with conflicting metadata`,
        code: "PAYLOAD_CONFLICT",
      },
      409,
    );
  }

  let putRes;
  try {
    putRes = await putLimitedStream(
      request.body as ReadableStream<Uint8Array>,
      MAX_PAYLOAD_BYTES,
      declaredSize,
      (body) =>
        env.R2_BUCKET.put(payloadKey, body, {
          onlyIf: IF_NONE_MATCH_COND,
          httpMetadata: { contentType: "application/json" },
          customMetadata,
        }),
    );
  } catch (err) {
    if (isPayloadTooLarge(err)) {
      return jsonResponse({ error: `Payload exceeds size limit of ${MAX_PAYLOAD_BYTES} bytes` }, 413);
    }
    return jsonResponse({ error: `Failed to store accepted payload: ${(err as Error).message}` }, 500);
  }

  if (!putRes) {
    return jsonResponse(
      {
        error: `Conflict: concurrent write created immutable payload ${payloadKey}`,
        code: "PAYLOAD_CONFLICT",
      },
      409,
    );
  }

  return jsonResponse({ ok: true, status: "created", accepted_id: acceptedId, payload_key: payloadKey }, 200);
}

/**
 * Handle GET /accepted-payloads/course-:courseYear/:acceptedId
 */
export async function handleGetAcceptedPayload(
  env: Env,
  courseYearStr: string,
  acceptedId: string,
): Promise<Response> {
  const courseYear = parseSupportedCourseYear(courseYearStr);
  if (courseYear === null) {
    return unsupportedCourse(courseYearStr);
  }

  if (!SAFE_ID_REGEX.test(acceptedId) || acceptedId.length > MAX_ACCEPTED_ID_LENGTH) {
    return jsonResponse({ error: "Invalid accepted_id syntax" }, 400);
  }

  const payloadKey = acceptedPayloadKey(courseYear, acceptedId);
  const obj = await env.R2_BUCKET.get(payloadKey);
  if (!obj) {
    return jsonResponse({ error: `Payload not found: ${payloadKey}` }, 404);
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: obj.httpEtag,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/**
 * Validate the accepted-state pointer write request.
 *
 * Every field is required and format-checked, including the ones a careless caller would happily
 * omit: `accepted_at`, and a `source_pdf_url` that still has to satisfy the official FCIM
 * timetable PDF policy. None of this reads the timetable — it only refuses to record provenance
 * the broker cannot vouch for.
 */
export function validatePointerRequest(
  payload: unknown,
  expectedCourseYear: number,
): { ok: true; request: AcceptedPointerWriteRequest } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Payload must be a JSON object" };
  }

  const req = payload as Partial<AcceptedPointerWriteRequest>;
  if (
    req.expected_previous_accepted_id !== null &&
    typeof req.expected_previous_accepted_id !== "string"
  ) {
    return { ok: false, error: "expected_previous_accepted_id must be a string or null" };
  }

  const pointer = req.pointer;
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) {
    return { ok: false, error: "pointer object is required" };
  }

  if (pointer.schema_version !== 1) {
    return { ok: false, error: "schema_version must be 1" };
  }

  if (pointer.course_year !== expectedCourseYear) {
    return {
      ok: false,
      error: `course_year ${JSON.stringify(pointer.course_year)} does not match requested course ${expectedCourseYear}`,
    };
  }

  if (
    typeof pointer.accepted_id !== "string" ||
    !SAFE_ID_REGEX.test(pointer.accepted_id) ||
    pointer.accepted_id.length > MAX_ACCEPTED_ID_LENGTH
  ) {
    return { ok: false, error: "accepted_id must be alphanumeric with safe symbols" };
  }

  const expectedPayloadKey = acceptedPayloadKey(expectedCourseYear, pointer.accepted_id);
  if (pointer.payload_key !== expectedPayloadKey) {
    return {
      ok: false,
      error: `payload_key ${JSON.stringify(pointer.payload_key)} does not match expected ${expectedPayloadKey}`,
    };
  }

  if (typeof pointer.payload_sha256 !== "string" || !HEX_64_REGEX.test(pointer.payload_sha256)) {
    return { ok: false, error: "payload_sha256 must be 64-character hex" };
  }

  if (typeof pointer.source_pdf_hash !== "string" || !HEX_64_REGEX.test(pointer.source_pdf_hash)) {
    return { ok: false, error: "source_pdf_hash must be 64-character hex" };
  }

  if (typeof pointer.source_snapshot_id !== "string" || !SNAPSHOT_ID_REGEX.test(pointer.source_snapshot_id)) {
    return { ok: false, error: "source_snapshot_id must be a valid snapshot identifier" };
  }

  if (typeof pointer.source_pdf_url !== "string" || !isOfficialTimetablePdfUrl(pointer.source_pdf_url)) {
    return { ok: false, error: "source_pdf_url must be an official FCIM timetable PDF URL" };
  }

  if (typeof pointer.parser_version !== "string" || !PARSER_VERSION_REGEX.test(pointer.parser_version)) {
    return { ok: false, error: "parser_version is required" };
  }

  if (typeof pointer.accepted_at !== "string" || !ISO_INSTANT_REGEX.test(pointer.accepted_at)) {
    return { ok: false, error: "accepted_at must be an ISO-8601 UTC instant" };
  }

  return { ok: true, request: req as AcceptedPointerWriteRequest };
}

/**
 * Handle PUT /accepted/course-:courseYear (small CAS pointer)
 */
export async function handlePutAccepted(
  request: Request,
  env: Env,
  courseYearStr: string,
): Promise<Response> {
  if (!verifyAuth(request, env)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const courseYear = parseSupportedCourseYear(courseYearStr);
  if (courseYear === null) {
    return unsupportedCourse(courseYearStr);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: `Invalid JSON body: ${(err as Error).message}` }, 400);
  }

  const validated = validatePointerRequest(body, courseYear);
  if (!validated.ok) {
    return jsonResponse({ error: validated.error }, 400);
  }

  const { expected_previous_accepted_id, pointer } = validated.request;

  // The pointer may only describe a payload that already exists and agrees with it field by field.
  const payloadObj = await env.R2_BUCKET.head(pointer.payload_key);
  if (!payloadObj) {
    return jsonResponse({ error: `Referenced payload ${pointer.payload_key} does not exist in storage` }, 400);
  }

  const meta = payloadObj.customMetadata;
  if (
    meta?.course_year !== String(courseYear) ||
    meta?.source_pdf_hash?.toLowerCase() !== pointer.source_pdf_hash.toLowerCase() ||
    meta?.source_pdf_url !== pointer.source_pdf_url ||
    meta?.payload_sha256?.toLowerCase() !== pointer.payload_sha256.toLowerCase() ||
    meta?.parser_version !== pointer.parser_version ||
    meta?.snapshot_id !== pointer.source_snapshot_id ||
    meta?.accepted_at !== pointer.accepted_at
  ) {
    return jsonResponse(
      {
        error: "Referenced payload metadata does not agree with pointer fields",
        expected_pointer: pointer,
        actual_metadata: meta,
      },
      400,
    );
  }

  const key = acceptedPointerKey(courseYear);
  const existingPointerObj = await env.R2_BUCKET.get(key);

  if (existingPointerObj) {
    let existingPointer: AcceptedPointer;
    try {
      existingPointer = (await existingPointerObj.json()) as AcceptedPointer;
    } catch {
      return jsonResponse({ error: "Corrupted existing accepted pointer in storage" }, 500);
    }

    if (existingPointer.accepted_id === pointer.accepted_id) {
      return jsonResponse({
        ok: true,
        status: "idempotent",
        message: "Pointer already accepted with identical accepted_id",
        accepted_id: pointer.accepted_id,
      });
    }

    if (existingPointer.accepted_id === expected_previous_accepted_id) {
      const putOptions: R2PutOptions = {
        onlyIf: { etagMatches: existingPointerObj.etag },
        httpMetadata: { contentType: "application/json" },
      };

      const putRes = await env.R2_BUCKET.put(key, JSON.stringify(pointer), putOptions);
      if (!putRes) {
        return jsonResponse(
          { error: "Conflict: concurrent write modified accepted pointer (CAS failure)", code: "CAS_CONFLICT" },
          409,
        );
      }

      return jsonResponse({ ok: true, status: "updated", accepted_id: pointer.accepted_id });
    }

    return jsonResponse(
      {
        error: `Conflict: current accepted_id (${existingPointer.accepted_id}) differs from expected (${expected_previous_accepted_id})`,
        current_accepted_id: existingPointer.accepted_id,
        expected_accepted_id: expected_previous_accepted_id,
      },
      409,
    );
  }

  if (expected_previous_accepted_id !== null) {
    return jsonResponse(
      {
        error: `Conflict: expected previous accepted_id (${expected_previous_accepted_id}) but no accepted state exists`,
      },
      409,
    );
  }

  const putRes = await env.R2_BUCKET.put(key, JSON.stringify(pointer), {
    onlyIf: IF_NONE_MATCH_COND,
    httpMetadata: { contentType: "application/json" },
  });
  if (!putRes) {
    return jsonResponse(
      { error: "Conflict: concurrent write created accepted pointer (CAS failure)", code: "CAS_CONFLICT" },
      409,
    );
  }

  return jsonResponse({ ok: true, status: "created", accepted_id: pointer.accepted_id }, 200);
}

/**
 * Handle GET /accepted/course-:courseYear (small CAS pointer)
 */
export async function handleGetAccepted(env: Env, courseYearStr: string): Promise<Response> {
  const courseYear = parseSupportedCourseYear(courseYearStr);
  if (courseYear === null) {
    return unsupportedCourse(courseYearStr);
  }

  const obj = await env.R2_BUCKET.get(acceptedPointerKey(courseYear));
  if (!obj) {
    return jsonResponse({ error: `No accepted state found for course ${courseYear}` }, 404);
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: obj.httpEtag,
      "Cache-Control": "public, max-age=15",
    },
  });
}
