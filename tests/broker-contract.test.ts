import { describe, expect, it, vi } from "vitest";
import {
  AcceptedPointerSchema,
  AcceptedPointerWriteRequestSchema,
  AcceptedRecordSchema,
  AcceptedWriteRequestSchema,
  CurrentPointerSchema,
  ScheduleMetadataSchema,
  SnapshotManifestSchema,
  type AcceptedPointer,
  type AcceptedRecord,
  type SnapshotManifest,
} from "@/lib/models";
import { selectCandidateFile, selectCandidateFromSnapshot } from "@/lib/services/updater";
import {
  fetchBrokerBounded,
  parseAndValidateBrokerUrl,
  validatePathToken,
  validatePdfFilename,
} from "@/lib/source/broker-client";

describe("broker contract schemas & backward compatibility", () => {
  const minimalSchedule = {
    metadata: {
      academic_year: "2026/2027",
      semester: "Semestrul I",
      course_year: 1,
      source_page_url: "https://fcim.utm.md/procesul-de-studii/orar/",
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      source_pdf_hash: "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a",
      source_kind: "live" as const,
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

  it("parses old metadata without source_transport and sets default 'direct'", () => {
    const oldMeta = {
      academic_year: "2026/2027",
      semester: "Semestrul I",
      course_year: 1,
      source_page_url: "https://fcim.utm.md/procesul-de-studii/orar/",
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      source_pdf_hash: "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a",
      source_kind: "live",
      downloaded_at: "2026-09-08T02:00:00.000Z",
      parsed_at: "2026-09-08T02:00:01.000Z",
      parser_version: "1.3.0",
      etag: '"test-etag"',
      last_modified: "Tue, 08 Sep 2026 02:00:00 GMT",
      pdf_title: null,
    };

    const parsed = ScheduleMetadataSchema.parse(oldMeta);
    expect(parsed.source_transport).toBe("direct");
    expect(parsed.source_snapshot_id).toBeNull();
    expect(parsed.source_kind).toBe("live");
  });

  it("parses new metadata with broker transport and snapshot id", () => {
    const newMeta = {
      ...minimalSchedule.metadata,
      source_transport: "broker" as const,
      source_snapshot_id: "2026-09-08T02-08-48Z-7a3b4c19",
    };

    const parsed = ScheduleMetadataSchema.parse(newMeta);
    expect(parsed.source_transport).toBe("broker");
    expect(parsed.source_snapshot_id).toBe("2026-09-08T02-08-48Z-7a3b4c19");
    expect(parsed.source_kind).toBe("live");
  });

  it("validates AcceptedPointerSchema and AcceptedPointerWriteRequestSchema", () => {
    const validPointer: AcceptedPointer = {
      schema_version: 1,
      course_year: 1,
      accepted_id: "a4c610d24dd53bbf-p1_3_0-1111111111111111",
      payload_key: "accepted-payloads/course-1/a4c610d24dd53bbf-p1_3_0-1111111111111111.json",
      payload_sha256: "1111111111111111111111111111111111111111111111111111111111111111",
      source_snapshot_id: "2026-09-08T02-08-48Z-7a3b4c19",
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      source_pdf_hash: "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a",
      parser_version: "1.3.0",
      accepted_at: "2026-09-08T02:08:50.000Z",
    };

    expect(AcceptedPointerSchema.safeParse(validPointer).success).toBe(true);

    const validWriteRequest = {
      expected_previous_accepted_id: null,
      pointer: validPointer,
    };
    expect(AcceptedPointerWriteRequestSchema.safeParse(validWriteRequest).success).toBe(true);

    const validUpdateRequest = {
      expected_previous_accepted_id: "old-id-1234",
      pointer: validPointer,
    };
    expect(AcceptedPointerWriteRequestSchema.safeParse(validUpdateRequest).success).toBe(true);
  });

  it("validates AcceptedRecordSchema successfully for a valid record", () => {
    const record: AcceptedRecord = {
      schema_version: 1,
      course_year: 1,
      snapshot_id: "2026-09-08T02-08-48Z-7a3b4c19",
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      source_pdf_hash: "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a",
      accepted_at: "2026-09-08T02:08:50.000Z",
      schedule: {
        ...minimalSchedule,
        metadata: {
          ...minimalSchedule.metadata,
          source_transport: "broker",
          source_snapshot_id: "2026-09-08T02-08-48Z-7a3b4c19",
        },
      },
    };

    const parsed = AcceptedRecordSchema.parse(record);
    expect(parsed.course_year).toBe(1);
    expect(parsed.source_pdf_hash).toBe("a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a");
  });

  it("rejects AcceptedRecordSchema when source_pdf_hash is invalid length", () => {
    const invalidRecord = {
      schema_version: 1,
      course_year: 1,
      snapshot_id: "snap-1",
      source_pdf_url: "https://fcim.utm.md/test.pdf",
      source_pdf_hash: "short-hash",
      accepted_at: new Date().toISOString(),
      schedule: minimalSchedule,
    };

    const result = AcceptedRecordSchema.safeParse(invalidRecord);
    expect(result.success).toBe(false);
  });

  it("validates CurrentPointerSchema and SnapshotManifestSchema", () => {
    const pointer = {
      schema_version: 1,
      snapshot_id: "2026-09-08T02-08-48Z-7a3b4c19",
      updated_at: "2026-09-08T02:08:50.000Z",
      manifest_r2_key: "snapshots/2026-09-08T02-08-48Z-7a3b4c19/manifest.json",
    };
    expect(CurrentPointerSchema.safeParse(pointer).success).toBe(true);

    const manifest: SnapshotManifest = {
      schema_version: 1,
      snapshot_id: "2026-09-08T02-08-48Z-7a3b4c19",
      previous_snapshot_id: null,
      created_at: "2026-09-08T02:08:48.000Z",
      source: {
        page_api_url: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view",
        page_id: 1739,
        page_modified_gmt: "2026-09-08T02:00:00",
        retrieved_at: "2026-09-08T02:08:48.000Z",
        etag: '"page-etag"',
        last_modified: "Tue, 08 Sep 2026 02:00:00 GMT",
      },
      files: [
        {
          filename: "anul_i_semestrul_i-18.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
          r2_key: "snapshots/2026-09-08T02-08-48Z-7a3b4c19/pdfs/anul_i_semestrul_i-18.pdf",
          content_type: "application/pdf",
          size: 1024000,
          upstream_etag: '"pdf-etag-1"',
          upstream_last_modified: "Tue, 08 Sep 2026 02:00:00 GMT",
        },
        {
          filename: "anul_ii_semestrul_iii-11.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-11.pdf",
          r2_key: "snapshots/2026-09-08T02-08-48Z-7a3b4c19/pdfs/anul_ii_semestrul_iii-11.pdf",
          content_type: "application/pdf",
          size: 1048576,
          upstream_etag: '"pdf-etag-2"',
          upstream_last_modified: "Tue, 08 Sep 2026 02:00:00 GMT",
        },
      ],
    };

    expect(SnapshotManifestSchema.safeParse(manifest).success).toBe(true);

    const course1File = selectCandidateFile(manifest, 1);
    expect(course1File?.filename).toBe("anul_i_semestrul_i-18.pdf");

    const course2File = selectCandidateFile(manifest, 2);
    expect(course2File?.filename).toBe("anul_ii_semestrul_iii-11.pdf");

    const course3File = selectCandidateFile(manifest, 3);
    expect(course3File).toBeNull();
  });
});

describe("Audit E-01: Adversarial candidate selection fixtures", () => {
  const baseManifest = (files: SnapshotManifest["files"]): SnapshotManifest => ({
    schema_version: 1,
    snapshot_id: "snap-adversarial-1",
    previous_snapshot_id: null,
    created_at: "2026-09-08T02:00:00.000Z",
    source: {
      page_api_url: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view",
      page_id: 1739,
      page_modified_gmt: null,
      retrieved_at: "2026-09-08T02:00:00.000Z",
      etag: null,
      last_modified: null,
    },
    files,
  });

  it("Fixture 1: selects Autumn revision 18 over Spring revision 1 in Autumn semester", () => {
    const pageApiPayload = [
      {
        content: {
          rendered: `
            <section>
              <h2>Ciclul I, Licență - învățământ cu frecvență</h2>
              <table>
                <tr>
                  <td>Orarul semestrul de primavara 2026/2027</td>
                  <td><a href="https://fcim.utm.md/wp-content/uploads/sites/24/2026/02/anul_i_semestrul_ii-1.pdf">Anul I</a></td>
                </tr>
                <tr>
                  <td>Orarul semestrul de toamna 2026/2027</td>
                  <td><a href="https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf">Anul I</a></td>
                </tr>
              </table>
            </section>
          `,
        },
      },
    ];

    const manifest = baseManifest([
      {
        filename: "anul_i_semestrul_ii-1.pdf",
        source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/02/anul_i_semestrul_ii-1.pdf",
        r2_key: "snapshots/snap-adversarial-1/pdfs/anul_i_semestrul_ii-1.pdf",
        content_type: "application/pdf",
        size: 1000,
        upstream_etag: null,
        upstream_last_modified: null,
      },
      {
        filename: "anul_i_semestrul_i-18.pdf",
        source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
        r2_key: "snapshots/snap-adversarial-1/pdfs/anul_i_semestrul_i-18.pdf",
        content_type: "application/pdf",
        size: 1000,
        upstream_etag: null,
        upstream_last_modified: null,
      },
    ]);

    // Autumn date: September 2026
    const autumnDate = new Date("2026-09-08T10:00:00Z");
    const { candidateFile, discovered } = selectCandidateFromSnapshot(pageApiPayload, manifest, 1, autumnDate);

    expect(candidateFile.filename).toBe("anul_i_semestrul_i-18.pdf");
    expect(discovered.pdf_url).toBe(
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
    );
  });

  it("Fixture 2: selects Licență Anul II r11 over Master Anul II r99", () => {
    const pageApiPayload = [
      {
        content: {
          rendered: `
            <section>
              <h2>Ciclul II, Masterat</h2>
              <table>
                <tr>
                  <td>Orarul semestrul de toamna 2026/2027</td>
                  <td><a href="https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/master_anul_ii-99.pdf">Anul II</a></td>
                </tr>
              </table>
            </section>
            <section>
              <h2>Ciclul I, Licență - învățământ cu frecvență</h2>
              <table>
                <tr>
                  <td>Orarul semestrul de toamna 2026/2027</td>
                  <td><a href="https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-11.pdf">Anul II</a></td>
                </tr>
              </table>
            </section>
          `,
        },
      },
    ];

    const manifest = baseManifest([
      {
        filename: "master_anul_ii-99.pdf",
        source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/master_anul_ii-99.pdf",
        r2_key: "snapshots/snap-adversarial-1/pdfs/master_anul_ii-99.pdf",
        content_type: "application/pdf",
        size: 1000,
        upstream_etag: null,
        upstream_last_modified: null,
      },
      {
        filename: "anul_ii_semestrul_iii-11.pdf",
        source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-11.pdf",
        r2_key: "snapshots/snap-adversarial-1/pdfs/anul_ii_semestrul_iii-11.pdf",
        content_type: "application/pdf",
        size: 1000,
        upstream_etag: null,
        upstream_last_modified: null,
      },
    ]);

    const { candidateFile } = selectCandidateFromSnapshot(pageApiPayload, manifest, 2, new Date("2026-09-08T10:00:00Z"));
    expect(candidateFile.filename).toBe("anul_ii_semestrul_iii-11.pdf");
  });

  it("Fixture 3: selects regular timetable and ignores exam session timetable", () => {
    const pageApiPayload = [
      {
        content: {
          rendered: `
            <section>
              <h2>Ciclul I, Licență - învățământ cu frecvență</h2>
              <table>
                <tr>
                  <td>Sesiunea de examinare 2026/2027</td>
                  <td><a href="https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_sesiune-5.pdf">Anul I</a></td>
                </tr>
                <tr>
                  <td>Orarul semestrul de toamna 2026/2027</td>
                  <td><a href="https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf">Anul I</a></td>
                </tr>
              </table>
            </section>
          `,
        },
      },
    ];

    const manifest = baseManifest([
      {
        filename: "anul_i_sesiune-5.pdf",
        source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_sesiune-5.pdf",
        r2_key: "snapshots/snap-adversarial-1/pdfs/anul_i_sesiune-5.pdf",
        content_type: "application/pdf",
        size: 1000,
        upstream_etag: null,
        upstream_last_modified: null,
      },
      {
        filename: "anul_i_semestrul_i-18.pdf",
        source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
        r2_key: "snapshots/snap-adversarial-1/pdfs/anul_i_semestrul_i-18.pdf",
        content_type: "application/pdf",
        size: 1000,
        upstream_etag: null,
        upstream_last_modified: null,
      },
    ]);

    const { candidateFile } = selectCandidateFromSnapshot(pageApiPayload, manifest, 1, new Date("2026-09-08T10:00:00Z"));
    expect(candidateFile.filename).toBe("anul_i_semestrul_i-18.pdf");
  });

  it("Fixture 4: throws when discovered PDF is absent from snapshot manifest", () => {
    const pageApiPayload = [
      {
        content: {
          rendered: `
            <section>
              <h2>Ciclul I, Licență - învățământ cu frecvență</h2>
              <table>
                <tr>
                  <td>Orarul semestrul de toamna 2026/2027</td>
                  <td><a href="https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf">Anul I</a></td>
                </tr>
              </table>
            </section>
          `,
        },
      },
    ];

    // Manifest contains unrelated file, not the discovered r18
    const manifest = baseManifest([
      {
        filename: "anul_i_semestrul_i-9.pdf",
        source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
        r2_key: "snapshots/snap-adversarial-1/pdfs/anul_i_semestrul_i-9.pdf",
        content_type: "application/pdf",
        size: 1000,
        upstream_etag: null,
        upstream_last_modified: null,
      },
    ]);

    expect(() => {
      selectCandidateFromSnapshot(pageApiPayload, manifest, 1, new Date("2026-09-08T10:00:00Z"));
    }).toThrow(/is absent from snapshot manifest/);
  });
});

describe("Audit E-05: Broker URL security parsing & path token validators", () => {
  it("strictly validates SCHEDULE_BROKER_URL", () => {
    // Valid HTTPS URLs
    expect(parseAndValidateBrokerUrl("https://broker.fcim.internal").origin).toBe("https://broker.fcim.internal");
    expect(parseAndValidateBrokerUrl("https://fcim-schedule-broker.barbalatv.workers.dev").origin).toBe(
      "https://fcim-schedule-broker.barbalatv.workers.dev",
    );

    // Insecure HTTP
    expect(() => parseAndValidateBrokerUrl("http://broker.fcim.internal")).toThrow(
      /must use https: protocol/i,
    );

    // Embedded userinfo credentials
    expect(() => parseAndValidateBrokerUrl("https://user:pass@broker.fcim.internal")).toThrow(
      "must not contain credentials",
    );

    // Fragment
    expect(() => parseAndValidateBrokerUrl("https://broker.fcim.internal/#test")).toThrow(
      /query parameters or fragments/i,
    );

    // Non-root path
    expect(() => parseAndValidateBrokerUrl("https://broker.fcim.internal/api/v1")).toThrow(
      "must be origin only",
    );

    // Query parameters
    expect(() => parseAndValidateBrokerUrl("https://broker.fcim.internal?foo=bar")).toThrow(
      /query parameters or fragments/i,
    );
  });

  it("rejects traversal in the raw value that URL normalisation would erase", () => {
    // `new URL()` reports pathname "/" for every one of these, which is exactly why the raw
    // configured string has to be inspected before it is parsed.
    const normalisedAway = [
      "https://broker.fcim.internal/..",
      "https://broker.fcim.internal/../",
      "https://broker.fcim.internal/a/../",
      "https://broker.fcim.internal/%2e%2e",
      "https://broker.fcim.internal/%2E%2E/",
      "https://broker.fcim.internal/%252e%252e",
      "https://broker.fcim.internal/%2f",
      "https://broker.fcim.internal/%252f",
      "https://broker.fcim.internal/%5c",
      "https://broker.fcim.internal/%255c",
      "https://broker.fcim.internal\\evil",
    ];

    for (const raw of normalisedAway) {
      expect(() => parseAndValidateBrokerUrl(raw)).toThrow();
    }

    // The specific traversal message, so the check cannot silently become a shape check only.
    expect(() => parseAndValidateBrokerUrl("https://broker.fcim.internal/../")).toThrow(/path traversal/i);
    expect(() => parseAndValidateBrokerUrl("https://broker.fcim.internal/%2e%2e")).toThrow(/path traversal/i);
  });

  it("accepts a host with at most one trailing slash and rejects ports and extra slashes", () => {
    expect(parseAndValidateBrokerUrl("https://broker.fcim.internal/").origin).toBe("https://broker.fcim.internal");

    expect(() => parseAndValidateBrokerUrl("https://broker.fcim.internal//")).toThrow(/origin only/i);
    expect(() => parseAndValidateBrokerUrl("https://broker.fcim.internal///")).toThrow(/origin only/i);
    expect(() => parseAndValidateBrokerUrl("https://broker.fcim.internal:8443")).toThrow(/port/i);
    expect(() => parseAndValidateBrokerUrl("https://broker.fcim.internal:443")).toThrow(/port/i);
    expect(() => parseAndValidateBrokerUrl("")).toThrow(/not configured/i);
  });

  it("strictly validates path tokens against path traversal", () => {
    // Valid tokens
    expect(validatePathToken("snap-2026-09-08", "snapshot_id")).toBe("snap-2026-09-08");
    expect(validatePathToken("a4c610d24dd53bbf-p1_3_0-1111111111111111", "accepted_id")).toBe(
      "a4c610d24dd53bbf-p1_3_0-1111111111111111",
    );

    // Traversal attacks
    expect(() => validatePathToken("..", "test")).toThrow(/forbidden characters|invalid/i);
    expect(() => validatePathToken("../foo", "test")).toThrow(/forbidden characters|invalid/i);
    expect(() => validatePathToken("foo/bar", "test")).toThrow(/forbidden characters|invalid/i);
    expect(() => validatePathToken("foo\\bar", "test")).toThrow(/forbidden characters|invalid/i);
    expect(() => validatePathToken("%2e%2e", "test")).toThrow(/forbidden characters|invalid/i);
    expect(() => validatePathToken("%2f", "test")).toThrow(/forbidden characters|invalid/i);
    expect(() => validatePathToken("%5c", "test")).toThrow(/forbidden characters|invalid/i);
    expect(() => validatePathToken("", "test")).toThrow(/forbidden characters|invalid/i);
  });

  it("strictly validates PDF filenames", () => {
    // Valid filenames
    expect(validatePdfFilename("anul_i_semestrul_i-18.pdf")).toBe("anul_i_semestrul_i-18.pdf");
    expect(validatePdfFilename("anul_ii_semestrul_iii-11.pdf")).toBe("anul_ii_semestrul_iii-11.pdf");

    // Traversal and evil extensions
    expect(() => validatePdfFilename("../anul_i.pdf")).toThrow(/forbidden characters|does not end in \.pdf|must have \.pdf/i);
    expect(() => validatePdfFilename("anul_i.pdf/foo")).toThrow(/forbidden characters|does not end in \.pdf|must have \.pdf/i);
    expect(() => validatePdfFilename("anul_i.pdf.exe")).toThrow(/forbidden characters|does not end in \.pdf|must have \.pdf/i);
    expect(() => validatePdfFilename("anul_i.docx")).toThrow(/forbidden characters|does not end in \.pdf|must have \.pdf/i);
    expect(() => validatePdfFilename("%2e%2e%2fanul_i.pdf")).toThrow(/forbidden characters|does not end in \.pdf|must have \.pdf/i);
  });
});

describe("Audit E-03: Stream timeout & bounded reader", () => {
  it("aborts when response stream stalls beyond timeoutMs", async () => {
    const originalFetch = globalThis.fetch;
    // Create a stream that emits initial chunk, then hangs indefinitely
    const stallingStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        // Do not close or enqueue more
      },
    });

    globalThis.fetch = vi.fn(async () => {
      return new Response(stallingStream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await expect(
        fetchBrokerBounded("https://broker.fcim.internal/current", {}, 1024, 50),
      ).rejects.toThrow(/timed out/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts when response stream exceeds maxBytes", async () => {
    const originalFetch = globalThis.fetch;
    const largeChunk = new Uint8Array(2048);

    globalThis.fetch = vi.fn(async () => {
      return new Response(largeChunk, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await expect(
        fetchBrokerBounded("https://broker.fcim.internal/current", {}, 1024, 5000),
      ).rejects.toThrow(/exceeded limit/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
