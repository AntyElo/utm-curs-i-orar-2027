/**
 * Cloudflare Worker accepted-state persistence gateway.
 *
 * Implements CPU-light split architecture:
 * 1. Streamed immutable payload (/accepted-payloads/course-:year/:acceptedId)
 *    - Authenticated, create-only streaming upload directly into R2
 *    - No parsing or buffering of ~200 KB Schedule in Worker memory
 *    - Custom metadata cross-check
 * 2. Small CAS pointer (/accepted/course-:year)
 *    - Authenticated, small JSON record (~300 bytes)
 *    - Cross-checks referenced payload metadata in R2
 *    - Stale-safe conditional CAS write via ETag match or If-None-Match: *
 *    - Idempotent on accepted_id match
 */

import type {
  AcceptedPointer,
  AcceptedPointerWriteRequest,
  Env,
  R2PutOptions,
} from "./types";

const SAFE_ID_REGEX = /^[a-zA-Z0-9._-]+$/;
const HEX_64_REGEX = /^[a-f0-9]{64}$/i;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MB limit for serialized schedule
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

function verifyAuth(request: Request, env: Env): boolean {
  if (!env.SCHEDULE_BROKER_SECRET) {
    console.error("SCHEDULE_BROKER_SECRET is not configured in worker environment");
    return false;
  }
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;
  const expected = `Bearer ${env.SCHEDULE_BROKER_SECRET}`;
  return authHeader.trim() === expected;
}

/**
 * Handle PUT /accepted-payloads/course-:courseYear/:acceptedId
 * Stream serialized Schedule JSON directly into R2 with If-None-Match: *
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

  const courseYear = Number.parseInt(courseYearStr, 10);
  if (!Number.isFinite(courseYear) || courseYear <= 0) {
    return jsonResponse({ error: "Invalid course year in path" }, 400);
  }

  if (!SAFE_ID_REGEX.test(acceptedId) || acceptedId.length > 128) {
    return jsonResponse({ error: "Invalid accepted_id syntax" }, 400);
  }

  const contentType = request.headers.get("Content-Type");
  if (!contentType || !contentType.toLowerCase().includes("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json" }, 400);
  }

  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader) {
    const declaredSize = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_PAYLOAD_BYTES) {
      return jsonResponse({ error: `Payload exceeds size limit of ${MAX_PAYLOAD_BYTES} bytes` }, 413);
    }
  }

  // Metadata headers
  const sourcePdfHash = request.headers.get("x-source-pdf-hash");
  const payloadSha256 = request.headers.get("x-payload-sha256");
  const snapshotId = request.headers.get("x-snapshot-id");
  const parserVersion = request.headers.get("x-parser-version");

  if (!sourcePdfHash || !HEX_64_REGEX.test(sourcePdfHash)) {
    return jsonResponse({ error: "Header x-source-pdf-hash must be 64-char SHA-256 hex" }, 400);
  }
  if (!payloadSha256 || !HEX_64_REGEX.test(payloadSha256)) {
    return jsonResponse({ error: "Header x-payload-sha256 must be 64-char SHA-256 hex" }, 400);
  }
  if (!snapshotId || !SAFE_ID_REGEX.test(snapshotId)) {
    return jsonResponse({ error: "Header x-snapshot-id is required" }, 400);
  }
  if (!parserVersion) {
    return jsonResponse({ error: "Header x-parser-version is required" }, 400);
  }

  if (!request.body) {
    return jsonResponse({ error: "Request body is empty" }, 400);
  }

  const payloadKey = `accepted-payloads/course-${courseYear}/${acceptedId}.json`;
  const customMetadata: Record<string, string> = {
    course_year: String(courseYear),
    source_pdf_hash: sourcePdfHash.toLowerCase(),
    payload_sha256: payloadSha256.toLowerCase(),
    snapshot_id: snapshotId,
    parser_version: parserVersion,
  };

  // Check if object already exists
  const existing = await env.R2_BUCKET.head(payloadKey);
  if (existing) {
    const meta = existing.customMetadata;
    const sameCourse = meta?.course_year === String(courseYear);
    const sameSourceHash = meta?.source_pdf_hash?.toLowerCase() === sourcePdfHash.toLowerCase();
    const samePayloadHash = meta?.payload_sha256?.toLowerCase() === payloadSha256.toLowerCase();
    const sameParser = meta?.parser_version === parserVersion;

    if (sameCourse && sameSourceHash && samePayloadHash && sameParser) {
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

  // Stream directly into R2.put with If-None-Match: *
  const putRes = await env.R2_BUCKET.put(payloadKey, request.body, {
    onlyIf: IF_NONE_MATCH_COND,
    httpMetadata: { contentType: "application/json" },
    customMetadata,
  });

  if (!putRes) {
    return jsonResponse(
      {
        error: `Conflict: concurrent write created immutable payload ${payloadKey}`,
        code: "PAYLOAD_CONFLICT",
      },
      409,
    );
  }

  return jsonResponse(
    {
      ok: true,
      status: "created",
      accepted_id: acceptedId,
      payload_key: payloadKey,
    },
    200,
  );
}

/**
 * Handle GET /accepted-payloads/course-:courseYear/:acceptedId
 * Stream immutable payload body from R2
 */
export async function handleGetAcceptedPayload(
  env: Env,
  courseYearStr: string,
  acceptedId: string,
): Promise<Response> {
  const courseYear = Number.parseInt(courseYearStr, 10);
  if (!Number.isFinite(courseYear) || courseYear <= 0) {
    return jsonResponse({ error: "Invalid course year in path" }, 400);
  }

  if (!SAFE_ID_REGEX.test(acceptedId)) {
    return jsonResponse({ error: "Invalid accepted_id syntax" }, 400);
  }

  const payloadKey = `accepted-payloads/course-${courseYear}/${acceptedId}.json`;
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
 * Validate that the request payload conforms to the accepted-state pointer contract.
 */
function validatePointerRequest(
  payload: unknown,
  expectedCourseYear: number,
): { ok: true; request: AcceptedPointerWriteRequest } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") {
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
  if (!pointer || typeof pointer !== "object") {
    return { ok: false, error: "pointer object is required" };
  }

  if (pointer.schema_version !== 1) {
    return { ok: false, error: "schema_version must be 1" };
  }

  if (pointer.course_year !== expectedCourseYear) {
    return {
      ok: false,
      error: `course_year ${pointer.course_year} does not match requested course ${expectedCourseYear}`,
    };
  }

  if (!pointer.accepted_id || !SAFE_ID_REGEX.test(pointer.accepted_id)) {
    return { ok: false, error: "accepted_id must be alphanumeric with safe symbols" };
  }

  const expectedPayloadKey = `accepted-payloads/course-${expectedCourseYear}/${pointer.accepted_id}.json`;
  if (pointer.payload_key !== expectedPayloadKey) {
    return {
      ok: false,
      error: `payload_key ${pointer.payload_key} does not match expected ${expectedPayloadKey}`,
    };
  }

  if (!pointer.payload_sha256 || !HEX_64_REGEX.test(pointer.payload_sha256)) {
    return { ok: false, error: "payload_sha256 must be 64-character hex" };
  }

  if (!pointer.source_pdf_hash || !HEX_64_REGEX.test(pointer.source_pdf_hash)) {
    return { ok: false, error: "source_pdf_hash must be 64-character hex" };
  }

  if (!pointer.source_snapshot_id || typeof pointer.source_snapshot_id !== "string") {
    return { ok: false, error: "source_snapshot_id is required" };
  }

  if (!pointer.source_pdf_url || typeof pointer.source_pdf_url !== "string") {
    return { ok: false, error: "source_pdf_url is required" };
  }

  if (!pointer.parser_version || typeof pointer.parser_version !== "string") {
    return { ok: false, error: "parser_version is required" };
  }

  return { ok: true, request: req as AcceptedPointerWriteRequest };
}

/**
 * Handle PUT /accepted/course-:courseYear (Small CAS Pointer)
 */
export async function handlePutAccepted(
  request: Request,
  env: Env,
  courseYearStr: string,
): Promise<Response> {
  if (!verifyAuth(request, env)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const courseYear = Number.parseInt(courseYearStr, 10);
  if (!Number.isFinite(courseYear) || courseYear <= 0) {
    return jsonResponse({ error: "Invalid course year in path" }, 400);
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

  // Cross-check: Verify referenced payload exists and R2 custom metadata matches
  const payloadObj = await env.R2_BUCKET.head(pointer.payload_key);
  if (!payloadObj) {
    return jsonResponse(
      {
        error: `Referenced payload ${pointer.payload_key} does not exist in storage`,
      },
      400,
    );
  }

  const meta = payloadObj.customMetadata;
  if (
    meta?.course_year !== String(courseYear) ||
    meta?.source_pdf_hash?.toLowerCase() !== pointer.source_pdf_hash.toLowerCase() ||
    meta?.payload_sha256?.toLowerCase() !== pointer.payload_sha256.toLowerCase() ||
    meta?.parser_version !== pointer.parser_version ||
    meta?.snapshot_id !== pointer.source_snapshot_id
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

  const key = `accepted/course-${courseYear}.json`;
  const existingPointerObj = await env.R2_BUCKET.get(key);

  if (existingPointerObj) {
    let existingPointer: AcceptedPointer;
    try {
      existingPointer = (await existingPointerObj.json()) as AcceptedPointer;
    } catch {
      return jsonResponse({ error: "Corrupted existing accepted pointer in storage" }, 500);
    }

    // 1. Current accepted_id == incoming accepted_id -> Idempotent success
    if (existingPointer.accepted_id === pointer.accepted_id) {
      return jsonResponse({
        ok: true,
        status: "idempotent",
        message: "Pointer already accepted with identical accepted_id",
        accepted_id: pointer.accepted_id,
      });
    }

    // 2. Current accepted_id == expected_previous_accepted_id -> CAS update
    if (existingPointer.accepted_id === expected_previous_accepted_id) {
      const putOptions: R2PutOptions = {
        onlyIf: { etagMatches: existingPointerObj.etag },
        httpMetadata: { contentType: "application/json" },
      };

      const putRes = await env.R2_BUCKET.put(key, JSON.stringify(pointer), putOptions);
      if (!putRes) {
        return jsonResponse(
          {
            error: "Conflict: concurrent write modified accepted pointer (CAS failure)",
            code: "CAS_CONFLICT",
          },
          409,
        );
      }

      return jsonResponse({
        ok: true,
        status: "updated",
        accepted_id: pointer.accepted_id,
      });
    }

    // 3. Current accepted_id differs from expected -> 409 Conflict
    return jsonResponse(
      {
        error: `Conflict: current accepted_id (${existingPointer.accepted_id}) differs from expected (${expected_previous_accepted_id})`,
        current_accepted_id: existingPointer.accepted_id,
        expected_accepted_id: expected_previous_accepted_id,
      },
      409,
    );
  }

  // Pointer does not exist yet
  if (expected_previous_accepted_id !== null) {
    return jsonResponse(
      {
        error: `Conflict: expected previous accepted_id (${expected_previous_accepted_id}) but no accepted state exists`,
      },
      409,
    );
  }

  // Initial pointer creation: use HTTP If-None-Match: *
  const putOptions: R2PutOptions = {
    onlyIf: IF_NONE_MATCH_COND,
    httpMetadata: { contentType: "application/json" },
  };

  const putRes = await env.R2_BUCKET.put(key, JSON.stringify(pointer), putOptions);
  if (!putRes) {
    return jsonResponse(
      {
        error: "Conflict: concurrent write created accepted pointer (CAS failure)",
        code: "CAS_CONFLICT",
      },
      409,
    );
  }

  return jsonResponse(
    {
      ok: true,
      status: "created",
      accepted_id: pointer.accepted_id,
    },
    200,
  );
}

/**
 * Handle GET /accepted/course-:courseYear (Small CAS Pointer)
 */
export async function handleGetAccepted(env: Env, courseYearStr: string): Promise<Response> {
  const courseYear = Number.parseInt(courseYearStr, 10);
  if (!Number.isFinite(courseYear) || courseYear <= 0) {
    return jsonResponse({ error: "Invalid course year in path" }, 400);
  }

  const key = `accepted/course-${courseYear}.json`;
  const obj = await env.R2_BUCKET.get(key);
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

