/**
 * Gate F: MD Publisher ingestion.
 *
 * The properties worth pinning down are the ones that hold when the publisher is wrong, slow,
 * interrupted, duplicated or hostile. The laptop is transport-only: it can hand the broker bytes
 * and an attempt id, and nothing it sends may become an R2 key, a filename, a source URL, a
 * snapshot id, a trusted HTTP validator or an acceptance decision.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/src/index";
import { operationKey, pendingCompletionKey, pendingDescriptorKey, snapshotManifestKey, snapshotPageApiKey, snapshotPdfKey } from "../worker/src/keys";
import { parseCurrentPointer } from "../worker/src/pointer";
import { GC_MAX_OPERATION_DELETIONS, PENDING_MAX_AGE_MS, RETENTION_AGE_MS, runRetention } from "../worker/src/maintenance";
import { evaluatePageTimestamp, runFinalize, runReconcile } from "../worker/src/publisher";
import { validateJob } from "../worker/src/jobs";
import type { CompletionMarker, PendingDescriptor, SnapshotManifest } from "../worker/src/types";
import {
  completePublication,
  getPublication,
  openPublication,
  pagePayload,
  pdfBody,
  publicationStatus,
  publishThroughApi,
  putHeartbeat,
  asBody,
  sha256Hex,
  uploadPublicationFile,
  UPLOAD_BASE,
  type PlanResponse,
} from "./helpers/md-publication";
import { createHarness, TEST_PUBLISHER_TOKEN, type WorkerHarness } from "./helpers/worker-doubles";

const PAGE_API_URL = "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view";

/** Any FCIM request from inside a test is a bug: after Gate F the broker never makes one. */
let fcimCalls: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fcimCalls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fcimCalls.push(url);
    throw new Error(`unexpected outbound fetch in a Gate F test: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function harness(overrides = {}): WorkerHarness {
  return createHarness({ FCIM_PAGE_API_URL: PAGE_API_URL, ...overrides });
}

async function planOf(response: Response): Promise<PlanResponse> {
  return (await response.json()) as PlanResponse;
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/**
 * A syntactically valid snapshot id stamped at `instant`, in the broker's own id format.
 * Tests that care about the publication window build ids from the clock they pinned rather
 * than writing a date down, so no assertion can change meaning as wall time moves past it.
 */
function snapshotIdAt(instant: number, suffix = "abcdef01"): string {
  const stamp = new Date(instant).toISOString().replace(/:/g, "-").replace(".", "-");
  return `${stamp}-${suffix}`;
}

/* ------------------------------------------------------------------ *
 * Auth and the trust boundary between the two credentials
 * ------------------------------------------------------------------ */

describe("Gate F: publisher authorization boundary", () => {
  it("refuses a publisher route with no credential", async () => {
    const h = harness();
    const response = await openPublication(h, pagePayload(), { token: null });
    expect(response.status).toBe(401);
    expect(h.bucket.keys()).toEqual([]);
  });

  it("refuses a publisher route with the wrong credential", async () => {
    const h = harness();
    const response = await openPublication(h, pagePayload(), { token: "not-the-publisher-token-000000000" });
    expect(response.status).toBe(401);
    expect(h.bucket.keys()).toEqual([]);
  });

  it("refuses the accepted-state secret on a publisher route", async () => {
    const h = harness();
    for (const call of [
      () => openPublication(h, pagePayload(), { token: "test-secret" }),
      () => publicationStatus(h, { token: "test-secret" }),
      () => putHeartbeat(h, { status: "ok" }, { token: "test-secret" }),
    ]) {
      expect((await call()).status).toBe(401);
    }
    expect(h.bucket.keys()).toEqual([]);
  });

  it("refuses the publisher token on an accepted-state route", async () => {
    const h = harness();
    const response = await worker.fetch(
      new Request("https://broker.test/accepted/course-1", {
        method: "PUT",
        headers: { Authorization: `Bearer ${TEST_PUBLISHER_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expected_previous_accepted_id: null, pointer: {} }),
      }),
      h.env,
      h.ctx,
    );
    expect(response.status).toBe(401);
  });

  it("fails closed when the publisher and accepted-state credentials are the same value", async () => {
    const shared = "identical-credential-0123456789abcdef";
    const h = harness({ MD_PUBLISHER_TOKEN: shared, SCHEDULE_BROKER_SECRET: shared });

    const response = await openPublication(h, pagePayload(), { token: shared });
    expect(response.status).toBe(503);
    expect((await body(response)).code).toBe("publisher_credentials_misconfigured");
    expect(h.bucket.keys()).toEqual([]);
  });

  it("fails closed when the rotation predecessor equals the accepted-state secret", async () => {
    const h = harness({ MD_PUBLISHER_TOKEN_PREVIOUS: "test-secret" });
    const response = await openPublication(h, pagePayload());
    expect(response.status).toBe(503);
  });

  it("fails closed when no publisher credential is configured, and when one is too short", async () => {
    const missing = harness({ MD_PUBLISHER_TOKEN: undefined });
    expect((await openPublication(missing, pagePayload(), { token: "anything" })).status).toBe(503);

    const short = harness({ MD_PUBLISHER_TOKEN: "too-short" });
    expect((await openPublication(short, pagePayload(), { token: "too-short" })).status).toBe(503);
  });

  it("accepts the rotation predecessor while it is still configured", async () => {
    const h = harness({
      MD_PUBLISHER_TOKEN: "current-publisher-token-0123456789ab",
      MD_PUBLISHER_TOKEN_PREVIOUS: "previous-publisher-token-0123456789",
    });
    const response = await openPublication(h, pagePayload(), { token: "previous-publisher-token-0123456789" });
    expect(response.status).toBe(201);
  });
});

/* ------------------------------------------------------------------ *
 * The broker derives everything
 * ------------------------------------------------------------------ */

describe("Gate F: the broker owns the plan", () => {
  it("derives the snapshot id, file ids, filenames, URLs and R2 keys itself", async () => {
    const h = harness();
    const plan = await planOf(await openPublication(h, pagePayload()));

    expect(plan.snapshot_id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/);
    expect(plan.files.map((file) => file.file_id)).toEqual(["f0", "f1"]);
    expect(plan.files.map((file) => file.filename)).toEqual([
      "anul_i_semestrul_i-19.pdf",
      "anul_ii_semestrul_iii-13.pdf",
    ]);
    for (const file of plan.files) {
      expect(file.source_url.startsWith(UPLOAD_BASE)).toBe(true);
      expect(file.upload_path).toBe(`/publications/${plan.snapshot_id}/files/${file.file_id}`);
      expect(file.status).toBe("needed");
    }

    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(plan.snapshot_id))!;
    expect(descriptor.origin).toBe("md_publisher");
    expect(descriptor.files.map((file) => file.r2_key)).toEqual(
      plan.files.map((file) => snapshotPdfKey(plan.snapshot_id, file.filename)),
    );
  });

  it("stores the Page API bytes verbatim, stamped with the operation and payload hash", async () => {
    const h = harness();
    const page = pagePayload();
    const operationId = crypto.randomUUID();
    const plan = await planOf(await openPublication(h, page, { operationId }));

    expect(h.bucket.text(snapshotPageApiKey(plan.snapshot_id))).toBe(page);
    const metadata = h.bucket.metadata(snapshotPageApiKey(plan.snapshot_id));
    expect(metadata?.operation_id).toBe(operationId);
    expect(metadata?.page_api_sha256).toBe(await sha256Hex(new TextEncoder().encode(page)));
  });

  it("refuses a payload whose declared hash does not match its bytes, without mutating anything", async () => {
    const h = harness();
    const response = await openPublication(h, pagePayload(), { pageSha256: "0".repeat(64) });
    expect(response.status).toBe(400);
    expect((await body(response)).code).toBe("page_hash_mismatch");
    expect(h.bucket.keys()).toEqual([]);
  });

  it("refuses a payload the broker cannot read as a page, or that names no official PDF", async () => {
    const h = harness();
    const notJson = await openPublication(h, "{not json");
    expect(notJson.status).toBe(400);
    expect((await body(notJson)).code).toBe("invalid_page_payload");

    const noPdfs = await openPublication(
      h,
      JSON.stringify([{ id: 1, modified_gmt: "2026-09-08T12:57:59", content: { rendered: "<p>nothing</p>" } }]),
    );
    expect(noPdfs.status).toBe(400);
    expect((await body(noPdfs)).code).toBe("no_official_pdfs");
    expect(h.bucket.keys()).toEqual([]);
  });

  it("ignores every off-policy URL a page tries to smuggle in", async () => {
    const h = harness();
    const plan = await planOf(
      await openPublication(
        h,
        pagePayload({
          urls: [
            `${UPLOAD_BASE}/anul_i_semestrul_i-19.pdf`,
            "https://evil.example.com/wp-content/uploads/sites/24/2026/09/x.pdf",
            "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/../../etc/passwd.pdf",
            "http://fcim.utm.md/wp-content/uploads/sites/24/2026/09/insecure.pdf",
          ],
        }),
      ),
    );
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].source_url).toBe(`${UPLOAD_BASE}/anul_i_semestrul_i-19.pdf`);
  });

  it("rejects an oversized or empty Page API payload", async () => {
    const h = harness();
    const huge = await openPublication(h, pagePayload(), { contentLength: String(2 * 1024 * 1024) });
    expect(huge.status).toBe(413);

    const empty = await openPublication(h, "");
    expect(empty.status).toBe(400);
    expect(h.bucket.keys()).toEqual([]);
  });

  it("rejects a non-JSON content type", async () => {
    const h = harness();
    const response = await openPublication(h, pagePayload(), { contentType: "text/plain" });
    expect(response.status).toBe(415);
  });
});

/* ------------------------------------------------------------------ *
 * DF-01 / DF-06: operation identity
 * ------------------------------------------------------------------ */

describe("Gate F: operation identity", () => {
  it("rejects an operation id that is not a UUIDv4", async () => {
    const h = harness();
    for (const id of ["", "not-a-uuid", "00000000-0000-0000-0000-000000000000", crypto.randomUUID().toUpperCase()]) {
      const response = await openPublication(h, pagePayload(), { operationId: id });
      expect(response.status).toBe(400);
    }
    expect(h.bucket.keys()).toEqual([]);
  });

  it("resumes the same publication for the same operation id and the same page bytes", async () => {
    const h = harness();
    const operationId = crypto.randomUUID();
    const page = pagePayload();

    const first = await openPublication(h, page, { operationId });
    expect(first.status).toBe(201);
    const firstPlan = await planOf(first);

    const second = await openPublication(h, page, { operationId });
    expect(second.status).toBe(200);
    const secondPlan = await planOf(second);

    expect(secondPlan.status).toBe("resumed");
    expect(secondPlan.snapshot_id).toBe(firstPlan.snapshot_id);
    expect(h.bucket.keys().filter((key) => key.startsWith("pending/"))).toHaveLength(1);
  });

  it("reports already-stored files when a resumed publication has partial uploads", async () => {
    const h = harness();
    const operationId = crypto.randomUUID();
    const page = pagePayload();
    const plan = await planOf(await openPublication(h, page, { operationId }));

    await uploadPublicationFile(h, plan.snapshot_id, "f0", pdfBody("f0"));

    const resumed = await planOf(await openPublication(h, page, { operationId }));
    expect(resumed.files.map((file) => file.status)).toEqual(["stored", "needed"]);
  });

  it("refuses the same operation id with different page bytes, and mutates nothing", async () => {
    const h = harness();
    const operationId = crypto.randomUUID();
    const plan = await planOf(await openPublication(h, pagePayload(), { operationId }));
    const before = h.bucket.keys();

    const response = await openPublication(h, pagePayload({ modifiedGmt: "2026-09-09T09:00:00" }), { operationId });
    expect(response.status).toBe(409);
    const failure = await body(response);
    expect(failure.code).toBe("operation_payload_mismatch");
    // The confused client must not learn which snapshot its id already owns.
    expect(JSON.stringify(failure)).not.toContain(plan.snapshot_id);
    expect(h.bucket.keys()).toEqual(before);
  });

  it("expires an operation whose descriptor is gone", async () => {
    const h = harness();
    const operationId = crypto.randomUUID();
    const page = pagePayload();
    const plan = await planOf(await openPublication(h, page, { operationId }));

    await h.bucket.delete(pendingDescriptorKey(plan.snapshot_id));

    const response = await openPublication(h, page, { operationId });
    expect(response.status).toBe(410);
    expect((await body(response)).code).toBe("operation_expired");
  });

  it("fails closed when the operation record and the descriptor disagree", async () => {
    const h = harness();
    const operationId = crypto.randomUUID();
    const page = pagePayload();
    const plan = await planOf(await openPublication(h, page, { operationId }));

    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(plan.snapshot_id))!;
    descriptor.operation_id = crypto.randomUUID();
    h.bucket.seed(pendingDescriptorKey(plan.snapshot_id), JSON.stringify(descriptor));

    const response = await openPublication(h, page, { operationId });
    expect(response.status).toBe(409);
    expect((await body(response)).code).toBe("operation_state_corrupt");
  });

  it("fails closed on complete when the stored page provenance disagrees with the descriptor", async () => {
    const h = harness();
    const page = pagePayload();
    const plan = await planOf(await openPublication(h, page));
    for (const file of plan.files) {
      await uploadPublicationFile(h, plan.snapshot_id, file.file_id, pdfBody(file.file_id));
    }

    // Rewrite the immutable page object's provenance stamp, as a storage-level tamper would.
    h.bucket.seed(snapshotPageApiKey(plan.snapshot_id), page, {
      snapshot_id: plan.snapshot_id,
      operation_id: crypto.randomUUID(),
      page_api_sha256: await sha256Hex(new TextEncoder().encode(page)),
    });

    const response = await completePublication(h, plan.snapshot_id);
    expect(response.status).toBe(409);
    expect((await body(response)).code).toBe("operation_state_corrupt");
    // runFinalize must not have executed: no manifest, no pointer.
    expect(h.bucket.has(snapshotManifestKey(plan.snapshot_id))).toBe(false);
    expect(h.bucket.has("current.json")).toBe(false);
  });

  it("writes the operation record before any snapshot state", async () => {
    const h = harness();
    const operationId = crypto.randomUUID();
    const plan = await planOf(await openPublication(h, pagePayload(), { operationId }));
    expect(h.bucket.has(operationKey(operationId))).toBe(true);
    expect(h.bucket.json<{ snapshot_id: string }>(operationKey(operationId))?.snapshot_id).toBe(plan.snapshot_id);
  });
});

/* ------------------------------------------------------------------ *
 * The regression Gate F exists for
 * ------------------------------------------------------------------ */

describe("Gate F: same page, changed PDF", () => {
  it("publishes a replaced PDF under an unchanged page and URL set, with no force of any kind", async () => {
    const h = harness();
    const page = pagePayload({ modifiedGmt: "2026-09-08T12:57:59" });

    const first = await publishThroughApi(h, { page, body: pdfBody("X") });
    expect(first.completeBody.status).toBe("published");
    const firstPointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(firstPointer.ok && firstPointer.pointer.snapshot_id).toBe(first.snapshotId);

    // FCIM replaced the document in place: identical page bytes, identical URL, new PDF body.
    const second = await publishThroughApi(h, { page, body: pdfBody("Y") });
    expect(second.completeBody.status).toBe("published");
    expect(second.snapshotId).not.toBe(first.snapshotId);

    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok && pointer.pointer.snapshot_id).toBe(second.snapshotId);

    // The old snapshot is untouched immutable history.
    const oldManifest = h.bucket.json<SnapshotManifest>(snapshotManifestKey(first.snapshotId))!;
    expect(oldManifest.snapshot_id).toBe(first.snapshotId);
    const oldBytes = h.bucket.bytes(snapshotPdfKey(first.snapshotId, oldManifest.files[0].filename))!;
    expect(new TextDecoder().decode(oldBytes)).toContain("body X");

    const newManifest = h.bucket.json<SnapshotManifest>(snapshotManifestKey(second.snapshotId))!;
    const newBytes = h.bucket.bytes(snapshotPdfKey(second.snapshotId, newManifest.files[0].filename))!;
    expect(new TextDecoder().decode(newBytes)).toContain("body Y");
    expect(await sha256Hex(newBytes)).not.toBe(await sha256Hex(oldBytes));
  });

  it("has no force affordance on the publication route", async () => {
    const h = harness();
    await publishThroughApi(h, { page: pagePayload({ modifiedGmt: "2026-09-08T12:57:59" }) });

    const stale = pagePayload({ modifiedGmt: "2026-09-01T00:00:00" });
    const bytes = new TextEncoder().encode(stale);
    const forced = await worker.fetch(
      new Request("https://broker.test/publications?force=1", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_PUBLISHER_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": String(bytes.byteLength),
          "X-Publication-Operation-Id": crypto.randomUUID(),
          "X-Page-Sha256": await sha256Hex(bytes),
          "X-Publication-Force": "1",
        },
        body: asBody(bytes),
      }),
      h.env,
      h.ctx,
    );
    expect(forced.status).toBe(409);
    expect((await body(forced)).code).toBe("stale_page");
  });
});

/* ------------------------------------------------------------------ *
 * DF-03: temporal guards
 * ------------------------------------------------------------------ */

describe("Gate F: temporal guards", () => {
  const HOUR = 60 * 60 * 1000;
  const now = Date.parse("2026-09-10T12:00:00Z");
  const skew = 26 * HOUR;

  it("evaluates every documented case", () => {
    // No baseline: anything is allowed, including a page with no timestamp at all.
    expect(evaluatePageTimestamp("2026-09-08T12:57:59", null, now, skew).ok).toBe(true);
    expect(evaluatePageTimestamp(null, null, now, skew).ok).toBe(true);

    // A baseline exists but the incoming payload has no usable timestamp: refuse.
    const missing = evaluatePageTimestamp(null, "2026-09-08T12:57:59", now, skew);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.code).toBe("stale_page");

    const older = evaluatePageTimestamp("2026-09-07T00:00:00", "2026-09-08T12:57:59", now, skew);
    expect(!older.ok && older.status).toBe(409);
    expect(!older.ok && older.code).toBe("stale_page");

    // Equal must stay valid: it is how an in-place PDF replacement gets published.
    expect(evaluatePageTimestamp("2026-09-08T12:57:59", "2026-09-08T12:57:59", now, skew).ok).toBe(true);
    expect(evaluatePageTimestamp("2026-09-09T00:00:00", "2026-09-08T12:57:59", now, skew).ok).toBe(true);
  });

  it("holds the future-skew boundary exactly", () => {
    const atBoundary = new Date(now + skew).toISOString().slice(0, 19);
    const pastBoundary = new Date(now + skew + 1000).toISOString().slice(0, 19);

    expect(evaluatePageTimestamp(atBoundary, null, now, skew).ok).toBe(true);
    const refused = evaluatePageTimestamp(pastBoundary, null, now, skew);
    expect(!refused.ok && refused.status).toBe(400);
    expect(!refused.ok && refused.code).toBe("future_page");
  });

  it("refuses an older page over HTTP once a snapshot exists", async () => {
    const h = harness();
    await publishThroughApi(h, { page: pagePayload({ modifiedGmt: "2026-09-08T12:57:59" }) });
    const keysBefore = h.bucket.keys();

    const response = await openPublication(h, pagePayload({ modifiedGmt: "2026-09-07T08:00:00" }));
    expect(response.status).toBe(409);
    expect((await body(response)).code).toBe("stale_page");
    expect(h.bucket.keys()).toEqual(keysBefore);
  });

  it("refuses a page with no timestamp once a timestamped snapshot exists", async () => {
    const h = harness();
    await publishThroughApi(h, { page: pagePayload({ modifiedGmt: "2026-09-08T12:57:59" }) });

    const untimed = JSON.stringify([
      { id: 1739, content: { rendered: `<a href="${UPLOAD_BASE}/anul_i_semestrul_i-19.pdf">x</a>` } },
    ]);
    const response = await openPublication(h, untimed);
    expect(response.status).toBe(409);
    expect((await body(response)).code).toBe("stale_page");
  });

  it("refuses a page dated beyond the future-skew allowance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    const h = harness();
    const response = await openPublication(h, pagePayload({ modifiedGmt: "2026-09-14T12:00:00" }));
    expect(response.status).toBe(400);
    expect((await body(response)).code).toBe("future_page");
    expect(h.bucket.keys()).toEqual([]);
  });

  it("honours a configured skew allowance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    const h = harness({ MAX_PAGE_FUTURE_SKEW_HOURS: "1" });
    expect((await openPublication(h, pagePayload({ modifiedGmt: "2026-09-10T12:30:00" }))).status).toBe(201);

    const h2 = harness({ MAX_PAGE_FUTURE_SKEW_HOURS: "1" });
    expect((await openPublication(h2, pagePayload({ modifiedGmt: "2026-09-10T14:00:00" }))).status).toBe(400);
  });

  it("fails closed when current.json cannot be parsed", async () => {
    const h = harness();
    h.bucket.seed("current.json", '{"snapshot_id":"nope"}');
    const response = await openPublication(h, pagePayload());
    expect(response.status).toBe(503);
    expect((await body(response)).code).toBe("broker_state_unreadable");
  });
});

/* ------------------------------------------------------------------ *
 * DF-05 and the rest of upload validation
 * ------------------------------------------------------------------ */

describe("Gate F: upload integrity", () => {
  async function openOne(h: WorkerHarness) {
    return planOf(await openPublication(h, pagePayload({ filenames: ["anul_i_semestrul_i-19.pdf"] })));
  }

  it("stores a valid body and records a completion marker with null trusted validators", async () => {
    const h = harness();
    const plan = await openOne(h);
    const bytes = pdfBody("one");

    const response = await uploadPublicationFile(h, plan.snapshot_id, "f0", bytes, {
      observedEtag: '"upstream-etag"',
      observedLastModified: "Tue, 08 Sep 2026 12:57:59 GMT",
    });
    expect(response.status).toBe(200);

    const key = snapshotPdfKey(plan.snapshot_id, plan.files[0].filename);
    expect(h.bucket.bytes(key)).toEqual(bytes);
    expect(h.bucket.metadata(key)?.content_sha256).toBe(await sha256Hex(bytes));

    const marker = h.bucket.json<CompletionMarker>(pendingCompletionKey(plan.snapshot_id, "f0"))!;
    expect(marker.upstream_etag).toBeNull();
    expect(marker.upstream_last_modified).toBeNull();
    expect(marker.publisher_observed_etag).toBe('"upstream-etag"');
    expect(marker.content_sha256).toBe(await sha256Hex(bytes));
  });

  it("rejects a body whose bytes do not hash to the declared digest, and stores nothing", async () => {
    const h = harness();
    const plan = await openOne(h);
    const key = snapshotPdfKey(plan.snapshot_id, plan.files[0].filename);

    const response = await uploadPublicationFile(h, plan.snapshot_id, "f0", pdfBody("real"), {
      sha256: await sha256Hex(pdfBody("different")),
    });
    expect(response.status).toBe(400);
    expect((await body(response)).code).toBe("content_hash_mismatch");
    // The R2 double refuses the write server-side, exactly as a declared-checksum PUT does.
    expect(await h.env.R2_BUCKET.head(key)).toBeNull();
    expect(h.bucket.has(pendingCompletionKey(plan.snapshot_id, "f0"))).toBe(false);
  });

  it("rejects a body that is not a PDF", async () => {
    const h = harness();
    const plan = await openOne(h);
    const response = await uploadPublicationFile(
      h, plan.snapshot_id, "f0", new TextEncoder().encode("<html>not a pdf at all</html>"),
    );
    expect(response.status).toBe(400);
    expect((await body(response)).code).toBe("invalid_pdf_magic");
    expect(h.bucket.has(snapshotPdfKey(plan.snapshot_id, plan.files[0].filename))).toBe(false);
  });

  it("rejects a body shorter than a PDF signature", async () => {
    const h = harness();
    const plan = await openOne(h);
    const response = await uploadPublicationFile(h, plan.snapshot_id, "f0", new TextEncoder().encode("%PD"));
    expect(response.status).toBe(400);
    expect((await body(response)).code).toBe("invalid_pdf_magic");
  });

  it("rejects a declared length over the ceiling before reading a byte", async () => {
    const h = harness();
    const plan = await openOne(h);
    const response = await uploadPublicationFile(h, plan.snapshot_id, "f0", pdfBody(), {
      contentLength: String(26 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
    expect(h.bucket.has(snapshotPdfKey(plan.snapshot_id, plan.files[0].filename))).toBe(false);
  });

  it("rejects a body whose real length disagrees with Content-Length", async () => {
    const h = harness();
    const plan = await openOne(h);
    const response = await uploadPublicationFile(h, plan.snapshot_id, "f0", pdfBody(), {
      contentLength: "12",
    });
    expect(response.status).toBe(400);
    expect((await body(response)).code).toBe("length_mismatch");
    expect(h.bucket.has(snapshotPdfKey(plan.snapshot_id, plan.files[0].filename))).toBe(false);
  });

  it("requires a Content-Length, an application/pdf type and a declared digest", async () => {
    const h = harness();
    const plan = await openOne(h);
    const bytes = pdfBody();

    const noLength = await worker.fetch(
      new Request(`https://broker.test/publications/${plan.snapshot_id}/files/f0`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TEST_PUBLISHER_TOKEN}`,
          "Content-Type": "application/pdf",
          "X-Content-Sha256": await sha256Hex(bytes),
        },
        body: asBody(bytes),
      }),
      h.env,
      h.ctx,
    );
    expect(noLength.status).toBe(411);

    expect((await uploadPublicationFile(h, plan.snapshot_id, "f0", bytes, { contentType: "text/html" })).status).toBe(415);
    expect((await uploadPublicationFile(h, plan.snapshot_id, "f0", bytes, { sha256: "nope" })).status).toBe(400);
  });

  it("treats an identical re-upload as success and a conflicting one as a conflict", async () => {
    const h = harness();
    const plan = await openOne(h);
    const bytes = pdfBody("first");

    expect((await uploadPublicationFile(h, plan.snapshot_id, "f0", bytes)).status).toBe(200);

    // "The upload timed out, but maybe it landed" — the retry is a success, not a duplicate.
    const retry = await uploadPublicationFile(h, plan.snapshot_id, "f0", bytes);
    expect(retry.status).toBe(200);
    expect((await body(retry)).status).toBe("already_stored");

    const conflicting = await uploadPublicationFile(h, plan.snapshot_id, "f0", pdfBody("second"));
    expect(conflicting.status).toBe(409);
    expect((await body(conflicting)).code).toBe("file_conflict");
    // The immutable object still holds the original bytes.
    expect(h.bucket.bytes(snapshotPdfKey(plan.snapshot_id, plan.files[0].filename))).toEqual(bytes);
  });

  it("refuses a file id the plan does not contain, and one that is not a file id at all", async () => {
    const h = harness();
    const plan = await openOne(h);
    expect((await uploadPublicationFile(h, plan.snapshot_id, "f7", pdfBody())).status).toBe(404);
    expect((await uploadPublicationFile(h, plan.snapshot_id, "../../current.json", pdfBody())).status).toBe(404);
    expect((await uploadPublicationFile(h, plan.snapshot_id, "f99999", pdfBody())).status).toBe(400);
  });

  it("refuses an upload to an unknown or expired publication", async () => {
    // The route checks the six-hour window before it checks existence, so "unknown" and
    // "expired" are only distinguishable against a pinned clock. Both ids are built relative
    // to that clock rather than written down, so neither answer can drift with wall time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
    const h = harness();

    const unknown = await uploadPublicationFile(h, snapshotIdAt(Date.now() - 60_000), "f0", pdfBody());
    expect(unknown.status).toBe(404);

    const expired = await uploadPublicationFile(
      h,
      snapshotIdAt(Date.now() - PENDING_MAX_AGE_MS - 60_000),
      "f0",
      pdfBody(),
    );
    expect(expired.status).toBe(410);
  });
});

/* ------------------------------------------------------------------ *
 * Transactions
 * ------------------------------------------------------------------ */

describe("Gate F: transaction safety", () => {
  it("leaves an opened-but-abandoned publication entirely out of current.json", async () => {
    const h = harness();
    const plan = await planOf(await openPublication(h, pagePayload()));
    expect(h.bucket.has(pendingDescriptorKey(plan.snapshot_id))).toBe(true);
    expect(h.bucket.has(snapshotManifestKey(plan.snapshot_id))).toBe(false);
    expect(h.bucket.has("current.json")).toBe(false);
  });

  it("refuses to complete a publication that is missing an upload", async () => {
    const h = harness();
    const plan = await planOf(await openPublication(h, pagePayload()));
    await uploadPublicationFile(h, plan.snapshot_id, "f0", pdfBody("f0"));

    const response = await completePublication(h, plan.snapshot_id);
    expect(response.status).toBe(409);
    const failure = await body(response);
    expect(failure.code).toBe("publication_incomplete");
    expect((failure.missing as string[]).length).toBeGreaterThan(0);
    expect(h.bucket.has("current.json")).toBe(false);
  });

  it("publishes once every planned file is present, and is safe to complete twice", async () => {
    const h = harness();
    const result = await publishThroughApi(h);
    expect(result.completeBody.status).toBe("published");

    const again = await completePublication(h, result.snapshotId);
    expect(again.status).toBe(200);
    expect((await body(again)).status).toBe("already_current");
  });

  it("lets the first of two concurrent publications win the pointer and calls the second superseded", async () => {
    const h = harness();
    const page = pagePayload({ modifiedGmt: "2026-09-08T12:57:59" });

    // Both open against the same (absent) current.json, so both hold the same CAS expectation.
    const planA = await planOf(await openPublication(h, page));
    const planB = await planOf(await openPublication(h, page));
    expect(planA.snapshot_id).not.toBe(planB.snapshot_id);

    for (const plan of [planA, planB]) {
      for (const file of plan.files) {
        await uploadPublicationFile(h, plan.snapshot_id, file.file_id, pdfBody(file.filename));
      }
    }

    const first = await completePublication(h, planA.snapshot_id);
    expect((await body(first)).status).toBe("published");

    const second = await completePublication(h, planB.snapshot_id);
    expect(second.status).toBe(200);
    expect((await body(second)).status).toBe("superseded");

    const pointer = parseCurrentPointer(h.bucket.text("current.json")!);
    expect(pointer.ok && pointer.pointer.snapshot_id).toBe(planA.snapshot_id);
    // The loser stays complete, immutable and simply unreferenced.
    expect(h.bucket.has(snapshotManifestKey(planB.snapshot_id))).toBe(true);
  });

  it("gives two publishers with identical content two independent snapshots", async () => {
    const h = harness();
    const page = pagePayload();
    const a = await planOf(await openPublication(h, page));
    const b = await planOf(await openPublication(h, page));
    expect(a.snapshot_id).not.toBe(b.snapshot_id);
    expect(a.operation_id).not.toBe(b.operation_id);
  });

  it("keeps a publication out of the pointer when its finalize runs after expiry", async () => {
    const h = harness();
    const plan = await planOf(await openPublication(h, pagePayload()));
    for (const file of plan.files) {
      await uploadPublicationFile(h, plan.snapshot_id, file.file_id, pdfBody(file.file_id));
    }

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 7 * 60 * 60 * 1000));
    const response = await completePublication(h, plan.snapshot_id);
    expect(response.status).toBe(410);
    expect(h.bucket.has("current.json")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * DF-02: nothing publisher-controlled becomes a trusted validator
 * ------------------------------------------------------------------ */

describe("Gate F: publisher-observed validators stay untrusted", () => {
  it("publishes a manifest whose trusted validators are null and whose observations are informational", async () => {
    const h = harness();
    const result = await publishThroughApi(h, { observedEtag: '"render-current-etag"' });
    const manifest = h.bucket.json<SnapshotManifest>(snapshotManifestKey(result.snapshotId))!;

    expect(manifest.source.etag).toBeNull();
    expect(manifest.source.last_modified).toBeNull();
    for (const file of manifest.files) {
      expect(file.upstream_etag).toBeNull();
      expect(file.upstream_last_modified).toBeNull();
      expect(file.publisher_observed_etag).toBe('"render-current-etag"');
      expect(file.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("keeps the trusted validators null even if a completion marker claims otherwise", async () => {
    const h = harness();
    const plan = await planOf(await openPublication(h, pagePayload()));
    for (const file of plan.files) {
      await uploadPublicationFile(h, plan.snapshot_id, file.file_id, pdfBody(file.file_id));
    }

    // Tamper with a marker directly, as a storage-level compromise would.
    const key = pendingCompletionKey(plan.snapshot_id, "f0");
    const marker = h.bucket.json<CompletionMarker>(key)!;
    marker.upstream_etag = '"render-current-etag"';
    marker.upstream_last_modified = "Tue, 08 Sep 2026 12:57:59 GMT";
    h.bucket.seed(key, JSON.stringify(marker));

    expect((await runFinalize(h.env, plan.snapshot_id)).outcome).toBe("published");
    const manifest = h.bucket.json<SnapshotManifest>(snapshotManifestKey(plan.snapshot_id))!;
    expect(manifest.files.every((file) => file.upstream_etag === null)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Queue and cron narrowing
 * ------------------------------------------------------------------ */

describe("Gate F: no background path reaches FCIM", () => {
  it("removes the publish trigger route entirely", async () => {
    const h = harness();
    for (const [method, path] of [["POST", "/publish"], ["POST", "/publish?force=1"], ["GET", "/publish"]] as const) {
      const response = await worker.fetch(
        new Request(`https://broker.test${path}`, {
          method,
          headers: { Authorization: "Bearer test-secret" },
        }),
        h.env,
        h.ctx,
      );
      expect(response.status).toBe(404);
    }
  });

  it("queues only reconciliation from cron", async () => {
    const h = harness();
    await worker.scheduled({ cron: "*/20 * * * *", type: "scheduled", scheduledTime: Date.now() }, h.env, h.ctx);
    expect(h.queue.sent).toEqual([{ schema_version: 1, kind: "reconcile" }]);
    expect(fcimCalls).toEqual([]);
  });

  it("refuses the retired job kinds instead of executing them", () => {
    expect(validateJob({ schema_version: 1, kind: "discover", force: false }).ok).toBe(false);
    expect(
      validateJob({
        schema_version: 1,
        kind: "ingest_pdf",
        snapshot_id: "2026-09-10T10-00-00-000Z-abcdef01",
        file_id: "f0",
        filename: "anul_i_semestrul_i-19.pdf",
        source_url: `${UPLOAD_BASE}/anul_i_semestrul_i-19.pdf`,
        r2_key: "snapshots/2026-09-10T10-00-00-000Z-abcdef01/pdfs/anul_i_semestrul_i-19.pdf",
      }).ok,
    ).toBe(false);
  });

  it("acks a retired job without running anything or touching the network", async () => {
    const h = harness();
    let acked = false;
    let retried = false;
    await worker.queue(
      {
        queue: "fcim-broker-publication",
        messages: [
          {
            id: "legacy-1",
            timestamp: new Date(),
            attempts: 1,
            body: { schema_version: 1, kind: "discover", force: true } as never,
            ack: () => { acked = true; },
            retry: () => { retried = true; },
          },
        ],
        ackAll: () => {},
        retryAll: () => {},
      },
      h.env,
      h.ctx,
    );
    expect(acked).toBe(true);
    expect(retried).toBe(false);
    expect(fcimCalls).toEqual([]);
    expect(h.bucket.keys()).toEqual([]);
  });

  it("reconciles by re-driving finalize only, never by asking for bytes", async () => {
    const h = harness();
    const plan = await planOf(await openPublication(h, pagePayload()));
    for (const file of plan.files) {
      await uploadPublicationFile(h, plan.snapshot_id, file.file_id, pdfBody(file.file_id));
    }

    // Age the publication past the "leave it alone, its uploads are in flight" window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 10 * 60 * 1000));

    const result = await runReconcile(h.env);
    expect(result.outcome).toBe("requeued");
    expect(result.requeued_finalizes).toBe(1);
    expect(h.queue.sent.every((job) => job.kind === "finalize")).toBe(true);
    expect(fcimCalls).toEqual([]);
  });

  it("leaves a publication with missing uploads to the publisher rather than fetching for it", async () => {
    const h = harness();
    const plan = await planOf(await openPublication(h, pagePayload()));
    await uploadPublicationFile(h, plan.snapshot_id, "f0", pdfBody("f0"));

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 10 * 60 * 1000));

    await runReconcile(h.env);
    expect(h.queue.sent.filter((job) => job.kind !== "finalize")).toEqual([]);
    expect(fcimCalls).toEqual([]);
    expect(h.bucket.has("current.json")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Observability
 * ------------------------------------------------------------------ */

describe("Gate F: heartbeat and status", () => {
  it("stamps its own received_at and keeps the client clock informational", async () => {
    const h = harness();
    const response = await putHeartbeat(h, {
      schema_version: 1,
      client_reported_at: "1999-01-01T00:00:00.000Z",
      status: "ok",
      outcome: "published",
      pdf_count: 2,
      saw_drift: true,
      duration_ms: 4200,
      logon_model: "Interactive",
      publisher_version: "1.0.0",
    });
    expect(response.status).toBe(200);

    const stored = h.bucket.json<{ received_at: string; client_reported_at: string; outcome: string }>(
      "publisher/heartbeat.json",
    )!;
    expect(stored.client_reported_at).toBe("1999-01-01T00:00:00.000Z");
    expect(Date.parse(stored.received_at)).toBeGreaterThan(Date.parse("2020-01-01T00:00:00Z"));
    expect(stored.outcome).toBe("published");
  });

  it("bounds a hostile heartbeat instead of storing it", async () => {
    const h = harness();
    const response = await putHeartbeat(h, {
      status: "nonsense",
      error: "x".repeat(5000),
      snapshot_id: "../../current.json",
      operation_id: "not-a-uuid",
      pdf_count: -5,
    });
    expect(response.status).toBe(200);

    const stored = h.bucket.json<Record<string, unknown>>("publisher/heartbeat.json")!;
    expect(stored.status).toBe("error");
    expect((stored.error as string).length).toBeLessThanOrEqual(512);
    expect(stored.snapshot_id).toBeNull();
    expect(stored.operation_id).toBeNull();
    expect(stored.pdf_count).toBeNull();
  });

  it("rejects an oversized heartbeat", async () => {
    const h = harness();
    const response = await putHeartbeat(h, { status: "ok", error: "x".repeat(9000) });
    expect(response.status).toBe(413);
  });

  it("reports bounded operational state and never a secret", async () => {
    const h = harness();
    const result = await publishThroughApi(h);
    await putHeartbeat(h, { status: "ok", outcome: "published", snapshot_id: result.snapshotId, saw_drift: true });

    const response = await publicationStatus(h);
    expect(response.status).toBe(200);
    const status = await body(response);
    const raw = JSON.stringify(status);

    expect((status.current as { snapshot_id: string }).snapshot_id).toBe(result.snapshotId);
    expect(typeof (status.current as { age_seconds: number }).age_seconds).toBe("number");
    expect((status.publisher_heartbeat as { outcome: string }).outcome).toBe("published");
    expect(Array.isArray(status.accepted)).toBe(true);
    expect(status.open_publications).toBe(0);
    expect(raw).not.toContain(TEST_PUBLISHER_TOKEN);
    expect(raw).not.toContain("test-secret");
  });

  it("surfaces an unreadable pointer and a missing heartbeat as warnings", async () => {
    const h = harness();
    h.bucket.seed("current.json", "{}");
    const status = await body(await publicationStatus(h));
    expect(status.warnings).toContain("current_pointer_unreadable");
    expect(status.warnings).toContain("no_publisher_heartbeat");
  });

  it("counts an open publication and stops counting it once it closes", async () => {
    const h = harness();
    const plan = await planOf(await openPublication(h, pagePayload()));
    expect((await body(await publicationStatus(h))).open_publications).toBe(1);

    for (const file of plan.files) {
      await uploadPublicationFile(h, plan.snapshot_id, file.file_id, pdfBody(file.file_id));
    }
    await completePublication(h, plan.snapshot_id);
    expect((await body(await publicationStatus(h))).open_publications).toBe(0);
  });

  it("caps how many publications may be open at once", async () => {
    const h = harness();
    for (let i = 0; i < 8; i++) {
      expect((await openPublication(h, pagePayload())).status).toBe(201);
    }
    const refused = await openPublication(h, pagePayload());
    expect(refused.status).toBe(429);
    expect((await body(refused)).code).toBe("too_many_open_publications");
  });

  it("exposes the plan and per-file upload state for recovery", async () => {
    const h = harness();
    const plan = await planOf(await openPublication(h, pagePayload()));
    await uploadPublicationFile(h, plan.snapshot_id, "f0", pdfBody("f0"));

    const response = await getPublication(h, plan.snapshot_id);
    expect(response.status).toBe(200);
    const state = (await response.json()) as PlanResponse;
    expect(state.files.map((file) => file.status)).toEqual(["stored", "needed"]);

    expect((await getPublication(h, plan.snapshot_id, { token: null })).status).toBe(401);
  });
});

/* ------------------------------------------------------------------ *
 * Operation-record retention
 * ------------------------------------------------------------------ */

describe("Gate F: operations/ retention", () => {
  const OPERATION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  function seedOperation(h: WorkerHarness, operationId: string, snapshotId: string): void {
    h.bucket.seed(
      operationKey(operationId),
      JSON.stringify({
        schema_version: 1,
        operation_id: operationId,
        snapshot_id: snapshotId,
        page_api_sha256: "a".repeat(64),
        created_at: new Date().toISOString(),
      }),
    );
  }

  it("expires operation records past the retention age and keeps recent ones", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness();

    // An attempt from two days ago. Its six-hour publication window closed long before.
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    seedOperation(h, OPERATION_ID, "2026-09-09T00-00-00-000Z-abcdef12");

    // ...and one from a minute ago, which a publisher could still be resuming.
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    const recentId = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
    seedOperation(h, recentId, "2026-09-11T00-00-00-000Z-abcdef34");
    vi.setSystemTime(new Date("2026-09-11T00:01:00.000Z"));

    expect(Date.now() - Date.parse("2026-09-09T00:00:00.000Z")).toBeGreaterThan(RETENTION_AGE_MS);
    const result = await runRetention(h.env);

    expect(result.deleted_objects).toBe(1);
    expect(h.bucket.has(operationKey(OPERATION_ID))).toBe(false);
    expect(h.bucket.has(operationKey(recentId))).toBe(true);
  });

  it("bounds one sweep and converges over repeated invocations", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness();

    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    const ids: string[] = [];
    for (let n = 0; n < GC_MAX_OPERATION_DELETIONS + 20; n++) {
      const id = `3f2504e0-4f89-41d3-9a0c-${(0x305e82c3301 + n).toString(16).padStart(12, "0")}`;
      ids.push(id);
      seedOperation(h, id, "2026-09-09T00-00-00-000Z-abcdef12");
    }
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));

    const first = await runRetention(h.env);
    expect(first.deleted_objects).toBeLessThanOrEqual(GC_MAX_OPERATION_DELETIONS);
    expect(h.bucket.keys().filter((key) => key.startsWith("operations/")).length).toBeGreaterThan(0);

    for (let n = 0; n < 5; n++) await runRetention(h.env);
    expect(h.bucket.keys().filter((key) => key.startsWith("operations/"))).toHaveLength(0);
  });

  it("leaves pending and snapshot retention semantics untouched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness();

    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    const { snapshotId } = await publishThroughApi(h);
    seedOperation(h, OPERATION_ID, snapshotId);

    // Still inside the retention window: nothing at all is swept, operations included.
    vi.setSystemTime(new Date("2026-09-09T06:00:00.000Z"));
    expect((await runRetention(h.env)).deleted_objects).toBe(0);
    expect(h.bucket.has(operationKey(OPERATION_ID))).toBe(true);
    expect(h.bucket.has(snapshotManifestKey(snapshotId))).toBe(true);

    // Past it, the operation record goes — but the snapshot current.json still names does not.
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    await runRetention(h.env);
    expect(h.bucket.has(operationKey(OPERATION_ID))).toBe(false);
    expect(h.bucket.has(snapshotManifestKey(snapshotId))).toBe(true);
    expect(parseCurrentPointer(h.bucket.text("current.json")!).ok).toBe(true);
  });
});
