import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
import { generateSnapshotId } from "../worker/src/publisher";
import { SNAPSHOT_ID_REGEX } from "../worker/src/pointer";
import { acceptedPointerKey } from "../worker/src/keys";
import type { AcceptedPointer, R2Object, R2PutOptions } from "../worker/src/types";
import { createHarness, MockR2Bucket } from "./helpers/worker-doubles";

/**
 * R2 double that lets a test slip a concurrent write in between the Worker's `get()` of the
 * accepted pointer and the conditional `put()` that carries that object's ETag — the exact
 * window `onlyIf: { etagMatches }` exists to close.
 */
class RacingR2Bucket extends MockR2Bucket {
  private pendingRace: { key: string; run: () => void } | null = null;

  /** Run `run` once, immediately before the next `put()` to `key` evaluates its precondition. */
  raceBeforeNextPut(key: string, run: () => void): void {
    this.pendingRace = { key, run };
  }

  override async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    if (this.pendingRace && this.pendingRace.key === key) {
      const { run } = this.pendingRace;
      this.pendingRace = null;
      run();
    }
    return super.put(key, value, options);
  }
}

const SNAPSHOT_ID = "2026-09-08T02-08-48-000Z-7a3b4c19";
const OTHER_SNAPSHOT_ID = "2026-09-08T03-11-02-500Z-9f0e1d22";
const PDF_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf";
const OTHER_PDF_URL =
  "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-19.pdf";

describe("worker transport & URL policy", () => {
  it("strictly validates official timetable PDF URLs", () => {
    expect(isOfficialTimetablePdfUrl(PDF_URL)).toBe(true);
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
      isOfficialTimetablePdfUrl("https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/..%2f../etc/passwd.pdf"),
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

  it("generates collision-safe snapshot IDs the strict parser accepts", () => {
    const id1 = generateSnapshotId();
    const id2 = generateSnapshotId();

    expect(id1).not.toBe(id2);
    expect(id1).toMatch(SNAPSHOT_ID_REGEX);
    expect(SNAPSHOT_ID).toMatch(SNAPSHOT_ID_REGEX);
  });
});

describe("worker accepted-state gateway & CAS semantics", () => {
  const sampleSchedule = {
    metadata: {
      academic_year: "2026/2027",
      semester: "Semestrul I",
      course_year: 1,
      source_page_url: "https://fcim.utm.md/procesul-de-studii/orar/",
      source_pdf_url: PDF_URL,
      source_pdf_hash: "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a",
      source_kind: "live" as const,
      source_transport: "broker" as const,
      source_snapshot_id: SNAPSHOT_ID,
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

  const payloadSha = "1111111111111111111111111111111111111111111111111111111111111111";
  const acceptedId1 = "a4c610d24dd53bbf-p1_3_0-1111111111111111";

  const samplePointer: AcceptedPointer = {
    schema_version: 1,
    course_year: 1,
    accepted_id: acceptedId1,
    payload_key: `accepted-payloads/course-1/${acceptedId1}.json`,
    payload_sha256: payloadSha,
    source_snapshot_id: SNAPSHOT_ID,
    source_pdf_url: PDF_URL,
    source_pdf_hash: "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a",
    parser_version: "1.3.0",
    accepted_at: "2026-09-08T02:00:05.000Z",
  };

  function payloadHeaders(pointer: AcceptedPointer, secret = "secret"): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
      "x-course-year": String(pointer.course_year),
      "x-source-pdf-hash": pointer.source_pdf_hash,
      "x-source-pdf-url": pointer.source_pdf_url,
      "x-payload-sha256": pointer.payload_sha256,
      "x-snapshot-id": pointer.source_snapshot_id,
      "x-parser-version": pointer.parser_version,
      "x-accepted-at": pointer.accepted_at,
    };
  }

  function seedPayload(bucket: MockR2Bucket, pointer: AcceptedPointer): void {
    bucket.seed(pointer.payload_key, JSON.stringify(sampleSchedule), {
      course_year: String(pointer.course_year),
      source_pdf_hash: pointer.source_pdf_hash,
      source_pdf_url: pointer.source_pdf_url,
      payload_sha256: pointer.payload_sha256,
      snapshot_id: pointer.source_snapshot_id,
      parser_version: pointer.parser_version,
      accepted_at: pointer.accepted_at,
    });
  }

  function pointerRequest(body: unknown, secret = "secret"): Request {
    return new Request("https://broker.local/accepted/course-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    });
  }

  it("rejects unauthorized PUT /accepted-payloads without bearer secret", async () => {
    const { env } = createHarness({ SCHEDULE_BROKER_SECRET: "correct-secret" });

    const req = new Request(`https://broker.local/accepted-payloads/course-1/${acceptedId1}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sampleSchedule),
    });

    const res = await handlePutAcceptedPayload(req, env, "1", acceptedId1);
    expect(res.status).toBe(401);
  });

  it("supports immutable payload upload and GET retrieval", async () => {
    const { env } = createHarness({ SCHEDULE_BROKER_SECRET: "secret" });

    const res = await handlePutAcceptedPayload(
      new Request(`https://broker.local/accepted-payloads/course-1/${acceptedId1}`, {
        method: "PUT",
        headers: payloadHeaders(samplePointer),
        body: JSON.stringify(sampleSchedule),
      }),
      env,
      "1",
      acceptedId1,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("created");

    // Duplicate identical upload returns idempotent success
    const dupRes = await handlePutAcceptedPayload(
      new Request(`https://broker.local/accepted-payloads/course-1/${acceptedId1}`, {
        method: "PUT",
        headers: payloadHeaders(samplePointer),
        body: JSON.stringify(sampleSchedule),
      }),
      env,
      "1",
      acceptedId1,
    );
    expect(dupRes.status).toBe(200);
    expect((await dupRes.json()).status).toBe("idempotent");

    // Conflicting metadata on an existing immutable key is a 409, never an overwrite
    const conflictRes = await handlePutAcceptedPayload(
      new Request(`https://broker.local/accepted-payloads/course-1/${acceptedId1}`, {
        method: "PUT",
        headers: {
          ...payloadHeaders(samplePointer),
          "x-source-pdf-hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
        body: JSON.stringify(sampleSchedule),
      }),
      env,
      "1",
      acceptedId1,
    );
    expect(conflictRes.status).toBe(409);

    const getRes = await handleGetAcceptedPayload(env, "1", acceptedId1);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("Cache-Control")).toContain("immutable");
  });

  it("rejects unauthorized PUT /accepted/course-1 pointer without bearer secret", async () => {
    const { env } = createHarness({ SCHEDULE_BROKER_SECRET: "correct-secret" });

    const req = new Request("https://broker.local/accepted/course-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_previous_accepted_id: null, pointer: samplePointer }),
    });

    const res = await handlePutAccepted(req, env, "1");
    expect(res.status).toBe(401);
  });

  it("rejects pointer write when course_year does not match requested course", async () => {
    const { env } = createHarness({ SCHEDULE_BROKER_SECRET: "secret" });

    const res = await handlePutAccepted(
      new Request("https://broker.local/accepted/course-2", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        body: JSON.stringify({ expected_previous_accepted_id: null, pointer: samplePointer }),
      }),
      env,
      "2",
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("does not match requested course 2");
  });

  it("rejects pointer write when referenced payload does not exist in storage", async () => {
    const { env } = createHarness({ SCHEDULE_BROKER_SECRET: "secret" });

    const res = await handlePutAccepted(
      pointerRequest({ expected_previous_accepted_id: null, pointer: samplePointer }),
      env,
      "1",
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("does not exist in storage");
  });

  it("supports initial accepted pointer PUT and GET when payload exists", async () => {
    const { env, bucket } = createHarness({ SCHEDULE_BROKER_SECRET: "secret" });
    seedPayload(bucket, samplePointer);

    const res = await handlePutAccepted(
      pointerRequest({ expected_previous_accepted_id: null, pointer: samplePointer }),
      env,
      "1",
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("created");

    const getRes = await handleGetAccepted(env, "1");
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as AcceptedPointer;
    expect(fetched.accepted_id).toBe(samplePointer.accepted_id);
    expect(fetched.payload_key).toBe(samplePointer.payload_key);
  });

  it("handles idempotent pointer PUT when re-submitted with identical accepted_id", async () => {
    const { env, bucket } = createHarness({ SCHEDULE_BROKER_SECRET: "secret" });
    seedPayload(bucket, samplePointer);

    await handlePutAccepted(
      pointerRequest({ expected_previous_accepted_id: null, pointer: samplePointer }),
      env,
      "1",
    );

    const dupRes = await handlePutAccepted(
      pointerRequest({
        expected_previous_accepted_id: samplePointer.accepted_id,
        pointer: samplePointer,
      }),
      env,
      "1",
    );

    expect(dupRes.status).toBe(200);
    expect((await dupRes.json()).status).toBe("idempotent");
  });

  it("rejects stale pointer PUT with 409 conflict when existing accepted_id differs from expected", async () => {
    const { env, bucket } = createHarness({ SCHEDULE_BROKER_SECRET: "secret" });
    seedPayload(bucket, samplePointer);

    await handlePutAccepted(
      pointerRequest({ expected_previous_accepted_id: null, pointer: samplePointer }),
      env,
      "1",
    );

    const acceptedId2 = "b5d721e35ee64ccf-p1_3_0-2222222222222222";
    const updatedPointer: AcceptedPointer = {
      ...samplePointer,
      accepted_id: acceptedId2,
      payload_key: `accepted-payloads/course-1/${acceptedId2}.json`,
      payload_sha256: "2222222222222222222222222222222222222222222222222222222222222222",
      source_pdf_hash: "b5d721e35ee64ccf98d6eb42300ffc8abb223d8a394496988f29f2fc1637c80b",
      source_pdf_url: OTHER_PDF_URL,
      source_snapshot_id: OTHER_SNAPSHOT_ID,
    };
    seedPayload(bucket, updatedPointer);

    const staleRes = await handlePutAccepted(
      pointerRequest({
        expected_previous_accepted_id: "wrong_previous_id",
        pointer: updatedPointer,
      }),
      env,
      "1",
    );

    expect(staleRes.status).toBe(409);
    expect((await staleRes.json()).error).toContain("Conflict");
  });

  it("updates accepted pointer with 200 when expected_previous_accepted_id matches", async () => {
    const { env, bucket } = createHarness({ SCHEDULE_BROKER_SECRET: "secret" });
    seedPayload(bucket, samplePointer);

    await handlePutAccepted(
      pointerRequest({ expected_previous_accepted_id: null, pointer: samplePointer }),
      env,
      "1",
    );

    const acceptedId2 = "b5d721e35ee64ccf-p1_3_0-2222222222222222";
    const updatedPointer: AcceptedPointer = {
      ...samplePointer,
      accepted_id: acceptedId2,
      payload_key: `accepted-payloads/course-1/${acceptedId2}.json`,
      payload_sha256: "2222222222222222222222222222222222222222222222222222222222222222",
      source_pdf_hash: "b5d721e35ee64ccf98d6eb42300ffc8abb223d8a394496988f29f2fc1637c80b",
      source_pdf_url: OTHER_PDF_URL,
      source_snapshot_id: OTHER_SNAPSHOT_ID,
    };
    seedPayload(bucket, updatedPointer);

    const updateRes = await handlePutAccepted(
      pointerRequest({
        expected_previous_accepted_id: samplePointer.accepted_id,
        pointer: updatedPointer,
      }),
      env,
      "1",
    );

    expect(updateRes.status).toBe(200);
    expect((await updateRes.json()).status).toBe("updated");

    const getRes = await handleGetAccepted(env, "1");
    const fetched = (await getRes.json()) as AcceptedPointer;
    expect(fetched.accepted_id).toBe(updatedPointer.accepted_id);
  });

  it("returns 409 CAS_CONFLICT when the pointer object changes between the ETag read and the conditional PUT", async () => {
    const bucket = new RacingR2Bucket();
    const { env } = createHarness({ SCHEDULE_BROKER_SECRET: "secret", R2_BUCKET: bucket });
    const pointerKey = acceptedPointerKey(1);

    // Pointer A is the installed accepted state; Render read it and holds its accepted_id.
    seedPayload(bucket, samplePointer);
    const created = await handlePutAccepted(
      pointerRequest({ expected_previous_accepted_id: null, pointer: samplePointer }),
      env,
      "1",
    );
    expect(created.status).toBe(200);
    const etagA = (await bucket.head(pointerKey))!.etag;

    // Pointer C is what this request wants to install.
    const acceptedIdC = "c6e832f46ff75dd0-p1_3_0-3333333333333333";
    const pointerC: AcceptedPointer = {
      ...samplePointer,
      accepted_id: acceptedIdC,
      payload_key: `accepted-payloads/course-1/${acceptedIdC}.json`,
      payload_sha256: "3333333333333333333333333333333333333333333333333333333333333333",
      source_pdf_hash: "c6e832f46ff75dd098d6eb42300ffc8abb223d8a394496988f29f2fc1637c80b",
      source_pdf_url: OTHER_PDF_URL,
      source_snapshot_id: OTHER_SNAPSHOT_ID,
    };
    seedPayload(bucket, pointerC);

    // Pointer B is a competing writer that lands after the Worker's read, before its write.
    const acceptedIdB = "b5d721e35ee64ccf-p1_3_0-4444444444444444";
    const pointerB: AcceptedPointer = {
      ...samplePointer,
      accepted_id: acceptedIdB,
      payload_key: `accepted-payloads/course-1/${acceptedIdB}.json`,
      payload_sha256: "4444444444444444444444444444444444444444444444444444444444444444",
      source_pdf_hash: "b5d721e35ee64ccf98d6eb42300ffc8abb223d8a394496988f29f2fc1637c80b",
      source_pdf_url: OTHER_PDF_URL,
      source_snapshot_id: OTHER_SNAPSHOT_ID,
    };
    seedPayload(bucket, pointerB);
    bucket.raceBeforeNextPut(pointerKey, () => {
      bucket.seed(pointerKey, JSON.stringify(pointerB));
    });

    // expected_previous_accepted_id still matches A, so the application-level check passes and
    // the request reaches the `onlyIf: { etagMatches }` branch — which is what must reject it.
    const res = await handlePutAccepted(
      pointerRequest({ expected_previous_accepted_id: samplePointer.accepted_id, pointer: pointerC }),
      env,
      "1",
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe("CAS_CONFLICT");
    expect(body.error).toContain("concurrent write modified accepted pointer");
    // Not the accepted_id comparison path — that branch carries no code and a different message.
    expect(body.error).not.toContain("differs from expected");

    // The racing write survives untouched; C was never installed.
    const stored = bucket.json<AcceptedPointer>(pointerKey);
    expect(stored?.accepted_id).toBe(acceptedIdB);
    expect(stored?.payload_sha256).toBe(pointerB.payload_sha256);
    expect((await bucket.head(pointerKey))!.etag).not.toBe(etagA);

    const getRes = await handleGetAccepted(env, "1");
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as AcceptedPointer).accepted_id).toBe(acceptedIdB);
  });
});
