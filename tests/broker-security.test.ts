/**
 * Audit regression suite for the broker's input boundaries:
 * NR-C, now Gate F (the retired /publish trigger and exact publisher routing), NR-D (strict
 * current.json parsing), E-06 (actual streamed byte limit), E-08 (Page API redirect refusal)
 * and the explicit supported-course contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePutAccepted, handlePutAcceptedPayload, MAX_PAYLOAD_BYTES } from "../worker/src/accepted-handler";
import { parseSupportedCourseYear, SUPPORTED_COURSE_YEARS } from "../worker/src/courses";
import worker from "../worker/src/index";
import { validateJob, validatePendingFile } from "../worker/src/jobs";
import { fetchPageApi, PageApiError, resolvePageApiUrl } from "../worker/src/page-api";
import { buildCurrentPointer, parseCurrentPointer } from "../worker/src/pointer";
import { putLimitedStream } from "../worker/src/stream-limit";
import type { AcceptedPointer } from "../worker/src/types";
import { createHarness, MockR2Bucket, TEST_PUBLISHER_TOKEN } from "./helpers/worker-doubles";

const SNAPSHOT_ID = "2026-09-08T02-08-48-000Z-7a3b4c19";
const PDF_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf";
const PAGE_API_URL = "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view";

const restorers: (() => void)[] = [];
afterEach(() => {
  while (restorers.length) restorers.pop()!();
  vi.restoreAllMocks();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  restorers.push(() => {
    globalThis.fetch = original;
  });
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => impl(String(input), init));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

/* ------------------------------------------------------------------ *
 * NR-C: /publish is matched exactly
 * ------------------------------------------------------------------ */

describe("NR-C / Gate F: the retired /publish trigger and exact publisher routing", () => {
  const ACCEPTED_AUTH = { Authorization: "Bearer test-secret" };
  const PUBLISHER_AUTH = { Authorization: `Bearer ${TEST_PUBLISHER_TOKEN}` };

  async function request(path: string, method: string, headers: Record<string, string>) {
    const h = createHarness({ FCIM_PAGE_API_URL: PAGE_API_URL });
    const upstream = stubFetch(() => {
      throw new Error("no broker route may reach the Internet");
    });
    const res = await worker.fetch(new Request(`https://broker.local${path}`, { method, headers }), h.env, h.ctx);
    return { res, h, upstream };
  }

  // Gate F removed the trigger entirely: there is no authenticated way to ask the broker to go
  // and fetch anything, with or without a force query, under any spelling of the old path.
  const retired = [
    "/publish",
    "/publish?force=1",
    "/publish?anything",
    "/publish/",
    "/publish/extra",
    "/foo/publish",
    "/api/publish",
    "/PUBLISH",
  ];

  for (const path of retired) {
    it(`404s ${path} and performs no work, even with the accepted-state secret`, async () => {
      const { res, h, upstream } = await request(path, "POST", ACCEPTED_AUTH);
      expect(res.status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
      expect(h.bucket.keys()).toEqual([]);
      expect(h.queue.sent).toEqual([]);
    });
  }

  // The publisher routes are matched on the parsed path and nothing else.
  const notPublisherRoutes = [
    "/foo/publications",
    "/publications/extra/segments/here/more",
    "/publisher/heartbeat/extra",
    "/publication-status/extra",
    "/PUBLICATIONS",
  ];

  for (const path of notPublisherRoutes) {
    it(`404s ${path} without entering publisher logic`, async () => {
      const { res, h } = await request(path, "POST", PUBLISHER_AUTH);
      expect(res.status).toBe(404);
      expect(h.bucket.keys()).toEqual([]);
    });
  }

  it("405s a publisher route reached with the wrong method, before doing any work", async () => {
    const cases: [string, string][] = [
      ["/publications", "GET"],
      ["/publisher/heartbeat", "POST"],
      ["/publication-status", "POST"],
    ];
    for (const [path, method] of cases) {
      const { res, h } = await request(path, method, PUBLISHER_AUTH);
      expect(res.status).toBe(405);
      expect(h.bucket.keys()).toEqual([]);
    }
  });

  it("404s a publication path whose snapshot id is not a snapshot id", async () => {
    const { res } = await request("/publications/..%2F..%2Fcurrent.json", "GET", PUBLISHER_AUTH);
    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * NR-D: current.json is parsed, not pattern-matched
 * ------------------------------------------------------------------ */

describe("NR-D: strict current.json parsing", () => {
  const valid = buildCurrentPointer({
    snapshotId: SNAPSHOT_ID,
    publishedAt: "2026-09-08T02:08:50.000Z",
    pageModifiedGmt: "2026-09-08T02:00:00",
    pageId: 1739,
    pdfCount: 6,
  });

  it("accepts a well-formed pointer", () => {
    const parsed = parseCurrentPointer(JSON.stringify(valid));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.pointer.snapshot_id).toBe(SNAPSHOT_ID);
      expect(parsed.pointer.pdf_count).toBe(6);
    }
  });

  it("accepts a null page_modified_gmt and page_id", () => {
    const parsed = parseCurrentPointer(
      JSON.stringify(
        buildCurrentPointer({
          snapshotId: SNAPSHOT_ID,
          publishedAt: "2026-09-08T02:08:50.000Z",
          pageModifiedGmt: null,
          pageId: null,
          pdfCount: 0,
        }),
      ),
    );
    expect(parsed.ok).toBe(true);
  });

  const legacy = {
    schema_version: 1,
    snapshot_id: SNAPSHOT_ID,
    updated_at: "2026-09-08T02:08:50.000Z",
    manifest_r2_key: `snapshots/${SNAPSHOT_ID}/manifest.json`,
  };

  it("accepts and explicitly normalizes the exact legacy four-field pointer", () => {
    const parsed = parseCurrentPointer(JSON.stringify(legacy));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.format).toBe("legacy");
      expect(parsed.pointer.snapshot_id).toBe(SNAPSHOT_ID);
      expect(parsed.pointer.published_at).toBe(legacy.updated_at);
      expect(Object.hasOwn(parsed.pointer, "page_modified_gmt")).toBe(false);
      expect(Object.hasOwn(parsed.pointer, "page_id")).toBe(false);
      expect(Object.hasOwn(parsed.pointer, "pdf_count")).toBe(false);
    }
  });

  it("rejects malformed, extended, nested-decoy, and wrong-manifest legacy pointers", () => {
    const cases = [
      '{"schema_version":1,',
      JSON.stringify({ ...legacy, extra: "not legacy" }),
      JSON.stringify({ ...legacy, decoy: { snapshot_id: SNAPSHOT_ID } }),
      JSON.stringify({ ...legacy, manifest_r2_key: "snapshots/other/manifest.json" }),
    ];
    for (const body of cases) {
      expect(parseCurrentPointer(body).ok).toBe(false);
    }
  });

  const rejections: { name: string; body: string; error: RegExp }[] = [
    { name: "malformed JSON", body: '{"schema_version":1,', error: /not valid JSON/ },
    { name: "an array", body: JSON.stringify([valid]), error: /must be a JSON object/ },
    { name: "a bare string", body: '"just a string"', error: /must be a JSON object/ },
    {
      name: "a nested spoofed snapshot_id",
      body: JSON.stringify({ ...valid, decoy: { snapshot_id: "2026-09-09T00-00-00-000Z-deadbeef" } }),
      error: /exactly 8 fields/,
    },
    {
      name: "a nested object replacing a scalar field",
      body: JSON.stringify({ ...valid, page_id: { snapshot_id: SNAPSHOT_ID } }),
      error: /must be a string, number or null/,
    },
    {
      name: "a missing required field",
      body: JSON.stringify({ ...valid, pdf_count: undefined }),
      error: /exactly 8 fields|missing required field/,
    },
    {
      name: "a wrong schema version",
      body: JSON.stringify({ ...valid, schema_version: 2 }),
      error: /schema_version must be 1/,
    },
    {
      name: "a stringly-typed schema version",
      body: JSON.stringify({ ...valid, schema_version: "1" }),
      error: /schema_version must be 1/,
    },
    {
      name: "an invalid snapshot id",
      body: JSON.stringify({ ...valid, snapshot_id: "../../etc/passwd" }),
      error: /not a valid snapshot identifier/,
    },
    {
      name: "a manifest key that addresses another snapshot",
      body: JSON.stringify({ ...valid, manifest_r2_key: "snapshots/other/manifest.json" }),
      error: /manifest_r2_key/,
    },
    {
      name: "a non-integer pdf_count",
      body: JSON.stringify({ ...valid, pdf_count: 2.5 }),
      error: /pdf_count/,
    },
    {
      name: "an unknown extra field",
      body: JSON.stringify({ ...valid, extra: "x" }),
      error: /exactly 8 fields/,
    },
    { name: "an empty document", body: "", error: /empty/ },
  ];

  for (const testCase of rejections) {
    it(`rejects ${testCase.name}`, () => {
      const parsed = parseCurrentPointer(testCase.body);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(testCase.error);
    });
  }

  it("rejects a duplicated critical key even though JSON.parse keeps only the last value", () => {
    const body = `{"schema_version":1,"snapshot_id":"2026-09-09T00-00-00-000Z-deadbeef","snapshot_id":"${SNAPSHOT_ID}","updated_at":"${valid.updated_at}","published_at":"${valid.published_at}","manifest_r2_key":"${valid.manifest_r2_key}","page_modified_gmt":"2026-09-08T02:00:00","page_id":1739,"pdf_count":6}`;

    // JSON.parse alone would happily hand back the last one.
    expect((JSON.parse(body) as { snapshot_id: string }).snapshot_id).toBe(SNAPSHOT_ID);

    const parsed = parseCurrentPointer(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/more than once/);
  });

  it("rejects an oversized pointer without parsing it", () => {
    const parsed = parseCurrentPointer(`{"padding":"${"x".repeat(5000)}"}`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/exceeds/);
  });
});

/* ------------------------------------------------------------------ *
 * E-06: the enforced limit is the counted one
 * ------------------------------------------------------------------ */

describe("E-06: accepted payload byte limit is enforced on the stream", () => {
  const acceptedId = "a4c610d24dd53bbf-p1_3_0-1111111111111111";

  function chunkedBody(totalBytes: number): ReadableStream<Uint8Array> {
    const chunkSize = 512 * 1024;
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(chunkSize, totalBytes - sent);
        controller.enqueue(new Uint8Array(size).fill(0x20));
        sent += size;
      },
    });
  }

  it("preserves Cloudflare's known-length stream contract while counting actual bytes", async () => {
    const marked = new WeakSet<object>();
    class TestFixedLengthStream {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array>;
      constructor(_length: number) {
        const stream = new TransformStream<Uint8Array, Uint8Array>();
        this.readable = stream.readable;
        this.writable = stream.writable;
        marked.add(this.readable);
      }
    }
    const runtime = globalThis as typeof globalThis & { FixedLengthStream?: typeof TestFixedLengthStream };
    const original = runtime.FixedLengthStream;
    runtime.FixedLengthStream = TestFixedLengthStream;
    restorers.push(() => {
      if (original) runtime.FixedLengthStream = original;
      else delete runtime.FixedLengthStream;
    });

    const bytes = new TextEncoder().encode("known-length payload");
    const stored = await putLimitedStream(
      new Response(bytes).body!,
      1024,
      bytes.byteLength,
      async (body) => {
        expect(marked.has(body)).toBe(true);
        if (body instanceof Uint8Array) return body;
        return new Uint8Array(await new Response(body).arrayBuffer());
      },
    );

    expect(stored).toEqual(bytes);
  });

  async function upload(totalBytes: number) {
    const h = createHarness({ SCHEDULE_BROKER_SECRET: "secret" });
    const request = new Request(`https://broker.local/accepted-payloads/course-1/${acceptedId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
        "x-source-pdf-hash": "a".repeat(64),
        "x-source-pdf-url": PDF_URL,
        "x-payload-sha256": "b".repeat(64),
        "x-snapshot-id": SNAPSHOT_ID,
        "x-parser-version": "1.3.0",
        "x-accepted-at": "2026-09-08T02:00:05.000Z",
      },
      body: chunkedBody(totalBytes),
      // Chunked upload: no Content-Length is sent at all.
      duplex: "half",
    } as RequestInit & { duplex: string });

    expect(request.headers.get("Content-Length")).toBeNull();
    const res = await handlePutAcceptedPayload(request, h.env, "1", acceptedId);
    return { res, bucket: h.bucket as MockR2Bucket };
  }

  it("accepts a body one byte under the limit", async () => {
    const { res, bucket } = await upload(MAX_PAYLOAD_BYTES - 1);
    expect(res.status).toBe(200);
    expect(bucket.has(`accepted-payloads/course-1/${acceptedId}.json`)).toBe(true);
  });

  it("accepts a body exactly at the limit", async () => {
    const { res, bucket } = await upload(MAX_PAYLOAD_BYTES);
    expect(res.status).toBe(200);
    expect(bucket.bytes(`accepted-payloads/course-1/${acceptedId}.json`)!.byteLength).toBe(MAX_PAYLOAD_BYTES);
  });

  it("rejects a body one byte over the limit and stores nothing", async () => {
    const { res, bucket } = await upload(MAX_PAYLOAD_BYTES + 1);
    expect(res.status).toBe(413);
    expect(bucket.has(`accepted-payloads/course-1/${acceptedId}.json`)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Supported course contract
 * ------------------------------------------------------------------ */

describe("supported course contract", () => {
  it("accepts only the canonical spelling of a supported course year", () => {
    expect(SUPPORTED_COURSE_YEARS).toEqual([1, 2]);
    expect(parseSupportedCourseYear("1")).toBe(1);
    expect(parseSupportedCourseYear("2")).toBe(2);

    for (const raw of ["0", "3", "99", "-1", "01", "1.0", "1x", " 1", "1 ", "+1", "", "1e0"]) {
      expect(parseSupportedCourseYear(raw)).toBeNull();
    }
  });

  it("refuses unsupported course years on every accepted-state route", async () => {
    const h = createHarness({ SCHEDULE_BROKER_SECRET: "secret" });
    for (const raw of ["0", "3", "99"]) {
      const res = await worker.fetch(
        new Request(`https://broker.local/accepted/course-${raw}`, { method: "GET" }),
        h.env,
        h.ctx,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.supported_course_years).toEqual([1, 2]);
    }
  });

  it("404s a course token that is not even shaped like one", async () => {
    const h = createHarness();
    for (const path of ["/accepted/course-", "/accepted/course-abc", "/accepted/1", "/accepted/course-1/extra"]) {
      const res = await worker.fetch(new Request(`https://broker.local${path}`), h.env, h.ctx);
      expect(res.status).toBe(404);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Accepted pointer validation
 * ------------------------------------------------------------------ */

describe("accepted pointer validation", () => {
  const basePointer: AcceptedPointer = {
    schema_version: 1,
    course_year: 1,
    accepted_id: "a4c610d24dd53bbf-p1_3_0-1111111111111111",
    payload_key: "accepted-payloads/course-1/a4c610d24dd53bbf-p1_3_0-1111111111111111.json",
    payload_sha256: "1".repeat(64),
    source_snapshot_id: SNAPSHOT_ID,
    source_pdf_url: PDF_URL,
    source_pdf_hash: "a".repeat(64),
    parser_version: "1.3.0",
    accepted_at: "2026-09-08T02:00:05.000Z",
  };

  function seedPayload(bucket: MockR2Bucket, pointer: AcceptedPointer): void {
    bucket.seed(pointer.payload_key, "{}", {
      course_year: String(pointer.course_year),
      source_pdf_hash: pointer.source_pdf_hash,
      source_pdf_url: pointer.source_pdf_url,
      payload_sha256: pointer.payload_sha256,
      snapshot_id: pointer.source_snapshot_id,
      parser_version: pointer.parser_version,
      accepted_at: pointer.accepted_at,
    });
  }

  async function put(pointer: unknown, bucketSeed?: AcceptedPointer) {
    const h = createHarness({ SCHEDULE_BROKER_SECRET: "secret" });
    if (bucketSeed) seedPayload(h.bucket, bucketSeed);
    const res = await handlePutAccepted(
      new Request("https://broker.local/accepted/course-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        body: JSON.stringify({ expected_previous_accepted_id: null, pointer }),
      }),
      h.env,
      "1",
    );
    return { res, bucket: h.bucket };
  }

  it("rejects a pointer with no accepted_at", async () => {
    const { accepted_at: _dropped, ...withoutAcceptedAt } = basePointer;
    const { res } = await put(withoutAcceptedAt, basePointer);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/accepted_at/);
  });

  it("rejects a pointer whose accepted_at is not an instant", async () => {
    const { res } = await put({ ...basePointer, accepted_at: "yesterday" }, basePointer);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/accepted_at/);
  });

  it("rejects a source_pdf_url outside the official timetable policy", async () => {
    for (const url of [
      "https://evil.example/anul_i.pdf",
      "http://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/../anul_i.pdf",
    ]) {
      const { res } = await put({ ...basePointer, source_pdf_url: url }, basePointer);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/source_pdf_url/);
    }
  });

  it("rejects a source_snapshot_id that is not a snapshot identifier", async () => {
    const { res } = await put({ ...basePointer, source_snapshot_id: "snap-1" }, basePointer);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/source_snapshot_id/);
  });

  it("rejects a pointer whose fields disagree with the stored payload metadata", async () => {
    const stored = { ...basePointer, accepted_at: "2026-09-08T09:00:00.000Z" };
    const { res } = await put(basePointer, stored);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not agree with pointer fields/);
  });

  it("accepts a fully consistent pointer", async () => {
    const { res } = await put(basePointer, basePointer);
    expect(res.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * E-08: the Page API must answer directly
 * ------------------------------------------------------------------ */

describe("E-08: Page API redirect safety", () => {
  it("only accepts the exact approved endpoint", () => {
    expect(resolvePageApiUrl(undefined)).toBe(PAGE_API_URL);
    expect(resolvePageApiUrl(PAGE_API_URL)).toBe(PAGE_API_URL);
    expect(() => resolvePageApiUrl("https://fcim.utm.md/wp-json/wp/v2/pages?slug=other&context=view")).toThrow(
      /Invalid Page API URL/,
    );
    expect(() => resolvePageApiUrl("https://evil.example/wp-json/wp/v2/pages?slug=orar&context=view")).toThrow(
      /Invalid Page API URL/,
    );
  });

  it("requests with redirect: manual so nothing is followed implicitly", async () => {
    const spy = stubFetch(
      () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await fetchPageApi(createHarness().env, PAGE_API_URL);
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe("manual");
  });

  const redirects: { name: string; location: string }[] = [
    { name: "a different host", location: "https://evil.example/wp-json/wp/v2/pages?slug=orar&context=view" },
    { name: "a different path", location: "https://fcim.utm.md/wp-json/wp/v2/pages/9999" },
    { name: "an unexpected query", location: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=edit" },
    { name: "plain HTTP", location: "http://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view" },
    { name: "the same URL", location: PAGE_API_URL },
  ];

  for (const { name, location } of redirects) {
    it(`refuses a redirect to ${name}`, async () => {
      stubFetch(() => new Response(null, { status: 302, headers: { Location: location } }));
      await expect(fetchPageApi(createHarness().env, PAGE_API_URL)).rejects.toThrow(PageApiError);
      await expect(fetchPageApi(createHarness().env, PAGE_API_URL)).rejects.toThrow(/redirect/i);
    });
  }

  for (const status of [301, 303, 307, 308]) {
    it(`refuses an HTTP ${status} redirect`, async () => {
      stubFetch(() => new Response(null, { status, headers: { Location: "https://evil.example/" } }));
      await expect(fetchPageApi(createHarness().env, PAGE_API_URL)).rejects.toThrow(/redirect/i);
    });
  }
});

/* ------------------------------------------------------------------ *
 * Job contract
 * ------------------------------------------------------------------ */

describe("publication job contract", () => {
  const validFile = {
    snapshot_id: SNAPSHOT_ID,
    file_id: "f0",
    filename: "anul_i_semestrul_i-18.pdf",
    source_url: PDF_URL,
    r2_key: `snapshots/${SNAPSHOT_ID}/pdfs/anul_i_semestrul_i-18.pdf`,
  };

  it("accepts a well-formed planned file", () => {
    expect(validatePendingFile(validFile).ok).toBe(true);
  });

  const badFiles: { name: string; file: Parameters<typeof validatePendingFile>[0] }[] = [
    { name: "a foreign source_url", file: { ...validFile, source_url: "https://evil.example/x.pdf" } },
    {
      name: "an r2_key pointing at another snapshot",
      file: { ...validFile, r2_key: "snapshots/other/pdfs/anul_i_semestrul_i-18.pdf" },
    },
    {
      name: "a filename that disagrees with the source_url",
      file: { ...validFile, filename: "elsewhere.pdf", r2_key: `snapshots/${SNAPSHOT_ID}/pdfs/elsewhere.pdf` },
    },
    { name: "a traversal filename", file: { ...validFile, filename: "../secret.pdf" } },
    { name: "an invalid snapshot id", file: { ...validFile, snapshot_id: "../.." } },
    { name: "a non-string file id", file: { ...validFile, file_id: 0 } },
  ];

  for (const testCase of badFiles) {
    it(`rejects ${testCase.name}`, () => {
      expect(validatePendingFile(testCase.file).ok).toBe(false);
    });
  }

  // The queue carries two kinds now. The two that could reach FCIM are refused on receipt.
  it("accepts only finalize and reconcile jobs", () => {
    expect(validateJob({ schema_version: 1, kind: "finalize", snapshot_id: SNAPSHOT_ID }).ok).toBe(true);
    expect(validateJob({ schema_version: 1, kind: "reconcile" }).ok).toBe(true);
  });

  const badJobs: { name: string; job: unknown }[] = [
    { name: "a retired discover job", job: { schema_version: 1, kind: "discover", force: false } },
    { name: "a retired ingest job", job: { schema_version: 1, kind: "ingest_pdf", ...validFile } },
    { name: "an unknown kind", job: { schema_version: 1, kind: "delete_everything" } },
    { name: "an unsupported schema version", job: { schema_version: 2, kind: "reconcile" } },
    { name: "a finalize job with a bad snapshot id", job: { schema_version: 1, kind: "finalize", snapshot_id: "../.." } },
    { name: "a non-object", job: "ingest everything" },
  ];

  for (const testCase of badJobs) {
    it(`rejects ${testCase.name}`, () => {
      expect(validateJob(testCase.job).ok).toBe(false);
    });
  }
});
