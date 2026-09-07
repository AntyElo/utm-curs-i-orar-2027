/**
 * Parser pipeline entry point:
 * PDF → extraction → grid → layout → cells → lessons → normalised Schedule.
 * `parsePdf` never talks to the network or storage; callers pass provenance.
 */
import { createHash } from "node:crypto";
import { config } from "@/lib/config";
import { DEFAULT_COURSE_YEAR } from "@/lib/courses";
import { getLogger } from "@/lib/logger";
import type { Schedule, ScheduleMetadata } from "@/lib/models";
import { repairTruncatedColumnBorders, type BoundaryRepair } from "./boundary-repair";
import { buildCells, type TableCell } from "./cell-builder";
import { buildGrid, type Grid } from "./geometry";
import { interpretCell } from "./lesson-interpreter";
import { cleanText } from "./normalizer";
import { extractPages, type PageExtraction } from "./pdf-extract";
import { canonicalTimeSlots, detectLayout, type TableLayout } from "./table-detector";

const log = getLogger("parser");

export interface Provenance {
  source_page_url: string;
  source_pdf_url: string;
  source_kind: ScheduleMetadata["source_kind"];
  source_transport?: ScheduleMetadata["source_transport"];
  source_snapshot_id?: string | null;
  downloaded_at: string;
  /** Course year the caller asked for. Only fills the gap when the PDF prints no title;
   *  a title that names its own course year always wins, which is what the updater's
   *  course guard then compares against the requested course. */
  course_year?: number;
  etag?: string | null;
  last_modified?: string | null;
  academic_year?: string | null;
  semester?: string | null;
  /** How the caller obtained `semester`; see `resolveSemester`. */
  semester_source?: "explicit" | "inferred" | null;
}

export interface ParseArtifacts {
  schedule: Schedule;
  pages: PageExtraction[];
  grid: Grid;
  layout: TableLayout;
  cells: TableCell[];
  orphans: TableCell[];
  /** Clipped column borders restored before cell reconstruction; empty for a well-formed PDF. */
  border_repairs: BoundaryRepair[];
}

const TITLE_RE = /ANUL UNIVERSITAR\s+(\d{4}\s*[/-]\s*\d{4}),?\s*ANUL\s+([IVX]+),?\s*SEMESTRUL\s+([IVX]+)/i;

export async function parsePdf(pdfBytes: Uint8Array, provenance: Provenance): Promise<ParseArtifacts> {
  const pages = await extractPages(pdfBytes);
  if (pages.length === 0) throw new Error("PDF contains no pages");

  // The timetable is a single very wide table; pick the page with the most group headers.
  const perPage = pages.map((page) => {
    const grid = buildGrid(page.rects);
    const layout = detectLayout(page.texts, grid);
    return { page, grid, layout };
  });
  const best = perPage.reduce((acc, item) => (item.layout.groups.length > acc.layout.groups.length ? item : acc));
  const { page, layout } = best;
  // Layout is detected on the borders as drawn; cells are reconstructed on the borders
  // as intended, with clipped column-border stubs restored (see boundary-repair).
  const { grid, repairs } = repairTruncatedColumnBorders(best.grid, layout);

  log.info("layout detected", {
    page: page.page,
    groups: layout.groups.length,
    days: layout.days.length,
    rows: layout.rows.length,
    repaired_borders: repairs.length,
  });
  for (const repair of repairs) {
    log.info("column border restored", { x: repair.x, day: repair.day, slot: repair.start_time, gap: Number(repair.gap.toFixed(2)) });
  }

  const { cells, orphans } = buildCells(page.texts, grid, layout, page.page);
  const lessons = cells.flatMap(interpretCell).sort(compareLessons);
  const titleInfo = extractTitleInfo(pages);

  const warnings: string[] = [];
  if (orphans.length > 0) warnings.push(`${orphans.length} text cells inside the table could not be mapped to a group/slot`);
  const uncertain = lessons.filter((lesson) => lesson.uncertain).length;
  if (uncertain > 0) warnings.push(`${uncertain} lessons flagged as uncertain`);

  const metadata: ScheduleMetadata = {
    // The title printed inside the document describes the document; provenance only fills gaps.
    academic_year: titleInfo.academicYear ?? provenance.academic_year ?? null,
    semester: resolveSemester(titleInfo.semester, provenance),
    course_year: titleInfo.courseYear ?? provenance.course_year ?? DEFAULT_COURSE_YEAR,
    source_page_url: provenance.source_page_url,
    source_pdf_url: provenance.source_pdf_url,
    source_pdf_hash: sha256(pdfBytes),
    source_kind: provenance.source_kind,
    source_transport: provenance.source_transport ?? "direct",
    source_snapshot_id: provenance.source_snapshot_id ?? null,
    downloaded_at: provenance.downloaded_at,
    parsed_at: new Date().toISOString(),
    parser_version: config.parserVersion,
    etag: provenance.etag ?? null,
    last_modified: provenance.last_modified ?? null,
    pdf_title: titleInfo.title,
  };

  const schedule: Schedule = {
    metadata,
    groups: layout.groups,
    days: layout.days.map((block) => block.day),
    time_slots: canonicalTimeSlots(layout.rows),
    lessons,
    warnings,
  };

  return { schedule, pages, grid, layout, cells, orphans, border_repairs: repairs };
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareLessons(a: Schedule["lessons"][number], b: Schedule["lessons"][number]): number {
  return a.geometry.y0 - b.geometry.y0 || a.geometry.x0 - b.geometry.x0;
}

/**
 * Semester precedence, strongest first:
 *   1. the title printed inside the PDF ("... ANUL II, SEMESTRUL III");
 *   2. a semester printed next to the discovered document/link;
 *   3. the course-year + season inference discovery falls back to;
 *   4. unknown.
 * A season-only label ("Orar Semestrul de TOAMNĂ") says nothing about the course
 * year, so an inference from it must never overwrite what the document states.
 */
function resolveSemester(fromTitle: string | null, provenance: Provenance): string | null {
  const discovered = provenance.semester ?? null;
  const inferred = provenance.semester_source === "inferred";
  const fromDocument = inferred ? null : discovered;
  const fromSeason = inferred ? discovered : null;
  return fromTitle ?? fromDocument ?? fromSeason ?? null;
}

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 };

function extractTitleInfo(pages: PageExtraction[]) {
  const text = cleanText(pages.flatMap((page) => page.texts.map((item) => item.text)).join(" "));
  const match = TITLE_RE.exec(text);
  if (!match) return { title: null, academicYear: null, semester: null, courseYear: null };
  return {
    title: match[0],
    academicYear: match[1].replace(/\s+/g, ""),
    semester: `Semestrul ${match[3].toUpperCase()}`,
    courseYear: ROMAN[match[2].toUpperCase()] ?? null,
  };
}
