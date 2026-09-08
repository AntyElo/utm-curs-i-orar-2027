/**
 * Cloudflare Worker entry point for FCIM Schedule Broker.
 *
 * Routes:
 * - GET  /current                               -> Latest snapshot pointer
 * - GET  /snapshots/:id/manifest.json           -> Immutable candidate manifest
 * - GET  /snapshots/:id/pdfs/:filename          -> Immutable candidate PDF
 * - GET  /accepted/course-:year                 -> Authoritative accepted state
 * - PUT  /accepted/course-:year                 -> Authenticated CAS accepted-state persistence
 * - POST /publish                               -> Diagnostic / manual publication trigger
 *
 * Scheduled event:
 * - cron trigger                                -> Periodic candidate publication check
 */

import {
  handleGetAccepted,
  handleGetAcceptedPayload,
  handlePutAccepted,
  handlePutAcceptedPayload,
} from "./accepted-handler";
import { publishCandidateSnapshot } from "./publisher";
import type { Env, ExecutionContext, ScheduledEvent } from "./types";

function jsonResponse(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // 1. Current pointer: GET /current or GET /current.json
    if ((path === "/current" || path === "/current.json") && method === "GET") {
      const current = await env.R2_BUCKET.get("current.json");
      if (!current) {
        return jsonResponse({ error: "No candidate snapshots published yet" }, 404);
      }
      return new Response(current.body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: current.httpEtag,
          "Cache-Control": "public, max-age=10",
        },
      });
    }

    // 2. Snapshot Manifest: GET /snapshots/:id/manifest.json
    const manifestMatch = /^\/snapshots\/([^/]+)\/manifest\.json$/.exec(path);
    if (manifestMatch && method === "GET") {
      const snapshotId = manifestMatch[1];
      const manifest = await env.R2_BUCKET.get(`snapshots/${snapshotId}/manifest.json`);
      if (!manifest) {
        return jsonResponse({ error: `Manifest not found for snapshot ${snapshotId}` }, 404);
      }
      return new Response(manifest.body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: manifest.httpEtag,
          "Cache-Control": "public, max-age=3600, immutable",
        },
      });
    }

    // 3. Snapshot Page API: GET /snapshots/:id/page-api.json
    const pageApiMatch = /^\/snapshots\/([^/]+)\/page-api\.json$/.exec(path);
    if (pageApiMatch && method === "GET") {
      const snapshotId = pageApiMatch[1];
      const pageApiObj = await env.R2_BUCKET.get(`snapshots/${snapshotId}/page-api.json`);
      if (!pageApiObj) {
        return jsonResponse({ error: `page-api.json not found for snapshot ${snapshotId}` }, 404);
      }
      return new Response(pageApiObj.body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: pageApiObj.httpEtag,
          "Cache-Control": "public, max-age=3600, immutable",
        },
      });
    }

    // 4. Snapshot PDF: GET /snapshots/:id/pdfs/:filename
    const pdfMatch = /^\/snapshots\/([^/]+)\/pdfs\/([^/]+)$/.exec(path);
    if (pdfMatch && method === "GET") {
      const [_, snapshotId, filename] = pdfMatch;
      const pdfKey = `snapshots/${snapshotId}/pdfs/${filename}`;
      const pdfObj = await env.R2_BUCKET.get(pdfKey);
      if (!pdfObj) {
        return jsonResponse({ error: `PDF not found: ${pdfKey}` }, 404);
      }
      return new Response(pdfObj.body, {
        status: 200,
        headers: {
          "Content-Type": pdfObj.httpMetadata?.contentType ?? "application/pdf",
          ETag: pdfObj.httpEtag,
          "Cache-Control": "public, max-age=86400, immutable",
        },
      });
    }

    // 5. Accepted Immutable Payloads: /accepted-payloads/course-:courseYear/:acceptedId
    const payloadMatch = /^\/accepted-payloads\/course-(\d+)\/([^/]+)$/.exec(path);
    if (payloadMatch) {
      const [_, courseYear, acceptedId] = payloadMatch;
      if (method === "GET") {
        return handleGetAcceptedPayload(env, courseYear, acceptedId);
      }
      if (method === "PUT") {
        return handlePutAcceptedPayload(request, env, courseYear, acceptedId);
      }
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    // 6. Accepted CAS Pointer: /accepted/course-:courseYear
    const acceptedMatch = /^\/accepted\/course-(\d+)$/.exec(path);
    if (acceptedMatch) {
      const courseYear = acceptedMatch[1];
      if (method === "GET") {
        return handleGetAccepted(env, courseYear);
      }
      if (method === "PUT") {
        return handlePutAccepted(request, env, courseYear);
      }
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    // 7. Manual / diagnostic publish trigger: POST /publish
    if (path === "/publish" && method === "POST") {
      const auth = request.headers.get("Authorization");
      if (!env.SCHEDULE_BROKER_SECRET || auth !== `Bearer ${env.SCHEDULE_BROKER_SECRET}`) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
      const result = await publishCandidateSnapshot(env, { force });
      const status = result.published || result.reason ? 200 : (result.conflict ? 409 : 500);
      return jsonResponse(result, status);
    }

    // Health check
    if (path === "/health" && method === "GET") {
      return jsonResponse({ ok: true, timestamp: new Date().toISOString() });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Cron triggered at ${new Date(event.scheduledTime).toISOString()}`);
    const res = await publishCandidateSnapshot(env);
    console.log("Candidate publication cron result:", JSON.stringify(res));
    if (!res.published && !res.reason?.includes("unchanged")) {
      throw new Error(`Candidate publication failed: ${res.error ?? "Unknown error"}`);
    }
  },
};

export default worker;

