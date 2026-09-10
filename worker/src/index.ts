/**
 * Cloudflare Worker entry point for the FCIM Schedule Broker.
 *
 * Public/read routes (matched exactly — a path that merely *contains* a route never reaches its
 * handler):
 * - GET  /health
 * - GET  /current | /current.json                -> newest complete snapshot pointer
 * - GET  /snapshots/:id/manifest.json            -> immutable candidate manifest
 * - GET  /snapshots/:id/page-api.json            -> immutable Page API payload
 * - GET  /snapshots/:id/pdfs/:filename           -> immutable candidate PDF
 *
 * Accepted-state routes (SCHEDULE_BROKER_SECRET only — Render):
 * - GET  /accepted/course-:year                  -> authoritative accepted-state pointer
 * - PUT  /accepted/course-:year                  -> authenticated CAS pointer write
 * - GET  /accepted-payloads/course-:year/:id     -> immutable accepted payload
 * - PUT  /accepted-payloads/course-:year/:id     -> authenticated streamed payload write
 *
 * MD Publisher routes (MD_PUBLISHER_TOKEN only — the Moldova laptop):
 * - POST /publications                           -> open or resume a publication
 * - GET  /publications/:snapshot_id              -> broker-generated plan and upload state
 * - PUT  /publications/:snapshot_id/files/:id    -> one checksum-validated PDF body
 * - POST /publications/:snapshot_id/complete     -> close the snapshot; may advance current.json
 * - PUT  /publisher/heartbeat                    -> bounded liveness
 * - GET  /publication-status                     -> bounded operational state
 *
 * The two credentials are never interchangeable, and neither grants the other's powers.
 *
 * Cron trigger  -> enqueue reconciliation only
 * Queue consumer -> finalize or reconcile, one per invocation
 *
 * Nothing reachable from `scheduled()` or `queue()` performs an FCIM request. Candidate bytes
 * enter this Worker only through an authenticated MD Publisher upload.
 */

import { isSafeOfficialPdfFilename } from "../../worker-shared/fcim-policy";
import {
  handleGetAccepted,
  handleGetAcceptedPayload,
  handlePutAccepted,
  handlePutAcceptedPayload,
} from "./accepted-handler";
import { buildReconcileJob, validateJob } from "./jobs";
import { snapshotManifestKey, snapshotPageApiKey, snapshotPdfKey } from "./keys";
import {
  handleCompletePublication,
  handleGetPublication,
  handleOpenPublication,
  handlePublicationStatus,
  handlePublisherHeartbeat,
  handleUploadPublicationFile,
} from "./publication-api";
import { SNAPSHOT_ID_REGEX } from "./pointer";
import { runFinalize, runReconcile } from "./publisher";
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

function methodNotAllowed(): Response {
  return jsonResponse({ error: "Method not allowed" }, 405);
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

const worker = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const segments = path.split("/").filter((segment) => segment.length > 0);

    if (path === "/health") {
      if (method !== "GET") return methodNotAllowed();
      return jsonResponse({ ok: true, timestamp: new Date().toISOString() });
    }

    if (path === "/publication-status") {
      if (method !== "GET") return methodNotAllowed();
      return handlePublicationStatus(request, env);
    }

    if (path === "/publisher/heartbeat") {
      if (method !== "PUT") return methodNotAllowed();
      return handlePublisherHeartbeat(request, env);
    }

    // MD Publisher ingestion. Every path component below is validated by the handler against the
    // broker's own descriptor before it can address storage.
    if (segments[0] === "publications") {
      if (segments.length === 1) {
        if (method !== "POST") return methodNotAllowed();
        return handleOpenPublication(request, env);
      }

      const snapshotId = segments[1];
      if (!snapshotId || !SNAPSHOT_ID_REGEX.test(snapshotId)) return notFound();

      if (segments.length === 2) {
        if (method !== "GET") return methodNotAllowed();
        return handleGetPublication(request, env, snapshotId);
      }
      if (segments.length === 3 && segments[2] === "complete") {
        if (method !== "POST") return methodNotAllowed();
        return handleCompletePublication(request, env, snapshotId);
      }
      if (segments.length === 4 && segments[2] === "files") {
        if (method !== "PUT") return methodNotAllowed();
        return handleUploadPublicationFile(request, env, snapshotId, segments[3]);
      }
      return notFound();
    }

    if (path === "/current" || path === "/current.json") {
      if (method !== "GET") return methodNotAllowed();
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
      if (method !== "GET") return methodNotAllowed();
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
      return methodNotAllowed();
    }

    // /accepted/course-:year
    if (segments[0] === "accepted") {
      if (segments.length !== 2) return notFound();
      const courseMatch = COURSE_TOKEN_REGEX.exec(segments[1]);
      if (!courseMatch) return notFound();

      if (method === "GET") return handleGetAccepted(env, courseMatch[1]);
      if (method === "PUT") return handlePutAccepted(request, env, courseMatch[1]);
      return methodNotAllowed();
    }

    return notFound();
  },

  /**
   * Cron is producer-only and now enqueues nothing but reconciliation.
   *
   * There is no scheduled discovery any more: the broker never initiates an upstream request, so
   * a cron tick can only re-drive work that already exists in storage and run bounded retention.
   */
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await env.PUBLICATION_QUEUE.send(buildReconcileJob());
    console.log(`cron ${new Date(event.scheduledTime).toISOString()}: queued reconciliation`);
  },

  /**
   * Queue consumer. The queue is configured with a batch size of one, so every message is its
   * own invocation with its own CPU budget.
   *
   * Only `finalize` and `reconcile` exist. A surviving `discover` or `ingest_pdf` message — from
   * before the cutover, or a replay — fails validation and is acked without being executed.
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
        if (job.kind === "finalize") {
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
