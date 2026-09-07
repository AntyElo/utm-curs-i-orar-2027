/**
 * PostgreSQL history is optional (DATABASE_URL) and a live server is not part of CI, so
 * the part that actually matters — that every statement is scoped to one course year — is
 * tested by rendering the query builders through drizzle's own PostgreSQL dialect. No
 * connection is opened and no database is faked: these are the exact SQL fragments the
 * storage layer sends.
 *
 * What must hold: two courses each keep one `is_current` row, installing one course never
 * retires or prunes the other's rows, and a payload always carries its own course year.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { currentVersionFilter, HISTORY_LIMIT_PER_COURSE, pruneStatement, versionValues } from "@/db/schedule-versions";
import { scheduleVersions } from "@/db/schema";
import type { Schedule } from "@/lib/models";

const dialect = new PgDialect();

function render(query: Parameters<PgDialect["sqlToQuery"]>[0]) {
  const { sql, params } = dialect.sqlToQuery(query);
  return { sql, params };
}

function scheduleFor(courseYear: number): Schedule {
  return {
    metadata: {
      academic_year: "2026/2027",
      semester: courseYear === 1 ? "Semestrul I" : "Semestrul III",
      course_year: courseYear,
      source_page_url: "https://fcim.utm.md/procesul-de-studii/orar/",
      source_pdf_url: `https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_${courseYear}.pdf`,
      source_pdf_hash: `hash-${courseYear}`,
      source_kind: "live",
      source_transport: "direct",
      source_snapshot_id: null,
      downloaded_at: "2026-09-01T00:00:00.000Z",
      parsed_at: "2026-09-01T00:00:00.000Z",
      parser_version: "1.1.0",
      etag: null,
      last_modified: null,
      pdf_title: null,
    },
    groups: [{ name: "SI-261", program: "SI", x0: 0, x1: 1 }],
    days: ["Luni"],
    time_slots: [{ index: 0, start_time: "08:00", end_time: "09:30", raw: "08:00-09:30" }],
    lessons: [],
    warnings: [],
  };
}

describe("course-scoped schedule history", () => {
  it("carries the course year on the table itself", () => {
    expect(scheduleVersions.courseYear.name).toBe("course_year");
    // Rows written before multi-course support are Anul I history, which is what they were.
    expect(scheduleVersions.courseYear.notNull).toBe(true);
    expect(scheduleVersions.courseYear.default).toBe(1);
  });

  it("looks up the current version of one course only", () => {
    const { sql, params } = render(currentVersionFilter(2));
    expect(sql).toMatch(/"is_current"\s*=\s*\$\d/);
    expect(sql).toMatch(/"course_year"\s*=\s*\$\d/);
    expect(params).toEqual([true, 2]);

    // The two courses produce different bound parameters, never a shared global filter.
    expect(render(currentVersionFilter(1)).params).toEqual([true, 1]);
  });

  it("retires the previous current row of that course alone", () => {
    // This is the filter the update statement uses before inserting a new version.
    const { sql, params } = render(currentVersionFilter(2));
    expect(sql).toContain("and");
    expect(params).toContain(2);
    expect(params).not.toContain(1);
  });

  it("labels an inserted version with the course year the document declares", () => {
    expect(versionValues(scheduleFor(2))).toMatchObject({
      courseYear: 2,
      semester: "Semestrul III",
      pdfHash: "hash-2",
      isCurrent: true,
    });
    expect(versionValues(scheduleFor(1)).courseYear).toBe(1);
  });

  it("prunes within a course, so one course's activity cannot evict the other's history", () => {
    const { sql, params } = render(pruneStatement(2));
    expect(sql).toMatch(/delete from schedule_versions where course_year = \$\d/);
    // The subselect that decides what to keep is scoped too – otherwise a busy course
    // would push the only recovery row of a quiet one out of the retention window.
    expect(sql).toMatch(/select id from schedule_versions where course_year = \$\d order by created_at desc limit \$\d/);
    expect(params).toEqual([2, 2, HISTORY_LIMIT_PER_COURSE]);
    expect(HISTORY_LIMIT_PER_COURSE).toBe(20);

    expect(render(pruneStatement(1)).params).toEqual([1, 1, HISTORY_LIMIT_PER_COURSE]);
  });

  it("keeps a full history budget for each course independently", () => {
    // 20 rows of course 1 plus 20 of course 2 all survive: each statement binds its own
    // course year and never the other's, so the two retention windows do not compete.
    const one = render(pruneStatement(1));
    const two = render(pruneStatement(2));
    expect(one.sql).toBe(two.sql);
    expect(one.params).toEqual([1, 1, HISTORY_LIMIT_PER_COURSE]);
    expect(two.params).toEqual([2, 2, HISTORY_LIMIT_PER_COURSE]);
    expect(one.params).not.toContain(2);
    expect(two.params.filter((value) => value === 1)).toHaveLength(0);
  });
});
