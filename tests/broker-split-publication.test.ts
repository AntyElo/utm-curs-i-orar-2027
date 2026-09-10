/**
 * Audit E-02 / NR-A regression suite: staged candidate publication.
 *
 * Gate F replaced the queue-driven acquisition stages with authenticated MD Publisher uploads,
 * but the properties worth pinning down are unchanged and are still the ones that hold *between*
 * requests: opening a publication never publishes, an unfinished publication never becomes
 * current, every step is safe to repeat, and a stale completion loses the CAS.
 *
 * NR-A is the reason this file exists: the broker mirrors every strictly-valid official timetable
 * PDF the authoritative page references, including names it cannot interpret, because
 * `discoverPdf()` on Render is the only thing allowed to decide what a timetable means.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/src/index";
import { pendingCompletionKey, pendingDescriptorKey, snapshotManifestKey, snapshotPageApiKey } from "../worker/src/keys";
import { parseCurrentPointer } from "../worker/src/pointer";
import { runFinalize, runReconcile } from "../worker/src/publisher";
import type { CompletionMarker, PendingDescriptor, SnapshotManifest } from "../worker/src/types";
import {
  completePublication,
  openPublication,
  pagePayload,
  pdfBody,
  publishThroughApi,
  uploadPublicationFile,
  UPLOAD_BASE,
  type PlanResponse,
} from "./helpers/md-publication";
import { createHarness, drainQueue, type WorkerHarness } from "./helpers/worker-doubles";

const PAGE_API_URL = "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view";
const PDF_BODY = pdfBody("shared");

/** After Gate F no broker code path may reach the Internet; a call here is a test failure. */
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`the broker must make no outbound request: ${String(input)}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function harness(): WorkerHarness {
  return createHarness({ FCIM_PAGE_API_URL: PAGE_API_URL });
}

async function open(h: WorkerHarness, page = pagePayload()): Promise<PlanResponse> {
  const response = await openPublication(h, page);
  expect(response.status).toBe(201);
  return (await response.json()) as PlanResponse;
}

async function uploadAll(h: WorkerHarness, plan: PlanResponse, body = PDF_BODY): Promise<void> {
  for (const file of plan.files) {
    const response = await uploadPublicationFile(h, plan.snapshot_id, file.file_id, body);
    expect(response.status).toBe(200);
  }
}

describe("staged publication: opening a publication", () => {
  it("mirrors every strictly-valid official PDF, including names it cannot interpret", async () => {
    // NR-A: the deleted `anul_(i|ii)` filename filter would have starved discoverPdf() of these.
    const h = harness();
    const plan = await open(
      h,
      pagePayload({
        filenames: [
          "orar-licenta-anul-1.pdf",
          "orar-licenta-anul-2.pdf",
          "orar-master-2026-sem-3-anul-2-1.pdf",
          "orar_ses_toamna_fr-3.pdf",
        ],
      }),
    );

    expect(plan.files).toHaveLength(4);
    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(plan.snapshot_id))!;
    expect(descriptor.files.map((file) => file.filename).sort()).toEqual([
      "orar-licenta-anul-1.pdf",
      "orar-licenta-anul-2.pdf",
      "orar-master-2026-sem-3-anul-2-1.pdf",
      "orar_ses_toamna_fr-3.pdf",
    ]);
  });

  it("gives two upload folders that share a basename their own object names", async () => {
    const h = harness();
    const page = JSON.stringify([
      {
        id: 1739,
        modified_gmt: "2026-09-08T12:57:59",
        content: {
          rendered: `
            <a href="https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/orar.pdf">new</a>
            <a href="https://fcim.utm.md/wp-content/uploads/sites/24/2026/08/orar.pdf">old</a>`,
        },
      },
    ]);

    const plan = await open(h, page);
    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(plan.snapshot_id))!;
    expect(new Set(descriptor.files.map((file) => file.r2_key)).size).toBe(2);
    expect(descriptor.files.map((file) => file.filename).sort()).toEqual(["2026-08-orar.pdf", "orar.pdf"]);

    await uploadAll(h, plan);
    expect((await completePublication(h, plan.snapshot_id)).status).toBe(200);
    for (const file of descriptor.files) {
      expect(h.bucket.has(file.r2_key)).toBe(true);
    }
    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok && pointer.pointer.pdf_count).toBe(2);
  });

  it("writes only the page payload, the descriptor and the operation record", async () => {
    const h = harness();
    const plan = await open(h);

    expect(h.bucket.has(snapshotPageApiKey(plan.snapshot_id))).toBe(true);
    expect(h.bucket.has(pendingDescriptorKey(plan.snapshot_id))).toBe(true);
    expect(h.bucket.has(snapshotManifestKey(plan.snapshot_id))).toBe(false);
    expect(h.bucket.has("current.json")).toBe(false);
    // Opening a publication schedules no background work at all.
    expect(h.queue.sent).toEqual([]);
  });

  it("chains a new publication onto the snapshot that is current when it opens", async () => {
    const h = harness();
    const first = await publishThroughApi(h);

    const plan = await open(
      h,
      pagePayload({
        filenames: ["anul_i_semestrul_i-19.pdf", "anul_ii_semestrul_iii-13.pdf", "anul_iii_semestrul_v-5.pdf"],
      }),
    );
    expect(plan.snapshot_id).not.toBe(first.snapshotId);
    expect(plan.files).toHaveLength(3);

    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(plan.snapshot_id))!;
    expect(descriptor.previous_snapshot_id).toBe(first.snapshotId);
  });
});

describe("staged publication: uploads", () => {
  it("stores each PDF under its own create-only key and records a completion marker", async () => {
    const h = harness();
    const plan = await open(h);

    const response = await uploadPublicationFile(h, plan.snapshot_id, "f0", PDF_BODY);
    expect(response.status).toBe(200);

    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(plan.snapshot_id))!;
    const entry = descriptor.files[0];
    expect(h.bucket.has(entry.r2_key)).toBe(true);

    const marker = h.bucket.json<CompletionMarker>(pendingCompletionKey(plan.snapshot_id, "f0"))!;
    expect(marker.source_url).toBe(entry.source_url);
    expect(marker.r2_key).toBe(entry.r2_key);
    expect(marker.size).toBe(PDF_BODY.byteLength);
  });

  it("is idempotent when the same upload is delivered twice", async () => {
    const h = harness();
    const plan = await open(h);

    const first = await uploadPublicationFile(h, plan.snapshot_id, "f0", PDF_BODY);
    const second = await uploadPublicationFile(h, plan.snapshot_id, "f0", PDF_BODY);
    expect((await first.json()).status).toBe("stored");
    expect((await second.json()).status).toBe("already_stored");

    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(plan.snapshot_id))!;
    expect(h.bucket.bytes(descriptor.files[0].r2_key)).toEqual(PDF_BODY);
  });

  it("fails rather than overwriting when the key exists with different provenance", async () => {
    const h = harness();
    const plan = await open(h);
    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(plan.snapshot_id))!;

    h.bucket.seed(descriptor.files[0].r2_key, "someone else's bytes", {
      source_url: `${UPLOAD_BASE}/unrelated.pdf`,
      content_sha256: "f".repeat(64),
    });

    const response = await uploadPublicationFile(h, plan.snapshot_id, "f0", PDF_BODY);
    expect(response.status).toBe(409);
    expect(h.bucket.text(descriptor.files[0].r2_key)).toBe("someone else's bytes");
  });

  it("refuses an upload the descriptor does not describe", async () => {
    const h = harness();
    const plan = await open(h);

    // There is no way to name a file the plan does not contain: the id is the only client input,
    // and everything used to address storage is looked up from the broker's own descriptor.
    const response = await uploadPublicationFile(h, plan.snapshot_id, "f9", PDF_BODY);
    expect(response.status).toBe(404);
    expect(h.bucket.keys().some((key) => key.includes("/pdfs/"))).toBe(false);
  });
});

describe("staged publication: completion", () => {
  it("refuses to publish before every planned upload has arrived", async () => {
    const h = harness();
    const plan = await open(h);
    await uploadPublicationFile(h, plan.snapshot_id, "f0", PDF_BODY);

    const early = await runFinalize(h.env, plan.snapshot_id);
    expect(early.outcome).toBe("incomplete");
    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(plan.snapshot_id))!;
    expect(early.missing).toContain(descriptor.files[1].r2_key);
    expect(h.bucket.has(snapshotManifestKey(plan.snapshot_id))).toBe(false);
    expect(h.bucket.has("current.json")).toBe(false);
  });

  it("publishes once every expected object and marker exists, and the manifest agrees with the descriptor", async () => {
    const h = harness();
    const plan = await open(h);
    await uploadAll(h, plan);

    expect((await completePublication(h, plan.snapshot_id)).status).toBe(200);

    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(plan.snapshot_id))!;
    const manifest = h.bucket.json<SnapshotManifest>(snapshotManifestKey(plan.snapshot_id))!;

    expect(manifest.snapshot_id).toBe(plan.snapshot_id);
    expect(manifest.files.map((file) => file.r2_key).sort()).toEqual(
      descriptor.files.map((file) => file.r2_key).sort(),
    );
    expect(manifest.source).toEqual(descriptor.source);

    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok).toBe(true);
    if (pointer.ok) {
      expect(pointer.pointer.snapshot_id).toBe(plan.snapshot_id);
      expect(pointer.pointer.manifest_r2_key).toBe(snapshotManifestKey(plan.snapshot_id));
      expect(pointer.pointer.pdf_count).toBe(2);
      expect(pointer.pointer.page_modified_gmt).toBe("2026-09-08T12:57:59");
    }
  });

  it("is safe to run twice", async () => {
    const h = harness();
    const result = await publishThroughApi(h);
    expect((await runFinalize(h.env, result.snapshotId)).outcome).toBe("already_current");
  });

  it("loses the CAS when a newer publication already advanced current.json", async () => {
    const h = harness();
    const first = await publishThroughApi(h);

    // A second publication reads the pointer written by the first...
    const plan = await open(h, pagePayload({ modifiedGmt: "2026-09-09T09:00:00" }));
    await uploadAll(h, plan, pdfBody("second"));

    // ...but something advances current.json before it completes.
    const stolen = JSON.parse(h.bucket.text("current.json")!) as Record<string, unknown>;
    h.bucket.seed("current.json", JSON.stringify({ ...stolen, updated_at: "2026-09-09T09:30:00.000Z" }));

    expect((await runFinalize(h.env, plan.snapshot_id)).outcome).toBe("superseded");

    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok && pointer.pointer.snapshot_id).toBe(first.snapshotId);
    // The superseded snapshot survives intact as harmless history.
    expect(h.bucket.has(snapshotManifestKey(plan.snapshot_id))).toBe(true);
  });

  it("errors when a completion marker disagrees with the descriptor", async () => {
    const h = harness();
    const plan = await open(h);
    await uploadAll(h, plan);

    const markerKey = pendingCompletionKey(plan.snapshot_id, "f0");
    const marker = h.bucket.json<CompletionMarker>(markerKey)!;
    h.bucket.seed(markerKey, JSON.stringify({ ...marker, source_url: `${UPLOAD_BASE}/swapped.pdf` }));

    expect((await runFinalize(h.env, plan.snapshot_id)).outcome).toBe("error");
    expect(h.bucket.has("current.json")).toBe(false);
  });
});

/** A snapshot id whose encoded instant lands inside the reconciliation window. */
function agedSnapshotId(minutesAgo: number, suffix = "abcdef12"): string {
  const stamp = new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${suffix}`;
}

/** Copy a live publication's state onto a backdated snapshot id, as a stalled run would look. */
function backdate(h: WorkerHarness, snapshotId: string, agedId: string): PendingDescriptor {
  const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(snapshotId))!;
  const aged: PendingDescriptor = {
    ...descriptor,
    snapshot_id: agedId,
    files: descriptor.files.map((file) => ({ ...file, r2_key: file.r2_key.replace(snapshotId, agedId) })),
  };
  h.bucket.seed(pendingDescriptorKey(agedId), JSON.stringify(aged));
  h.bucket.seed(snapshotPageApiKey(agedId), h.bucket.text(snapshotPageApiKey(snapshotId))!, {
    snapshot_id: agedId,
    operation_id: descriptor.operation_id,
    page_api_sha256: descriptor.page_api_sha256,
  });
  return aged;
}

describe("staged publication: reconciliation", () => {
  it("re-drives finalize for a stalled publication, and never asks anyone for bytes", async () => {
    const h = harness();
    const plan = await open(h);
    await uploadAll(h, plan);

    const staleId = agedSnapshotId(30);
    const aged = backdate(h, plan.snapshot_id, staleId);
    const live = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(plan.snapshot_id))!;
    for (const [index, file] of aged.files.entries()) {
      const source = h.bucket.json<CompletionMarker>(pendingCompletionKey(plan.snapshot_id, file.file_id))!;
      h.bucket.seed(file.r2_key, h.bucket.text(live.files[index].r2_key)!, {
        snapshot_id: staleId,
        file_id: file.file_id,
        source_url: file.source_url,
      });
      h.bucket.seed(
        pendingCompletionKey(staleId, file.file_id),
        JSON.stringify({ ...source, snapshot_id: staleId, r2_key: file.r2_key }),
      );
    }

    const before = h.queue.sent.length;
    const result = await runReconcile(h.env);

    expect(result.outcome).toBe("requeued");
    expect(result.requeued_finalizes).toBe(1);
    expect(h.queue.sent.slice(before)).toEqual([
      expect.objectContaining({ kind: "finalize", snapshot_id: staleId }),
    ]);

    await drainQueue(h, worker.queue);
    expect(h.bucket.has(snapshotManifestKey(staleId))).toBe(true);
  });

  it("ignores a snapshot that already has a manifest", async () => {
    const h = harness();
    const result = await publishThroughApi(h);

    const agedId = agedSnapshotId(30, "beef0001");
    backdate(h, result.snapshotId, agedId);
    h.bucket.seed(snapshotManifestKey(agedId), JSON.stringify({ snapshot_id: agedId }));

    expect((await runReconcile(h.env)).requeued_finalizes).toBe(0);
  });

  it("leaves alone a pending publication whose observed current ETag is superseded", async () => {
    const h = harness();
    const plan = await open(h);
    backdate(h, plan.snapshot_id, agedSnapshotId(30, "dead0002"));
    h.bucket.seed("current.json", JSON.stringify({ superseding: true }));

    const before = h.queue.sent.length;
    const result = await runReconcile(h.env);

    expect(result.outcome).toBe("idle");
    expect(result.requeued_finalizes).toBe(0);
    expect(h.queue.sent).toHaveLength(before);
  });
});

describe("staged publication: end to end", () => {
  it("takes one publisher run to a complete, current snapshot", async () => {
    const h = harness();
    const result = await publishThroughApi(h);

    expect(result.completeBody.status).toBe("published");
    expect(h.bucket.has(snapshotPageApiKey(result.snapshotId))).toBe(true);
    expect(h.bucket.has(snapshotManifestKey(result.snapshotId))).toBe(true);

    const manifest = h.bucket.json<SnapshotManifest>(snapshotManifestKey(result.snapshotId))!;
    for (const file of manifest.files) {
      expect(h.bucket.has(file.r2_key)).toBe(true);
    }

    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok && pointer.pointer.snapshot_id).toBe(result.snapshotId);
  });
});
