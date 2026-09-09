/**
 * Cloudflare Worker entry point for the FCIM Schedule Broker.
 *
 * HTTP routes (matched exactly — a path that merely *contains* a route never reaches its handler):
 * - GET  /health
 * - GET  /current | /current.json                -> newest complete snapshot pointer
 * - GET  /snapshots/:id/manifest.json            -> immutable candidate manifest
 * - GET  /snapshots/:id/page-api.json            -> immutable Page API payload
 * - GET  /snapshots/:id/pdfs/:filename           -> immutable candidate PDF
 * - GET  /accepted/course-:year                  -> authoritative accepted-state pointer
 * - PUT  /accepted/course-:year                  -> authenticated CAS pointer write
 * - GET  /accepted-payloads/course-:year/:id     -> immutable accepted payload
 * - PUT  /accepted-payloads/course-:year/:id     -> authenticated streamed payload write
 * - POST /publish                                -> authenticated discovery trigger
 *
 * Cron trigger  -> discovery + reconciliation
 * Queue consumer -> one bounded publication stage per invocation
 */

import { isSafeOfficialPdfFilename } from "../../worker-shared/fcim-policy";
import {
  handleGetAccepted,
  handleGetAcceptedPayload,
  handlePutAccepted,
  handlePutAcceptedPayload,
} from "./accepted-handler";
import { buildDiscoverJob, buildReconcileJob, validateJob } from "./jobs";
import { snapshotManifestKey, snapshotPageApiKey, snapshotPdfKey } from "./keys";
import { SNAPSHOT_ID_REGEX } from "./pointer";
import { runDiscovery, runFinalize, runPdfIngest, runReconcile } from "./publisher";
import type {
  Env,
  ExecutionContext,
  PublicationJob,
  QueueMessageBatch,
  ScheduledEvent,
} from "./types";

const JSON_HEADERS = { "Content-Type": "application/json" };

const COURSE_TOKEN_REGEX = /^course-(\d{1,3})$/;
const RETRY_DELAY_SECONDS = 300;

function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: headers ? { ...JSON_HEADERS, ...headers } : JSON_HEADERS,
  });
}

function notFound(): Response {
  return jsonResponse({ error: "Not found" }, 404);
}

/** Stream an immutable snapshot child straight back to the caller. */
async function serveImmutable(
  env: Env,
  key: string,
  contentType: string,
  maxAgeSeconds: number,
): Promise<Response> {
  const obj = await env.R2_BUCKET.get(key);
  if (!obj) {
    return jsonResponse({ error: `Not found: ${key}` }, 404);
  }
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? contentType,
      ETag: obj.httpEtag,
      "Cache-Control": `public, max-age=${maxAgeSeconds}, immutable`,
    },
  });
}

/**
 * `POST /publish` is authenticated and side-effecting, so it is matched on the parsed URL and
 * nothing else. `/foo/publish`, `/publish/extra` and any query but `force=1` are 404/400 before
 * the secret is even compared — a route must not be reachable by resembling one.
 */
async function handlePublish(request: Request, env: Env, search: string): Promise<Response> {
  if (search !== "" && search !== "?force=1") {
    return jsonResponse({ error: "Only the exact query force=1 is accepted on /publish" }, 400);
  }

  const auth = request.headers.get("Authorization");
  if (!env.SCHEDULE_BROKER_SECRET || auth !== `Bearer ${env.SCHEDULE_BROKER_SECRET}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const force = search === "?force=1";
  await env.PUBLICATION_QUEUE.send(buildDiscoverJob(force));
  return jsonResponse({ outcome: "queued", stage: "discover", force }, 202);
}

const worker = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const segments = path.split("/").filter((segment) => segment.length > 0);

    if (path === "/publish") {
      if (method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }
      return handlePublish(request, env, url.search);
    }

    if (path === "/health") {
      if (method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
      return jsonResponse({ ok: true, timestamp: new Date().toISOString() });
    }

    if (path === "/current" || path === "/current.json") {
      if (method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
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

    // /snapshots/:id/manifest.json | page-api.json | pdfs/:filename
    if (segments[0] === "snapshots") {
      if (method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
      const snapshotId = segments[1];
      if (!snapshotId || !SNAPSHOT_ID_REGEX.test(snapshotId)) return notFound();

      if (segments.length === 3 && segments[2] === "manifest.json") {
        return serveImmutable(env, snapshotManifestKey(snapshotId), "application/json", 3600);
      }
      if (segments.length === 3 && segments[2] === "page-api.json") {
        return serveImmutable(env, snapshotPageApiKey(snapshotId), "application/json", 3600);
      }
      if (segments.length === 4 && segments[2] === "pdfs" && isSafeOfficialPdfFilename(segments[3])) {
        return serveImmutable(env, snapshotPdfKey(snapshotId, segments[3]), "application/pdf", 86400);
      }
      return notFound();
    }

    // /accepted-payloads/course-:year/:acceptedId
    if (segments[0] === "accepted-payloads") {
      if (segments.length !== 3) return notFound();
      const courseMatch = COURSE_TOKEN_REGEX.exec(segments[1]);
      if (!courseMatch) return notFound();
      const acceptedId = segments[2];

      if (method === "GET") return handleGetAcceptedPayload(env, courseMatch[1], acceptedId);
      if (method === "PUT") return handlePutAcceptedPayload(request, env, courseMatch[1], acceptedId);
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    // /accepted/course-:year
    if (segments[0] === "accepted") {
      if (segments.length !== 2) return notFound();
      const courseMatch = COURSE_TOKEN_REGEX.exec(segments[1]);
      if (!courseMatch) return notFound();

      if (method === "GET") return handleGetAccepted(env, courseMatch[1]);
      if (method === "PUT") return handlePutAccepted(request, env, courseMatch[1]);
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    return notFound();
  },

  /**
   * Cron is deliberately producer-only: both operations run in fresh Queue invocations, keeping
   * the scheduled invocation safely below the Free plan's 10 ms CPU limit.
   */
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await env.PUBLICATION_QUEUE.send(buildDiscoverJob());
    await env.PUBLICATION_QUEUE.send(buildReconcileJob());
    console.log(`cron ${new Date(event.scheduledTime).toISOString()}: queued discovery and reconciliation`);
  },

  /**
   * Queue consumer. The queue is configured with a batch size of one, so every message is its
   * own invocation with its own CPU budget — that is the whole point of the split.
   */
  async queue(
    batch: QueueMessageBatch<PublicationJob>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    for (const message of batch.messages) {
      const validated = validateJob(message.body);
      if (!validated.ok) {
        // This is a deterministic poison message. Retrying it cannot change the outcome.
        console.error(`rejected publication job ${message.id}: ${validated.error}`);
        message.ack();
        continue;
      }

      const job = validated.job;
      try {
        if (job.kind === "discover") {
          const result = await runDiscovery(env, { force: job.force });
          console.log("discover:", JSON.stringify(result));
          if (result.outcome === "error") {
            if (result.retryable) message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
            else message.ack();
            continue;
          }
        } else if (job.kind === "ingest_pdf") {
          const result = await runPdfIngest(env, job);
          console.log("ingest:", JSON.stringify(result));
          if (result.outcome === "error" || result.outcome === "conflict") {
            if (result.retryable) message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
            else message.ack();
            continue;
          }
        } else if (job.kind === "finalize") {
          const result = await runFinalize(env, job.snapshot_id);
          console.log("finalize:", JSON.stringify(result));
          if (result.outcome === "error") {
            if (result.retryable) message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
            else message.ack();
            continue;
          }
        } else {
          const result = await runReconcile(env);
          console.log("reconcile:", JSON.stringify(result));
          if (result.outcome === "error") {
            if (result.retryable) message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
            else message.ack();
            continue;
          }
        }
        message.ack();
      } catch (err) {
        console.error(`publication job ${message.id} threw:`, (err as Error).message);
        message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      }
    }
  },
};

export default worker;
