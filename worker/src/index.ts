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

const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: headers ? { ...JSON_HEADERS, ...headers } : JSON_HEADERS,
  });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const reqUrl = request.url;
    const method = request.method;

    // 1. Fast-path manual / diagnostic publish trigger: POST /publish
    if (method === "POST" && (reqUrl.endsWith("/publish") || reqUrl.includes("/publish?"))) {
      const auth = request.headers.get("Authorization");
      if (!env.SCHEDULE_BROKER_SECRET || auth !== `Bearer ${env.SCHEDULE_BROKER_SECRET}`) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      const force = reqUrl.includes("force=1") || reqUrl.includes("force=true");
      const result = await publishCandidateSnapshot(env, { force });
      const status = result.published || result.reason ? 200 : (result.conflict ? 409 : 500);
      return jsonResponse(result, status);
    }

    const url = new URL(reqUrl);
    const path = url.pathname;

    // 2. Current pointer: GET /current or GET /current.json
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

    // 3. Snapshot Assets: /snapshots/*
    if (path.startsWith("/snapshots/")) {
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
    }

    // 4. Accepted Immutable Payloads: /accepted-payloads/course-:courseYear/:acceptedId
    if (path.startsWith("/accepted-payloads/")) {
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
    }

    // 5. Accepted CAS Pointer: /accepted/course-:courseYear
    if (path.startsWith("/accepted/")) {
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

