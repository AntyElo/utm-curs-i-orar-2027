import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "@/lib/config";
import type { AcceptedPointer, CurrentPointer, Schedule, SnapshotManifest } from "@/lib/models";
import { parsePdf, sha256 } from "@/lib/parser";
import {
  bootstrapScheduleState,
  checkForUpdates,
  refreshAllCourses,
} from "@/lib/services/updater";
import { getCurrentSchedule, getSourceState, replaceCurrentSchedule, resetStorageCache } from "@/lib/storage";

describe("accepted-state synchronization & transaction ordering", () => {
  let tempDir: string;
  let pdfBytes18: Uint8Array;
  let pdfBytes9: Uint8Array;
  let hash18: string;
  let hash9: string;

  const originalBrokerUrl = config.brokerUrl;
  const originalBrokerSecret = config.brokerSecret;
  const originalDataDir = config.dataDir;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "fcim-sync-test-"));
    (config as { dataDir: string }).dataDir = tempDir;
    (config as { brokerUrl: string }).brokerUrl = "https://broker.fcim.internal";
    (config as { brokerSecret: string }).brokerSecret = "broker-test-secret";
    resetStorageCache();

    // Read real PDF fixtures
    const seed18Path = path.join(__dirname, "..", "data", "seed", "anul_i_semestrul_i-18.pdf");
    const seed9Path = path.join(__dirname, "fixtures", "anul_i_semestrul_i-9.pdf");
    pdfBytes18 = new Uint8Array(await readFile(seed18Path));
    pdfBytes9 = new Uint8Array(await readFile(seed9Path));
    hash18 = sha256(pdfBytes18);
    hash9 = sha256(pdfBytes9);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    (config as { dataDir: string }).dataDir = originalDataDir;
    (config as { brokerUrl: string }).brokerUrl = originalBrokerUrl;
    (config as { brokerSecret: string }).brokerSecret = originalBrokerSecret;
    resetStorageCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  function decodeBody(body: unknown): string {
    if (!body) return "";
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      return new TextDecoder().decode(body);
    }
    return String(body);
  }

  function pdfResponse(bytes: Uint8Array): Response {
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    });
  }

  async function makeSchedule(
    bytes: Uint8Array,
    url: string,
    courseYear = 1,
    parserVersion: string = config.parserVersion,
    snapshotId = "snap-test",
  ): Promise<Schedule> {
    const { schedule } = await parsePdf(bytes, {
      source_page_url: "https://fcim.utm.md/procesul-de-studii/orar/",
      source_pdf_url: url,
      source_kind: "live",
      source_transport: "broker",
      source_snapshot_id: snapshotId,
      downloaded_at: "2026-09-08T02:00:00.000Z",
      course_year: courseYear,
    });
    schedule.metadata.parser_version = parserVersion;
    schedule.metadata.source_transport = "broker";
    schedule.metadata.source_snapshot_id = snapshotId;
    return schedule;
  }

  function makeAcceptedMock(
    courseYear: number,
    schedule: Schedule,
    snapshotId = "snap-test",
    acceptedAt = "2026-09-08T02:00:00.000Z",
  ) {
    schedule.metadata.source_snapshot_id = snapshotId;
    schedule.metadata.source_transport = "broker";
    const payloadBytes = new TextEncoder().encode(JSON.stringify(schedule));
    const payloadSha256 = sha256(payloadBytes);
    const parserVersion = schedule.metadata.parser_version || config.parserVersion;
    const acceptedId = `${schedule.metadata.source_pdf_hash.slice(0, 16)}-p${parserVersion.replace(/\./g, "_")}-${payloadSha256.slice(0, 16)}`;

    const pointer: AcceptedPointer = {
      schema_version: 1,
      course_year: courseYear,
      accepted_id: acceptedId,
      payload_key: `accepted-payloads/course-${courseYear}/${acceptedId}.json`,
      payload_sha256: payloadSha256,
      source_snapshot_id: snapshotId,
      source_pdf_url: schedule.metadata.source_pdf_url,
      source_pdf_hash: schedule.metadata.source_pdf_hash,
      parser_version: parserVersion,
      accepted_at: acceptedAt,
    };

    return { pointer, schedule, payloadBytes, acceptedId };
  }

  function makePageApiPayload(links: Array<{ courseYear: number; url: string }>) {
    const romanMap: Record<number, string> = { 1: "I", 2: "II", 3: "III", 4: "IV" };
    const cells = links
      .map((l) => `<td><a href="${l.url}">Anul ${romanMap[l.courseYear] ?? l.courseYear}</a></td>`)
      .join("\n");
    return [
      {
        id: 1739,
        date_gmt: "2026-09-08T02:00:00",
        content: {
          rendered: `
            <section>
              <h2>Ciclul I, Licență - învățământ cu frecvență</h2>
              <table>
                <tr>
                  <td>Orarul semestrul de toamna 2026/2027</td>
                  ${cells}
                </tr>
              </table>
            </section>
          `,
        },
      },
    ];
  }

  it("restores accepted schedule during cold-start bootstrap before candidate validation", async () => {
    const schedule = await makeSchedule(
      pdfBytes18,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      1,
      config.parserVersion,
      "snap-bootstrap",
    );

    const mockC1 = makeAcceptedMock(1, schedule, "snap-bootstrap");

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes("/accepted/course-1")) {
        return new Response(JSON.stringify(mockC1.pointer), { status: 200 });
      }
      if (urlStr.includes(`/accepted-payloads/course-1/${mockC1.acceptedId}`)) {
        return new Response(JSON.stringify(mockC1.schedule), { status: 200 });
      }
      if (urlStr.includes("/accepted/course-2")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    expect(await getCurrentSchedule(1)).toBeNull();

    await bootstrapScheduleState();

    const local = await getCurrentSchedule(1);
    expect(local).not.toBeNull();
    expect(local?.metadata.source_pdf_hash).toBe(hash18);
    expect(local?.lessons.length).toBe(schedule.lessons.length);

    const state = await getSourceState(1);
    expect(state.last_result).toBe("updated");
    expect(state.current_pdf_hash).toBe(hash18);
  });

  it("rejects wrong-course accepted state during cold-start bootstrap", async () => {
    const schedule = await makeSchedule(
      pdfBytes18,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      1,
    );

    // Corrupted record offering course 1 schedule for course 2
    const corruptedMock = makeAcceptedMock(2, schedule, "snap-wrong");
    // Force pointer course_year to 2 while schedule has 1
    corruptedMock.pointer.course_year = 2;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes("/accepted/course-2")) {
        return new Response(JSON.stringify(corruptedMock.pointer), { status: 200 });
      }
      if (urlStr.includes(`/accepted-payloads/course-2/${corruptedMock.acceptedId}`)) {
        return new Response(JSON.stringify(corruptedMock.schedule), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await bootstrapScheduleState();

    const localCourse2 = await getCurrentSchedule(2);
    if (localCourse2) {
      expect(localCourse2.metadata.course_year).toBe(2);
    }
  });

  it("maintains previous local schedule when durable write fails (transaction ordering)", async () => {
    const initialSchedule = await makeSchedule(
      pdfBytes9,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
      1,
      config.parserVersion,
      "snap-r9",
    );
    await replaceCurrentSchedule(1, initialSchedule);
    const mockR9 = makeAcceptedMock(1, initialSchedule, "snap-r9");

    const candidatePointer: CurrentPointer = {
      schema_version: 1,
      snapshot_id: "snap-r18",
      updated_at: "2026-09-08T02:30:00.000Z",
      manifest_r2_key: "snapshots/snap-r18/manifest.json",
    };

    const candidateManifest: SnapshotManifest = {
      schema_version: 1,
      snapshot_id: "snap-r18",
      previous_snapshot_id: "snap-r9",
      created_at: "2026-09-08T02:30:00.000Z",
      source: {
        page_api_url: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view",
        page_id: 1739,
        page_modified_gmt: null,
        retrieved_at: "2026-09-08T02:30:00.000Z",
        etag: null,
        last_modified: null,
      },
      files: [
        {
          filename: "anul_i_semestrul_i-18.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
          r2_key: "snapshots/snap-r18/pdfs/anul_i_semestrul_i-18.pdf",
          content_type: "application/pdf",
          size: pdfBytes18.byteLength,
          upstream_etag: '"etag-r18"',
          upstream_last_modified: null,
        },
      ],
    };

    const pageApiPayload = makePageApiPayload([
      { courseYear: 1, url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf" },
    ]);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";

      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(candidateManifest), { status: 200 });
      }
      if (urlStr.includes("/page-api.json")) {
        return new Response(JSON.stringify(pageApiPayload), { status: 200 });
      }
      if (urlStr.endsWith(".pdf")) {
        return pdfResponse(pdfBytes18);
      }
      if (urlStr.includes("/accepted/course-1")) {
        if (method === "GET") {
          return new Response(JSON.stringify(mockR9.pointer), { status: 200 });
        }
        if (method === "PUT") {
          return new Response(JSON.stringify({ error: "R2 storage down" }), { status: 500 });
        }
      }
      if (urlStr.includes(`/accepted-payloads/course-1/${mockR9.acceptedId}`)) {
        return new Response(JSON.stringify(mockR9.schedule), { status: 200 });
      }
      if (urlStr.includes("/accepted-payloads/course-1")) {
        if (method === "PUT") {
          return new Response(JSON.stringify({ ok: true, status: "created" }), { status: 200 });
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("error");
    expect(result.message).toContain("Durable accepted write failed");

    const localAfter = await getCurrentSchedule(1);
    expect(localAfter?.metadata.source_pdf_hash).toBe(hash9);
  });

  it("installs candidate locally only after durable write succeeds", async () => {
    const initialSchedule = await makeSchedule(
      pdfBytes9,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
      1,
      config.parserVersion,
      "snap-r9",
    );
    await replaceCurrentSchedule(1, initialSchedule);
    const mockR9 = makeAcceptedMock(1, initialSchedule, "snap-r9");

    let durableWriteExecuted = false;

    const candidatePointer: CurrentPointer = {
      schema_version: 1,
      snapshot_id: "snap-r18",
      updated_at: "2026-09-08T02:30:00.000Z",
      manifest_r2_key: "snapshots/snap-r18/manifest.json",
    };

    const candidateManifest: SnapshotManifest = {
      schema_version: 1,
      snapshot_id: "snap-r18",
      previous_snapshot_id: "snap-r9",
      created_at: "2026-09-08T02:30:00.000Z",
      source: {
        page_api_url: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view",
        page_id: 1739,
        page_modified_gmt: null,
        retrieved_at: "2026-09-08T02:30:00.000Z",
        etag: null,
        last_modified: null,
      },
      files: [
        {
          filename: "anul_i_semestrul_i-18.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
          r2_key: "snapshots/snap-r18/pdfs/anul_i_semestrul_i-18.pdf",
          content_type: "application/pdf",
          size: pdfBytes18.byteLength,
          upstream_etag: '"etag-r18"',
          upstream_last_modified: null,
        },
      ],
    };

    const pageApiPayload = makePageApiPayload([
      { courseYear: 1, url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf" },
    ]);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";

      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(candidateManifest), { status: 200 });
      }
      if (urlStr.includes("/page-api.json")) {
        return new Response(JSON.stringify(pageApiPayload), { status: 200 });
      }
      if (urlStr.endsWith(".pdf")) {
        return pdfResponse(pdfBytes18);
      }
      if (urlStr.includes("/accepted/course-1")) {
        if (method === "GET") {
          return new Response(JSON.stringify(mockR9.pointer), { status: 200 });
        }
        if (method === "PUT") {
          durableWriteExecuted = true;
          return new Response(JSON.stringify({ ok: true, status: "updated" }), { status: 200 });
        }
      }
      if (urlStr.includes(`/accepted-payloads/course-1/${mockR9.acceptedId}`)) {
        return new Response(JSON.stringify(mockR9.schedule), { status: 200 });
      }
      if (urlStr.includes("/accepted-payloads/course-1")) {
        if (method === "PUT") {
          return new Response(JSON.stringify({ ok: true, status: "created" }), { status: 200 });
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("updated");
    expect(durableWriteExecuted).toBe(true);

    const localAfter = await getCurrentSchedule(1);
    expect(localAfter?.metadata.source_pdf_hash).toBe(hash18);
  });

  it("reconciles durable state if local state is missing or stale before candidate evaluation", async () => {
    const r18Schedule = await makeSchedule(
      pdfBytes18,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      1,
      config.parserVersion,
      "snap-r18",
    );
    const mockR18 = makeAcceptedMock(1, r18Schedule, "snap-r18");

    const r9Schedule = await makeSchedule(
      pdfBytes9,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
      1,
      config.parserVersion,
      "snap-r9",
    );
    await replaceCurrentSchedule(1, r9Schedule);

    const candidatePointer: CurrentPointer = {
      schema_version: 1,
      snapshot_id: "snap-r18",
      updated_at: "2026-09-08T02:30:00.000Z",
      manifest_r2_key: "snapshots/snap-r18/manifest.json",
    };

    const candidateManifest: SnapshotManifest = {
      schema_version: 1,
      snapshot_id: "snap-r18",
      previous_snapshot_id: "snap-r9",
      created_at: "2026-09-08T02:30:00.000Z",
      source: {
        page_api_url: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view",
        page_id: 1739,
        page_modified_gmt: null,
        retrieved_at: "2026-09-08T02:30:00.000Z",
        etag: null,
        last_modified: null,
      },
      files: [
        {
          filename: "anul_i_semestrul_i-18.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
          r2_key: "snapshots/snap-r18/pdfs/anul_i_semestrul_i-18.pdf",
          content_type: "application/pdf",
          size: pdfBytes18.byteLength,
          upstream_etag: '"etag-r18"',
          upstream_last_modified: null,
        },
      ],
    };

    const pageApiPayload = makePageApiPayload([
      { courseYear: 1, url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf" },
    ]);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(candidateManifest), { status: 200 });
      }
      if (urlStr.includes("/page-api.json")) {
        return new Response(JSON.stringify(pageApiPayload), { status: 200 });
      }
      if (urlStr.endsWith(".pdf")) {
        return pdfResponse(pdfBytes18);
      }
      if (urlStr.includes("/accepted/course-1")) {
        return new Response(JSON.stringify(mockR18.pointer), { status: 200 });
      }
      if (urlStr.includes(`/accepted-payloads/course-1/${mockR18.acceptedId}`)) {
        return new Response(JSON.stringify(mockR18.schedule), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("unchanged");

    const local = await getCurrentSchedule(1);
    expect(local?.metadata.source_pdf_hash).toBe(hash18);
  });

  it("re-parses cached PDF when parser version is stale even if PDF is unchanged", async () => {
    const olderSchedule = await makeSchedule(
      pdfBytes18,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      1,
      "1.0.0",
      "snap-r18",
    );
    await replaceCurrentSchedule(1, olderSchedule);
    const mockOlder = makeAcceptedMock(1, olderSchedule, "snap-r18");

    let durableWriteExecuted = false;

    const candidatePointer: CurrentPointer = {
      schema_version: 1,
      snapshot_id: "snap-r18",
      updated_at: "2026-09-08T02:30:00.000Z",
      manifest_r2_key: "snapshots/snap-r18/manifest.json",
    };

    const candidateManifest: SnapshotManifest = {
      schema_version: 1,
      snapshot_id: "snap-r18",
      previous_snapshot_id: null,
      created_at: "2026-09-08T02:30:00.000Z",
      source: {
        page_api_url: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view",
        page_id: 1739,
        page_modified_gmt: null,
        retrieved_at: "2026-09-08T02:30:00.000Z",
        etag: null,
        last_modified: null,
      },
      files: [
        {
          filename: "anul_i_semestrul_i-18.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
          r2_key: "snapshots/snap-r18/pdfs/anul_i_semestrul_i-18.pdf",
          content_type: "application/pdf",
          size: pdfBytes18.byteLength,
          upstream_etag: '"etag-r18"',
          upstream_last_modified: null,
        },
      ],
    };

    const pageApiPayload = makePageApiPayload([
      { courseYear: 1, url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf" },
    ]);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";

      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(candidateManifest), { status: 200 });
      }
      if (urlStr.includes("/page-api.json")) {
        return new Response(JSON.stringify(pageApiPayload), { status: 200 });
      }
      if (urlStr.endsWith(".pdf")) {
        return pdfResponse(pdfBytes18);
      }
      if (urlStr.includes("/accepted/course-1")) {
        if (method === "GET") {
          return new Response(JSON.stringify(mockOlder.pointer), { status: 200 });
        }
        if (method === "PUT") {
          durableWriteExecuted = true;
          return new Response(JSON.stringify({ ok: true, status: "updated" }), { status: 200 });
        }
      }
      if (urlStr.includes(`/accepted-payloads/course-1/${mockOlder.acceptedId}`)) {
        return new Response(JSON.stringify(mockOlder.schedule), { status: 200 });
      }
      if (urlStr.includes("/accepted-payloads/course-1")) {
        if (method === "PUT") {
          return new Response(JSON.stringify({ ok: true, status: "created" }), { status: 200 });
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("updated");
    expect(durableWriteExecuted).toBe(true);

    const localAfter = await getCurrentSchedule(1);
    expect(localAfter?.metadata.parser_version).toBe(config.parserVersion);
  });

  it("maintains per-course independence during refresh: course 1 succeeds, course 2 stays unchanged on error", async () => {
    const course1Initial = await makeSchedule(
      pdfBytes9,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
      1,
      config.parserVersion,
      "snap-c1",
    );
    await replaceCurrentSchedule(1, course1Initial);
    const mockC1 = makeAcceptedMock(1, course1Initial, "snap-c1");

    const seed11Path = path.join(__dirname, "..", "data", "seed", "anul_ii_semestrul_iii-11.pdf");
    const pdfBytes11 = new Uint8Array(await readFile(seed11Path));
    const course2Initial = await makeSchedule(
      pdfBytes11,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-11.pdf",
      2,
      config.parserVersion,
      "snap-c2",
    );
    await replaceCurrentSchedule(2, course2Initial);
    const mockC2 = makeAcceptedMock(2, course2Initial, "snap-c2");

    const candidatePointer: CurrentPointer = {
      schema_version: 1,
      snapshot_id: "snap-mixed",
      updated_at: "2026-09-08T03:00:00.000Z",
      manifest_r2_key: "snapshots/snap-mixed/manifest.json",
    };

    const candidateManifest: SnapshotManifest = {
      schema_version: 1,
      snapshot_id: "snap-mixed",
      previous_snapshot_id: null,
      created_at: "2026-09-08T03:00:00.000Z",
      source: {
        page_api_url: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view",
        page_id: 1739,
        page_modified_gmt: null,
        retrieved_at: "2026-09-08T03:00:00.000Z",
        etag: null,
        last_modified: null,
      },
      files: [
        {
          filename: "anul_i_semestrul_i-18.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
          r2_key: "snapshots/snap-mixed/pdfs/anul_i_semestrul_i-18.pdf",
          content_type: "application/pdf",
          size: pdfBytes18.byteLength,
          upstream_etag: '"etag-c1"',
          upstream_last_modified: null,
        },
        {
          filename: "anul_ii_semestrul_iii-99.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-99.pdf",
          r2_key: "snapshots/snap-mixed/pdfs/anul_ii_semestrul_iii-99.pdf",
          content_type: "application/pdf",
          size: 100,
          upstream_etag: '"etag-c2"',
          upstream_last_modified: null,
        },
      ],
    };

    const pageApiPayload = makePageApiPayload([
      { courseYear: 1, url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf" },
      { courseYear: 2, url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-99.pdf" },
    ]);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";

      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(candidateManifest), { status: 200 });
      }
      if (urlStr.includes("/page-api.json")) {
        return new Response(JSON.stringify(pageApiPayload), { status: 200 });
      }
      if (urlStr.includes("anul_i_semestrul_i-18.pdf")) {
        return pdfResponse(pdfBytes18);
      }
      if (urlStr.includes("anul_ii_semestrul_iii-99.pdf")) {
        return pdfResponse(new TextEncoder().encode("%PDF-1.4 Not a timetable"));
      }
      if (urlStr.includes("/accepted/course-1")) {
        if (method === "GET") {
          return new Response(JSON.stringify(mockC1.pointer), { status: 200 });
        }
        if (method === "PUT") {
          return new Response(JSON.stringify({ ok: true, status: "updated" }), { status: 200 });
        }
      }
      if (urlStr.includes(`/accepted-payloads/course-1/${mockC1.acceptedId}`)) {
        return new Response(JSON.stringify(mockC1.schedule), { status: 200 });
      }
      if (urlStr.includes("/accepted-payloads/course-1")) {
        if (method === "PUT") {
          return new Response(JSON.stringify({ ok: true, status: "created" }), { status: 200 });
        }
      }
      if (urlStr.includes("/accepted/course-2")) {
        return new Response(JSON.stringify(mockC2.pointer), { status: 200 });
      }
      if (urlStr.includes(`/accepted-payloads/course-2/${mockC2.acceptedId}`)) {
        return new Response(JSON.stringify(mockC2.schedule), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const results = await refreshAllCourses();
    const c1Result = results.find((r) => r.course_year === 1);
    const c2Result = results.find((r) => r.course_year === 2);

    expect(c1Result?.outcome).toBe("updated");
    expect(c2Result?.outcome).toBe("rejected");

    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(hash18);
    expect((await getCurrentSchedule(2))?.metadata.source_pdf_hash).toBe(sha256(pdfBytes11));
  });

  it("end-to-end contract: r18 accepted -> r19 valid -> r20 bad rejected -> wipe local -> r19 baseline restored -> r20 rejected again", async () => {
    const r18Schedule = await makeSchedule(
      pdfBytes18,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      1,
      config.parserVersion,
      "snap-r18",
    );
    await replaceCurrentSchedule(1, r18Schedule);
    let activeMock = makeAcceptedMock(1, r18Schedule, "snap-r18");

    const r19Schedule = await makeSchedule(
      pdfBytes9,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
      1,
      config.parserVersion,
      "snap-r19",
    );

    let currentPointer: CurrentPointer = {
      schema_version: 1,
      snapshot_id: "snap-r19",
      updated_at: "2026-09-08T02:30:00.000Z",
      manifest_r2_key: "snapshots/snap-r19/manifest.json",
    };

    let currentManifest: SnapshotManifest = {
      schema_version: 1,
      snapshot_id: "snap-r19",
      previous_snapshot_id: "snap-r18",
      created_at: "2026-09-08T02:30:00.000Z",
      source: {
        page_api_url: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view",
        page_id: 1739,
        page_modified_gmt: null,
        retrieved_at: "2026-09-08T02:30:00.000Z",
        etag: null,
        last_modified: null,
      },
      files: [
        {
          filename: "anul_i_semestrul_i-9.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
          r2_key: "snapshots/snap-r19/pdfs/anul_i_semestrul_i-9.pdf",
          content_type: "application/pdf",
          size: pdfBytes9.byteLength,
          upstream_etag: '"etag-r19"',
          upstream_last_modified: null,
        },
      ],
    };

    let activePageApi = makePageApiPayload([
      { courseYear: 1, url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf" },
    ]);
    let activePointer = activeMock.pointer;
    const payloads = new Map<string, Schedule>();
    payloads.set(activePointer.accepted_id, activeMock.schedule);
    let activePdfBytes = pdfBytes9;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";

      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(currentPointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(currentManifest), { status: 200 });
      }
      if (urlStr.includes("/page-api.json")) {
        return new Response(JSON.stringify(activePageApi), { status: 200 });
      }
      if (urlStr.endsWith(".pdf")) {
        return pdfResponse(activePdfBytes);
      }
      if (urlStr.includes("/accepted/course-1")) {
        if (method === "GET") {
          return new Response(JSON.stringify(activePointer), { status: 200 });
        }
        if (method === "PUT") {
          const body = JSON.parse(decodeBody(init?.body)) as {
            expected_previous_accepted_id: string | null;
            pointer: AcceptedPointer;
          };
          if (body.expected_previous_accepted_id !== activePointer.accepted_id) {
            return new Response(JSON.stringify({ error: "CAS conflict" }), { status: 409 });
          }
          activePointer = body.pointer;
          return new Response(JSON.stringify({ ok: true, status: "updated" }), { status: 200 });
        }
      }
      if (urlStr.includes("/accepted-payloads/course-1/")) {
        const id = urlStr.split("/accepted-payloads/course-1/")[1];
        if (method === "GET") {
          const sched = payloads.get(id);
          if (sched) return new Response(JSON.stringify(sched), { status: 200 });
          return new Response("not found", { status: 404 });
        }
        if (method === "PUT") {
          const sched = JSON.parse(decodeBody(init?.body)) as Schedule;
          payloads.set(id, sched);
          return new Response(JSON.stringify({ ok: true, status: "created" }), { status: 200 });
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const r19Result = await checkForUpdates(1);
    expect(r19Result.outcome).toBe("updated");
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(hash9);
    expect(activePointer.source_pdf_hash).toBe(hash9);

    // Stage 3: r20 candidate is bad
    activePdfBytes = new TextEncoder().encode("%PDF-1.4 Not a valid timetable table content at all");
    currentPointer = {
      schema_version: 1,
      snapshot_id: "snap-r20",
      updated_at: "2026-09-08T03:00:00.000Z",
      manifest_r2_key: "snapshots/snap-r20/manifest.json",
    };
    currentManifest = {
      ...currentManifest,
      snapshot_id: "snap-r20",
      previous_snapshot_id: "snap-r19",
      files: [
        {
          filename: "anul_i_semestrul_i-20.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-20.pdf",
          r2_key: "snapshots/snap-r20/pdfs/anul_i_semestrul_i-20.pdf",
          content_type: "application/pdf",
          size: activePdfBytes.byteLength,
          upstream_etag: '"etag-r20"',
          upstream_last_modified: null,
        },
      ],
    };
    activePageApi = makePageApiPayload([
      { courseYear: 1, url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-20.pdf" },
    ]);

    const r20Result = await checkForUpdates(1);
    expect(r20Result.outcome).toBe("rejected");

    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(hash9);
    expect(activePointer.source_pdf_hash).toBe(hash9);

    // Stage 4: Wipe local files
    await rm(tempDir, { recursive: true, force: true });
    tempDir = await mkdtemp(path.join(tmpdir(), "fcim-sync-test-wiped-"));
    (config as { dataDir: string }).dataDir = tempDir;
    resetStorageCache();

    expect(await getCurrentSchedule(1)).toBeNull();

    await bootstrapScheduleState();
    const restored = await getCurrentSchedule(1);
    expect(restored).not.toBeNull();
    expect(restored?.metadata.source_pdf_hash).toBe(hash9);

    const r20SecondResult = await checkForUpdates(1);
    expect(r20SecondResult.outcome).toBe("rejected");
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(hash9);
  });

  it("r19 validates, durable PUT fails -> local remains r18 -> restart restores r18", async () => {
    const r18Schedule = await makeSchedule(
      pdfBytes18,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      1,
      config.parserVersion,
      "snap-r18",
    );
    await replaceCurrentSchedule(1, r18Schedule);
    const mockR18 = makeAcceptedMock(1, r18Schedule, "snap-r18");

    const candidatePointer: CurrentPointer = {
      schema_version: 1,
      snapshot_id: "snap-r19",
      updated_at: "2026-09-08T02:30:00.000Z",
      manifest_r2_key: "snapshots/snap-r19/manifest.json",
    };

    const candidateManifest: SnapshotManifest = {
      schema_version: 1,
      snapshot_id: "snap-r19",
      previous_snapshot_id: "snap-r18",
      created_at: "2026-09-08T02:30:00.000Z",
      source: {
        page_api_url: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view",
        page_id: 1739,
        page_modified_gmt: null,
        retrieved_at: "2026-09-08T02:30:00.000Z",
        etag: null,
        last_modified: null,
      },
      files: [
        {
          filename: "anul_i_semestrul_i-9.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
          r2_key: "snapshots/snap-r19/pdfs/anul_i_semestrul_i-9.pdf",
          content_type: "application/pdf",
          size: pdfBytes9.byteLength,
          upstream_etag: '"etag-r19"',
          upstream_last_modified: null,
        },
      ],
    };

    const pageApiPayload = makePageApiPayload([
      { courseYear: 1, url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf" },
    ]);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";

      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(candidateManifest), { status: 200 });
      }
      if (urlStr.includes("/page-api.json")) {
        return new Response(JSON.stringify(pageApiPayload), { status: 200 });
      }
      if (urlStr.endsWith(".pdf")) {
        return pdfResponse(pdfBytes9);
      }
      if (urlStr.includes("/accepted/course-1")) {
        if (method === "GET") {
          return new Response(JSON.stringify(mockR18.pointer), { status: 200 });
        }
        if (method === "PUT") {
          return new Response(JSON.stringify({ error: "durable write error" }), { status: 500 });
        }
      }
      if (urlStr.includes(`/accepted-payloads/course-1/${mockR18.acceptedId}`)) {
        return new Response(JSON.stringify(mockR18.schedule), { status: 200 });
      }
      if (urlStr.includes("/accepted-payloads/course-1")) {
        if (method === "PUT") {
          return new Response(JSON.stringify({ ok: true, status: "created" }), { status: 200 });
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("error");

    const local = await getCurrentSchedule(1);
    expect(local?.metadata.source_pdf_hash).toBe(hash18);

    await rm(tempDir, { recursive: true, force: true });
    tempDir = await mkdtemp(path.join(tmpdir(), "fcim-sync-test-restart-"));
    (config as { dataDir: string }).dataDir = tempDir;
    resetStorageCache();

    await bootstrapScheduleState();
    const restored = await getCurrentSchedule(1);
    expect(restored?.metadata.source_pdf_hash).toBe(hash18);
  });

  it("Audit E-04 Hard Gate: durable-to-local resync failure halts tick immediately and never evaluates candidate", async () => {
    // Local state is r18
    const r18Schedule = await makeSchedule(
      pdfBytes18,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      1,
      config.parserVersion,
      "snap-r18",
    );
    await replaceCurrentSchedule(1, r18Schedule);

    // Durable state in broker is r19
    const r19Schedule = await makeSchedule(
      pdfBytes9,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
      1,
      config.parserVersion,
      "snap-r19",
    );
    const mockR19 = makeAcceptedMock(1, r19Schedule, "snap-r19");

    // Candidate pointer is snap-r20
    const candidatePointer: CurrentPointer = {
      schema_version: 1,
      snapshot_id: "snap-r20",
      updated_at: "2026-09-08T03:00:00.000Z",
      manifest_r2_key: "snapshots/snap-r20/manifest.json",
    };

    let candidatePdfFetchAttempted = false;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes("/accepted/course-1")) {
        return new Response(JSON.stringify(mockR19.pointer), { status: 200 });
      }
      if (urlStr.includes(`/accepted-payloads/course-1/${mockR19.acceptedId}`)) {
        return new Response(JSON.stringify(mockR19.schedule), { status: 200 });
      }
      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("r20.pdf") || urlStr.includes("snap-r20")) {
        candidatePdfFetchAttempted = true;
        return pdfResponse(pdfBytes9);
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const storage = await import("@/lib/storage");
    vi.spyOn(storage, "replaceCurrentSchedule").mockRejectedValueOnce(
      new Error("Disk I/O error writing current_schedule.json"),
    );

    try {
      const result = await checkForUpdates(1);
      expect(result.outcome).toBe("error");
      expect(result.message).toContain("Durable to local resync failed");
      expect(candidatePdfFetchAttempted).toBe(false);
      const state = await getSourceState(1);
      expect(state.last_result).toBe("error");
      expect(state.last_error).toContain("Durable to local resync failed");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("Audit E-10: same PDF hash reparsed under bumped parser version updates accepted pointer and payload", async () => {
    const olderSchedule = await makeSchedule(
      pdfBytes18,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      1,
      "1.0.0",
      "snap-r18",
    );
    await replaceCurrentSchedule(1, olderSchedule);
    const mockOlder = makeAcceptedMock(1, olderSchedule, "snap-r18");

    let savedPayload: Schedule | null = null;
    let savedPointer: AcceptedPointer | null = null;

    const candidatePointer: CurrentPointer = {
      schema_version: 1,
      snapshot_id: "snap-r18",
      updated_at: "2026-09-08T02:30:00.000Z",
      manifest_r2_key: "snapshots/snap-r18/manifest.json",
    };

    const candidateManifest: SnapshotManifest = {
      schema_version: 1,
      snapshot_id: "snap-r18",
      previous_snapshot_id: null,
      created_at: "2026-09-08T02:30:00.000Z",
      source: {
        page_api_url: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view",
        page_id: 1739,
        page_modified_gmt: null,
        retrieved_at: "2026-09-08T02:30:00.000Z",
        etag: null,
        last_modified: null,
      },
      files: [
        {
          filename: "anul_i_semestrul_i-18.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
          r2_key: "snapshots/snap-r18/pdfs/anul_i_semestrul_i-18.pdf",
          content_type: "application/pdf",
          size: pdfBytes18.byteLength,
          upstream_etag: '"etag-r18"',
          upstream_last_modified: null,
        },
      ],
    };

    const pageApiPayload = makePageApiPayload([
      { courseYear: 1, url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf" },
    ]);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";

      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(candidateManifest), { status: 200 });
      }
      if (urlStr.includes("/page-api.json")) {
        return new Response(JSON.stringify(pageApiPayload), { status: 200 });
      }
      if (urlStr.endsWith(".pdf")) {
        return pdfResponse(pdfBytes18);
      }
      if (urlStr.includes("/accepted/course-1")) {
        if (method === "GET") {
          return new Response(JSON.stringify(mockOlder.pointer), { status: 200 });
        }
        if (method === "PUT") {
          const body = JSON.parse(decodeBody(init?.body)) as {
            expected_previous_accepted_id: string | null;
            pointer: AcceptedPointer;
          };
          expect(body.expected_previous_accepted_id).toBe(mockOlder.acceptedId);
          savedPointer = body.pointer;
          return new Response(JSON.stringify({ ok: true, status: "updated" }), { status: 200 });
        }
      }
      if (urlStr.includes(`/accepted-payloads/course-1/${mockOlder.acceptedId}`)) {
        return new Response(JSON.stringify(mockOlder.schedule), { status: 200 });
      }
      if (urlStr.includes("/accepted-payloads/course-1")) {
        if (method === "PUT") {
          savedPayload = JSON.parse(decodeBody(init?.body)) as Schedule;
          return new Response(JSON.stringify({ ok: true, status: "created" }), { status: 200 });
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("updated");

    expect(savedPointer).not.toBeNull();
    const finalPointer = savedPointer as unknown as AcceptedPointer;
    expect(finalPointer.parser_version).toBe(config.parserVersion);
    expect(finalPointer.accepted_id).not.toBe(mockOlder.acceptedId);
    expect(finalPointer.source_pdf_hash).toBe(hash18);

    expect(savedPayload).not.toBeNull();
    const finalPayload = savedPayload as unknown as Schedule;
    expect(finalPayload.metadata.parser_version).toBe(config.parserVersion);
    expect(finalPayload.metadata.source_pdf_hash).toBe(hash18);
  });
});
