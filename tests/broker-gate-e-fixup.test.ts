import { afterEach, describe, expect, it, vi } from "vitest";
import { isOfficialTimetablePdfUrl, isSafeOfficialPdfFilename, MAX_OFFICIAL_PDF_FILENAME_LENGTH } from "../worker-shared/fcim-policy";
import { extractOfficialPdfUrls } from "../worker/src/extractor";
import worker from "../worker/src/index";
import { validatePendingFile } from "../worker/src/jobs";
import { pendingCompletionKey, pendingDescriptorKey, snapshotManifestKey, snapshotPageApiKey } from "../worker/src/keys";
import { GC_MAX_OBJECTS_PER_PREFIX, GC_MAX_PREFIX_DELETIONS, GC_PREFIXES_PER_NAMESPACE, RECONCILE_SCAN_PAGES, RETENTION_AGE_MS, runRetention, snapshotIdInstant } from "../worker/src/maintenance";
import { buildCurrentPointer } from "../worker/src/pointer";
import { generateSnapshotId, planSnapshotFiles, runFinalize, runReconcile } from "../worker/src/publisher";
import type { PendingDescriptor } from "../worker/src/types";
import { createHarness, drainQueue, type WorkerHarness } from "./helpers/worker-doubles";
import { openPublication, pagePayload, publishThroughApi, uploadPublicationFile } from "./helpers/md-publication";

const BASE = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/";
const HOUR = 60 * 60 * 1000;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function idAt(ageHours: number, n = 1): string {
  return new Date(Date.now() - ageHours * HOUR).toISOString().replace(/[:.]/g, "-") + `-${n.toString(16).padStart(8, "0")}`;
}

function seedPending(h: WorkerHarness, id: string, etag: string | null = null): PendingDescriptor {
  const descriptor: PendingDescriptor = {
    schema_version: 1, snapshot_id: id, previous_snapshot_id: null,
    created_at: new Date().toISOString(), current_etag: etag,
    operation_id: crypto.randomUUID(), page_api_sha256: "0".repeat(64), origin: "md_publisher",
    source: { page_api_url: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view",
      page_id: 1739, page_modified_gmt: null, retrieved_at: new Date().toISOString(), etag: null, last_modified: null },
    files: planSnapshotFiles(id, [BASE + "a.PDF", BASE + "b.Pdf"]),
  };
  h.bucket.seed(pendingDescriptorKey(id), JSON.stringify(descriptor));
  h.bucket.seed(snapshotPageApiKey(id), "[]");
  return descriptor;
}

function seedFinalized(h: WorkerHarness, id: string, previous: string | null): void {
  const descriptor = seedPending(h, id);
  h.bucket.seed(snapshotManifestKey(id), JSON.stringify({ ...descriptor, previous_snapshot_id: previous }));
  for (const file of descriptor.files) h.bucket.seed(file.r2_key, "%PDF-1.4");
}

function pointAt(h: WorkerHarness, id: string): void {
  h.bucket.seed("current.json", JSON.stringify(buildCurrentPointer({ snapshotId: id,
    publishedAt: new Date().toISOString(), pageModifiedGmt: null, pageId: 1739, pdfCount: 2 })));
}

function mockUpstream(filenames: string[], status = 200): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/wp-json/")) return new Response(JSON.stringify([{ id: 1739, modified_gmt: null,
      content: { rendered: filenames.map((name) => `<a href="${BASE}${name}">pdf</a>`).join("") } }]),
    { headers: { "Content-Type": "application/json" } });
    return new Response("%PDF-1.4 body", { status, headers: { "Content-Type": "application/pdf" } });
  }));
}

describe("GE-N01 canonical filename policy", () => {
  const names = ["a.pdf", "a.PDF", "a.Pdf", "x".repeat(191) + ".pdf", "x".repeat(191) + ".PDF",
    "a".repeat(127) + ".Pdf", "a".repeat(128) + ".PDF", "a".repeat(190) + ".pdf",
    "a".repeat(182) + "." + "b".repeat(8) + ".PDF"];
  it.each(names)("URL → extraction → descriptor → valid job → serving: %s", async (name) => {
    const h = createHarness();
    const id = generateSnapshotId();
    const url = BASE + name;
    expect(isSafeOfficialPdfFilename(name)).toBe(true);
    expect(isOfficialTimetablePdfUrl(url)).toBe(true);
    const urls = extractOfficialPdfUrls(`<a href="${url}">pdf</a>`);
    expect(urls).toEqual([url]);
    // Include a duplicate basename in another month to exercise length expansion as well.
    const files = planSnapshotFiles(id, [...urls, url.replace("/09/", "/08/")]);
    for (const file of files) {
      expect(file.filename.length).toBeLessThanOrEqual(MAX_OFFICIAL_PDF_FILENAME_LENGTH);
      expect(validatePendingFile({ snapshot_id: id, ...file }).ok).toBe(true);
      h.bucket.seed(file.r2_key, "%PDF-1.4");
      expect((await worker.fetch(new Request(`https://broker/snapshots/${id}/pdfs/${file.filename}`), h.env, h.ctx)).status).toBe(200);
    }
  });

  it.each(["a".repeat(192) + ".pdf", ".pdf", "_a.pdf", "a b.pdf", "a?.pdf", "a#.pdf", "a%20.pdf", "a/b.pdf", "a\\b.pdf", "a..b.pdf", "a.pdf\n", "a.pdf\r"])("rejects unsafe/out-of-bound filename %s", (name) => {
    expect(isSafeOfficialPdfFilename(name)).toBe(false);
    expect(isOfficialTimetablePdfUrl(BASE + name)).toBe(false);
    expect(() => planSnapshotFiles(generateSnapshotId(), [BASE + name])).toThrow();
  });

  it.each(["?download=1", "#page=1", "?", "#"])("still rejects URL suffix %s", (suffix) => {
    expect(isOfficialTimetablePdfUrl(BASE + "a.PDF" + suffix)).toBe(false);
    expect(extractOfficialPdfUrls(`<a href="${BASE}a.PDF${suffix}">pdf</a>`)).toEqual([]);
  });

  it("publishes uppercase and boundary-length files through the publisher API", async () => {
    const h = createHarness();
    const names = ["a.PDF", "m".repeat(191) + ".Pdf"];
    const result = await publishThroughApi(h, { page: pagePayload({ urls: names.map((name) => BASE + name) }) });
    expect(result.completeBody.status).toBe("published");
    expect(result.plan.files.map((file) => file.filename)).toEqual(names);
    expect(h.bucket.json<{ snapshot_id: string }>("current.json")?.snapshot_id).toBe(result.snapshotId);
  });

  it("rejects deterministic descriptor/job mismatch at snapshot level without poison requeue", async () => {
    const h = createHarness();
    const id = idAt(1);
    const descriptor = seedPending(h, id);
    descriptor.files[0].filename = "invalid?.PDF";
    h.bucket.seed(pendingDescriptorKey(id), JSON.stringify(descriptor));
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let n = 0; n < 3; n++) expect((await runReconcile(h.env)).outcome).toBe("idle");
    expect(h.queue.sent).toHaveLength(0);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("deterministically failed"));
    expect(await runFinalize(h.env, id)).toMatchObject({ outcome: "error", retryable: false,
      error: expect.stringContaining("invalid file entry") });
    expect(h.bucket.has("current.json")).toBe(false);
  });
});

describe("GE-N02 incremental retention", () => {
  it("keeps current and two historical predecessors, removes old superseded snapshots and pending", async () => {
    const h = createHarness();
    const ids = [100, 90, 80, 70].map((age) => idAt(age));
    ids.forEach((id, i) => seedFinalized(h, id, ids[i - 1] ?? null));
    pointAt(h, ids[3]);
    const before = h.bucket.text("current.json");
    for (let n = 0; n < 6; n++) await runReconcile(h.env);
    expect(h.bucket.keys().some((key) => key.startsWith(`snapshots/${ids[0]}/`))).toBe(false);
    for (const id of ids.slice(1)) expect(h.bucket.has(snapshotManifestKey(id))).toBe(true);
    expect(h.bucket.has(pendingDescriptorKey(ids[0]))).toBe(false);
    expect(h.bucket.text("current.json")).toBe(before);
  });

  it("preserves active predecessor-CAS work and recent history; expires abandoned same-CAS work", async () => {
    const h = createHarness();
    const old = idAt(48), active = idAt(1), recent = idAt(12);
    seedPending(h, old); seedPending(h, active); seedFinalized(h, recent, null);
    for (let n = 0; n < 4; n++) await runRetention(h.env);
    expect(h.bucket.has(pendingDescriptorKey(active))).toBe(true);
    expect(h.bucket.has(snapshotPageApiKey(active))).toBe(true);
    expect(h.bucket.has(snapshotManifestKey(recent))).toBe(true);
    expect(h.bucket.has(pendingDescriptorKey(old))).toBe(false);
    expect(h.bucket.has(snapshotPageApiKey(old))).toBe(false);
  });

  it("bounds prefix examination/deletion and converges on oversized partially deleted prefixes", async () => {
    const h = createHarness();
    for (let n = 0; n < 20; n++) {
      const id = idAt(48, n);
      seedPending(h, id);
      if (n === 0) for (let f = 0; f < 150; f++) h.bucket.seed(`snapshots/${id}/pdfs/${f}.pdf`, "pdf");
    }
    await runRetention(h.env);
    expect(h.bucket.deletions.length).toBeLessThanOrEqual(GC_MAX_PREFIX_DELETIONS);
    expect(h.bucket.deletions.flat().length).toBeLessThanOrEqual(GC_MAX_PREFIX_DELETIONS * GC_MAX_OBJECTS_PER_PREFIX);
    expect(h.bucket.listings.filter((call) => call.delimiter).every((call) => call.limit === GC_PREFIXES_PER_NAMESPACE)).toBe(true);
    for (let n = 0; n < 60; n++) await runRetention(h.env);
    expect(h.bucket.keys().filter((key) => /^(pending|snapshots)\//.test(key))).toHaveLength(0);
  });

  it("fails closed on malformed current pointers and impossible structured dates", async () => {
    const h = createHarness();
    seedPending(h, idAt(48));
    h.bucket.seed("current.json", '{"nested":{"snapshot_id":"spoof"}}');
    await runRetention(h.env);
    expect(h.bucket.deletions).toHaveLength(0);
    expect(snapshotIdInstant("2026-02-30T00-00-00-000Z-abcdef12")).toBe(null);
  });

  it("resumes safely after delete succeeded but the GC cursor write failed", async () => {
    const h = createHarness();
    for (let n = 0; n < 15; n++) seedPending(h, idAt(48, n));
    const put = h.bucket.put.bind(h.bucket);
    vi.spyOn(h.bucket, "put").mockImplementationOnce(async () => { throw new Error("simulated crash saving cursor"); });
    await expect(runRetention(h.env)).rejects.toThrow("simulated crash");
    vi.mocked(h.bucket.put).mockImplementation(put);
    for (let n = 0; n < 30; n++) await runRetention(h.env);
    expect(h.bucket.keys().filter((key) => /^(pending|snapshots)\//.test(key))).toHaveLength(0);
  });

  it("checks expiry again after manifest creation and before current CAS", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = createHarness();
    const page = pagePayload({ urls: [BASE + "a.PDF"] });
    const plan = await (await openPublication(h, page)).json() as { snapshot_id: string; files: { file_id: string }[] };
    for (const file of plan.files) {
      await uploadPublicationFile(h, plan.snapshot_id, file.file_id, new TextEncoder().encode("%PDF-1.4 body"));
    }
    const put = h.bucket.put.bind(h.bucket);
    vi.spyOn(h.bucket, "put").mockImplementation(async (key, value, options) => {
      const result = await put(key, value, options);
      if (key === snapshotManifestKey(plan.snapshot_id)) vi.setSystemTime(Date.now() + 7 * HOUR);
      return result;
    });
    expect(await runFinalize(h.env, plan.snapshot_id)).toMatchObject({ outcome: "error", retryable: false });
    expect(h.bucket.has("current.json")).toBe(false);
    expect(h.bucket.has(snapshotManifestKey(plan.snapshot_id))).toBe(true);
  });

  it("abandons a sweep if current changes while loading the retained history", async () => {
    const h = createHarness();
    const old = idAt(48), current = idAt(1);
    seedFinalized(h, old, null); seedFinalized(h, current, null); pointAt(h, current);
    const original = h.bucket.head.bind(h.bucket);
    vi.spyOn(h.bucket, "head").mockImplementation(async (key) => {
      if (key === "current.json") pointAt(h, current);
      return original(key);
    });
    await runRetention(h.env);
    expect(h.bucket.deletions).toHaveLength(0);
  });

  it("refuses expired upload/finalize even while the predecessor ETag could still match", async () => {
    const h = createHarness();
    const id = idAt(7);
    const descriptor = seedPending(h, id);
    const file = descriptor.files[0];
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const upload = await uploadPublicationFile(h, id, file.file_id, new TextEncoder().encode("%PDF-1.4 body"));
    expect(upload.status).toBe(410);
    expect(h.bucket.has(file.r2_key)).toBe(false);
    expect(await runFinalize(h.env, id)).toMatchObject({ outcome: "error", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(h.bucket.has("current.json")).toBe(false);
  });

  it("bounds retained storage under repeated real publications after sufficient GC cycles", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = createHarness();
    const start = Date.now();
    const page = pagePayload({ urls: [BASE + "a.PDF"] });
    for (let n = 0; n < 35; n++) {
      vi.setSystemTime(start + n * RETENTION_AGE_MS);
      const result = await publishThroughApi(h, { page });
      expect(result.completeBody.status).toBe("published");
      await runReconcile(h.env);
    }
    vi.setSystemTime(Date.now() + 2 * RETENTION_AGE_MS);
    for (let n = 0; n < 40; n++) await runReconcile(h.env);
    const snapshots = new Set(h.bucket.keys().filter((key) => key.startsWith("snapshots/")).map((key) => key.split("/")[1]));
    const pending = new Set(h.bucket.keys().filter((key) => key.startsWith("pending/")).map((key) => key.split("/")[1]));
    expect(snapshots.size).toBe(3);
    expect(pending.size).toBeLessThanOrEqual(1);
  });

  it("keeps last-known-good and bounds storage when the publisher can never finish a publication", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = createHarness();
    const page = pagePayload({ urls: [BASE + "a.PDF"] });
    await publishThroughApi(h, { page });
    const before = h.bucket.text("current.json");
    for (let n = 0; n < 15; n++) {
      vi.setSystemTime(Date.now() + 2 * HOUR);
      // The laptop opens a publication and then dies before it can upload anything.
      expect((await openPublication(h, page)).status).toBe(201);
      await runReconcile(h.env);
      const drain = await drainQueue(h, worker.queue);
      expect(drain.retried).toBe(0);
    }
    vi.setSystemTime(Date.now() + 2 * RETENTION_AGE_MS);
    for (let n = 0; n < 30; n++) await runReconcile(h.env);
    expect(h.bucket.text("current.json")).toBe(before);
    expect(new Set(h.bucket.keys().filter((key) => key.startsWith("snapshots/")).map((key) => key.split("/")[1])).size).toBe(1);
    expect(new Set(h.bucket.keys().filter((key) => key.startsWith("pending/")).map((key) => key.split("/")[1])).size).toBeLessThanOrEqual(1);
  });
});

describe("GE-N03 cursor-aware reconciliation", () => {
  it("finds later-page repairable work beyond 150 old prefixes, skips newer superseded work and requeues finalize only", async () => {
    const h = createHarness();
    h.bucket.listPageSize = 60;
    const repairable = idAt(1);
    const descriptor = seedPending(h, repairable);
    h.bucket.seed(pendingCompletionKey(repairable, descriptor.files[0].file_id), "{}");
    for (let n = 0; n < 5; n++) seedPending(h, idAt(0.5, n), "superseded-etag");
    // Reverse insertion order deliberately differs from R2's ordering.
    for (let n = 170; n > 0; n--) seedPending(h, idAt(12, n));
    const result = await runReconcile(h.env);
    expect(result).toMatchObject({ outcome: "requeued", requeued_finalizes: 1 });
    // Gate F: reconciliation never asks for bytes. Missing uploads are the publisher's to resend.
    expect(h.queue.sent).toEqual([expect.objectContaining({ kind: "finalize", snapshot_id: repairable })]);
    const scans = h.bucket.listings.filter((call) => call.limit === 100);
    expect(scans).toHaveLength(3);
    expect(scans[0].cursor).toBeUndefined();
    expect(new Set(scans.slice(1).map((call) => call.cursor)).size).toBe(2);
  });

  it("persists continuation across bounded invocations before GC catches up", async () => {
    const h = createHarness();
    for (let n = 0; n < 850; n++) seedPending(h, idAt(12, n));
    const repairable = idAt(1); seedPending(h, repairable);
    for (let n = 0; n < 2; n++) expect((await runReconcile(h.env)).outcome).toBe("idle");
    expect((await runReconcile(h.env)).outcome).toBe("requeued");
    expect(h.queue.sent.every((job) => "snapshot_id" in job && job.snapshot_id === repairable)).toBe(true);
    expect(h.bucket.listings.filter((call) => call.limit === 100).length).toBeLessThanOrEqual(3 * RECONCILE_SCAN_PAGES);
  });

  it("selects only the newest three eligible snapshots in the scan set", async () => {
    const h = createHarness();
    const ids = [1, 2, 3, 4, 5].map((age) => idAt(age));
    for (const id of [...ids].reverse()) seedPending(h, id);
    const result = await runReconcile(h.env);
    expect(result.requeued_finalizes).toBe(3);
    expect(h.queue.ofKind("finalize").map((job) => "snapshot_id" in job && job.snapshot_id)).toEqual(ids.slice(0, 3));
  });
});
