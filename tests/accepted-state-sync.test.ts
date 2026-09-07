import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "@/lib/config";
import type { AcceptedRecord, CurrentPointer, Schedule, SnapshotManifest } from "@/lib/models";
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
    // Override dataDir for tests
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

  function pdfResponse(bytes: Uint8Array): Response {
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    });
  }

  async function makeSchedule(bytes: Uint8Array, url: string, courseYear = 1, parserVersion: string = config.parserVersion): Promise<Schedule> {
    const { schedule } = await parsePdf(bytes, {
      source_page_url: "https://fcim.utm.md/procesul-de-studii/orar/",
      source_pdf_url: url,
      source_kind: "live",
      source_transport: "broker",
      source_snapshot_id: "snap-test",
      downloaded_at: "2026-09-08T02:00:00.000Z",
      course_year: courseYear,
    });
    schedule.metadata.parser_version = parserVersion;
    return schedule;
  }

  it("restores accepted schedule during cold-start bootstrap before candidate validation", async () => {
    const schedule = await makeSchedule(
      pdfBytes18,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
    );

    const brokerAcceptedRecord: AcceptedRecord = {
      schema_version: 1,
      course_year: 1,
      snapshot_id: "snap-bootstrap",
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      source_pdf_hash: hash18,
      accepted_at: "2026-09-08T02:00:00.000Z",
      schedule,
    };

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes("/accepted/course-1")) {
        return new Response(JSON.stringify(brokerAcceptedRecord), { status: 200 });
      }
      if (urlStr.includes("/accepted/course-2")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    // Verify local storage is empty initially
    expect(await getCurrentSchedule(1)).toBeNull();

    await bootstrapScheduleState();

    // Verify course 1 was restored exactly
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
    const corruptedRecord: AcceptedRecord = {
      schema_version: 1,
      course_year: 2,
      snapshot_id: "snap-wrong",
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      source_pdf_hash: hash18,
      accepted_at: "2026-09-08T02:00:00.000Z",
      schedule: {
        ...schedule,
        metadata: {
          ...schedule.metadata,
          course_year: 1, // Course year mismatch with record.course_year
        },
      },
    };

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes("/accepted/course-2")) {
        return new Response(JSON.stringify(corruptedRecord), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await bootstrapScheduleState();

    // Course 2 should NOT have installed the wrong course record
    const localCourse2 = await getCurrentSchedule(2);
    // Either bundled seed for course 2 or null, but never the course 1 schedule!
    if (localCourse2) {
      expect(localCourse2.metadata.course_year).toBe(2);
    }
  });

  it("maintains previous local schedule when durable write fails (transaction ordering)", async () => {
    // Initial local known-good schedule (r9)
    const initialSchedule = await makeSchedule(
      pdfBytes9,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
    );
    await replaceCurrentSchedule(1, initialSchedule);

    // Mock broker candidate pointing to r18
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

    // Broker fails on PUT /accepted/course-1 with 500 error
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";

      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(candidateManifest), { status: 200 });
      }
      if (urlStr.endsWith(".pdf")) {
        return pdfResponse(pdfBytes18);
      }
      if (urlStr.includes("/accepted/course-1")) {
        if (method === "GET") {
          return new Response(
            JSON.stringify({
              schema_version: 1,
              course_year: 1,
              snapshot_id: "snap-r9",
              source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
              source_pdf_hash: hash9,
              accepted_at: "2026-09-08T02:00:00.000Z",
              schedule: initialSchedule,
            }),
            { status: 200 },
          );
        }
        if (method === "PUT") {
          // Durable write FAILS!
          return new Response(JSON.stringify({ error: "R2 storage down" }), { status: 500 });
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("error");
    expect(result.message).toContain("Durable accepted write failed");

    // Local schedule MUST remain r9! Not r18!
    const localAfter = await getCurrentSchedule(1);
    expect(localAfter?.metadata.source_pdf_hash).toBe(hash9);
  });

  it("installs candidate locally only after durable write succeeds", async () => {
    // Initial local known-good schedule (r9)
    const initialSchedule = await makeSchedule(
      pdfBytes9,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
    );
    await replaceCurrentSchedule(1, initialSchedule);

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

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";

      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(candidateManifest), { status: 200 });
      }
      if (urlStr.endsWith(".pdf")) {
        return pdfResponse(pdfBytes18);
      }
      if (urlStr.includes("/accepted/course-1")) {
        if (method === "GET") {
          return new Response(
            JSON.stringify({
              schema_version: 1,
              course_year: 1,
              snapshot_id: "snap-r9",
              source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
              source_pdf_hash: hash9,
              accepted_at: "2026-09-08T02:00:00.000Z",
              schedule: initialSchedule,
            }),
            { status: 200 },
          );
        }
        if (method === "PUT") {
          durableWriteExecuted = true;
          return new Response(JSON.stringify({ ok: true, status: "updated" }), { status: 200 });
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
    // Durable state in broker is r18
    const r18Schedule = await makeSchedule(
      pdfBytes18,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
    );

    // But local state is stale (r9)
    const r9Schedule = await makeSchedule(
      pdfBytes9,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
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

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(candidateManifest), { status: 200 });
      }
      if (urlStr.endsWith(".pdf")) {
        return pdfResponse(pdfBytes18);
      }
      if (urlStr.includes("/accepted/course-1")) {
        return new Response(
          JSON.stringify({
            schema_version: 1,
            course_year: 1,
            snapshot_id: "snap-r18",
            source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
            source_pdf_hash: hash18,
            accepted_at: "2026-09-08T02:10:00.000Z",
            schedule: r18Schedule,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("unchanged");

    // Local schedule has been reconciled to r18
    const local = await getCurrentSchedule(1);
    expect(local?.metadata.source_pdf_hash).toBe(hash18);
  });

  it("re-parses cached PDF when parser version is stale even if PDF is unchanged", async () => {
    // Current schedule parsed by older parser 1.0.0
    const olderSchedule = await makeSchedule(
      pdfBytes18,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      1,
      "1.0.0",
    );
    await replaceCurrentSchedule(1, olderSchedule);

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

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";

      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(candidateManifest), { status: 200 });
      }
      if (urlStr.endsWith(".pdf")) {
        return pdfResponse(pdfBytes18);
      }
      if (urlStr.includes("/accepted/course-1")) {
        if (method === "GET") {
          return new Response(
            JSON.stringify({
              schema_version: 1,
              course_year: 1,
              snapshot_id: "snap-r18",
              source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
              source_pdf_hash: hash18,
              accepted_at: "2026-09-08T02:00:00.000Z",
              schedule: olderSchedule,
            }),
            { status: 200 },
          );
        }
        if (method === "PUT") {
          durableWriteExecuted = true;
          return new Response(JSON.stringify({ ok: true, status: "idempotent" }), { status: 200 });
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
    // Course 1 and Course 2 both have initial valid schedules
    const course1Initial = await makeSchedule(
      pdfBytes9,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
      1,
    );
    await replaceCurrentSchedule(1, course1Initial);

    const seed11Path = path.join(__dirname, "..", "data", "seed", "anul_ii_semestrul_iii-11.pdf");
    const pdfBytes11 = new Uint8Array(await readFile(seed11Path));
    const course2Initial = await makeSchedule(
      pdfBytes11,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-11.pdf",
      2,
    );
    await replaceCurrentSchedule(2, course2Initial);

    const candidatePointer: CurrentPointer = {
      schema_version: 1,
      snapshot_id: "snap-mixed",
      updated_at: "2026-09-08T03:00:00.000Z",
      manifest_r2_key: "snapshots/snap-mixed/manifest.json",
    };

    // Candidate manifest has updated PDF for Course 1 (r18), but invalid/failing candidate for Course 2
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

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";

      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(candidateManifest), { status: 200 });
      }
      if (urlStr.includes("anul_i_semestrul_i-18.pdf")) {
        return pdfResponse(pdfBytes18);
      }
      if (urlStr.includes("anul_ii_semestrul_iii-99.pdf")) {
        // Corrupted file for course 2!
        return pdfResponse(new TextEncoder().encode("%PDF-1.4 Not a timetable"));
      }
      if (urlStr.includes("/accepted/course-1")) {
        if (method === "GET") {
          return new Response(
            JSON.stringify({
              schema_version: 1,
              course_year: 1,
              snapshot_id: "snap-c1",
              source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
              source_pdf_hash: hash9,
              accepted_at: "2026-09-08T02:00:00.000Z",
              schedule: course1Initial,
            }),
            { status: 200 },
          );
        }
        if (method === "PUT") {
          return new Response(JSON.stringify({ ok: true, status: "updated" }), { status: 200 });
        }
      }
      if (urlStr.includes("/accepted/course-2")) {
        return new Response(
          JSON.stringify({
            schema_version: 1,
            course_year: 2,
            snapshot_id: "snap-c2",
            source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-11.pdf",
            source_pdf_hash: sha256(pdfBytes11),
            accepted_at: "2026-09-08T02:00:00.000Z",
            schedule: course2Initial,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const results = await refreshAllCourses();
    const c1Result = results.find((r) => r.course_year === 1);
    const c2Result = results.find((r) => r.course_year === 2);

    expect(c1Result?.outcome).toBe("updated");
    expect(c2Result?.outcome).toBe("rejected");

    // Course 1 was updated to r18
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(hash18);
    // Course 2 was NOT touched, still holds initial schedule
    expect((await getCurrentSchedule(2))?.metadata.source_pdf_hash).toBe(sha256(pdfBytes11));
  });

  it("end-to-end contract: r18 accepted -> r19 valid -> r20 bad rejected -> wipe local -> r19 baseline restored -> r20 rejected again", async () => {
    // Stage 1: r18 durable accepted and installed
    const r18Schedule = await makeSchedule(
      pdfBytes18,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
    );
    await replaceCurrentSchedule(1, r18Schedule);

    let brokerDurableState: AcceptedRecord = {
      schema_version: 1,
      course_year: 1,
      snapshot_id: "snap-r18",
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      source_pdf_hash: hash18,
      accepted_at: "2026-09-08T02:00:00.000Z",
      schedule: r18Schedule,
    };

    // Stage 2: r19 valid candidate published
    // We create r19 as a valid schedule from pdfBytes9
    const r19Schedule = await makeSchedule(
      pdfBytes9,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
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
      if (urlStr.endsWith(".pdf")) {
        return pdfResponse(activePdfBytes);
      }
      if (urlStr.includes("/accepted/course-1")) {
        if (method === "GET") {
          return new Response(JSON.stringify(brokerDurableState), { status: 200 });
        }
        if (method === "PUT") {
          const body = JSON.parse(String(init?.body)) as {
            expected_previous_hash: string | null;
            state: AcceptedRecord;
          };
          if (body.expected_previous_hash !== brokerDurableState.source_pdf_hash) {
            return new Response(JSON.stringify({ error: "CAS conflict" }), { status: 409 });
          }
          brokerDurableState = body.state;
          return new Response(JSON.stringify({ ok: true, status: "updated" }), { status: 200 });
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    // Run check: r19 should be accepted and installed
    const r19Result = await checkForUpdates(1);
    expect(r19Result.outcome).toBe("updated");
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(hash9);
    expect(brokerDurableState.source_pdf_hash).toBe(hash9);

    // Stage 3: r20 candidate is bad (corrupted PDF that fails parsing)
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

    const r20Result = await checkForUpdates(1);
    expect(r20Result.outcome).toBe("rejected");

    // r19 remains both local and durable
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(hash9);
    expect(brokerDurableState.source_pdf_hash).toBe(hash9);

    // Stage 4: Wipe local files (simulate fresh container or wiped disk)
    await rm(tempDir, { recursive: true, force: true });
    tempDir = await mkdtemp(path.join(tmpdir(), "fcim-sync-test-wiped-"));
    (config as { dataDir: string }).dataDir = tempDir;
    resetStorageCache();

    expect(await getCurrentSchedule(1)).toBeNull();

    // Cold-start bootstrap restores exact r19 baseline from broker
    await bootstrapScheduleState();
    const restored = await getCurrentSchedule(1);
    expect(restored).not.toBeNull();
    expect(restored?.metadata.source_pdf_hash).toBe(hash9);

    // Now evaluate bad candidate r20 again -> rejected again using restored r19 baseline!
    const r20SecondResult = await checkForUpdates(1);
    expect(r20SecondResult.outcome).toBe("rejected");
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(hash9);
  });

  it("r19 validates, durable PUT fails -> local remains r18 -> restart restores r18", async () => {
    // r18 is installed locally and durable in broker
    const r18Schedule = await makeSchedule(
      pdfBytes18,
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
    );
    await replaceCurrentSchedule(1, r18Schedule);

    const brokerDurableState: AcceptedRecord = {
      schema_version: 1,
      course_year: 1,
      snapshot_id: "snap-r18",
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      source_pdf_hash: hash18,
      accepted_at: "2026-09-08T02:00:00.000Z",
      schedule: r18Schedule,
    };

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

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const method = init?.method?.toUpperCase() ?? "GET";

      if (urlStr.endsWith("/current")) {
        return new Response(JSON.stringify(candidatePointer), { status: 200 });
      }
      if (urlStr.includes("/manifest.json")) {
        return new Response(JSON.stringify(candidateManifest), { status: 200 });
      }
      if (urlStr.endsWith(".pdf")) {
        return pdfResponse(pdfBytes9);
      }
      if (urlStr.includes("/accepted/course-1")) {
        if (method === "GET") {
          return new Response(JSON.stringify(brokerDurableState), { status: 200 });
        }
        if (method === "PUT") {
          // Durable write fails!
          return new Response(JSON.stringify({ error: "durable write error" }), { status: 500 });
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("error");

    // Local state remains r18
    const local = await getCurrentSchedule(1);
    expect(local?.metadata.source_pdf_hash).toBe(hash18);

    // Wipe local cache (simulate restart/cold start)
    await rm(tempDir, { recursive: true, force: true });
    tempDir = await mkdtemp(path.join(tmpdir(), "fcim-sync-test-restart-"));
    (config as { dataDir: string }).dataDir = tempDir;
    resetStorageCache();

    // Cold start restart restores r18 from broker
    await bootstrapScheduleState();
    const restored = await getCurrentSchedule(1);
    expect(restored?.metadata.source_pdf_hash).toBe(hash18);
  });
});
