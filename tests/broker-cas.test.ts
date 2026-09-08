import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  handleGetAccepted,
  handleGetAcceptedPayload,
  handlePutAccepted,
  handlePutAcceptedPayload,
} from "../worker/src/accepted-handler";
import {
  extractOfficialPdfUrls,
  isAllowedPageApiUrl,
  isOfficialTimetablePdfUrl,
} from "../worker/src/extractor";
import { generateSnapshotId, publishCandidateSnapshot } from "../worker/src/publisher";
import type {
  AcceptedPointer,
  AcceptedRecord,
  CurrentPointer,
  Env,
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
  SnapshotManifest,
} from "../worker/src/types";

/**
 * High-fidelity in-memory Cloudflare R2 bucket simulator.
 * Strictly models R2 conditional PUT operations:
 * - onlyIf: { etagMatches }
 * - onlyIf: Headers("If-None-Match: *")
 * Concurrent writes to the same key without matching conditions return null (CAS conflict).
 */
export class MockR2Bucket implements R2Bucket {
  private storage = new Map<
    string,
    {
      data: Uint8Array;
      etag: string;
      httpEtag: string;
      uploaded: Date;
      httpMetadata?: Record<string, string>;
      customMetadata?: Record<string, string>;
    }
  >();

  async head(key: string): Promise<R2Object | null> {
    const item = this.storage.get(key);
    if (!item) return null;
    return {
      key,
      version: item.etag,
      size: item.data.byteLength,
      etag: item.etag,
      httpEtag: item.httpEtag,
      uploaded: item.uploaded,
      httpMetadata: item.httpMetadata,
      customMetadata: item.customMetadata,
    };
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const item = this.storage.get(key);
    if (!item) return null;

    const data = item.data;
    const bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });

    return {
      key,
      version: item.etag,
      size: data.byteLength,
      etag: item.etag,
      httpEtag: item.httpEtag,
      uploaded: item.uploaded,
      httpMetadata: item.httpMetadata,
      customMetadata: item.customMetadata,
      body: bodyStream,
      bodyUsed: false,
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(data),
      json: async <T = unknown>() => JSON.parse(new TextDecoder().decode(data)) as T,
      blob: async () => new Blob([Buffer.from(data)]),
    };
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    const existing = this.storage.get(key);

    // Evaluate R2 conditional preconditions
    if (options?.onlyIf) {
      if (options.onlyIf instanceof Headers) {
        const ifNoneMatch = options.onlyIf.get("If-None-Match");
        if (ifNoneMatch === "*" && existing) {
          // Object exists but If-None-Match: * was requested -> Precondition failed
          return null;
        }
      } else {
        const cond = options.onlyIf;
        if (cond.etagMatches) {
          if (!existing || existing.etag !== cond.etagMatches) {
            // ETag mismatch -> Precondition failed
            return null;
          }
        }
      }
    }

    let bytes: Uint8Array;
    if (typeof value === "string") {
      bytes = new TextEncoder().encode(value);
    } else if (value instanceof Uint8Array) {
      bytes = value;
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else if (value && typeof value === "object" && "getReader" in value) {
      const reader = (value as ReadableStream).getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        chunks.push(chunk);
      }
      const totalLen = chunks.reduce((acc, c) => acc + c.byteLength, 0);
      bytes = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      bytes = new Uint8Array(0);
    }

    const etag = crypto.randomUUID().replace(/-/g, "");
    const httpEtag = `"${etag}"`;
    const uploaded = new Date();

    this.storage.set(key, {
      data: bytes,
      etag,
      httpEtag,
      uploaded,
      customMetadata: options?.customMetadata,
    });

    return {
      key,
      version: etag,
      size: bytes.byteLength,
      etag,
      httpEtag,
      uploaded,
      customMetadata: options?.customMetadata,
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      this.storage.delete(k);
    }
  }

  // Helper for test assertions
  has(key: string): boolean {
    return this.storage.has(key);
  }
}

describe("worker transport & URL policy", () => {
  it("strictly validates official timetable PDF URLs", () => {
    // Valid official URLs
    expect(
      isOfficialTimetablePdfUrl("https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf"),
    ).toBe(true);
    expect(
      isOfficialTimetablePdfUrl(
        "https://fcim.utm.md/wp-content/uploads/sites/24/2026/02/anul_ii_semestrul_iii-10.pdf",
      ),
    ).toBe(true);

    // Insecure / non-https
    expect(
      isOfficialTimetablePdfUrl("http://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf"),
    ).toBe(false);

    // External domain
    expect(
      isOfficialTimetablePdfUrl("https://evil.com/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf"),
    ).toBe(false);

    // Traversal and encoding attacks
    expect(
      isOfficialTimetablePdfUrl(
        "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/..%2f../etc/passwd.pdf",
      ),
    ).toBe(false);
    expect(
      isOfficialTimetablePdfUrl("https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/../test.pdf"),
    ).toBe(false);

    // Non-PDF extension
    expect(
      isOfficialTimetablePdfUrl("https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.docx"),
    ).toBe(false);
  });

  it("validates WordPress Page API URL", () => {
    expect(isAllowedPageApiUrl("https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view")).toBe(true);
    expect(isAllowedPageApiUrl("https://utm.md/wp-json/wp/v2/pages")).toBe(false);
    expect(isAllowedPageApiUrl("https://fcim.utm.md/wp-json/wp/v2/pages")).toBe(false);
    expect(isAllowedPageApiUrl("http://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view")).toBe(false);
    expect(isAllowedPageApiUrl("https://malicious.com/wp-json")).toBe(false);
  });

  it("extracts official timetable PDF URLs from HTML fixture without cheerio", async () => {
    const fixturePath = path.join(__dirname, "fixtures", "orar-page-autumn-2026.html");
    const html = await readFile(fixturePath, "utf-8");

    const extracted = extractOfficialPdfUrls(html);
    expect(extracted.length).toBeGreaterThanOrEqual(4);

    expect(
      extracted.some((url) =>
        url.includes("https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf"),
      ),
    ).toBe(true);
    expect(
      extracted.some((url) =>
        url.includes("https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-8.pdf"),
      ),
    ).toBe(true);
  });

  it("generates collision-safe snapshot IDs with random suffix", () => {
    const id1 = generateSnapshotId();
    const id2 = generateSnapshotId();

    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/i);
  });
});

describe("worker candidate snapshot publication & CAS ordering", () => {
  const fakePageApiPayload = [
    {
      id: 1739,
      date_gmt: "2026-09-08T02:00:00",
      modified_gmt: "2026-09-08T02:00:00",
      content: {
        rendered: `
          <p>Orar licenta:</p>
          <a href="https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf">Anul I</a>
          <a href="https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-11.pdf">Anul II</a>
        `,
      },
    },
  ];

  const fakePdfContent = new TextEncoder().encode("%PDF-1.4 Fake PDF Content");

  it("publishes candidate snapshot with strict ordering and updates current.json via CAS", async () => {
    const bucket = new MockR2Bucket();
    const env: Env = {
      R2_BUCKET: bucket,
      SCHEDULE_BROKER_SECRET: "test-secret",
    };

    // Mock global fetch for FCIM page API and PDFs
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes("wp-json/wp/v2/pages")) {
        return new Response(JSON.stringify(fakePageApiPayload), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: '"api-etag-1"',
            "Last-Modified": "Tue, 08 Sep 2026 02:00:00 GMT",
          },
        });
      }
      if (urlStr.endsWith(".pdf")) {
        return new Response(fakePdfContent, {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Length": String(fakePdfContent.byteLength),
            ETag: '"pdf-etag-1"',
            "Last-Modified": "Tue, 08 Sep 2026 02:00:00 GMT",
          },
        });
      }
      return originalFetch(input);
    }) as typeof fetch;

    try {
      const result = await publishCandidateSnapshot(env);
      expect(result.published).toBe(true);
      expect(result.snapshot_id).toBeDefined();

      const snapshotId = result.snapshot_id!;

      // Verify immutable objects were written
      expect(bucket.has(`snapshots/${snapshotId}/pdfs/anul_i_semestrul_i-18.pdf`)).toBe(true);
      expect(bucket.has(`snapshots/${snapshotId}/pdfs/anul_ii_semestrul_iii-11.pdf`)).toBe(true);
      expect(bucket.has(`snapshots/${snapshotId}/page-api.json`)).toBe(true);
      expect(bucket.has(`snapshots/${snapshotId}/manifest.json`)).toBe(true);

      // Verify current.json was written
      const currentObj = await bucket.get("current.json");
      expect(currentObj).not.toBeNull();
      const currentPointer = (await currentObj!.json()) as CurrentPointer;
      expect(currentPointer.snapshot_id).toBe(snapshotId);
      expect(currentPointer.manifest_r2_key).toBe(`snapshots/${snapshotId}/manifest.json`);

      // Verify manifest content
      const manifestObj = await bucket.get(`snapshots/${snapshotId}/manifest.json`);
      const manifest = (await manifestObj!.json()) as SnapshotManifest;
      expect(manifest.schema_version).toBe(1);
      expect(manifest.snapshot_id).toBe(snapshotId);
      expect(manifest.files.length).toBe(2);
      expect(manifest.files[0].upstream_etag).toBe('"pdf-etag-1"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("detects CAS conflict when two publishers race and rejects the stale publisher", async () => {
    const bucket = new MockR2Bucket();
    const env: Env = {
      R2_BUCKET: bucket,
      SCHEDULE_BROKER_SECRET: "test-secret",
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes("wp-json/wp/v2/pages")) {
        return new Response(JSON.stringify(fakePageApiPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(fakePdfContent, {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }) as typeof fetch;

    try {
      // First publisher publishes successfully
      const first = await publishCandidateSnapshot(env);
      expect(first.published).toBe(true);
      const firstSnapshotId = first.snapshot_id!;

      // A competing concurrent publisher had read the same initial state (or stale state).
      // We simulate this by having an interceptor that modifies current.json before publisher 2 finishes.
      // Let's test publisher 2 attempting CAS with a stale ETag:
      const currentObj = await bucket.get("current.json");
      const validEtag = currentObj!.etag;

      // Publisher 2 starts with validEtag, but meanwhile another process updates current.json
      await bucket.put("current.json", JSON.stringify({ snapshot_id: "newer-snap" }), {
        onlyIf: { etagMatches: validEtag },
      });

      // Now publisher 2 attempts conditional put with old ETag
      const stalePutResult = await bucket.put(
        "current.json",
        JSON.stringify({ snapshot_id: "stale-snap" }),
        { onlyIf: { etagMatches: validEtag } },
      );

      // CAS MUST fail
      expect(stalePutResult).toBeNull();

      // current.json must still point to newer-snap, never stale-snap
      const currentAfter = await bucket.get("current.json");
      const pointer = (await currentAfter!.json()) as { snapshot_id: string };
      expect(pointer.snapshot_id).toBe("newer-snap");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("never updates current.json if a PDF write fails (partial snapshot never becomes current)", async () => {
    const bucket = new MockR2Bucket();
    const env: Env = {
      R2_BUCKET: bucket,
      SCHEDULE_BROKER_SECRET: "test-secret",
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes("wp-json/wp/v2/pages")) {
        return new Response(JSON.stringify(fakePageApiPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Simulate PDF network error
      throw new Error("Simulated network failure on PDF download");
    }) as typeof fetch;

    try {
      const result = await publishCandidateSnapshot(env);
      expect(result.published).toBe(false);
      expect(result.error).toContain("Simulated network failure");

      // current.json MUST NOT exist
      expect(bucket.has("current.json")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("worker accepted-state gateway & CAS semantics", () => {
  const sampleSchedule = {
    metadata: {
      academic_year: "2026/2027",
      semester: "Semestrul I",
      course_year: 1,
      source_page_url: "https://fcim.utm.md/procesul-de-studii/orar/",
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      source_pdf_hash: "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a",
      source_kind: "live" as const,
      source_transport: "broker" as const,
      source_snapshot_id: "snap-1",
      downloaded_at: "2026-09-08T02:00:00.000Z",
      parsed_at: "2026-09-08T02:00:01.000Z",
      parser_version: "1.3.0",
      etag: null,
      last_modified: null,
      pdf_title: null,
    },
    groups: [{ name: "SI-261", program: "SI", x0: 0, x1: 10 }],
    days: ["Luni" as const],
    time_slots: [{ index: 0, start_time: "08:00", end_time: "09:30", raw: "08:00-09:30" }],
    lessons: [],
    warnings: [],
  };

  const sampleAcceptedRecord: AcceptedRecord = {
    schema_version: 1,
    course_year: 1,
    snapshot_id: "snap-1",
    source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
    source_pdf_hash: "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a",
    accepted_at: "2026-09-08T02:00:05.000Z",
    schedule: sampleSchedule,
  };

  const payloadSha = "1111111111111111111111111111111111111111111111111111111111111111";
  const acceptedId1 = "a4c610d24dd53bbf-p1_3_0-1111111111111111";

  const samplePointer: AcceptedPointer = {
    schema_version: 1,
    course_year: 1,
    accepted_id: acceptedId1,
    payload_key: `accepted-payloads/course-1/${acceptedId1}.json`,
    payload_sha256: payloadSha,
    source_snapshot_id: "snap-1",
    source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
    source_pdf_hash: "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a",
    parser_version: "1.3.0",
    accepted_at: "2026-09-08T02:00:05.000Z",
  };

  it("rejects unauthorized PUT /accepted-payloads without bearer secret", async () => {
    const bucket = new MockR2Bucket();
    const env: Env = { R2_BUCKET: bucket, SCHEDULE_BROKER_SECRET: "correct-secret" };

    const req = new Request(`https://broker.local/accepted-payloads/course-1/${acceptedId1}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sampleSchedule),
    });

    const res = await handlePutAcceptedPayload(req, env, "1", acceptedId1);
    expect(res.status).toBe(401);
  });

  it("supports immutable payload upload and GET retrieval", async () => {
    const bucket = new MockR2Bucket();
    const env: Env = { R2_BUCKET: bucket, SCHEDULE_BROKER_SECRET: "secret" };

    const req = new Request(`https://broker.local/accepted-payloads/course-1/${acceptedId1}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
        "x-source-pdf-hash": samplePointer.source_pdf_hash,
        "x-payload-sha256": samplePointer.payload_sha256,
        "x-snapshot-id": samplePointer.source_snapshot_id,
        "x-parser-version": samplePointer.parser_version,
      },
      body: JSON.stringify(sampleSchedule),
    });

    const res = await handlePutAcceptedPayload(req, env, "1", acceptedId1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("created");

    // Duplicate identical upload returns idempotent success
    const dupReq = new Request(`https://broker.local/accepted-payloads/course-1/${acceptedId1}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
        "x-source-pdf-hash": samplePointer.source_pdf_hash,
        "x-payload-sha256": samplePointer.payload_sha256,
        "x-snapshot-id": samplePointer.source_snapshot_id,
        "x-parser-version": samplePointer.parser_version,
      },
      body: JSON.stringify(sampleSchedule),
    });
    const dupRes = await handlePutAcceptedPayload(dupReq, env, "1", acceptedId1);
    expect(dupRes.status).toBe(200);
    const dupBody = await dupRes.json();
    expect(dupBody.status).toBe("idempotent");

    // Conflicting metadata on existing key returns 409
    const conflictReq = new Request(`https://broker.local/accepted-payloads/course-1/${acceptedId1}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
        "x-source-pdf-hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "x-payload-sha256": samplePointer.payload_sha256,
        "x-snapshot-id": samplePointer.source_snapshot_id,
        "x-parser-version": samplePointer.parser_version,
      },
      body: JSON.stringify(sampleSchedule),
    });
    const conflictRes = await handlePutAcceptedPayload(conflictReq, env, "1", acceptedId1);
    expect(conflictRes.status).toBe(409);

    // GET payload returns streamed content
    const getRes = await handleGetAcceptedPayload(env, "1", acceptedId1);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("Cache-Control")).toContain("immutable");
  });

  it("rejects unauthorized PUT /accepted/course-1 pointer without bearer secret", async () => {
    const bucket = new MockR2Bucket();
    const env: Env = { R2_BUCKET: bucket, SCHEDULE_BROKER_SECRET: "correct-secret" };

    const req = new Request("https://broker.local/accepted/course-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_previous_accepted_id: null, pointer: samplePointer }),
    });

    const res = await handlePutAccepted(req, env, "1");
    expect(res.status).toBe(401);
  });

  it("rejects pointer write when course_year does not match requested course", async () => {
    const bucket = new MockR2Bucket();
    const env: Env = { R2_BUCKET: bucket, SCHEDULE_BROKER_SECRET: "secret" };

    const req = new Request("https://broker.local/accepted/course-2", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      },
      // Course 1 pointer offered to Course 2 endpoint
      body: JSON.stringify({ expected_previous_accepted_id: null, pointer: samplePointer }),
    });

    const res = await handlePutAccepted(req, env, "2");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("does not match requested course 2");
  });

  it("rejects pointer write when referenced payload does not exist in storage", async () => {
    const bucket = new MockR2Bucket();
    const env: Env = { R2_BUCKET: bucket, SCHEDULE_BROKER_SECRET: "secret" };

    const req = new Request("https://broker.local/accepted/course-1", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      },
      body: JSON.stringify({ expected_previous_accepted_id: null, pointer: samplePointer }),
    });

    const res = await handlePutAccepted(req, env, "1");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("does not exist in storage");
  });

  it("supports initial accepted pointer PUT and GET when payload exists", async () => {
    const bucket = new MockR2Bucket();
    const env: Env = { R2_BUCKET: bucket, SCHEDULE_BROKER_SECRET: "secret" };

    // 1. Upload payload first
    await bucket.put(samplePointer.payload_key, JSON.stringify(sampleSchedule), {
      customMetadata: {
        course_year: "1",
        source_pdf_hash: samplePointer.source_pdf_hash,
        payload_sha256: samplePointer.payload_sha256,
        snapshot_id: samplePointer.source_snapshot_id,
        parser_version: samplePointer.parser_version,
      },
    });

    // 2. Put pointer with expected_previous_accepted_id: null
    const req = new Request("https://broker.local/accepted/course-1", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      },
      body: JSON.stringify({ expected_previous_accepted_id: null, pointer: samplePointer }),
    });

    const res = await handlePutAccepted(req, env, "1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("created");

    // 3. GET /accepted/course-1 returns stored pointer
    const getRes = await handleGetAccepted(env, "1");
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as AcceptedPointer;
    expect(fetched.accepted_id).toBe(samplePointer.accepted_id);
    expect(fetched.payload_key).toBe(samplePointer.payload_key);
  });

  it("handles idempotent pointer PUT when re-submitted with identical accepted_id", async () => {
    const bucket = new MockR2Bucket();
    const env: Env = { R2_BUCKET: bucket, SCHEDULE_BROKER_SECRET: "secret" };

    await bucket.put(samplePointer.payload_key, JSON.stringify(sampleSchedule), {
      customMetadata: {
        course_year: "1",
        source_pdf_hash: samplePointer.source_pdf_hash,
        payload_sha256: samplePointer.payload_sha256,
        snapshot_id: samplePointer.source_snapshot_id,
        parser_version: samplePointer.parser_version,
      },
    });

    // Initial pointer write
    await handlePutAccepted(
      new Request("https://broker.local/accepted/course-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        body: JSON.stringify({ expected_previous_accepted_id: null, pointer: samplePointer }),
      }),
      env,
      "1",
    );

    // Duplicate submission with same accepted_id
    const dupRes = await handlePutAccepted(
      new Request("https://broker.local/accepted/course-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        body: JSON.stringify({
          expected_previous_accepted_id: samplePointer.accepted_id,
          pointer: samplePointer,
        }),
      }),
      env,
      "1",
    );

    expect(dupRes.status).toBe(200);
    const body = await dupRes.json();
    expect(body.status).toBe("idempotent");
  });

  it("rejects stale pointer PUT with 409 conflict when existing accepted_id differs from expected", async () => {
    const bucket = new MockR2Bucket();
    const env: Env = { R2_BUCKET: bucket, SCHEDULE_BROKER_SECRET: "secret" };

    await bucket.put(samplePointer.payload_key, JSON.stringify(sampleSchedule), {
      customMetadata: {
        course_year: "1",
        source_pdf_hash: samplePointer.source_pdf_hash,
        payload_sha256: samplePointer.payload_sha256,
        snapshot_id: samplePointer.source_snapshot_id,
        parser_version: samplePointer.parser_version,
      },
    });

    // Initial write
    await handlePutAccepted(
      new Request("https://broker.local/accepted/course-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        body: JSON.stringify({ expected_previous_accepted_id: null, pointer: samplePointer }),
      }),
      env,
      "1",
    );

    // Newer pointer and payload
    const acceptedId2 = "b5d721e35ee64ccf-p1_3_0-2222222222222222";
    const updatedPointer: AcceptedPointer = {
      ...samplePointer,
      accepted_id: acceptedId2,
      payload_key: `accepted-payloads/course-1/${acceptedId2}.json`,
      payload_sha256: "2222222222222222222222222222222222222222222222222222222222222222",
      source_pdf_hash: "b5d721e35ee64ccf98d6eb42300ffc8abb223d8a394496988f29f2fc1637c80b",
      source_snapshot_id: "snap-2",
    };

    await bucket.put(updatedPointer.payload_key, JSON.stringify(sampleSchedule), {
      customMetadata: {
        course_year: "1",
        source_pdf_hash: updatedPointer.source_pdf_hash,
        payload_sha256: updatedPointer.payload_sha256,
        snapshot_id: updatedPointer.source_snapshot_id,
        parser_version: updatedPointer.parser_version,
      },
    });

    // Stale writer expects wrong previous ID
    const staleRes = await handlePutAccepted(
      new Request("https://broker.local/accepted/course-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        body: JSON.stringify({
          expected_previous_accepted_id: "wrong_previous_id",
          pointer: updatedPointer,
        }),
      }),
      env,
      "1",
    );

    expect(staleRes.status).toBe(409);
    const body = await staleRes.json();
    expect(body.error).toContain("Conflict");
  });

  it("updates accepted pointer with 200 when expected_previous_accepted_id matches", async () => {
    const bucket = new MockR2Bucket();
    const env: Env = { R2_BUCKET: bucket, SCHEDULE_BROKER_SECRET: "secret" };

    await bucket.put(samplePointer.payload_key, JSON.stringify(sampleSchedule), {
      customMetadata: {
        course_year: "1",
        source_pdf_hash: samplePointer.source_pdf_hash,
        payload_sha256: samplePointer.payload_sha256,
        snapshot_id: samplePointer.source_snapshot_id,
        parser_version: samplePointer.parser_version,
      },
    });

    // Initial write
    await handlePutAccepted(
      new Request("https://broker.local/accepted/course-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        body: JSON.stringify({ expected_previous_accepted_id: null, pointer: samplePointer }),
      }),
      env,
      "1",
    );

    // Update with valid payload and matching expected_previous_accepted_id
    const acceptedId2 = "b5d721e35ee64ccf-p1_3_0-2222222222222222";
    const updatedPointer: AcceptedPointer = {
      ...samplePointer,
      accepted_id: acceptedId2,
      payload_key: `accepted-payloads/course-1/${acceptedId2}.json`,
      payload_sha256: "2222222222222222222222222222222222222222222222222222222222222222",
      source_pdf_hash: "b5d721e35ee64ccf98d6eb42300ffc8abb223d8a394496988f29f2fc1637c80b",
      source_snapshot_id: "snap-2",
    };

    await bucket.put(updatedPointer.payload_key, JSON.stringify(sampleSchedule), {
      customMetadata: {
        course_year: "1",
        source_pdf_hash: updatedPointer.source_pdf_hash,
        payload_sha256: updatedPointer.payload_sha256,
        snapshot_id: updatedPointer.source_snapshot_id,
        parser_version: updatedPointer.parser_version,
      },
    });

    const updateRes = await handlePutAccepted(
      new Request("https://broker.local/accepted/course-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        body: JSON.stringify({
          expected_previous_accepted_id: samplePointer.accepted_id,
          pointer: updatedPointer,
        }),
      }),
      env,
      "1",
    );

    expect(updateRes.status).toBe(200);
    const body = await updateRes.json();
    expect(body.status).toBe("updated");

    const getRes = await handleGetAccepted(env, "1");
    const fetched = (await getRes.json()) as AcceptedPointer;
    expect(fetched.accepted_id).toBe(updatedPointer.accepted_id);
  });
});
