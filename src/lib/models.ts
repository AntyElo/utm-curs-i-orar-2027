/**
 * Strict data model shared by parser, storage, API and frontend.
 * zod plays the role Pydantic would play in a Python stack.
 */
import { z } from "zod";

export const DAY_NAMES = ["Luni", "Marți", "Miercuri", "Joi", "Vineri"] as const;
export const DaySchema = z.enum(DAY_NAMES);
export type DayName = z.infer<typeof DaySchema>;

export const LESSON_TYPES = [
  "lecture",
  "lab",
  "seminar",
  "practice",
  "physical_education",
  "language",
  "project",
  "unknown",
] as const;
export const LessonTypeSchema = z.enum(LESSON_TYPES);
export type LessonType = z.infer<typeof LessonTypeSchema>;

export const WeekParitySchema = z.enum(["odd", "even", "both", "unknown"]);
export type WeekParity = z.infer<typeof WeekParitySchema>;

const TimeString = z.string().regex(/^\d{2}:\d{2}$/, "expected HH:MM");

export const GeometrySchema = z.object({
  page: z.number().int().min(1),
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
});
export type Geometry = z.infer<typeof GeometrySchema>;

export const LessonSchema = z.object({
  id: z.string().min(1),
  day: DaySchema,
  /** Index of the first time slot the lesson occupies (0 = 08:00). */
  slot_index: z.number().int().min(0),
  /** Number of consecutive time slots covered (vertically merged cells). */
  slot_span: z.number().int().min(1),
  start_time: TimeString,
  end_time: TimeString,
  groups: z.array(z.string().min(1)).min(1),
  subject: z.string().min(1),
  teacher: z.string().nullable(),
  room: z.string().nullable(),
  lesson_type: LessonTypeSchema,
  subgroup: z.string().nullable(),
  week_parity: WeekParitySchema,
  notes: z.array(z.string()),
  raw_text: z.string(),
  geometry: GeometrySchema,
  /** 0..1 – how confident the interpreter is about subject/teacher/room split. */
  confidence: z.number().min(0).max(1),
  uncertain: z.boolean(),
});
export type Lesson = z.infer<typeof LessonSchema>;

export const TimeSlotSchema = z.object({
  index: z.number().int().min(0),
  start_time: TimeString,
  end_time: TimeString,
  raw: z.string(),
});
export type TimeSlot = z.infer<typeof TimeSlotSchema>;

export const GroupSchema = z.object({
  name: z.string().min(1),
  /** Program prefix, e.g. "SI" for SI-261. */
  program: z.string(),
  x0: z.number(),
  x1: z.number(),
});
export type GroupColumn = z.infer<typeof GroupSchema>;

export const ScheduleMetadataSchema = z.object({
  academic_year: z.string().nullable(),
  semester: z.string().nullable(),
  course_year: z.number().int(),
  source_page_url: z.string(),
  source_pdf_url: z.string(),
  source_pdf_hash: z.string(),
  /** "manual" = authenticated explicit official-PDF recovery; other values describe discovery/bootstrap. */
  source_kind: z.enum(["live", "wayback", "seed", "manual"]),
  source_transport: z.enum(["direct", "broker"]).default("direct"),
  source_snapshot_id: z.string().nullable().default(null),
  downloaded_at: z.string(),
  parsed_at: z.string(),
  parser_version: z.string(),
  etag: z.string().nullable(),
  last_modified: z.string().nullable(),
  pdf_title: z.string().nullable(),
});
export type ScheduleMetadata = z.infer<typeof ScheduleMetadataSchema>;

export const ScheduleSchema = z.object({
  metadata: ScheduleMetadataSchema,
  groups: z.array(GroupSchema).min(1),
  days: z.array(DaySchema),
  time_slots: z.array(TimeSlotSchema),
  lessons: z.array(LessonSchema),
  /** Non-fatal parser observations (orphan cells, uncertain entries, ...). */
  warnings: z.array(z.string()),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const SnapshotSourceSchema = z.object({
  page_api_url: z.string(),
  page_id: z.number().nullable().default(null),
  page_modified_gmt: z.string().nullable().default(null),
  retrieved_at: z.string(),
  etag: z.string().nullable().default(null),
  last_modified: z.string().nullable().default(null),
});
export type SnapshotSource = z.infer<typeof SnapshotSourceSchema>;

export const SnapshotFileSchema = z.object({
  filename: z.string(),
  source_url: z.string(),
  r2_key: z.string(),
  content_type: z.string().nullable().default(null),
  size: z.number().nullable().default(null),
  upstream_etag: z.string().nullable().default(null),
  upstream_last_modified: z.string().nullable().default(null),
});
export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;

export const SnapshotManifestSchema = z.object({
  schema_version: z.literal(1).default(1),
  snapshot_id: z.string(),
  previous_snapshot_id: z.string().nullable().default(null),
  created_at: z.string(),
  source: SnapshotSourceSchema,
  files: z.array(SnapshotFileSchema),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

/**
 * The broker's `current.json`. The broker validates this document far more strictly than we do —
 * it is the one object that decides which snapshot may be served, so it enforces an exact field
 * set on write. Here we only require what Render actually consumes, and treat the publication
 * bookkeeping fields as informational.
 */
export const CurrentPointerSchema = z.object({
  schema_version: z.literal(1).default(1),
  snapshot_id: z.string(),
  updated_at: z.string(),
  manifest_r2_key: z.string(),
  published_at: z.string().optional(),
  page_modified_gmt: z.string().nullable().optional(),
  page_id: z.number().nullable().optional(),
  pdf_count: z.number().int().nonnegative().optional(),
});
export type CurrentPointer = z.infer<typeof CurrentPointerSchema>;

export const AcceptedPointerSchema = z.object({
  schema_version: z.literal(1).default(1),
  course_year: z.number().int(),
  accepted_id: z.string(),
  payload_key: z.string(),
  payload_sha256: z.string().regex(/^[a-f0-9]{64}$/i, "expected 64-character SHA-256 hash"),
  source_snapshot_id: z.string(),
  source_pdf_url: z.string(),
  source_pdf_hash: z.string().regex(/^[a-f0-9]{64}$/i, "expected 64-character SHA-256 hash"),
  parser_version: z.string(),
  accepted_at: z.string(),
});
export type AcceptedPointer = z.infer<typeof AcceptedPointerSchema>;

export const AcceptedPointerWriteRequestSchema = z.object({
  expected_previous_accepted_id: z.string().nullable(),
  pointer: AcceptedPointerSchema,
});
export type AcceptedPointerWriteRequest = z.infer<typeof AcceptedPointerWriteRequestSchema>;

export const AcceptedRecordSchema = z.object({
  schema_version: z.literal(1).default(1),
  course_year: z.number().int(),
  accepted_id: z.string().optional(),
  snapshot_id: z.string(),
  source_pdf_url: z.string(),
  source_pdf_hash: z.string().regex(/^[a-f0-9]{64}$/i, "expected 64-character SHA-256 hash"),
  parser_version: z.string().optional(),
  payload_sha256: z.string().regex(/^[a-f0-9]{64}$/i, "expected 64-character SHA-256 hash").optional(),
  accepted_at: z.string(),
  schedule: ScheduleSchema,
});
export type AcceptedRecord = z.infer<typeof AcceptedRecordSchema>;

export const AcceptedWriteRequestSchema = z.object({
  expected_previous_hash: z.string().nullable(),
  state: AcceptedRecordSchema,
});
export type AcceptedWriteRequest = z.infer<typeof AcceptedWriteRequestSchema>;

/** Persisted state of the auto-update loop. */
export const SourceStateSchema = z.object({
  current_pdf_url: z.string().nullable(),
  current_pdf_hash: z.string().nullable(),
  etag: z.string().nullable(),
  last_modified: z.string().nullable(),
  last_check_at: z.string().nullable(),
  last_success_at: z.string().nullable(),
  last_error: z.string().nullable(),
  last_error_at: z.string().nullable(),
  /** Latest automatic discovery/bootstrap result; explicit recovery preserves this diagnostic. */
  last_result: z
    .enum(["updated", "unchanged", "rejected", "error", "seeded", "never"])
    .default("never"),
  academic_year: z.string().nullable().default(null),
  semester: z.string().nullable().default(null),
  parity_note: z.string().nullable().default(null),
});
export type SourceState = z.infer<typeof SourceStateSchema>;

/**
 * A course with no state yet. This is a factory, never a shared object: two courses
 * that are both empty must not end up holding the same instance, or a later mutation
 * of one course's state would silently appear in the other.
 */
export function createEmptySourceState(): SourceState {
  return {
    current_pdf_url: null,
    current_pdf_hash: null,
    etag: null,
    last_modified: null,
    last_check_at: null,
    last_success_at: null,
    last_error: null,
    last_error_at: null,
    last_result: "never",
    academic_year: null,
    semester: null,
    parity_note: null,
  };
}

/** Read-only template, frozen so it cannot become shared mutable state by accident. */
export const EMPTY_SOURCE_STATE: Readonly<SourceState> = Object.freeze(createEmptySourceState());
