/**
 * Cloudflare Worker accepted-state persistence gateway.
 *
 * Implements strict CAS and idempotent updates for durable accepted state:
 * - Bearer authorization check with SCHEDULE_BROKER_SECRET
 * - Strict course parameter routing (/accepted/course-:year)
 * - Schema validation: course_year == schedule.metadata.course_year == requested course
 * - Idempotent PUT if existing hash == new hash
 * - Stale-safe conditional CAS write if existing hash == expected_previous_hash
 * - 409 Conflict if existing hash differs from both or CAS fails
 */

import type { AcceptedRecord, AcceptedWriteRequest, Env, R2PutOptions } from "./types";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
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
 * Validate that the request payload conforms to the accepted-state contract.
 */
function validateAcceptedRequest(
  payload: unknown,
  expectedCourseYear: number,
): { ok: true; request: AcceptedWriteRequest } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Payload must be a JSON object" };
  }

  const req = payload as Partial<AcceptedWriteRequest>;
  if (req.expected_previous_hash !== null && typeof req.expected_previous_hash !== "string") {
    return { ok: false, error: "expected_previous_hash must be a string or null" };
  }

  const state = req.state;
  if (!state || typeof state !== "object") {
    return { ok: false, error: "state object is required" };
  }

  if (state.schema_version !== 1) {
    return { ok: false, error: "schema_version must be 1" };
  }

  if (state.course_year !== expectedCourseYear) {
    return {
      ok: false,
      error: `course_year ${state.course_year} does not match requested course ${expectedCourseYear}`,
    };
  }

  if (!state.source_pdf_hash || typeof state.source_pdf_hash !== "string" || state.source_pdf_hash.length !== 64) {
    return { ok: false, error: "source_pdf_hash must be a 64-character SHA-256 hash" };
  }

  const schedule = state.schedule;
  if (!schedule || typeof schedule !== "object") {
    return { ok: false, error: "schedule object is required" };
  }

  const metadata = (schedule as { metadata?: { course_year?: unknown } }).metadata;
  if (!metadata || typeof metadata !== "object") {
    return { ok: false, error: "schedule.metadata is required" };
  }

  if (metadata.course_year !== expectedCourseYear) {
    return {
      ok: false,
      error: `schedule.metadata.course_year ${metadata.course_year} does not match requested course ${expectedCourseYear}`,
    };
  }

  return { ok: true, request: req as AcceptedWriteRequest };
}

/**
 * Handle PUT /accepted/course-:courseYear
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

  const validated = validateAcceptedRequest(body, courseYear);
  if (!validated.ok) {
    return jsonResponse({ error: validated.error }, 400);
  }

  const { expected_previous_hash, state } = validated.request;
  const key = `accepted/course-${courseYear}.json`;

  const existingObj = await env.R2_BUCKET.get(key);

  if (existingObj) {
    let existingRecord: AcceptedRecord;
    try {
      existingRecord = (await existingObj.json()) as AcceptedRecord;
    } catch {
      return jsonResponse({ error: "Corrupted existing accepted state in storage" }, 500);
    }

    // 1. Existing accepted hash == new hash -> Idempotent success
    if (existingRecord.source_pdf_hash === state.source_pdf_hash) {
      return jsonResponse({
        ok: true,
        status: "idempotent",
        message: "State already accepted with identical hash",
        source_pdf_hash: state.source_pdf_hash,
      });
    }

    // 2. Existing accepted hash == expected_previous_hash -> Attempt CAS write
    if (existingRecord.source_pdf_hash === expected_previous_hash) {
      const putOptions: R2PutOptions = {
        onlyIf: { etagMatches: existingObj.etag },
        httpMetadata: { contentType: "application/json" },
      };

      const putRes = await env.R2_BUCKET.put(key, JSON.stringify(state, null, 2), putOptions);
      if (!putRes) {
        return jsonResponse(
          {
            error: "Conflict: concurrent write modified accepted state (CAS failure)",
            code: "CAS_CONFLICT",
          },
          409,
        );
      }

      return jsonResponse({
        ok: true,
        status: "updated",
        source_pdf_hash: state.source_pdf_hash,
      });
    }

    // 3. Existing accepted hash differs from both -> Conflict
    return jsonResponse(
      {
        error: `Conflict: current accepted hash (${existingRecord.source_pdf_hash}) differs from expected (${expected_previous_hash})`,
        current_hash: existingRecord.source_pdf_hash,
        expected_hash: expected_previous_hash,
      },
      409,
    );
  }

  // Object does not exist yet
  if (expected_previous_hash !== null) {
    return jsonResponse(
      {
        error: `Conflict: expected previous hash (${expected_previous_hash}) but no accepted state exists`,
      },
      409,
    );
  }

  // Initial creation: use HTTP If-None-Match: *
  const putOptions: R2PutOptions = {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: { contentType: "application/json" },
  };

  const putRes = await env.R2_BUCKET.put(key, JSON.stringify(state, null, 2), putOptions);
  if (!putRes) {
    return jsonResponse(
      {
        error: "Conflict: concurrent write created accepted state (CAS failure)",
        code: "CAS_CONFLICT",
      },
      409,
    );
  }

  return jsonResponse(
    {
      ok: true,
      status: "created",
      source_pdf_hash: state.source_pdf_hash,
    },
    200,
  );
}

/**
 * Handle GET /accepted/course-:courseYear
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
