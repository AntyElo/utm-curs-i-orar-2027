/**
 * The stateful boundaries: what a course year may reach, and what it may inherit.
 *
 * Three rules are protected here.
 *
 *  - An unsupported course year is refused at every exported entry point. It is never
 *    normalised to course 1, and it must not be able to create a namespace of its own
 *    (`data/courses/3`) that later code would treat as real.
 *  - Two courses with nothing persisted yet do not share one empty state object; a
 *    mutation of one must be invisible to the other.
 *  - A pre-multi-course metadata.json is adopted only when it demonstrably describes the
 *    schedule being adopted. Both files being well-formed proves nothing.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Schedule, SourceState } from "@/lib/models";

const tempDir = await mkdtempDir();
process.env.SCHEDULE_COURSES = "1,2";
process.env.SCHEDULE_DATA_DIR = tempDir;
process.env.DATABASE_URL = "";

const { UnsupportedCourseError } = await import("@/lib/courses");
const { createEmptySourceState, EMPTY_SOURCE_STATE } = await import("@/lib/models");
const { getCurrentSchedule, getSourceState, replaceCurrentSchedule, resetStorageCache, saveSourceState } =
  await import("@/lib/storage");
const { checkForUpdates, refreshFromExplicitPdf } = await import("@/lib/services/updater");
const { buildStatus, requireSchedule } = await import("@/lib/services/schedule-service");

async function mkdtempDir(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(tmpdir(), "fcim-bounds-"));
}

const PDF_A = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf";
const PDF_B = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-5.pdf";

/** A minimal but schema-valid schedule; storage cares about identity, not lesson content. */
function scheduleFor(courseYear: number, url = PDF_A, hash = `hash-${courseYear}`): Schedule {
  return {
    metadata: {
      academic_year: "2026/2027",
      semester: courseYear === 1 ? "Semestrul I" : "Semestrul III",
      course_year: courseYear,
      source_page_url: "https://fcim.utm.md/procesul-de-studii/orar/",
      source_pdf_url: url,
      source_pdf_hash: hash,
      source_kind: "live",
      downloaded_at: "2026-09-01T00:00:00.000Z",
      parsed_at: "2026-09-01T00:00:00.000Z",
      parser_version: "1.1.0",
      etag: null,
      last_modified: null,
      pdf_title: null,
    },
    groups: [{ name: "SI-261", program: "SI", x0: 0, x1: 10 }],
    days: ["Luni"],
    time_slots: [{ index: 0, start_time: "08:00", end_time: "09:30", raw: "08:00-09:30" }],
    lessons: [],
    warnings: [],
  };
}

async function writeLegacy(schedule: Schedule, state: Partial<SourceState> | null) {
  await mkdir(tempDir, { recursive: true });
  await writeFile(path.join(tempDir, "current_schedule.json"), JSON.stringify(schedule), "utf8");
  if (state) {
    await writeFile(
      path.join(tempDir, "metadata.json"),
      JSON.stringify({ ...createEmptySourceState(), ...state }),
      "utf8",
    );
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  await rm(path.join(tempDir, "courses"), { recursive: true, force: true });
  await Promise.all([
    rm(path.join(tempDir, "current_schedule.json"), { force: true }),
    rm(path.join(tempDir, "metadata.json"), { force: true }),
  ]);
  resetStorageCache();
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("unsupported course years are refused at every boundary", () => {
  const invalid = [3, 0, -1, 1.5, Number.NaN];

  it("refuses reads and writes through storage", async () => {
    for (const courseYear of invalid) {
      await expect(getCurrentSchedule(courseYear), `getCurrentSchedule(${courseYear})`).rejects.toThrow(
        UnsupportedCourseError,
      );
      await expect(getSourceState(courseYear), `getSourceState(${courseYear})`).rejects.toThrow(
        UnsupportedCourseError,
      );
      await expect(saveSourceState(courseYear, { last_result: "updated" })).rejects.toThrow(UnsupportedCourseError);
      await expect(replaceCurrentSchedule(courseYear, scheduleFor(1))).rejects.toThrow(UnsupportedCourseError);
    }
  });

  it("refuses updates and reads through the services", async () => {
    for (const courseYear of invalid) {
      await expect(checkForUpdates(courseYear)).rejects.toThrow(UnsupportedCourseError);
      await expect(refreshFromExplicitPdf(courseYear, { pdfUrl: PDF_A })).rejects.toThrow(UnsupportedCourseError);
      await expect(requireSchedule(courseYear)).rejects.toThrow(UnsupportedCourseError);
      await expect(buildStatus(courseYear)).rejects.toThrow(UnsupportedCourseError);
    }
  });

  it("creates no namespace for a course it does not serve", async () => {
    await expect(saveSourceState(3, { last_result: "error" })).rejects.toThrow();
    await expect(replaceCurrentSchedule(3, { ...scheduleFor(1), metadata: { ...scheduleFor(1).metadata, course_year: 3 } })).rejects.toThrow();
    // The refusal happens before any directory is created.
    expect(await exists(path.join(tempDir, "courses", "3"))).toBe(false);
  });

  it("still refuses a value that would be normalised by a lenient parse", async () => {
    // "1x" and "01" become 1 under Number.parseInt; as numbers they never reach here,
    // but a non-integer that slipped through arithmetic must not round into course 1.
    await expect(getCurrentSchedule(1.0000001)).rejects.toThrow(UnsupportedCourseError);
    expect(await exists(path.join(tempDir, "courses", "1.0000001"))).toBe(false);
  });
});

describe("empty source state is per course", () => {
  it("never hands two courses the same object", async () => {
    const one = await getSourceState(1);
    const two = await getSourceState(2);

    expect(one).toEqual(two);
    expect(one).not.toBe(two);
    expect(one).not.toBe(EMPTY_SOURCE_STATE);
  });

  it("keeps a mutation of one course's state out of the other", async () => {
    const one = await getSourceState(1);
    one.last_error = "scribbled by course 1";
    one.current_pdf_hash = "hash-1";

    expect((await getSourceState(2)).last_error).toBeNull();
    expect((await getSourceState(2)).current_pdf_hash).toBeNull();
    // And the course that was scribbled on is unaffected too: nothing was persisted.
    expect((await getSourceState(1)).last_error).toBeNull();
  });

  it("keeps the exported template immutable", () => {
    expect(Object.isFrozen(EMPTY_SOURCE_STATE)).toBe(true);
    expect(createEmptySourceState()).not.toBe(createEmptySourceState());
  });
});

describe("legacy metadata is bound to the schedule it describes", () => {
  const scheduleHash = "aaaa1111";

  it("adopts state whose hash matches the adopted schedule", async () => {
    await writeLegacy(scheduleFor(1, PDF_A, scheduleHash), {
      current_pdf_url: PDF_A,
      current_pdf_hash: scheduleHash,
      etag: '"matching-etag"',
      last_modified: "Mon, 01 Sep 2026 00:00:00 GMT",
      last_result: "updated",
    });

    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(scheduleHash);
    const state = await getSourceState(1);
    expect(state.etag).toBe('"matching-etag"');
    expect(state.last_result).toBe("updated");
  });

  it("discards state whose hash names another document", async () => {
    await writeLegacy(scheduleFor(1, PDF_A, scheduleHash), {
      current_pdf_url: PDF_A,
      current_pdf_hash: "bbbb2222",
      etag: '"someone-elses-etag"',
      last_modified: "Mon, 01 Sep 2026 00:00:00 GMT",
      last_result: "updated",
      last_error: "an unrelated failure",
    });

    // The schedule is still adopted – it is valid data and belongs to this course.
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(scheduleHash);
    // ...but nothing from the foreign state travels with it. A stale ETag here would make
    // the next check answer 304 for a PDF this course does not actually hold.
    const state = await getSourceState(1);
    expect(state.etag).toBeNull();
    expect(state.last_modified).toBeNull();
    expect(state.current_pdf_hash).toBeNull();
    expect(state.current_pdf_url).toBeNull();
    expect(state.last_error).toBeNull();
    expect(state.last_result).toBe("never");
    expect(await exists(path.join(tempDir, "courses", "1", "metadata.json"))).toBe(false);
  });

  it("discards hash-less state whose URL names another document", async () => {
    await writeLegacy(scheduleFor(1, PDF_A, scheduleHash), {
      current_pdf_url: PDF_B,
      current_pdf_hash: null,
      etag: '"other-document"',
      last_result: "updated",
    });

    expect((await getCurrentSchedule(1))?.metadata.source_pdf_url).toBe(PDF_A);
    expect((await getSourceState(1)).etag).toBeNull();
  });

  it("accepts hash-less state whose URL matches", async () => {
    await writeLegacy(scheduleFor(1, PDF_A, scheduleHash), {
      current_pdf_url: PDF_A,
      current_pdf_hash: null,
      etag: '"same-document"',
      last_result: "updated",
    });

    expect((await getSourceState(1)).etag).toBe('"same-document"');
  });

  it("discards state that identifies no document at all", async () => {
    await writeLegacy(scheduleFor(1, PDF_A, scheduleHash), { last_result: "updated", etag: '"unattributed"' });

    expect(await getCurrentSchedule(1)).not.toBeNull();
    expect((await getSourceState(1)).etag).toBeNull();
  });

  it("adopts a schedule that has no legacy state beside it", async () => {
    await writeLegacy(scheduleFor(1, PDF_A, scheduleHash), null);

    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(scheduleHash);
    expect(await getSourceState(1)).toEqual(createEmptySourceState());
  });

  it("adopts nothing from an orphan legacy metadata.json", async () => {
    await mkdir(tempDir, { recursive: true });
    await writeFile(
      path.join(tempDir, "metadata.json"),
      JSON.stringify({ ...createEmptySourceState(), etag: '"orphan"', current_pdf_hash: "cccc3333" }),
      "utf8",
    );

    expect(await getCurrentSchedule(1)).toBeNull();
    expect((await getSourceState(1)).etag).toBeNull();
    expect(await exists(path.join(tempDir, "courses", "1", "metadata.json"))).toBe(false);
  });
});

describe("atomic writes survive overlapping callers", () => {
  it("leaves one valid file and no temporary leftovers", async () => {
    // Concurrent writes of the same path used to share one temp file name (pid only), so
    // one writer could truncate another's buffer before either rename landed.
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        saveSourceState(1, { current_pdf_hash: `hash-${index}`, last_result: "updated" }),
      ),
    );

    const statePath = path.join(tempDir, "courses", "1", "metadata.json");
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as SourceState;
    expect(parsed.last_result).toBe("updated");
    expect(parsed.current_pdf_hash).toMatch(/^hash-\d+$/);

    const { readdir } = await import("node:fs/promises");
    const leftovers = (await readdir(path.join(tempDir, "courses", "1"))).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
