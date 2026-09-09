/**
 * Audit E-02 / NR-A regression suite: split candidate publication.
 *
 * Publication is four bounded stages joined by a queue, so the properties worth pinning down are
 * the ones that hold *between* invocations: discovery never publishes, an unfinished snapshot
 * never becomes current, every stage is safe to run twice, and a stale finalize loses the CAS.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/src/index";
import { pendingCompletionKey, pendingDescriptorKey, snapshotManifestKey, snapshotPageApiKey } from "../worker/src/keys";
import { buildDiscoverJob, buildIngestJob } from "../worker/src/jobs";
import { parseCurrentPointer } from "../worker/src/pointer";
import { runDiscovery, runFinalize, runPdfIngest, runReconcile } from "../worker/src/publisher";
import type {
  CompletionMarker,
  IngestPdfJob,
  PendingDescriptor,
  PublicationJob,
  QueueMessageBatch,
  SnapshotManifest,
} from "../worker/src/types";
import { createHarness, drainQueue, type WorkerHarness } from "./helpers/worker-doubles";

const PAGE_API_URL = "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view";
const UPLOAD_BASE = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09";

const PDF_BODY = new TextEncoder().encode("%PDF-1.4 fake timetable body");

interface PageOptions {
  modifiedGmt?: string;
  filenames?: string[];
  etag?: string | null;
}

function pagePayload(options: PageOptions = {}): string {
  const filenames = options.filenames ?? ["anul_i_semestrul_i-19.pdf", "anul_ii_semestrul_iii-13.pdf"];
  const anchors = filenames.map((name) => `<a href="${UPLOAD_BASE}/${name}">${name}</a>`).join("\n");
  return JSON.stringify([
    {
      id: 1739,
      modified_gmt: options.modifiedGmt ?? "2026-09-08T12:57:59",
      content: { rendered: `<p>Orar</p>${anchors}` },
    },
  ]);
}

interface FetchScript {
  page?: (request: Request) => Response | Promise<Response>;
  pdf?: (url: string, request: Request) => Response | Promise<Response>;
}

const restorers: (() => void)[] = [];

function installFetch(script: FetchScript): void {
  const original = globalThis.fetch;
  restorers.push(() => {
    globalThis.fetch = original;
  });

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const request = new Request(url, init as RequestInit);
    if (url.startsWith("https://fcim.utm.md/wp-json/")) {
      return script.page
        ? script.page(request)
        : new Response(pagePayload(), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith(".pdf")) {
      return script.pdf
        ? script.pdf(url, request)
        : new Response(PDF_BODY, {
            status: 200,
            headers: {
              "Content-Type": "application/pdf",
              "Content-Length": String(PDF_BODY.byteLength),
              ETag: '"pdf-1"',
            },
          });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

afterEach(() => {
  while (restorers.length) restorers.pop()!();
  vi.restoreAllMocks();
});

function harness(): WorkerHarness {
  return createHarness({ FCIM_PAGE_API_URL: PAGE_API_URL });
}

async function ingestJobsFor(h: WorkerHarness): Promise<IngestPdfJob[]> {
  return h.queue.sent.filter((job): job is IngestPdfJob => job.kind === "ingest_pdf");
}

async function publishFully(h: WorkerHarness): Promise<string> {
  const discovery = await runDiscovery(h.env, { force: true });
  expect(discovery.outcome).toBe("scheduled");
  await drainQueue(h, worker.queue);
  return discovery.snapshot_id!;
}

describe("split publication: discovery", () => {
  it("mirrors every strictly-valid official PDF, including names it cannot interpret", async () => {
    // NR-A: the deleted `anul_(i|ii)` filename filter would have starved discoverPdf() of these.
    installFetch({
      page: async () =>
        new Response(
          pagePayload({
            filenames: [
              "orar-licenta-anul-1.pdf",
              "orar-licenta-anul-2.pdf",
              "orar-master-2026-sem-3-anul-2-1.pdf",
              "orar_ses_toamna_fr-3.pdf",
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    const h = harness();
    const result = await runDiscovery(h.env);

    expect(result.outcome).toBe("scheduled");
    expect(result.files).toBe(4);

    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(result.snapshot_id!))!;
    expect(descriptor.files.map((f) => f.filename).sort()).toEqual([
      "orar-licenta-anul-1.pdf",
      "orar-licenta-anul-2.pdf",
      "orar-master-2026-sem-3-anul-2-1.pdf",
      "orar_ses_toamna_fr-3.pdf",
    ]);
  });

  it("gives two upload folders that share a basename their own object names", async () => {
    installFetch({
      page: async () =>
        new Response(
          JSON.stringify([
            {
              id: 1739,
              modified_gmt: "2026-09-08T12:57:59",
              content: {
                rendered: `
                  <a href="https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/orar.pdf">new</a>
                  <a href="https://fcim.utm.md/wp-content/uploads/sites/24/2026/08/orar.pdf">old</a>`,
              },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    const h = harness();
    const discovery = await runDiscovery(h.env);
    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(discovery.snapshot_id!))!;

    expect(new Set(descriptor.files.map((f) => f.r2_key)).size).toBe(2);
    expect(descriptor.files.map((f) => f.filename).sort()).toEqual(["2026-08-orar.pdf", "orar.pdf"]);

    await drainQueue(h, worker.queue);
    for (const file of descriptor.files) {
      expect(h.bucket.has(file.r2_key)).toBe(true);
    }
    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok && pointer.pointer.pdf_count).toBe(2);
  });

  it("writes only the page payload and the descriptor, and never touches current.json", async () => {
    installFetch({});
    const h = harness();

    const result = await runDiscovery(h.env);
    const snapshotId = result.snapshot_id!;

    expect(h.bucket.has(snapshotPageApiKey(snapshotId))).toBe(true);
    expect(h.bucket.has(pendingDescriptorKey(snapshotId))).toBe(true);
    expect(h.bucket.has(snapshotManifestKey(snapshotId))).toBe(false);
    expect(h.bucket.has("current.json")).toBe(false);

    // One bounded job per PDF, plus one backstop finalize.
    const kinds = h.queue.sent.map((job) => job.kind);
    expect(kinds.filter((k) => k === "ingest_pdf")).toHaveLength(2);
    expect(kinds.filter((k) => k === "finalize")).toHaveLength(1);
  });

  it("reports unchanged when modified_gmt, the PDF catalogue and every PDF are unchanged", async () => {
    installFetch({});
    const h = harness();
    await publishFully(h);

    installFetch({
      pdf: async (_url, request) =>
        request.headers.get("If-None-Match") === '"pdf-1"'
          ? new Response(null, { status: 304 })
          : new Response(PDF_BODY, { status: 200 }),
    });

    const second = await runDiscovery(h.env);
    expect(second.outcome).toBe("unchanged");
    expect(h.queue.ofKind("ingest_pdf")).toHaveLength(2); // nothing new scheduled
  });

  it("uses the immutable manifest to revalidate an exact legacy current pointer", async () => {
    installFetch({
      page: async () =>
        new Response(pagePayload(), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: '"page-legacy"' },
        }),
    });
    const h = harness();
    const snapshotId = await publishFully(h);
    const current = h.bucket.json<{ updated_at: string; manifest_r2_key: string }>("current.json")!;
    h.bucket.seed(
      "current.json",
      JSON.stringify({
        schema_version: 1,
        snapshot_id: snapshotId,
        updated_at: current.updated_at,
        manifest_r2_key: current.manifest_r2_key,
      }),
    );

    let pageRevalidated = false;
    let pdfsRevalidated = 0;
    installFetch({
      page: async (request) => {
        pageRevalidated = request.headers.get("If-None-Match") === '"page-legacy"';
        return new Response(null, { status: 304 });
      },
      pdf: async (_url, request) => {
        if (request.headers.get("If-None-Match") === '"pdf-1"') pdfsRevalidated += 1;
        return new Response(null, { status: 304 });
      },
    });

    const result = await runDiscovery(h.env);
    expect(result).toMatchObject({ outcome: "unchanged", previous_snapshot_id: snapshotId });
    expect(pageRevalidated).toBe(true);
    expect(pdfsRevalidated).toBe(2);
  });

  it("publishes again when the page catalogue gains a PDF", async () => {
    installFetch({});
    const h = harness();
    const first = await publishFully(h);

    installFetch({
      page: async () =>
        new Response(
          pagePayload({
            filenames: ["anul_i_semestrul_i-19.pdf", "anul_ii_semestrul_iii-13.pdf", "anul_iii_semestrul_v-5.pdf"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    const second = await runDiscovery(h.env);
    expect(second.outcome).toBe("scheduled");
    expect(second.snapshot_id).not.toBe(first);
    expect(second.files).toBe(3);
    expect(second.previous_snapshot_id).toBe(first);
  });
});

describe("split publication: error matrix", () => {
  const cases: { name: string; page: () => Response; expectError: RegExp }[] = [
    {
      name: "403 challenge",
      page: () => new Response("denied", { status: 403 }),
      expectError: /HTTP 403/,
    },
    {
      name: "500 upstream failure",
      page: () => new Response("boom", { status: 500 }),
      expectError: /HTTP 500/,
    },
    {
      name: "redirect",
      page: () => new Response(null, { status: 302, headers: { Location: "https://evil.example/page" } }),
      expectError: /redirect/i,
    },
  ];

  for (const testCase of cases) {
    it(`treats a Page API ${testCase.name} as an error, never as unchanged`, async () => {
      installFetch({ page: async () => testCase.page() });
      const h = harness();

      const result = await runDiscovery(h.env);
      expect(result.outcome).toBe("error");
      expect(result.error).toMatch(testCase.expectError);
      expect(h.bucket.has("current.json")).toBe(false);
    });
  }

  it("treats a Page API network failure as an error", async () => {
    installFetch({
      page: async () => {
        throw new Error("connection reset");
      },
    });
    const h = harness();

    const result = await runDiscovery(h.env);
    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/connection reset/);
  });

  it("leaves the previous current pointer untouched when discovery fails", async () => {
    installFetch({});
    const h = harness();
    const published = await publishFully(h);

    installFetch({ page: async () => new Response("denied", { status: 403 }) });
    const failed = await runDiscovery(h.env);

    expect(failed.outcome).toBe("error");
    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok && pointer.pointer.snapshot_id).toBe(published);
  });

  it("keeps authenticated HTTP producer-only and leaves discovery retry to the queue", async () => {
    const upstream = vi.fn();
    const original = globalThis.fetch;
    restorers.push(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = upstream as typeof fetch;
    const h = harness();
    const response = await worker.fetch(
      new Request("https://broker.local/publish", {
        method: "POST",
        headers: { Authorization: "Bearer test-secret" },
      }),
      h.env,
      h.ctx,
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ outcome: "queued", stage: "discover" });
    expect(h.queue.pending).toContainEqual(expect.objectContaining({
      body: expect.objectContaining({ kind: "discover", force: false }),
    }));
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps the scheduled handler producer-only and queues discovery plus reconciliation", async () => {
    const upstream = vi.fn();
    const original = globalThis.fetch;
    restorers.push(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = upstream as typeof fetch;
    const h = harness();

    await worker.scheduled(
      { cron: "*/20 * * * *", type: "scheduled", scheduledTime: Date.now() },
      h.env,
      h.ctx,
    );

    expect(h.queue.ofKind("discover")).toHaveLength(1);
    expect(h.queue.ofKind("reconcile")).toHaveLength(1);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["network", null],
    ["403", 403],
    ["429", 429],
    ["5xx", 503],
  ] as const)("retries a queued discovery %s failure with an explicit five-minute delay", async (_name, status) => {
    installFetch({
      page: async () => {
        if (status === null) throw new Error("connection reset");
        return new Response("upstream failure", { status });
      },
    });
    const h = harness();
    const retry = vi.fn();
    const ack = vi.fn();
    const batch: QueueMessageBatch<PublicationJob> = {
      queue: "fcim-broker-publication",
      messages: [{
        id: "discover-transient",
        timestamp: new Date(),
        body: buildDiscoverJob(),
        attempts: 1,
        ack,
        retry,
      }],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    };

    await worker.queue(batch, h.env, h.ctx);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(ack).not.toHaveBeenCalled();
  });

  it("acks a deterministic queued discovery error instead of retrying it", async () => {
    const h = createHarness({ FCIM_PAGE_API_URL: "https://example.com/not-approved" });
    const retry = vi.fn();
    const ack = vi.fn();
    await worker.queue({
      queue: "fcim-broker-publication",
      messages: [{ id: "discover-invalid", timestamp: new Date(), body: buildDiscoverJob(), attempts: 1, ack, retry }],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }, h.env, h.ctx);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries a queued discovery until the upstream recovers", async () => {
    let attempts = 0;
    installFetch({
      page: async () => {
        attempts += 1;
        return attempts <= 2
          ? new Response("denied", { status: 403 })
          : new Response(pagePayload(), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    const h = harness();
    await worker.scheduled(
      { cron: "*/20 * * * *", type: "scheduled", scheduledTime: Date.now() },
      h.env,
      h.ctx,
    );

    const drain = await drainQueue(h, worker.queue);
    expect(drain.deadLettered).toBe(0);

    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok).toBe(true);
  });

  it("dead-letters a queued discovery that never recovers", async () => {
    installFetch({ page: async () => new Response("denied", { status: 403 }) });
    const h = harness();

    await worker.scheduled(
      { cron: "*/20 * * * *", type: "scheduled", scheduledTime: Date.now() },
      h.env,
      h.ctx,
    );

    const drain = await drainQueue(h, worker.queue);
    expect(drain.deadLettered).toBe(1);
    expect(h.bucket.has("current.json")).toBe(false);
  });

  it("recovers on the next scheduled cycle after a discovery job is dead-lettered", async () => {
    let healthy = false;
    installFetch({
      page: async () =>
        healthy
          ? new Response(pagePayload(), { status: 200, headers: { "Content-Type": "application/json" } })
          : new Response("denied", { status: 403 }),
    });
    const h = harness();

    // First cron tick: FCIM is down for the whole retry budget, so the message is dead-lettered
    // and current.json is left exactly as it was (absent, here).
    await worker.scheduled(
      { cron: "*/20 * * * *", type: "scheduled", scheduledTime: Date.now() },
      h.env,
      h.ctx,
    );
    const firstDrain = await drainQueue(h, worker.queue);
    expect(firstDrain.deadLettered).toBe(1);
    expect(h.bucket.has("current.json")).toBe(false);

    // FCIM recovers before the next normal cron tick fires — no manual/administrative action.
    healthy = true;
    await worker.scheduled(
      { cron: "*/20 * * * *", type: "scheduled", scheduledTime: Date.now() },
      h.env,
      h.ctx,
    );
    const secondDrain = await drainQueue(h, worker.queue);
    expect(secondDrain.deadLettered).toBe(0);

    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok).toBe(true);
  });
});

describe("split publication: PDF ingest jobs", () => {
  it("stores each PDF under its own create-only key and records a completion marker", async () => {
    installFetch({});
    const h = harness();
    const discovery = await runDiscovery(h.env);
    const jobs = await ingestJobsFor(h);

    const result = await runPdfIngest(h.env, jobs[0]);
    expect(result.outcome).toBe("ingested");
    expect(h.bucket.has(jobs[0].r2_key)).toBe(true);

    const marker = h.bucket.json<CompletionMarker>(
      pendingCompletionKey(discovery.snapshot_id!, jobs[0].file_id),
    )!;
    expect(marker.source_url).toBe(jobs[0].source_url);
    expect(marker.r2_key).toBe(jobs[0].r2_key);
    expect(marker.size).toBe(PDF_BODY.byteLength);
  });

  it("is idempotent when the same job is delivered twice", async () => {
    installFetch({});
    const h = harness();
    await runDiscovery(h.env);
    const jobs = await ingestJobsFor(h);

    const first = await runPdfIngest(h.env, jobs[0]);
    const second = await runPdfIngest(h.env, jobs[0]);

    expect(first.outcome).toBe("ingested");
    expect(second.outcome).toBe("already_ingested");
    expect(h.bucket.bytes(jobs[0].r2_key)).toEqual(PDF_BODY);
  });

  it("fails rather than overwriting when the key exists with different provenance", async () => {
    installFetch({});
    const h = harness();
    await runDiscovery(h.env);
    const jobs = await ingestJobsFor(h);

    h.bucket.seed(jobs[0].r2_key, "someone else's bytes", {
      source_url: `${UPLOAD_BASE}/unrelated.pdf`,
    });

    const result = await runPdfIngest(h.env, jobs[0]);
    expect(result.outcome).toBe("conflict");
    expect(h.bucket.text(jobs[0].r2_key)).toBe("someone else's bytes");
  });

  it("refuses a job that does not match the pending descriptor", async () => {
    installFetch({});
    const h = harness();
    const discovery = await runDiscovery(h.env);

    const forged = buildIngestJob({
      snapshotId: discovery.snapshot_id!,
      fileId: "f0",
      filename: "not-in-descriptor.pdf",
      sourceUrl: `${UPLOAD_BASE}/not-in-descriptor.pdf`,
    });

    const result = await runPdfIngest(h.env, forged);
    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/does not match the pending descriptor/);
    expect(h.bucket.has(forged.r2_key)).toBe(false);
  });

  it("retries a transient PDF failure and eventually publishes", async () => {
    let failures = 0;
    installFetch({
      pdf: async (url) => {
        if (url.endsWith("anul_ii_semestrul_iii-13.pdf") && failures < 2) {
          failures += 1;
          return new Response("upstream hiccup", { status: 503 });
        }
        return new Response(PDF_BODY, { status: 200, headers: { "Content-Type": "application/pdf" } });
      },
    });

    const h = harness();
    const discovery = await runDiscovery(h.env);
    const drain = await drainQueue(h, worker.queue);

    expect(failures).toBe(2);
    expect(drain.retried).toBe(2);
    expect(drain.deadLettered).toBe(0);

    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok && pointer.pointer.snapshot_id).toBe(discovery.snapshot_id);
  });

  it("never publishes a snapshot whose PDF permanently fails", async () => {
    installFetch({
      pdf: async (url) =>
        url.endsWith("anul_ii_semestrul_iii-13.pdf")
          ? new Response("gone", { status: 404 })
          : new Response(PDF_BODY, { status: 200 }),
    });

    const h = harness();
    await runDiscovery(h.env);
    const drain = await drainQueue(h, worker.queue);

    expect(drain.deadLettered).toBe(0);
    expect(drain.retried).toBe(0);
    expect(h.bucket.has("current.json")).toBe(false);
  });
});

describe("split publication: finalize", () => {
  it("refuses to publish before every ingest job has completed", async () => {
    installFetch({});
    const h = harness();
    const discovery = await runDiscovery(h.env);
    const snapshotId = discovery.snapshot_id!;
    const jobs = await ingestJobsFor(h);

    await runPdfIngest(h.env, jobs[0]);

    const early = await runFinalize(h.env, snapshotId);
    expect(early.outcome).toBe("incomplete");
    expect(early.missing).toContain(jobs[1].r2_key);
    expect(h.bucket.has(snapshotManifestKey(snapshotId))).toBe(false);
    expect(h.bucket.has("current.json")).toBe(false);
  });

  it("publishes once every expected object and marker exists, and the manifest agrees with the descriptor", async () => {
    installFetch({});
    const h = harness();
    const discovery = await runDiscovery(h.env);
    const snapshotId = discovery.snapshot_id!;
    const jobs = await ingestJobsFor(h);

    for (const job of jobs) await runPdfIngest(h.env, job);

    const finalized = await runFinalize(h.env, snapshotId);
    expect(finalized.outcome).toBe("published");

    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(snapshotId))!;
    const manifest = h.bucket.json<SnapshotManifest>(snapshotManifestKey(snapshotId))!;

    expect(manifest.snapshot_id).toBe(snapshotId);
    expect(manifest.files.map((f) => f.r2_key).sort()).toEqual(descriptor.files.map((f) => f.r2_key).sort());
    expect(manifest.source).toEqual(descriptor.source);

    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok).toBe(true);
    if (pointer.ok) {
      expect(pointer.pointer.snapshot_id).toBe(snapshotId);
      expect(pointer.pointer.manifest_r2_key).toBe(snapshotManifestKey(snapshotId));
      expect(pointer.pointer.pdf_count).toBe(2);
      expect(pointer.pointer.page_modified_gmt).toBe("2026-09-08T12:57:59");
    }
  });

  it("is safe to run twice", async () => {
    installFetch({});
    const h = harness();
    const snapshotId = await publishFully(h);

    const again = await runFinalize(h.env, snapshotId);
    expect(again.outcome).toBe("already_current");
  });

  it("loses the CAS when a newer publisher already advanced current.json", async () => {
    installFetch({});
    const h = harness();
    const first = await publishFully(h);

    // A second cycle reads the pointer written by the first...
    const second = await runDiscovery(h.env, { force: true });
    const secondId = second.snapshot_id!;
    const jobs = h.queue.sent
      .filter((job): job is IngestPdfJob => job.kind === "ingest_pdf" && job.snapshot_id === secondId);
    for (const job of jobs) await runPdfIngest(h.env, job);

    // ...but a third publisher advances current.json before the second one finalizes.
    const stolen = JSON.parse(h.bucket.text("current.json")!) as Record<string, unknown>;
    h.bucket.seed("current.json", JSON.stringify({ ...stolen, snapshot_id: first }));

    const finalized = await runFinalize(h.env, secondId);
    expect(finalized.outcome).toBe("superseded");

    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok && pointer.pointer.snapshot_id).toBe(first);
    // The superseded snapshot survives intact as harmless history.
    expect(h.bucket.has(snapshotManifestKey(secondId))).toBe(true);
  });

  it("errors when a completion marker disagrees with the descriptor", async () => {
    installFetch({});
    const h = harness();
    const discovery = await runDiscovery(h.env);
    const snapshotId = discovery.snapshot_id!;
    const jobs = await ingestJobsFor(h);
    for (const job of jobs) await runPdfIngest(h.env, job);

    const markerKey = pendingCompletionKey(snapshotId, jobs[0].file_id);
    const marker = h.bucket.json<CompletionMarker>(markerKey)!;
    h.bucket.seed(markerKey, JSON.stringify({ ...marker, source_url: `${UPLOAD_BASE}/swapped.pdf` }));

    const finalized = await runFinalize(h.env, snapshotId);
    expect(finalized.outcome).toBe("error");
    expect(h.bucket.has("current.json")).toBe(false);
  });
});

/** A snapshot id whose encoded instant lands inside the reconciliation window. */
function agedSnapshotId(minutesAgo: number, suffix = "abcdef12"): string {
  const stamp = new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${suffix}`;
}

describe("split publication: reconciliation", () => {
  it("re-drives only the missing file in a partially completed stalled snapshot", async () => {
    installFetch({});
    const h = harness();
    const discovery = await runDiscovery(h.env);
    const snapshotId = discovery.snapshot_id!;
    const jobs = await ingestJobsFor(h);
    await runPdfIngest(h.env, jobs[0]);

    // Backdate the descriptor's prefix so reconciliation considers it stalled rather than fresh.
    const staleId = agedSnapshotId(30);
    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(snapshotId))!;
    const staleDescriptor: PendingDescriptor = {
      ...descriptor,
      snapshot_id: staleId,
      files: descriptor.files.map((f) => ({ ...f, r2_key: f.r2_key.replace(snapshotId, staleId) })),
    };
    h.bucket.seed(pendingDescriptorKey(staleId), JSON.stringify(staleDescriptor));
    h.bucket.seed(
      snapshotPageApiKey(staleId),
      h.bucket.text(snapshotPageApiKey(snapshotId))!,
    );

    // Preserve the first file's completion under the aged snapshot. Only the second file is
    // missing, so reconciliation must not duplicate work for the already-completed file.
    const completedMarker = h.bucket.json<CompletionMarker>(
      pendingCompletionKey(snapshotId, jobs[0].file_id),
    )!;
    h.bucket.seed(
      staleDescriptor.files[0].r2_key,
      h.bucket.text(jobs[0].r2_key)!,
      {
        snapshot_id: staleId,
        file_id: jobs[0].file_id,
        source_url: jobs[0].source_url,
      },
    );
    h.bucket.seed(
      pendingCompletionKey(staleId, jobs[0].file_id),
      JSON.stringify({
        ...completedMarker,
        snapshot_id: staleId,
        r2_key: staleDescriptor.files[0].r2_key,
      }),
    );

    const before = h.queue.sent.length;
    const result = await runReconcile(h.env);

    expect(result.outcome).toBe("requeued");
    expect(result.requeued_ingests).toBe(1);
    expect(result.requeued_finalizes).toBe(1);

    const requeued = h.queue.sent.slice(before) as PublicationJob[];
    expect(requeued).toEqual([
      expect.objectContaining({
        kind: "ingest_pdf",
        snapshot_id: staleId,
        file_id: staleDescriptor.files[1].file_id,
      }),
      expect.objectContaining({ kind: "finalize", snapshot_id: staleId }),
    ]);

    const missingJob = requeued.find((job): job is IngestPdfJob => job.kind === "ingest_pdf")!;
    expect((await runPdfIngest(h.env, missingJob)).outcome).toBe("ingested");
    expect((await runFinalize(h.env, staleId)).outcome).toBe("published");
    expect(h.bucket.has(snapshotManifestKey(staleId))).toBe(true);
  });

  it("ignores a snapshot that already has a manifest", async () => {
    installFetch({});
    const h = harness();
    const snapshotId = await publishFully(h);

    // Age the finished snapshot's pending prefix into the reconciliation window.
    const agedId = agedSnapshotId(30, "beef0001");
    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(snapshotId))!;
    h.bucket.seed(pendingDescriptorKey(agedId), JSON.stringify({ ...descriptor, snapshot_id: agedId }));
    h.bucket.seed(snapshotManifestKey(agedId), JSON.stringify({ snapshot_id: agedId }));

    const result = await runReconcile(h.env);
    expect(result.requeued_ingests).toBe(0);
    expect(result.requeued_finalizes).toBe(0);
  });

  it("does not re-fetch a pending snapshot whose observed current ETag is superseded", async () => {
    installFetch({});
    const h = harness();
    const discovery = await runDiscovery(h.env);
    const snapshotId = discovery.snapshot_id!;
    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(snapshotId))!;
    const agedId = agedSnapshotId(30, "dead0002");
    h.bucket.seed(
      pendingDescriptorKey(agedId),
      JSON.stringify({
        ...descriptor,
        snapshot_id: agedId,
        files: descriptor.files.map((file) => ({
          ...file,
          r2_key: file.r2_key.replace(snapshotId, agedId),
        })),
      }),
    );
    h.bucket.seed("current.json", JSON.stringify({ superseding: true }));

    const before = h.queue.sent.length;
    const result = await runReconcile(h.env);

    expect(result.outcome).toBe("idle");
    expect(result.requeued_ingests).toBe(0);
    expect(result.requeued_finalizes).toBe(0);
    expect(h.queue.sent).toHaveLength(before);
  });
});

describe("split publication: end to end through the queue consumer", () => {
  it("takes one trigger to a complete, current snapshot", async () => {
    installFetch({});
    const h = harness();

    const discovery = await runDiscovery(h.env);
    const snapshotId = discovery.snapshot_id!;
    const drain = await drainQueue(h, worker.queue);

    expect(drain.deadLettered).toBe(0);
    expect(h.bucket.has(snapshotPageApiKey(snapshotId))).toBe(true);
    expect(h.bucket.has(snapshotManifestKey(snapshotId))).toBe(true);

    const manifest = h.bucket.json<SnapshotManifest>(snapshotManifestKey(snapshotId))!;
    for (const file of manifest.files) {
      expect(h.bucket.has(file.r2_key)).toBe(true);
    }

    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok && pointer.pointer.snapshot_id).toBe(snapshotId);
  });
});
