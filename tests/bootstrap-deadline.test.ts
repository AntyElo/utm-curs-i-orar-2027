/**
 * Audit E-03 regression suite: `bootstrapScheduleState`'s `totalTimeoutMs` is a real wall-clock
 * bound.
 *
 * The defect these tests exist for is subtle and easy to reintroduce: an `AbortController` whose
 * signal is created but never handed to `fetch` looks like a timeout, logs like a timeout, and
 * bounds nothing. So every assertion here is on elapsed wall-clock time, not on a flag.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import { Deadline, DeadlineExceededError } from "@/lib/deadline";
import type { AcceptedPointer, Schedule } from "@/lib/models";
import { parsePdf, sha256 } from "@/lib/parser";
import { bootstrapScheduleState } from "@/lib/services/updater";
import { getCurrentSchedule, resetStorageCache } from "@/lib/storage";

/** Slack for scheduler jitter and one final microtask turn. */
const TOLERANCE_MS = 400;

const BROKER = "https://broker.fcim.internal";
const SEED_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf";

describe("Audit E-03: bootstrap total deadline is a real wall-clock bound", () => {
  let tempDir: string;
  let course1Schedule: Schedule;
  let course1Accepted: { pointer: AcceptedPointer; payloadBytes: Uint8Array };

  const originalBrokerUrl = config.brokerUrl;
  const originalDataDir = config.dataDir;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    const bytes = new Uint8Array(await readFile(path.join(__dirname, "..", "data", "seed", "anul_i_semestrul_i-18.pdf")));
    const { schedule } = await parsePdf(bytes, {
      source_page_url: "https://fcim.utm.md/procesul-de-studii/orar/",
      source_pdf_url: SEED_URL,
      source_kind: "live",
      source_transport: "broker",
      source_snapshot_id: "2026-09-08T02-08-48-000Z-7a3b4c19",
      downloaded_at: "2026-09-08T02:00:00.000Z",
      course_year: 1,
    });
    schedule.metadata.parser_version = config.parserVersion;
    course1Schedule = schedule;

    const payloadBytes = new TextEncoder().encode(JSON.stringify(schedule));
    const payloadSha256 = sha256(payloadBytes);
    const acceptedId = `${schedule.metadata.source_pdf_hash.slice(0, 16)}-p${config.parserVersion.replace(/\./g, "_")}-${payloadSha256.slice(0, 16)}`;
    course1Accepted = {
      payloadBytes,
      pointer: {
        schema_version: 1,
        course_year: 1,
        accepted_id: acceptedId,
        payload_key: `accepted-payloads/course-1/${acceptedId}.json`,
        payload_sha256: payloadSha256,
        source_snapshot_id: "2026-09-08T02-08-48-000Z-7a3b4c19",
        source_pdf_url: SEED_URL,
        source_pdf_hash: schedule.metadata.source_pdf_hash,
        parser_version: config.parserVersion,
        accepted_at: "2026-09-08T02:00:00.000Z",
      },
    };
  }, 120_000);

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "fcim-deadline-test-"));
    (config as { dataDir: string }).dataDir = tempDir;
    (config as { brokerUrl: string }).brokerUrl = BROKER;
    resetStorageCache();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    (config as { dataDir: string }).dataDir = originalDataDir;
    (config as { brokerUrl: string }).brokerUrl = originalBrokerUrl;
    resetStorageCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** A response whose headers arrive but whose body never completes. */
  function stallingBody(): Response {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"schema_version":1,'));
          // never closed
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  function neverResolves(signal?: AbortSignal | null): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) return;
      const abort = () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  function installBroker(handler: (url: string, init: RequestInit) => Promise<Response> | Response): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) =>
      handler(String(input), init)) as typeof fetch;
  }

  async function timeBootstrap(totalTimeoutMs: number): Promise<number> {
    const startedAt = Date.now();
    await bootstrapScheduleState({ totalTimeoutMs });
    return Date.now() - startedAt;
  }

  it("returns within the deadline when the course 1 accepted pointer stalls", async () => {
    installBroker(async (url, init) => {
      if (url.includes("/accepted/course-1")) return neverResolves(init.signal);
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });

    const elapsed = await timeBootstrap(300);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(300 + TOLERANCE_MS);
  });

  it("returns within the deadline when the course 2 accepted pointer stalls", async () => {
    installBroker(async (url, init) => {
      if (url.includes("/accepted/course-2")) return neverResolves(init.signal);
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });

    const elapsed = await timeBootstrap(300);
    expect(elapsed).toBeLessThan(300 + TOLERANCE_MS);
  });

  it("returns within the deadline when every accepted pointer stalls", async () => {
    installBroker(async (_url, init) => neverResolves(init.signal));

    const elapsed = await timeBootstrap(400);
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(400 + TOLERANCE_MS);

    // Nothing was restored, and nothing was left half-written.
    expect(await getCurrentSchedule(1)).toBeNull();
    expect(await getCurrentSchedule(2)).toBeNull();
  });

  it("returns within the deadline when a payload stalls after its headers", async () => {
    installBroker(async (url) => {
      if (url.includes("/accepted/course-1")) {
        return new Response(JSON.stringify(course1Accepted.pointer), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/accepted-payloads/course-1/")) {
        return stallingBody();
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });

    const elapsed = await timeBootstrap(350);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(350 + TOLERANCE_MS);
    expect(await getCurrentSchedule(1)).toBeNull();
  });

  it("restores one course from the broker while the other stalls, still inside the deadline", async () => {
    installBroker(async (url, init) => {
      if (url.includes("/accepted/course-1")) {
        return new Response(JSON.stringify(course1Accepted.pointer), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/accepted-payloads/course-1/")) {
        return new Response(Buffer.from(course1Accepted.payloadBytes), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return neverResolves(init.signal);
    });

    // A real broker restore also verifies a SHA-256 and revalidates a full Schedule, which is
    // CPU work; the budget here is the production-shaped one rather than a few hundred ms.
    const elapsed = await timeBootstrap(3_000);
    expect(elapsed).toBeLessThan(3_000 + TOLERANCE_MS);

    const restored = await getCurrentSchedule(1);
    expect(restored).not.toBeNull();
    expect(restored!.metadata.course_year).toBe(1);
    expect(restored!.metadata.source_pdf_hash).toBe(course1Schedule.metadata.source_pdf_hash);
    // 'live' proves it came from the broker's accepted payload, not from the bundled seed.
    expect(restored!.metadata.source_kind).toBe('live');

    // Course 2 stalled and was abandoned rather than left blocking startup.
    expect(await getCurrentSchedule(2)).toBeNull();
  });

  it("does not start bundled seed restoration once the budget is gone", async () => {
    // Both broker lookups stall, so the deadline is already spent by the time the seed fallback
    // is considered; the seed parse is CPU-bound and must not be started without budget.
    installBroker(async (_url, init) => neverResolves(init.signal));

    const elapsed = await timeBootstrap(250);
    expect(elapsed).toBeLessThan(250 + TOLERANCE_MS);
    expect(await getCurrentSchedule(1)).toBeNull();
    expect(await getCurrentSchedule(2)).toBeNull();
  });

  it("still falls back to the bundled seed when the broker answers 404 within budget", async () => {
    installBroker(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }));

    await bootstrapScheduleState({ totalTimeoutMs: 60_000 });

    const course1 = await getCurrentSchedule(1);
    expect(course1).not.toBeNull();
    expect(course1!.metadata.source_kind).toBe("seed");
    expect(course1!.metadata.course_year).toBe(1);
  }, 120_000);
});

describe("Deadline", () => {
  it("reports the remaining budget and expires exactly once", async () => {
    const deadline = new Deadline(120);
    try {
      expect(deadline.remaining()).toBeLessThanOrEqual(120);
      expect(deadline.expired).toBe(false);

      await expect(deadline.race(new Promise(() => {}))).rejects.toThrow(DeadlineExceededError);

      expect(deadline.expired).toBe(true);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.remaining()).toBeLessThanOrEqual(0);
      expect(deadline.elapsed()).toBeGreaterThanOrEqual(100);
    } finally {
      deadline.dispose();
    }
  });

  it("lets work that finishes first through untouched", async () => {
    const deadline = new Deadline(5_000);
    try {
      await expect(deadline.race(Promise.resolve("done"))).resolves.toBe("done");
      expect(deadline.expired).toBe(false);
    } finally {
      deadline.dispose();
    }
  });

  it("aborts the shared signal so in-flight requests stop too", async () => {
    const deadline = new Deadline(80);
    try {
      const aborted = new Promise<boolean>((resolve) => {
        deadline.signal.addEventListener("abort", () => resolve(true), { once: true });
      });
      await expect(aborted).resolves.toBe(true);
    } finally {
      deadline.dispose();
    }
  });
});
