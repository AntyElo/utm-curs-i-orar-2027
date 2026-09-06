import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildGrid, mergeSegments } from "@/lib/parser/geometry";
import { buildCells, rowsCoveredBy, groupsCoveredBy } from "@/lib/parser/cell-builder";
import { classifyType, isRoom, isTeacher, isVenue, segmentLines } from "@/lib/parser/lesson-interpreter";
import { normalizeRoom, normalizeSubgroup, normalizeTeacher, normalizeTime } from "@/lib/parser/normalizer";
import { resolveSubjectAlias } from "@/lib/parser/subject-aliases";
import { extractPages, type PageExtraction } from "@/lib/parser/pdf-extract";
import { detectDays, detectGroups, detectLayout, detectSlotRows } from "@/lib/parser/table-detector";
import { validateSchedule } from "@/lib/parser/validator";
import { parsePdf, sha256, type ParseArtifacts } from "@/lib/parser";
import type { Grid } from "@/lib/parser/geometry";

const FIXTURE = path.join(__dirname, "fixtures", "anul_i_semestrul_ii-1.pdf");
const SEED = path.join(__dirname, "..", "data", "seed", "anul_i_semestrul_i-9.pdf");
const SEED_ANUL_II = path.join(__dirname, "..", "data", "seed", "anul_ii_semestrul_iii-8.pdf");
const REGRESSION = path.join(__dirname, "fixtures", "expected-spring-2026.json");
const SEED_HASH = "52e7f14be27a996e17d0614c1f9fe769d63bdf76876fce6d4fc60f026bf8c015";

const provenance = {
  source_page_url: "https://fcim.utm.md/procesul-de-studii/orar/",
  source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/03/anul_i_semestrul_ii-1.pdf",
  source_kind: "manual" as const,
  downloaded_at: "2026-01-01T00:00:00.000Z",
};

let pdfBytes: Uint8Array;
let page: PageExtraction;
let grid: Grid;
let artifacts: ParseArtifacts;
let seedBytes: Uint8Array;
let seedArtifacts: ParseArtifacts;
let seedBytesAnulII: Uint8Array;
let seedArtifactsAnulII: ParseArtifacts;

beforeAll(async () => {
  const [fixtureBytes, bundledBytes, bundledAnulIIBytes] = await Promise.all([
    readFile(FIXTURE),
    readFile(SEED),
    readFile(SEED_ANUL_II),
  ]);
  pdfBytes = new Uint8Array(fixtureBytes);
  seedBytes = new Uint8Array(bundledBytes);
  seedBytesAnulII = new Uint8Array(bundledAnulIIBytes);
  [page] = await extractPages(pdfBytes);
  grid = buildGrid(page.rects);
  [artifacts, seedArtifacts, seedArtifactsAnulII] = await Promise.all([
    parsePdf(pdfBytes, provenance),
    parsePdf(seedBytes, {
      ...provenance,
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf",
      source_kind: "seed",
      course_year: 1,
    }),
    parsePdf(seedBytesAnulII, {
      ...provenance,
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-8.pdf",
      source_kind: "seed",
      course_year: 2,
    }),
  ]);
});

/**
 * Pick one lesson out of the seed schedule. The lesson id is a hash of the cell's text and
 * position, so it is too brittle to select by; day + slot + group + raw text names the same
 * lesson for as long as the PDF prints it.
 */
function seedLesson(day: string, startTime: string, group: string, rawText: string) {
  const found = seedArtifacts.schedule.lessons.filter(
    (lesson) =>
      lesson.day === day && lesson.start_time === startTime && lesson.groups.includes(group) && lesson.raw_text === rawText,
  );
  expect(found, `${day} ${startTime} ${group} ${rawText}`).toHaveLength(1);
  return found[0];
}

describe("pdf extraction", () => {
  it("extracts positioned text and grid rectangles", () => {
    expect(page.texts.length).toBeGreaterThan(1000);
    expect(grid.vertical.length).toBeGreaterThan(30);
    expect(grid.horizontal.length).toBeGreaterThan(30);
  });
});

describe("grid reconstruction", () => {
  it("keeps the gap a merged cell leaves in a column border", () => {
    // The border of the column is drawn above and below the merged cell only; a stray
    // collinear rectangle must not bridge that gap, or the merged cell disappears.
    const lines = mergeSegments([
      { at: 100, from: 80, to: 116 },
      { at: 100, from: 134, to: 203 },
      { at: 100.1, from: 62, to: 80 },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0].from).toBeCloseTo(62);
    expect(lines[0].to).toBeCloseTo(116);
    expect(lines[1].from).toBeCloseTo(134);
    expect(lines[1].to).toBeCloseTo(203);
  });

  it("merges rectangles that paint one border a fraction of a point apart", () => {
    const lines = mergeSegments([
      { at: 52, from: 60, to: 720 },
      { at: 52.5, from: 60, to: 300 },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].from).toBeCloseTo(60);
    expect(lines[0].to).toBeCloseTo(720);
  });
});

describe("test_group_detection", () => {
  it("finds every group column from the header row without a hard-coded list", () => {
    const groups = detectGroups(page.texts, grid);
    expect(groups.length).toBe(35);
    expect(groups.map((g) => g.name)).toContain("TI-251");
    expect(groups.map((g) => g.name)).toContain("FAF-253");
    expect(groups.map((g) => g.name)).toContain("IBM-251");
    // Columns are contiguous and ordered left → right.
    for (let i = 1; i < groups.length; i += 1) {
      expect(groups[i].x0).toBeGreaterThanOrEqual(groups[i - 1].x1 - 0.5);
    }
  });
});

describe("test_day_detection", () => {
  it("detects the five working days as vertically ordered blocks", () => {
    const groups = detectGroups(page.texts, grid);
    const days = detectDays(page.texts, grid, groups);
    expect(days.map((d) => d.day)).toEqual(["Luni", "Marți", "Miercuri", "Joi", "Vineri"]);
    for (let i = 1; i < days.length; i += 1) expect(days[i].y0).toBeGreaterThanOrEqual(days[i - 1].y1 - 1);
  });
});

describe("test_time_slot_detection", () => {
  it("detects 7 slots per day with normalised HH:MM times", () => {
    const layout = detectLayout(page.texts, grid);
    const rows = detectSlotRows(page.texts, grid, layout.groups, layout.days);
    expect(rows.length).toBe(35);
    const luni = rows.filter((row) => row.day === "Luni").map((row) => `${row.start_time}-${row.end_time}`);
    expect(luni).toEqual(["08:00-09:30", "09:45-11:15", "11:30-13:00", "13:30-15:00", "15:15-16:45", "17:00-18:30", "18:45-20:15"]);
  });
});

describe("test_merged_cell_assignment", () => {
  it("assigns a lecture spanning several columns to all covered groups", () => {
    const layout = detectLayout(page.texts, grid);
    const { cells } = buildCells(page.texts, grid, layout, 1);
    const merged = cells.find((cell) => cell.lines[0]?.startsWith("c. Matematica Discretă și Probabilitatea Statistică"));
    expect(merged).toBeDefined();
    expect(merged!.groups.length).toBeGreaterThanOrEqual(8);
    expect(merged!.groups.slice(0, 5)).toEqual(["TI-251", "TI-252", "TI-253", "TI-254", "TI-255"]);
  });

  it("resolves colspan/rowspan purely from rectangle overlap", () => {
    const layout = detectLayout(page.texts, grid);
    const [first, second] = layout.groups;
    const twoColumns = groupsCoveredBy({ x0: first.x0, x1: second.x1, y0: 0, y1: 1 }, layout);
    expect(twoColumns).toEqual([first.name, second.name]);
    const luniRows = layout.rows.filter((row) => row.day === "Luni");
    const tall = rowsCoveredBy({ x0: 0, x1: 1, y0: luniRows[0].y0, y1: luniRows[1].y1 }, layout.rows);
    expect(tall.map((row) => row.start_time)).toEqual(["08:00", "09:45"]);
  });

  it("maps half-height cells to odd/even weeks", () => {
    const parities = new Set(artifacts.schedule.lessons.map((lesson) => lesson.week_parity));
    expect(parities.has("odd")).toBe(true);
    expect(parities.has("even")).toBe(true);
    expect(parities.has("both")).toBe(true);
  });
});

describe("test_schedule_normalization", () => {
  it("normalises times, teachers, rooms and subgroups", () => {
    expect(normalizeTime("8.00")).toBe("08:00");
    expect(normalizeTime("18:45")).toBe("18:45");
    expect(normalizeTeacher("Cuciuc V")).toBe("Cuciuc V.");
    expect(normalizeTeacher("Prozor-Barbalat l.")).toBe("Prozor-Barbalat L.");
    expect(normalizeRoom("D 01-03")).toBe("D01-03");
    expect(normalizeRoom("5 - 114")).toBe("5-114");
    expect(normalizeSubgroup("0,5 gr.")).toBe("0.5 gr.");
    expect(normalizeSubgroup("05,gr.")).toBe("0.5 gr.");
  });

  it("classifies line roles and splits stacked lessons", () => {
    expect(isRoom("606")).toBe(true);
    expect(isRoom("3-3")).toBe(true);
    expect(isRoom("D01-03")).toBe(true);
    expect(isRoom("A1")).toBe(false);
    // Two rooms for the two subgroups of one lesson.
    expect(isRoom("D02/04")).toBe(true);
    expect(isRoom("110/112")).toBe(true);
    expect(isRoom("301-304")).toBe(true);
    expect(isRoom("D-01 / D-03")).toBe(true);
    expect(isVenue("3-3 Amdaris")).toBe(true);
    expect(isVenue("Aula 6-2 Henri Coanda")).toBe(true);
    expect(isVenue("Sala sportiva")).toBe(true);
    expect(isVenue("Analiza Matematica")).toBe(false);
    expect(isTeacher("Costaș A.")).toBe(true);
    expect(isTeacher("Ceban Gh.")).toBe(true);
    expect(isTeacher("Analiza Matematică")).toBe(false);
    expect(isTeacher("Lab BB")).toBe(false);

    const segments = segmentLines(["L. Engleză", "Tintiuc C.", "606", "L. engleză A1", "Prozor-Barbalat L.", "611"]);
    expect(segments).toHaveLength(2);
    expect(segments[1].room).toBe("611");

    const half = segmentLines(["0,5 gr.", "RC", "Dubciuc D.", "215"]);
    expect(half).toHaveLength(1);
    expect(half[0].subgroup).toBe("0.5 gr.");

    // One lesson in two rooms, and an auditorium named after its patron: both used to
    // be split off into a second, subject-less lesson.
    const twoRooms = segmentLines(["L. Engleză", "720", "601"]);
    expect(twoRooms).toHaveLength(1);
    expect(twoRooms[0].room).toBe("720/601");
    const named = segmentLines(["c. Analiza Matematică", "Costaș A.", "3-3 Amdaris"]);
    expect(named).toHaveLength(1);
    expect(named[0].teacher).toBe("Costaș A.");
    expect(named[0].room).toBe("3-3 Amdaris");
    const paired = segmentLines(["Criptografie", "Reșetnicov M.", "D02/04"]);
    expect(paired).toHaveLength(1);
    expect(paired[0].room).toBe("D02/04");

    expect(classifyType("c. Analiza Matematică", null)).toEqual({ type: "lecture", subject: "Analiza Matematică" });
    expect(classifyType("Ed. fizică", null).type).toBe("physical_education");
    expect(classifyType("Educație fizică", null).type).toBe("physical_education");
    expect(classifyType("L. Engleză A1", null).type).toBe("language");
    expect(classifyType("MDPS", null).type).toBe("unknown");
  });
});

describe("teacher recognition", () => {
  it("reads the surname-first spelling and the initial-first one", () => {
    expect(isTeacher("Costaș A.")).toBe(true);
    expect(isTeacher("Ceban Gh.")).toBe(true);
    expect(isTeacher("Prozor-Barbalat L.")).toBe(true);
    expect(isTeacher("P. Russu")).toBe(true);
    expect(isTeacher("P.Russu")).toBe(true);
  });

  it("keeps abbreviated subjects out of the teacher field", () => {
    // "initial + word" is how this timetable abbreviates subjects far more often than it
    // names a teacher, so those initials must not open the initial-first form.
    expect(isTeacher("L. Engleză")).toBe(false);
    expect(isTeacher("L. Română")).toBe(false);
    expect(isTeacher("L.Engleză")).toBe(false);
    expect(isTeacher("T. Web")).toBe(false);
    expect(isTeacher("Ed. Fizică")).toBe(false);
    expect(isTeacher("c. Fizica")).toBe(false);
    expect(isTeacher("C. Fizica")).toBe(false);
    expect(isTeacher("C. Criptografie")).toBe(false);
  });

  it("canonicalises the space the PDF drops after the initial", () => {
    expect(normalizeTeacher("P.Russu")).toBe("P. Russu");
    expect(normalizeTeacher("P. Russu")).toBe("P. Russu");
    // The surname-first spellings keep the order the PDF prints.
    expect(normalizeTeacher("Costaș A.")).toBe("Costaș A.");
    expect(normalizeTeacher("Ceban Gh.")).toBe("Ceban Gh.");
  });

  it("splits the initial-first teacher off its subject line", () => {
    const segments = segmentLines(["ESU", "P. Russu", "401"]);
    expect(segments).toHaveLength(1);
    expect(segments[0].teacher).toBe("P. Russu");
    expect(segments[0].room).toBe("401");
    expect(segments[0].subjectLines).toEqual(["ESU"]);
  });
});

describe("subject aliases", () => {
  it("expands the abbreviations UTM uses in the grid", () => {
    expect(resolveSubjectAlias("AM")).toBe("Analiza matematică");
    expect(resolveSubjectAlias("ALGA")).toBe("Algebra liniară și geometria analitică");
    expect(resolveSubjectAlias("PC")).toBe("Programarea calculatoarelor");
    expect(resolveSubjectAlias("TP")).toBe("Tehnici de programare");
    expect(resolveSubjectAlias("TPA")).toBe("Tehnici de programare aplicată");
    expect(resolveSubjectAlias("CDE")).toBe("Circuite și dispozitive electronice");
    expect(resolveSubjectAlias("ICPP")).toBe("Ingineria calculatoarelor și produse program");
    expect(resolveSubjectAlias("ESU")).toBe("Etică și securitatea umană");
    expect(resolveSubjectAlias("EIA")).toBe("Etică și integritate academică");
    expect(resolveSubjectAlias("SSM")).toBe("Securitatea și sănătatea în muncă");
    expect(resolveSubjectAlias("SSM.")).toBe("Securitatea și sănătatea în muncă");
    expect(resolveSubjectAlias("MD")).toBe("Matematica discretă");
    expect(resolveSubjectAlias("ÎS")).toBe("Introducere în specialitate");
  });

  it("expands the two abbreviations this timetable misspells", () => {
    expect(resolveSubjectAlias("ESM")).toBe("Etică și securitatea umană");
    expect(resolveSubjectAlias("SMM")).toBe("Securitatea și sănătatea în muncă");
  });

  it("expands EA only where it is the subject, not the speciality code", () => {
    expect(resolveSubjectAlias("EA", ["FAF-261"])).toBe("Engleza în afaceri");
    expect(resolveSubjectAlias("EA", ["EA-261", "EA-262"])).toBe("EA");
    expect(resolveSubjectAlias("EA")).toBe("EA");
  });

  it("leaves anything it was not told about exactly as printed", () => {
    expect(resolveSubjectAlias("XYZ")).toBe("XYZ");
    // Abbreviations nobody confirmed keep their abbreviation rather than a guessed name.
    expect(resolveSubjectAlias("MDPS")).toBe("MDPS");
    expect(resolveSubjectAlias("RC")).toBe("RC");
    // Already-full names pass through untouched.
    expect(resolveSubjectAlias("Analiza matematică")).toBe("Analiza matematică");
    expect(resolveSubjectAlias("Programarea calculatoarelor")).toBe("Programarea calculatoarelor");
    // Whole-subject match only: an alias that happens to sit inside another string is not one.
    expect(resolveSubjectAlias("Amdaris")).toBe("Amdaris");
    expect(resolveSubjectAlias("PCAS Gavrilița M., Cazacu C.")).toBe("PCAS Gavrilița M., Cazacu C.");
  });
});

describe("test_parser_validation", () => {
  it("accepts the real PDF and rejects suspicious drops", () => {
    const ok = validateSchedule(artifacts.schedule, { previousLessonCount: 400 });
    expect(ok.ok).toBe(true);
    const suspicious = validateSchedule({ ...artifacts.schedule, lessons: artifacts.schedule.lessons.slice(0, 40) }, { previousLessonCount: 442 });
    expect(suspicious.ok).toBe(false);
    expect(suspicious.errors.join(" ")).toMatch(/dropped/);
    const noDays = validateSchedule({ ...artifacts.schedule, days: ["Luni"] });
    expect(noDays.errors.join(" ")).toMatch(/missing day/);
  });

  it("produces lessons with valid times and at least one group", () => {
    for (const lesson of artifacts.schedule.lessons) {
      expect(lesson.groups.length).toBeGreaterThan(0);
      expect(lesson.start_time < lesson.end_time).toBe(true);
    }
  });
});

describe("semester provenance precedence", () => {
  /**
   * The autumn row on the schedule page is labelled by season only, so discovery has to
   * infer the semester number from the course year. The document itself states it, and a
   * document always describes itself better than the page that links to it.
   */
  it("keeps the semester printed in the PDF over a conflicting inferred one", async () => {
    const { schedule } = await parsePdf(pdfBytes, {
      ...provenance,
      academic_year: "2026/2027",
      semester: "Semestrul I",
      semester_source: "inferred",
    });
    expect(schedule.metadata.pdf_title).toBe("ANUL UNIVERSITAR 2025/2026, ANUL I, SEMESTRUL II");
    expect(schedule.metadata.semester).toBe("Semestrul II");
    expect(schedule.metadata.academic_year).toBe("2025/2026");
    expect(schedule.metadata.course_year).toBe(1);
  });

  it("keeps the semester printed in the PDF over a conflicting explicit one", async () => {
    const { schedule } = await parsePdf(pdfBytes, {
      ...provenance,
      semester: "Semestrul IV",
      semester_source: "explicit",
    });
    expect(schedule.metadata.semester).toBe("Semestrul II");
  });
});

describe("test_merged_lectures_reach_every_group", () => {
  it("hands the lecture drawn across a block of columns to every one of those groups", () => {
    const { schedule } = seedArtifacts;
    const lecture = schedule.lessons.find(
      (lesson) => lesson.day === "Luni" && lesson.start_time === "11:30" && lesson.groups.includes("SI-261"),
    );
    expect(lecture).toBeDefined();
    expect(lecture!.subject).toBe("Analiza Matematică");
    expect(lecture!.lesson_type).toBe("lecture");
    expect(lecture!.teacher).toBe("Costaș A.");
    expect(lecture!.groups).toEqual(["SI-261", "SI-262", "SI-263", "SI-264", "SI-265", "SI-266"]);

    // A merged cell is only recognisable by the borders its columns do *not* draw, so a
    // grid that bridged those gaps left most groups without a single lecture.
    for (const group of schedule.groups) {
      const own = schedule.lessons.filter((lesson) => lesson.groups.includes(group.name));
      expect(own.length, group.name).toBeGreaterThanOrEqual(15);
      expect(own.some((lesson) => lesson.lesson_type === "lecture"), group.name).toBe(true);
    }
    expect(schedule.lessons.filter((lesson) => lesson.uncertain)).toHaveLength(0);
  });

  it("reads the room a lesson shares, the named auditorium and sports hall", () => {
    const { schedule } = seedArtifacts;
    const byRaw = (raw: string) => schedule.lessons.find((lesson) => lesson.raw_text === raw);

    const split = byRaw("Criptografie | Reșetnicov M. | D02/04");
    expect(split).toMatchObject({ subject: "Criptografie", teacher: "Reșetnicov M.", room: "D02/04", uncertain: false });

    const patron = byRaw("c. Tehnici de Programare | Roșca V. | 3-3 Amdaris");
    expect(patron).toMatchObject({ subject: "Tehnici de Programare", room: "3-3 Amdaris", lesson_type: "lecture" });

    const sports = byRaw("Educație fizică | Sala sportivă");
    expect(sports).toMatchObject({ lesson_type: "physical_education", room: "Sala sportivă", uncertain: false });
  });
});

describe("autumn 2026 packaged-seed regression", () => {
  it("parses and validates the verified -9.pdf fixture", () => {
    const { schedule } = seedArtifacts;
    expect(sha256(seedBytes)).toBe(SEED_HASH);
    expect(schedule.metadata.source_pdf_hash).toBe(SEED_HASH);
    expect(schedule.metadata.source_pdf_url).toMatch(/anul_i_semestrul_i-9\.pdf$/);
    expect(schedule.groups).toHaveLength(41);
    expect(schedule.lessons).toHaveLength(449);
    expect(schedule.lessons.filter((lesson) => lesson.uncertain)).toHaveLength(0);
    expect(validateSchedule(schedule).ok).toBe(true);
  });

  it("reads the teacher this PDF writes initial-first", () => {
    // "ESU | P. Russu | 401" used to leave the teacher glued to the subject, because only
    // the surname-first spelling was recognised.
    const lesson = seedLesson("Marți", "13:30", "IA-261", "ESU | P. Russu | 401");
    expect(lesson).toMatchObject({
      subject: "Etică și securitatea umană",
      teacher: "P. Russu",
      room: "401",
      uncertain: false,
    });
    expect(lesson.groups).toEqual(["IA-261", "IA-262"]);
    expect(lesson.raw_text).toBe("ESU | P. Russu | 401");

    // The same teacher without the space after the initial.
    const noSpace = seedLesson("Joi", "11:30", "IA-261", "ESU | P.Russu | 614");
    expect(noSpace).toMatchObject({ subject: "Etică și securitatea umană", teacher: "P. Russu", room: "614" });

    expect(seedArtifacts.schedule.lessons.filter((lesson) => /Russu/.test(lesson.raw_text))).toHaveLength(8);
    for (const lesson of seedArtifacts.schedule.lessons.filter((l) => /Russu/.test(l.raw_text))) {
      expect(lesson.teacher, lesson.raw_text).toBe("P. Russu");
    }
  });

  it("expands the abbreviated subjects without touching the printed text", () => {
    const cases = [
      { day: "Vineri", time: "11:30", group: "R-262", raw: "AM | Orlov V. | 515", subject: "Analiza matematică", teacher: "Orlov V.", room: "515" },
      { day: "Luni", time: "09:45", group: "SI-261", raw: "ALGA | Stanciu L. | 611", subject: "Algebra liniară și geometria analitică", teacher: "Stanciu L.", room: "611" },
      { day: "Miercuri", time: "08:00", group: "SI-261", raw: "PC | Danilov I. | 628", subject: "Programarea calculatoarelor", teacher: "Danilov I.", room: "628" },
      { day: "Luni", time: "13:30", group: "TI-262", raw: "lab. 0.5 gr. CDE | Litra D. | A03", subject: "Circuite și dispozitive electronice", teacher: "Litra D.", room: "A03" },
    ];
    for (const sample of cases) {
      const lesson = seedLesson(sample.day, sample.time, sample.group, sample.raw);
      expect(lesson.subject, sample.raw).toBe(sample.subject);
      expect(lesson.teacher, sample.raw).toBe(sample.teacher);
      expect(lesson.room, sample.raw).toBe(sample.room);
      expect(lesson.uncertain, sample.raw).toBe(false);
      // The abbreviation is expanded in `subject` only; `raw_text` stays the PDF's own text.
      expect(lesson.raw_text, sample.raw).toBe(sample.raw);
    }
    // The class-type prefix is still stripped and classified before the alias is resolved.
    expect(seedLesson("Luni", "13:30", "TI-262", "lab. 0.5 gr. CDE | Litra D. | A03")).toMatchObject({
      lesson_type: "lab",
      subgroup: "0.5 gr.",
    });

    // Nothing in this timetable is left holding a bare confirmed abbreviation.
    const abbreviations = new Set(["AM", "ALGA", "PC", "TP", "TPA", "CDE", "ICPP", "ESU", "EIA", "SSM", "SSM.", "MD", "ÎS", "ESM", "SMM"]);
    const unexpanded = seedArtifacts.schedule.lessons.filter((lesson) => abbreviations.has(lesson.subject));
    expect(unexpanded.map((lesson) => lesson.raw_text)).toEqual([]);
  });
});

describe("regression fixture", () => {
  it("matches the recorded statistics for the spring 2026 PDF", async () => {
    const expected = JSON.parse(await readFile(REGRESSION, "utf8"));
    const { schedule } = artifacts;
    expect(schedule.metadata.source_pdf_hash).toBe(sha256(pdfBytes));
    expect(schedule.metadata.pdf_title).toBe(expected.title);
    expect(schedule.groups.map((g) => g.name)).toEqual(expected.groups);
    expect(schedule.lessons.length).toBe(expected.lessons);
    expect(schedule.lessons.filter((l) => l.groups.length > 1).length).toBe(expected.merged_lessons);
    expect(schedule.lessons.filter((l) => l.uncertain).length).toBeLessThanOrEqual(expected.max_uncertain);
    const perGroup = Object.fromEntries(schedule.groups.map((g) => [g.name, schedule.lessons.filter((l) => l.groups.includes(g.name)).length]));
    expect(perGroup).toEqual(expected.per_group);
    for (const sample of expected.samples) {
      const found = schedule.lessons.find((l) => l.day === sample.day && l.start_time === sample.start_time && l.groups.includes(sample.group) && l.subject === sample.subject && l.week_parity === sample.week_parity);
      expect(found, JSON.stringify(sample)).toBeDefined();
      expect(found!.teacher).toBe(sample.teacher);
      expect(found!.room).toBe(sample.room);
      expect(found!.lesson_type).toBe(sample.lesson_type);
      expect(found!.week_parity).toBe(sample.week_parity);
      expect(found!.groups.length, JSON.stringify(sample)).toBe(sample.group_count);
    }
  });
});

describe("autumn 2026 packaged-seed course 2 regression", () => {
  it("eliminates phantom MCE lesson and satisfies all cardinality invariants", () => {
    const { schedule } = seedArtifactsAnulII;
    const phantom = schedule.lessons.filter(
      (lesson) =>
        lesson.day === "Marți" &&
        lesson.start_time === "18:45" &&
        /\bMCE\b/i.test(`${lesson.subject} ${lesson.raw_text}`),
    );
    expect(phantom).toHaveLength(0);
    expect(schedule.groups).toHaveLength(26);
    expect(schedule.lessons).toHaveLength(288);
    expect(schedule.lessons.filter((l) => l.groups.length > 1)).toHaveLength(64);
    expect(schedule.lessons.filter((l) => l.uncertain)).toHaveLength(0);
    expect(validateSchedule(schedule).ok).toBe(true);
    expect(schedule.warnings).toEqual([]);
  });

  it("preserves exactly the verified POO blocks at Tuesday 18:45 with no stray groups", () => {
    const { schedule } = seedArtifactsAnulII;
    const tues1845 = schedule.lessons.filter((l) => l.day === "Marți" && l.start_time === "18:45");
    expect(tues1845).toHaveLength(2);

    const ti = tues1845.find((l) => l.groups.includes("TI-251"));
    expect(ti).toBeDefined();
    expect(ti!.groups).toEqual(["TI-251", "TI-252", "TI-253", "TI-254"]);
    expect(ti!.subject).toBe("Programarea Orientată pe Obiecte");
    expect(ti!.teacher).toBe("Gîncu S.");
    expect(ti!.room).toBe("6-2");
    expect(ti!.lesson_type).toBe("lecture");

    const si = tues1845.find((l) => l.groups.includes("SI-251"));
    expect(si).toBeDefined();
    expect(si!.groups).toEqual(["SI-251", "SI-252"]);
    expect(si!.subject).toBe("POO");
    expect(si!.teacher).toBe("Gîncu S.");
    expect(si!.room).toBe("6-2");
    expect(si!.lesson_type).toBe("lecture");

    // No other Anul II group receives any lesson in this slot
    const coveredGroups = new Set(tues1845.flatMap((l) => l.groups));
    expect([...coveredGroups].sort()).toEqual(["SI-251", "SI-252", "TI-251", "TI-252", "TI-253", "TI-254"]);
  });

  it("preserves known-good regression anchors", () => {
    const { schedule } = seedArtifactsAnulII;

    // Large legitimate colspan: Luni 13:30 Matematici Speciale Pricop V. 3-3 Amdaris
    const matSpec = schedule.lessons.find((l) => l.day === "Luni" && l.start_time === "13:30" && l.groups.includes("AI-252"));
    expect(matSpec).toBeDefined();
    expect(matSpec!.subject).toBe("Matematici Speciale");
    expect(matSpec!.teacher).toBe("Pricop V.");
    expect(matSpec!.room).toBe("3-3 Amdaris");
    expect(matSpec!.groups).toEqual(["AI-252", "AI-251", "CR-251", "CR-252", "R-251", "MN-251", "IBM-251"]);

    // Odd half-cell: CR-251 Luni 08:00 Circuite și dispozitive electronice Chiriac M. A03 odd
    const cdeOdd = schedule.lessons.find((l) => l.day === "Luni" && l.start_time === "08:00" && l.groups.includes("CR-251"));
    expect(cdeOdd).toMatchObject({
      subject: "Circuite și dispozitive electronice",
      teacher: "Chiriac M.",
      room: "A03",
      week_parity: "odd",
    });

    // Even half-cell: AI-252 Luni 09:45 TSA Izvoreanu B. 524 even
    const tsaEven = schedule.lessons.find(
      (l) => l.day === "Luni" && l.start_time === "09:45" && l.groups.includes("AI-252") && l.subject === "TSA",
    );
    expect(tsaEven).toMatchObject({
      subject: "TSA",
      teacher: "Izvoreanu B.",
      room: "524",
      week_parity: "even",
    });

    // Multi-slot subgroup lesson: IBM-251 Marți 08:00–11:15 slot_span=2 1) CDE Chiriac M. A03 subgroup=0.5 gr.
    const cdeSub = schedule.lessons.find((l) => l.day === "Marți" && l.start_time === "08:00" && l.groups.includes("IBM-251"));
    expect(cdeSub).toMatchObject({
      subject: "1) CDE",
      teacher: "Chiriac M.",
      room: "A03",
      slot_span: 2,
      subgroup: "0.5 gr.",
    });

    // Normal single-group lesson: AI-252 Miercuri 13:30 CEI Moraru D. 524
    const cei = schedule.lessons.find((l) => l.day === "Miercuri" && l.start_time === "13:30" && l.groups.includes("AI-252"));
    expect(cei).toMatchObject({
      subject: "CEI",
      teacher: "Moraru D.",
      room: "524",
      groups: ["AI-252"],
    });
  });
});
