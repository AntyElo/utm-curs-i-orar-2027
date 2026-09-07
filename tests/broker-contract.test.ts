import { describe, expect, it } from "vitest";
import {
  AcceptedRecordSchema,
  AcceptedWriteRequestSchema,
  CurrentPointerSchema,
  ScheduleMetadataSchema,
  SnapshotManifestSchema,
  type AcceptedRecord,
  type SnapshotManifest,
} from "@/lib/models";
import { selectCandidateFile } from "@/lib/services/updater";

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

  it("validates AcceptedWriteRequestSchema with expected_previous_hash null or string", () => {
    const validInitial = {
      expected_previous_hash: null,
      state: {
        schema_version: 1,
        course_year: 1,
        snapshot_id: "snap-1",
        source_pdf_url: "https://fcim.utm.md/test.pdf",
        source_pdf_hash: "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a",
        accepted_at: new Date().toISOString(),
        schedule: minimalSchedule,
      },
    };

    expect(AcceptedWriteRequestSchema.safeParse(validInitial).success).toBe(true);

    const validUpdate = {
      ...validInitial,
      expected_previous_hash: "0000000000000000000000000000000000000000000000000000000000000000",
    };
    expect(AcceptedWriteRequestSchema.safeParse(validUpdate).success).toBe(true);
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

    // Test selectCandidateFile
    const course1File = selectCandidateFile(manifest, 1);
    expect(course1File?.filename).toBe("anul_i_semestrul_i-18.pdf");

    const course2File = selectCandidateFile(manifest, 2);
    expect(course2File?.filename).toBe("anul_ii_semestrul_iii-11.pdf");

    const course3File = selectCandidateFile(manifest, 3);
    expect(course3File).toBeNull();
  });

  it("selectCandidateFile prefers the highest revision when multiple revisions exist", () => {
    const manifest: SnapshotManifest = {
      schema_version: 1,
      snapshot_id: "snap-multi",
      previous_snapshot_id: null,
      created_at: new Date().toISOString(),
      source: {
        page_api_url: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view",
        page_id: 1739,
        page_modified_gmt: null,
        retrieved_at: new Date().toISOString(),
        etag: null,
        last_modified: null,
      },
      files: [
        {
          filename: "anul_i_semestrul_i-9.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
          r2_key: "snapshots/snap-multi/pdfs/anul_i_semestrul_i-9.pdf",
          content_type: "application/pdf",
          size: 1000,
          upstream_etag: null,
          upstream_last_modified: null,
        },
        {
          filename: "anul_i_semestrul_i-18.pdf",
          source_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
          r2_key: "snapshots/snap-multi/pdfs/anul_i_semestrul_i-18.pdf",
          content_type: "application/pdf",
          size: 1000,
          upstream_etag: null,
          upstream_last_modified: null,
        },
      ],
    };

    const selected = selectCandidateFile(manifest, 1);
    expect(selected?.filename).toBe("anul_i_semestrul_i-18.pdf");
  });
});
