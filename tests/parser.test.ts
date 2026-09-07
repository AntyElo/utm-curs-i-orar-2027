import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildGrid, mergeSegments } from "@/lib/parser/geometry";
import { buildCells, rowsCoveredBy, groupsCoveredBy } from "@/lib/parser/cell-builder";
import { classifyType, isRoom, isTeacher, isVenue, segmentLines } from "@/lib/parser/lesson-interpreter";
import { normalizeRoom, normalizeSubgroup, normalizeTeacher, normalizeTime, toCanonicalSubjectTitle } from "@/lib/parser/normalizer";
import { resolveSubjectAlias } from "@/lib/parser/subject-aliases";
import { extractPages, type PageExtraction } from "@/lib/parser/pdf-extract";
import { detectDays, detectGroups, detectLayout, detectSlotRows } from "@/lib/parser/table-detector";
import { validateSchedule } from "@/lib/parser/validator";
import { parsePdf, sha256, type ParseArtifacts } from "@/lib/parser";
import type { Grid } from "@/lib/parser/geometry";

const FIXTURE = path.join(__dirname, "fixtures", "anul_i_semestrul_ii-1.pdf");
const SEED = path.join(__dirname, "..", "data", "seed", "anul_i_semestrul_i-18.pdf");
const SEED_ANUL_II = path.join(__dirname, "..", "data", "seed", "anul_ii_semestrul_iii-11.pdf");
const REGRESSION = path.join(__dirname, "fixtures", "expected-spring-2026.json");
/** The seeds these two replaced; kept so the parser is proven unchanged against them. */
const PREVIOUS_SEED_ANUL_I = path.join(__dirname, "fixtures", "anul_i_semestrul_i-9.pdf");
const PREVIOUS_SEED_ANUL_II = path.join(__dirname, "fixtures", "anul_ii_semestrul_iii-8.pdf");
const FIXTURE_ANUL_I_16 = path.join(__dirname, "fixtures", "anul_i_semestrul_i-16.pdf");
const FIXTURE_ANUL_II_10 = path.join(__dirname, "fixtures", "anul_ii_semestrul_iii-10.pdf");
const SEED_HASH = "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a";
const SEED_HASH_ANUL_II = "3728f5ab165b6fe5095609d9aeff54da687c8312ed0ec1e89a9a951807a0a23b";

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
let fixture16Bytes: Uint8Array;
let fixture16Artifacts: ParseArtifacts;

beforeAll(async () => {
  const [fixtureBytes, bundledBytes, bundledAnulIIBytes, f16Bytes] = await Promise.all([
    readFile(FIXTURE),
    readFile(SEED),
    readFile(SEED_ANUL_II),
    readFile(FIXTURE_ANUL_I_16),
  ]);
  pdfBytes = new Uint8Array(fixtureBytes);
  seedBytes = new Uint8Array(bundledBytes);
  seedBytesAnulII = new Uint8Array(bundledAnulIIBytes);
  fixture16Bytes = new Uint8Array(f16Bytes);
  [page] = await extractPages(pdfBytes);
  grid = buildGrid(page.rects);
  [artifacts, seedArtifacts, seedArtifactsAnulII, fixture16Artifacts] = await Promise.all([
    parsePdf(pdfBytes, provenance),
    parsePdf(seedBytes, {
      ...provenance,
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
      source_kind: "seed",
      course_year: 1,
    }),
    parsePdf(seedBytesAnulII, {
      ...provenance,
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-11.pdf",
      source_kind: "seed",
      course_year: 2,
    }),
    parsePdf(fixture16Bytes, {
      ...provenance,
      source_pdf_url: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-16.pdf",
      source_kind: "seed",
      course_year: 1,
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
    expect(classifyType("Lab.PAE", null)).toEqual({ type: "lab", subject: "PAE" });
    expect(classifyType("Lab. PAE", null)).toEqual({ type: "lab", subject: "PAE" });
    expect(classifyType("lab.PAE", null)).toEqual({ type: "lab", subject: "PAE" });
    expect(classifyType("lab. PAE", null)).toEqual({ type: "lab", subject: "PAE" });
    expect(classifyType("labrador", null)).toEqual({ type: "unknown", subject: "labrador" });
  });
});

describe("teacher recognition", () => {
  it("reads the surname-first spelling and the initial-first one", () => {
    expect(isTeacher("Costaș A.")).toBe(true);
    expect(isTeacher("Ceban Gh.")).toBe(true);
    expect(isTeacher("Prozor-Barbalat L.")).toBe(true);
    expect(isTeacher("P. Russu")).toBe(true);
    expect(isTeacher("P.Russu")).toBe(true);
    expect(isTeacher("L. Stanciu")).toBe(true);
    expect(isTeacher("Bîrnaz")).toBe(true);
    expect(isTeacher("BÎrnaz A.")).toBe(true);
    expect(isTeacher("Bostan V.; Cojuhari E.")).toBe(true);
    expect(isTeacher("Bostan V. ; Cojuhari E.")).toBe(true);
    expect(isTeacher("Gavrilița M., Cazacu C., Graur E., Malîi A., Trubca D., Capitan P.")).toBe(true);
  });

  it("keeps abbreviated subjects out of the teacher field while allowing initial-first teachers", () => {
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
    // Arbitrary semicolon or comma prose is rejected
    expect(isTeacher("Proiect; Lucrare")).toBe(false);
    expect(isTeacher("Proiect, Lucrare")).toBe(false);
    expect(isTeacher("Matematică Discretă, Probabilitate Și Statistică Aplicată")).toBe(false);
  });

  it("canonicalises the space the PDF drops after the initial and normalizes teacher variants", () => {
    expect(normalizeTeacher("P.Russu")).toBe("P. Russu");
    expect(normalizeTeacher("P. Russu")).toBe("P. Russu");
    expect(normalizeTeacher("L. Stanciu")).toBe("L. Stanciu");
    expect(normalizeTeacher("Bîrnaz")).toBe("Bîrnaz A.");
    expect(normalizeTeacher("BÎrnaz A.")).toBe("Bîrnaz A.");
    expect(normalizeTeacher("Bostan V. ; Cojuhari E.")).toBe("Bostan V.; Cojuhari E.");
    expect(normalizeTeacher("Gavrilița M., Cazacu C., Graur E., Malîi A., Trubca D., Capitan P.")).toBe(
      "Gavrilița M., Cazacu C., Graur E., Malîi A., Trubca D., Capitan P.",
    );
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

describe("canonical subject title helper", () => {
  it("capitalizes each lexical word while preserving token remainder", () => {
    expect(toCanonicalSubjectTitle("Analiza și proiectarea algoritmilor")).toBe("Analiza Și Proiectarea Algoritmilor");
    expect(toCanonicalSubjectTitle("Programarea orientată pe obiecte")).toBe("Programarea Orientată Pe Obiecte");
    expect(toCanonicalSubjectTitle("Proiectarea asistată de calculator a dispozitivelor medicale")).toBe(
      "Proiectarea Asistată De Calculator A Dispozitivelor Medicale",
    );
    expect(toCanonicalSubjectTitle("TWeb")).toBe("TWeb");
    expect(toCanonicalSubjectTitle("UX/UI")).toBe("UX/UI");
    expect(toCanonicalSubjectTitle("POO")).toBe("POO");
    expect(toCanonicalSubjectTitle("1) CDE")).toBe("1) CDE");
    expect(toCanonicalSubjectTitle("II")).toBe("II");
    expect(toCanonicalSubjectTitle("și")).toBe("Și");
    expect(toCanonicalSubjectTitle("de")).toBe("De");
    expect(toCanonicalSubjectTitle("obiecte")).toBe("Obiecte");
  });

  it("handles Romanian diacritics and function words correctly", () => {
    expect(toCanonicalSubjectTitle("în")).toBe("În");
    expect(toCanonicalSubjectTitle("pe")).toBe("Pe");
    expect(toCanonicalSubjectTitle("a")).toBe("A");
    expect(toCanonicalSubjectTitle("al")).toBe("Al");
    expect(toCanonicalSubjectTitle("de")).toBe("De");
    expect(toCanonicalSubjectTitle("din")).toBe("Din");
    expect(toCanonicalSubjectTitle("cu")).toBe("Cu");
    expect(toCanonicalSubjectTitle("pentru")).toBe("Pentru");
    expect(toCanonicalSubjectTitle("unei")).toBe("Unei");
    expect(toCanonicalSubjectTitle("etică și integritate academică")).toBe("Etică Și Integritate Academică");
    expect(toCanonicalSubjectTitle("activități individuale/ în grup")).toBe("Activități Individuale/ În Grup");
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

  it("expands confirmed Anul II abbreviations", () => {
    expect(resolveSubjectAlias("POO")).toBe("Programarea orientată pe obiecte");
    expect(resolveSubjectAlias("MS")).toBe("Matematici speciale");
    expect(resolveSubjectAlias("APA")).toBe("Analiza și proiectarea algoritmilor");
    expect(resolveSubjectAlias("ASDN")).toBe("Analiza și sinteza dispozitivelor numerice");
    expect(resolveSubjectAlias("ASCS")).toBe("Analiza și specificarea cerințelor software");
    expect(resolveSubjectAlias("BD")).toBe("Baze de date");
    expect(resolveSubjectAlias("BSD")).toBe("Bazele statului și dreptului");
    expect(resolveSubjectAlias("SCC")).toBe("Structuri de calcul și de comunicare");
    expect(resolveSubjectAlias("DEMTPI")).toBe("Dispozitive electronice și mijloace tehnice de protecție a informației");
    expect(resolveSubjectAlias("CEI")).toBe("Circuite electronice integrate");
    expect(resolveSubjectAlias("TSA")).toBe("Teoria sistemelor automate");
    expect(resolveSubjectAlias("DNAC")).toBe("Dispozitive numerice și arhitecturi de calculatoare");
    expect(resolveSubjectAlias("FCS")).toBe("Fizica corpului solid");
    expect(resolveSubjectAlias("ME")).toBe("Măsurări electronice");
    expect(resolveSubjectAlias("PADM")).toBe("Proiectarea asistată de calculator a dispozitivelor medicale");
    expect(resolveSubjectAlias("PAE")).toBe("Proiectarea asistată în electronică");
    expect(resolveSubjectAlias("AFU")).toBe("Anatomia și fiziologia umană");
  });

  it("expands confirmed Anul II spelling and truncation variants", () => {
    expect(resolveSubjectAlias("Progromarea Orientată pe Obiecte")).toBe("Programarea orientată pe obiecte");
    expect(resolveSubjectAlias("Programarea Orientată pe Obiect")).toBe("Programarea orientată pe obiecte");
    expect(resolveSubjectAlias("Filosogie și gândire inginerească")).toBe("Filosofie și gândire inginerească");
    expect(resolveSubjectAlias("DMETPI")).toBe("Dispozitive electronice și mijloace tehnice de protecție a informației");
    expect(resolveSubjectAlias("DMTPI")).toBe("Dispozitive electronice și mijloace tehnice de protecție a informației");
    expect(resolveSubjectAlias("DAAC")).toBe("Dispozitive numerice și arhitecturi de calculatoare");
    expect(resolveSubjectAlias("AFV")).toBe("Anatomia și fiziologia umană");
    expect(resolveSubjectAlias("Dispoz. ElecT. MTPI")).toBe("Dispozitive electronice și mijloace tehnice de protecție a informației");
    expect(resolveSubjectAlias("Struct. Calc. și Comun.")).toBe("Structuri de calcul și de comunicare");
    expect(resolveSubjectAlias("Măsurări Electr.")).toBe("Măsurări electronice");
    expect(resolveSubjectAlias("Analiza și Specif. Software")).toBe("Analiza și specificarea cerințelor software");
    expect(resolveSubjectAlias("Filosofia GC")).toBe("Filosofie și gândire critică");
    expect(resolveSubjectAlias("Filosofie GC")).toBe("Filosofie și gândire critică");
    expect(resolveSubjectAlias("Filosofia GI")).toBe("Filosofie și gândire inginerească");
    expect(resolveSubjectAlias("Filosofie GI")).toBe("Filosofie și gândire inginerească");
    expect(resolveSubjectAlias("Filosofie și gand. ing.")).toBe("Filosofie și gândire inginerească");
  });

  it("expands confirmed RC alias", () => {
    expect(resolveSubjectAlias("RC")).toBe("Rețele de calculatoare");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("RC"))).toBe("Rețele De Calculatoare");
  });

  it("expands confirmed Tehnici de pogramare aplicată typo variant", () => {
    expect(resolveSubjectAlias("Tehnici de pogramare aplicată")).toBe("Tehnici de programare aplicată");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Tehnici de pogramare aplicată"))).toBe("Tehnici De Programare Aplicată");
  });

  it("expands confirmed MDPS alias to canonical title case", () => {
    expect(resolveSubjectAlias("MDPS")).toBe("Matematică discretă, probabilitate și statistică aplicată");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("MDPS"))).toBe("Matematică Discretă, Probabilitate Și Statistică Aplicată");
  });

  it("expands decorated aliases preserving decorations around confirmed alias cores", () => {
    expect(resolveSubjectAlias("PAE 1/l")).toBe("Proiectarea asistată în electronică 1/l");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("PAE 1/l"))).toBe("Proiectarea Asistată În Electronică 1/l");

    expect(resolveSubjectAlias("PAE 1/e")).toBe("Proiectarea asistată în electronică 1/e");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("PAE 1/e"))).toBe("Proiectarea Asistată În Electronică 1/e");

    expect(resolveSubjectAlias("PADM 1/l")).toBe("Proiectarea asistată de calculator a dispozitivelor medicale 1/l");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("PADM 1/l"))).toBe("Proiectarea Asistată De Calculator A Dispozitivelor Medicale 1/l");

    expect(resolveSubjectAlias("PADM 1/e")).toBe("Proiectarea asistată de calculator a dispozitivelor medicale 1/e");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("PADM 1/e"))).toBe("Proiectarea Asistată De Calculator A Dispozitivelor Medicale 1/e");

    expect(resolveSubjectAlias("1) CDE")).toBe("1) Circuite și dispozitive electronice");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("1) CDE"))).toBe("1) Circuite Și Dispozitive Electronice");

    expect(resolveSubjectAlias("2) MS")).toBe("2) Matematici speciale");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("2) MS"))).toBe("2) Matematici Speciale");

    // Non-alias cores are not expanded
    expect(resolveSubjectAlias("A-CDE-X")).toBe("A-CDE-X");
    expect(resolveSubjectAlias("Chimie 1/l")).toBe("Chimie 1/l");
  });

  it("expands confirmed language abbreviation aliases", () => {
    expect(resolveSubjectAlias("L. Engleză")).toBe("Limba engleză");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("L. Engleză"))).toBe("Limba Engleză");

    expect(resolveSubjectAlias("L. Română")).toBe("Limba română");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("L. Română"))).toBe("Limba Română");

    expect(resolveSubjectAlias("L. Străină")).toBe("Limba străină");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("L. Străină"))).toBe("Limba Străină");

    expect(resolveSubjectAlias("L. Engleză 1")).toBe("Limba engleză");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("L. Engleză 1"))).toBe("Limba Engleză");

    expect(resolveSubjectAlias("L.Engleza 1")).toBe("Limba engleză");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("L.Engleza 1"))).toBe("Limba Engleză");

    expect(resolveSubjectAlias("Limba Engleză 1")).toBe("Limba engleză");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Limba Engleză 1"))).toBe("Limba Engleză");

    expect(resolveSubjectAlias("L. Engleză A1")).toBe("Limba engleză A1");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("L. Engleză A1"))).toBe("Limba Engleză A1");

    expect(resolveSubjectAlias("L.Rom")).toBe("Limba română");
    expect(resolveSubjectAlias("L. Rom.")).toBe("Limba română");
  });

  it("expands confirmed SCS typo to Structuri de calcul și de comunicare", () => {
    expect(resolveSubjectAlias("SCS")).toBe("Structuri de calcul și de comunicare");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("SCS"))).toBe("Structuri De Calcul Și De Comunicare");
  });

  it("expands embedded SI subject abbreviation Cadrul Legal al SI without adding global SI alias", () => {
    expect(resolveSubjectAlias("Cadrul Legal al SI")).toBe("Cadrul Legal al Securității Informaționale");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Cadrul Legal al SI"))).toBe("Cadrul Legal Al Securității Informaționale");
    expect(resolveSubjectAlias("Cadrul legal al SI")).toBe("Cadrul Legal al Securității Informaționale");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Cadrul legal al SI"))).toBe("Cadrul Legal Al Securității Informaționale");

    // Bare SI is never expanded globally (it is a speciality / group code)
    expect(resolveSubjectAlias("SI")).toBe("SI");
  });

  it("resolves Filosofia și Gândire/Gândirea Critică variants and GC abbreviations to Filosofie Și Gândire Critică", () => {
    expect(resolveSubjectAlias("Filosofia GC")).toBe("Filosofie și gândire critică");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Filosofia GC"))).toBe("Filosofie Și Gândire Critică");

    expect(resolveSubjectAlias("Filosofie GC")).toBe("Filosofie și gândire critică");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Filosofie GC"))).toBe("Filosofie Și Gândire Critică");

    expect(resolveSubjectAlias("Filosofia și Gândire Critică")).toBe("Filosofie și gândire critică");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Filosofia și Gândire Critică"))).toBe("Filosofie Și Gândire Critică");

    expect(resolveSubjectAlias("Filosofia și Gândirea Critică")).toBe("Filosofie și gândire critică");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Filosofia și Gândirea Critică"))).toBe("Filosofie Și Gândire Critică");
  });

  it("resolves confirmed whole-subject canonical mappings (cases 1-9)", () => {
    // 1. Dreptul de Proprietate Intelectuală → Dreptul Proprietății Intelectuale
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Dreptul de Proprietate Intelectuală"))).toBe("Dreptul Proprietății Intelectuale");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Dreptul de proprietate intelectuală"))).toBe("Dreptul Proprietății Intelectuale");

    // 2. Proiectarea Conceptelor AS → Proiectarea Conceptuală A Unei Aplicații Software
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Proiectarea Conceptelor AS"))).toBe("Proiectarea Conceptuală A Unei Aplicații Software");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Proiectarea conceptelor AS"))).toBe("Proiectarea Conceptuală A Unei Aplicații Software");

    // 3. Circuite și Dispozitive Electrice → Circuite Și Dispozitive Electronice
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Circuite și Dispozitive Electrice"))).toBe("Circuite Și Dispozitive Electronice");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Circuite și dispozitive electrice"))).toBe("Circuite Și Dispozitive Electronice");

    // 4. Ed. Fizică → Educație Fizică
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Ed. Fizică"))).toBe("Educație Fizică");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Ed. fizică"))).toBe("Educație Fizică");

    // 5. Fizica → Fizică
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Fizica"))).toBe("Fizică");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("fizica"))).toBe("Fizică");

    // 6. Algebră Liniară și Geometrie Analitică → Algebra Liniară Și Geometria Analitică
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Algebră Liniară și Geometrie Analitică"))).toBe("Algebra Liniară Și Geometria Analitică");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Algebră liniară și geometrie analitică"))).toBe("Algebra Liniară Și Geometria Analitică");

    // 7. Etica și Integritatea Academică → Etică Și Integritate Academică
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Etica și Integritatea Academică"))).toBe("Etică Și Integritate Academică");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Etica și integritatea academică"))).toBe("Etică Și Integritate Academică");

    // 8. Security/ethics variants → Etică Și Securitatea Umană
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Etica și Securitate Umană"))).toBe("Etică Și Securitatea Umană");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Etica și securitate umană"))).toBe("Etică Și Securitatea Umană");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Etică și Securitate Umană"))).toBe("Etică Și Securitatea Umană");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Etică și securitate umană"))).toBe("Etică Și Securitatea Umană");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Etica și Securitatea Umană"))).toBe("Etică Și Securitatea Umană");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Etica și securitatea umană"))).toBe("Etică Și Securitatea Umană");

    // 9. Formatting normalization
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Activități Individuale/ În Grup"))).toBe("Activități Individuale/În Grup");
    expect(toCanonicalSubjectTitle(resolveSubjectAlias("Activități individuale/ în grup"))).toBe("Activități Individuale/În Grup");
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

    const patron = byRaw("c. Analiza Matematică | Costaș A. | 3-3 Amdaris");
    expect(patron).toMatchObject({ subject: "Analiza Matematică", room: "3-3 Amdaris", lesson_type: "lecture" });

    const sports = byRaw("Educație fizică | Sala sportivă");
    expect(sports).toMatchObject({ lesson_type: "physical_education", room: "Sala sportivă", uncertain: false });
  });
});

describe("autumn 2026 packaged-seed regression", () => {
  it("parses and validates the verified -18.pdf seed", () => {
    const { schedule } = seedArtifacts;
    expect(sha256(seedBytes)).toBe(SEED_HASH);
    expect(schedule.metadata.source_pdf_hash).toBe(SEED_HASH);
    expect(schedule.metadata.source_pdf_url).toMatch(/anul_i_semestrul_i-18\.pdf$/);
    expect(schedule.groups).toHaveLength(41);
    expect(schedule.lessons).toHaveLength(452);
    expect(schedule.lessons.filter((lesson) => lesson.uncertain)).toHaveLength(0);
    expect(validateSchedule(schedule).ok).toBe(true);
    expect(validateSchedule(schedule).warnings).toEqual([]);
  });

  it("reads the teacher this PDF writes initial-first", () => {
    // "ESU | P. Russu | 401" used to leave the teacher glued to the subject, because only
    // the surname-first spelling was recognised.
    const lesson = seedLesson("Marți", "13:30", "IA-261", "ESU | P. Russu | 401");
    expect(lesson).toMatchObject({
      subject: "Etică Și Securitatea Umană",
      teacher: "P. Russu",
      room: "401",
      uncertain: false,
    });
    expect(lesson.groups).toEqual(["IA-261", "IA-262"]);
    expect(lesson.raw_text).toBe("ESU | P. Russu | 401");

    // The same teacher without the space after the initial.
    const noSpace = seedLesson("Joi", "11:30", "IA-261", "ESU | P.Russu | 614");
    expect(noSpace).toMatchObject({ subject: "Etică Și Securitatea Umană", teacher: "P. Russu", room: "614" });

    expect(seedArtifacts.schedule.lessons.filter((lesson) => /Russu/.test(lesson.raw_text))).toHaveLength(8);
    for (const lesson of seedArtifacts.schedule.lessons.filter((l) => /Russu/.test(l.raw_text))) {
      expect(lesson.teacher, lesson.raw_text).toBe("P. Russu");
    }
  });

  it("expands the abbreviated subjects without touching the printed text", () => {
    const cases = [
      { day: "Vineri", time: "11:30", group: "R-262", raw: "AM | Orlov V. | 515", subject: "Analiza Matematică", teacher: "Orlov V.", room: "515" },
      { day: "Luni", time: "09:45", group: "SI-261", raw: "ALGA | Stanciu L. | 611", subject: "Algebra Liniară Și Geometria Analitică", teacher: "Stanciu L.", room: "611" },
      { day: "Miercuri", time: "08:00", group: "SI-261", raw: "PC | Danilov I. | 628", subject: "Programarea Calculatoarelor", teacher: "Danilov I.", room: "628" },
      { day: "Luni", time: "13:30", group: "TI-262", raw: "lab. 0.5 gr. CDE | Litra D. | A03", subject: "Circuite Și Dispozitive Electronice", teacher: "Litra D.", room: "A03" },
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

  it("resolves the Tehnici de pogramare aplicată typo to canonical subject while raw_text preserves the source typo", () => {
    const typoLessons = seedArtifacts.schedule.lessons.filter((l) => l.raw_text.includes("pogramare"));
    expect(typoLessons).toHaveLength(2);
    for (const lesson of typoLessons) {
      expect(lesson.subject).toBe("Tehnici De Programare Aplicată");
      expect(lesson.raw_text).toContain("pogramare");
    }
  });
});

describe("autumn 2026 Anul II packaged-seed regression", () => {
  it("parses and validates the verified -11.pdf seed", () => {
    const { schedule } = seedArtifactsAnulII;
    expect(sha256(seedBytesAnulII)).toBe(SEED_HASH_ANUL_II);
    expect(schedule.metadata.source_pdf_hash).toBe(SEED_HASH_ANUL_II);
    expect(schedule.metadata.source_pdf_url).toMatch(/anul_ii_semestrul_iii-11\.pdf$/);
    expect(schedule.groups).toHaveLength(26);
    expect(schedule.lessons).toHaveLength(288);
    expect(schedule.lessons.filter((lesson) => lesson.uncertain)).toHaveLength(0);
    expect(seedArtifactsAnulII.border_repairs).toHaveLength(0);
    expect(validateSchedule(schedule).ok).toBe(true);
    expect(validateSchedule(schedule).warnings).toEqual([]);
  });
});

/**
 * anul_i_semestrul_i-16.pdf clips the top of the TI-263 | IA-261 column border inside the
 * Vineri 11:30 row: it is drawn above the row and again from 632.45 down, but the ~5.9 pt
 * stub at the row's top edge is missing. The first printed line of both cells therefore found
 * no border between the columns and was reconstructed as one box spanning both, which
 * `dropEngulfingCells` demoted to an orphan – losing the subject of two real lessons.
 */
describe("clipped column border in the Anul I -16 fixture", () => {
  it("restores exactly one border, in the row that is actually damaged", () => {
    const repairs = fixture16Artifacts.border_repairs;
    expect(repairs).toHaveLength(1);
    expect(repairs[0].day).toBe("Vineri");
    expect(repairs[0].start_time).toBe("11:30");
    // The TI-263 | IA-261 column boundary, not an arbitrary vertical gap.
    expect(repairs[0].x).toBeCloseTo(433.6, 1);
    expect(repairs[0].gap).toBeLessThan(6);
    expect(repairs[0].kind).toBe("top_stub");
    expect(fixture16Artifacts.orphans).toHaveLength(0);
    expect(fixture16Artifacts.schedule.warnings).toEqual([]);
  });

  it("reads TI-263 Vineri 11:30 as a lesson instead of a bare venue", () => {
    const lesson = fixture16Artifacts.schedule.lessons.find(
      (l) => l.day === "Vineri" && l.start_time === "11:30" && l.groups.includes("TI-263") && l.raw_text.includes("Ed. Fizică"),
    );
    expect(lesson).toBeDefined();
    expect(lesson).toMatchObject({
      subject: "Educație Fizică",
      teacher: null,
      room: "Sala sportivă",
      lesson_type: "physical_education",
      week_parity: "odd",
      uncertain: false,
    });
    expect(lesson!.groups).toEqual(["TI-263"]);
    expect(lesson!.raw_text).toBe("Ed. Fizică | Sala sportivă");
  });

  it("reads IA-261 Vineri 11:30 as a lesson instead of a teacher and a room", () => {
    const lesson = fixture16Artifacts.schedule.lessons.find(
      (l) => l.day === "Vineri" && l.start_time === "11:30" && l.groups.includes("IA-261") && l.raw_text.includes("TPA"),
    );
    expect(lesson).toBeDefined();
    expect(lesson).toMatchObject({
      subject: "Tehnici De Programare Aplicată",
      teacher: "Rotari A.",
      room: "D01-03",
      week_parity: "both",
      uncertain: false,
    });
    expect(lesson!.groups).toEqual(["IA-261"]);
    expect(lesson!.raw_text).toBe("TPA | Rotari A. | D01-03");
  });

  it("leaves no lesson whose subject is really a venue, a teacher or a room", () => {
    for (const lesson of fixture16Artifacts.schedule.lessons) {
      expect(isVenue(lesson.subject), lesson.raw_text).toBe(false);
      expect(isRoom(lesson.subject), lesson.raw_text).toBe(false);
      expect(lesson.subject, lesson.raw_text).not.toContain("Rotari A.");
    }
  });
});

describe("internal gap column border in the canonical Anul I -18 seed", () => {
  it("restores exactly one internal-gap border in row Miercuri 09:45", () => {
    const repairs = seedArtifacts.border_repairs;
    expect(repairs).toHaveLength(1);
    expect(repairs[0].day).toBe("Miercuri");
    expect(repairs[0].start_time).toBe("09:45");
    // The IBM-261 | AI-262 column boundary at x ≈ 841.9
    expect(repairs[0].x).toBeCloseTo(841.9, 1);
    expect(repairs[0].gap).toBeCloseTo(2.75, 2);
    expect(repairs[0].kind).toBe("internal_gap");
    expect(seedArtifacts.orphans).toHaveLength(0);
    expect(seedArtifacts.schedule.warnings).toEqual([]);
  });

  it("recovers IBM-261 Miercuri 09:45 with both teachers Bernat O. and Pilețchi N.", () => {
    const ibmLesson = seedArtifacts.schedule.lessons.find(
      (l) => l.day === "Miercuri" && l.start_time === "09:45" && l.groups.includes("IBM-261"),
    );
    expect(ibmLesson).toBeDefined();
    expect(ibmLesson!.subject).toBe("Fizică");
    expect(ibmLesson!.teacher).toContain("Bernat O.");
    expect(ibmLesson!.teacher).toContain("Pilețchi N.");
    expect(ibmLesson!.teacher).toBe("Bernat O., Pilețchi N.");
    expect(ibmLesson!.room).toBe("301/304");
    expect(ibmLesson!.lesson_type).toBe("lab");
    expect(ibmLesson!.week_parity).toBe("even");
    expect(ibmLesson!.raw_text).toBe("Lab. Fizica | Bernat O., Pilețchi N. | 301/304");
    expect(ibmLesson!.uncertain).toBe(false);
  });

  it("does not assign Bernat/Pilețchi to neighbouring group AI-262", () => {
    const aiLessons = seedArtifacts.schedule.lessons.filter(
      (l) => l.day === "Miercuri" && l.start_time === "09:45" && l.groups.includes("AI-262"),
    );
    expect(aiLessons).toHaveLength(0);

    const wedBernat = seedArtifacts.schedule.lessons.filter(
      (l) =>
        l.day === "Miercuri" &&
        l.start_time === "09:45" &&
        ((l.teacher ?? "").includes("Bernat O.") || (l.teacher ?? "").includes("Pilețchi N.")),
    );
    expect(wedBernat).toHaveLength(1);
    expect(wedBernat[0].groups).toEqual(["IBM-261"]);
  });

  it("resolves IA-261 Vineri 13:30 Limba Engleză with teacher DutoaL., Nicolai F. without collision", () => {
    const iaLessons = seedArtifacts.schedule.lessons.filter(
      (l) => l.day === "Vineri" && l.start_time === "13:30" && l.groups.includes("IA-261"),
    );
    expect(iaLessons).toHaveLength(1);
    const lesson = iaLessons[0];
    expect(lesson.subject).toBe("Limba Engleză");
    expect(lesson.teacher).toBe("DutoaL., Nicolai F.");
    expect(lesson.room).toBe("203/601");
    expect(lesson.lesson_type).toBe("language");
    expect(lesson.raw_text).toBe("L. Engleză | 203/601 | DutoaL., Nicolai F.");
    expect(lesson.uncertain).toBe(false);
  });

  it("does not touch the geometry of PDFs that are not damaged", async () => {
    // The repair must be inert everywhere else: the previously shipped seeds parse exactly
    // as they did before it existed, and the current Anul II seed needs no repair at all.
    const cases = [
      { file: PREVIOUS_SEED_ANUL_I, groups: 41, lessons: 449 },
      { file: PREVIOUS_SEED_ANUL_II, groups: 26, lessons: 288 },
      { file: FIXTURE_ANUL_II_10, groups: 26, lessons: 288 },
    ];
    for (const sample of cases) {
      const artifacts = await parsePdf(new Uint8Array(await readFile(sample.file)), { ...provenance, source_kind: "seed" });
      expect(artifacts.border_repairs, sample.file).toHaveLength(0);
      expect(artifacts.orphans, sample.file).toHaveLength(0);
      expect(artifacts.schedule.groups, sample.file).toHaveLength(sample.groups);
      expect(artifacts.schedule.lessons, sample.file).toHaveLength(sample.lessons);
      expect(artifacts.schedule.lessons.filter((lesson) => lesson.uncertain), sample.file).toHaveLength(0);
    }
    expect(seedArtifactsAnulII.border_repairs).toHaveLength(0);
  });
});

describe("subjects the Anul I seed prints unusually", () => {
  it("corrects the misplaced space in \"Tehnici d eprogramare\" without rewriting the printed text", () => {
    const lesson = seedLesson("Joi", "18:45", "AI-261", "C. Tehnici d eprogramare | Roșca N. | 6-2");
    expect(lesson).toMatchObject({
      subject: "Tehnici De Programare",
      teacher: "Roșca N.",
      room: "6-2",
      lesson_type: "lecture",
      uncertain: false,
    });
    expect(lesson.raw_text).toBe("C. Tehnici d eprogramare | Roșca N. | 6-2");
    // The correction is one exact string, not a general space repair.
    expect(resolveSubjectAlias("Tehnici d eprogramare")).toBe("Tehnici de programare");
    expect(resolveSubjectAlias("Tehnici d eprogramare aplicată")).toBe("Tehnici d eprogramare aplicată");
  });

  it("folds the articulated \"Educația fizică\" into the one canonical discipline", () => {
    // One confirmed spelling of the same official discipline (the UTM curriculum names it
    // "Educație fizică"), resolved as an exact string — not grammatical normalisation.
    expect(resolveSubjectAlias("Educația fizică")).toBe("Educație fizică");

    const { schedule } = seedArtifacts;
    // The timetable no longer splits one discipline across two canonical subjects.
    expect(schedule.lessons.filter((l) => l.subject === "Educația Fizică")).toHaveLength(0);
    expect([...new Set(schedule.lessons.map((l) => l.subject).filter((s) => /Fizic/i.test(s)))].sort()).toEqual([
      "Educație Fizică",
      "Fizică",
    ]);

    // The lesson that printed it joins the canonical subject; its own text is untouched.
    const lesson = seedLesson("Joi", "13:30", "EA-261", "Educația fizică | Sala sportivă");
    expect(lesson).toMatchObject({
      subject: "Educație Fizică",
      room: "Sala sportivă",
      lesson_type: "physical_education",
      uncertain: false,
    });
    expect(lesson.raw_text).toBe("Educația fizică | Sala sportivă");

    // The variants that already resolved are unchanged, and nothing else moved.
    expect(resolveSubjectAlias("Ed. Fizică")).toBe("Educație fizică");
    expect(resolveSubjectAlias("Ed. fizică")).toBe("Educație fizică");
    expect(resolveSubjectAlias("Educație fizică")).toBe("Educație fizică");
    expect(schedule.lessons.filter((l) => l.raw_text.toLowerCase().includes("ed. fizică"))).toHaveLength(29);
    expect(schedule.lessons.filter((l) => l.subject === "Educație Fizică")).toHaveLength(36);
  });

  it("leaves the unconfirmed abbreviation TC exactly as printed", () => {
    // FCIM publishes no expansion for "TC" in this timetable, and PC / TP / Teoria
    // circuitelor are all plausible. An abbreviation nobody confirmed stays an abbreviation.
    const lesson = seedLesson("Marți", "11:30", "AI-262", "TC | Cazac A. | 112");
    expect(lesson.subject).toBe("TC");
    expect(lesson.teacher).toBe("Cazac A.");
    expect(lesson.room).toBe("112");
    expect(resolveSubjectAlias("TC")).toBe("TC");
    expect(resolveSubjectAlias("TC", ["AI-262"])).toBe("TC");
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

  it("resolves RC to Rețele De Calculatoare while raw_text preserves RC", () => {
    const rcLessons = artifacts.schedule.lessons.filter((l) => l.raw_text.includes("RC"));
    expect(rcLessons).toHaveLength(22);
    for (const lesson of rcLessons) {
      expect(lesson.subject).toBe("Rețele De Calculatoare");
      expect(lesson.raw_text).toMatch(/\bRC\b/);
    }
  });

  it("expands MDPS to canonical title in lessons while raw_text preserves MDPS", () => {
    const mdpsLessons = artifacts.schedule.lessons.filter((l) => l.raw_text.includes("MDPS"));
    expect(mdpsLessons).toHaveLength(86);
    for (const lesson of mdpsLessons) {
      expect(lesson.subject).toBe("Matematică Discretă, Probabilitate Și Statistică Aplicată");
      expect(lesson.raw_text).toContain("MDPS");
    }
  });

  it("expands L. Engleză to Limba Engleză in lessons while preserving raw_text", () => {
    const langLessons = artifacts.schedule.lessons.filter((l) => l.raw_text.includes("L. Engleză"));
    expect(langLessons.length).toBeGreaterThan(0);
    for (const lesson of langLessons) {
      expect(lesson.subject).toMatch(/^Limba Engleză/);
      expect(lesson.raw_text).toContain("L. Engleză");
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
    expect(ti!.subject).toBe("Programarea Orientată Pe Obiecte");
    expect(ti!.teacher).toBe("Gîncu S.");
    expect(ti!.room).toBe("6-2");
    expect(ti!.lesson_type).toBe("lecture");

    const si = tues1845.find((l) => l.groups.includes("SI-251"));
    expect(si).toBeDefined();
    expect(si!.groups).toEqual(["SI-251", "SI-252"]);
    expect(si!.subject).toBe("Programarea Orientată Pe Obiecte");
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
      subject: "Circuite Și Dispozitive Electronice",
      teacher: "Chiriac M.",
      room: "A03",
      week_parity: "odd",
    });

    // Even half-cell: AI-252 Luni 09:45 TSA Izvoreanu B. 524 even
    const tsaEven = schedule.lessons.find(
      (l) => l.day === "Luni" && l.start_time === "09:45" && l.groups.includes("AI-252") && l.subject === "Teoria Sistemelor Automate",
    );
    expect(tsaEven).toMatchObject({
      subject: "Teoria Sistemelor Automate",
      teacher: "Izvoreanu B.",
      room: "524",
      week_parity: "even",
    });

    // Multi-slot subgroup lesson: IBM-251 Marți 08:00–11:15 slot_span=2 1) CDE Chiriac M. A03 subgroup=0.5 gr.
    const cdeSub = schedule.lessons.find((l) => l.day === "Marți" && l.start_time === "08:00" && l.groups.includes("IBM-251"));
    expect(cdeSub).toMatchObject({
      subject: "1) Circuite Și Dispozitive Electronice",
      teacher: "Chiriac M.",
      room: "A03",
      slot_span: 2,
      subgroup: "0.5 gr.",
    });

    // Normal single-group lesson: AI-252 Miercuri 13:30 CEI Moraru D. 524
    const cei = schedule.lessons.find((l) => l.day === "Miercuri" && l.start_time === "13:30" && l.groups.includes("AI-252"));
    expect(cei).toMatchObject({
      subject: "Circuite Electronice Integrate",
      teacher: "Moraru D.",
      room: "524",
      groups: ["AI-252"],
    });
  });

  it("expands representative Anul II abbreviations in the real PDF to canonical title case", () => {
    const { schedule } = seedArtifactsAnulII;

    // POO → Programarea Orientată Pe Obiecte
    const poo = schedule.lessons.find((l) => l.raw_text.startsWith("POO |"));
    expect(poo).toBeDefined();
    expect(poo!.subject).toBe("Programarea Orientată Pe Obiecte");

    // MS → Matematici Speciale
    const ms = schedule.lessons.find((l) => l.raw_text.startsWith("MS | Pricop V."));
    expect(ms).toBeDefined();
    expect(ms!.subject).toBe("Matematici Speciale");

    // APA → Analiza Și Proiectarea Algoritmilor
    const apa = schedule.lessons.find((l) => l.raw_text.startsWith("APA |"));
    expect(apa).toBeDefined();
    expect(apa!.subject).toBe("Analiza Și Proiectarea Algoritmilor");

    // SCC → Structuri De Calcul Și De Comunicare
    const scc = schedule.lessons.find((l) => l.raw_text.startsWith("SCC |"));
    expect(scc).toBeDefined();
    expect(scc!.subject).toBe("Structuri De Calcul Și De Comunicare");

    // DEMTPI → Dispozitive Electronice Și Mijloace Tehnice De Protecție A Informației
    const demtpi = schedule.lessons.find((l) => l.raw_text.startsWith("DEMTPI |"));
    expect(demtpi).toBeDefined();
    expect(demtpi!.subject).toBe("Dispozitive Electronice Și Mijloace Tehnice De Protecție A Informației");

    // CEI → Circuite Electronice Integrate
    const cei = schedule.lessons.find((l) => l.raw_text.includes("CEI |"));
    expect(cei).toBeDefined();
    expect(cei!.subject).toBe("Circuite Electronice Integrate");

    // TSA → Teoria Sistemelor Automate
    const tsa = schedule.lessons.find((l) => l.raw_text.startsWith("TSA |"));
    expect(tsa).toBeDefined();
    expect(tsa!.subject).toBe("Teoria Sistemelor Automate");

    // DNAC → Dispozitive Numerice Și Arhitecturi De Calculatoare
    const dnac = schedule.lessons.find((l) => l.raw_text.startsWith("DNAC |"));
    expect(dnac).toBeDefined();
    expect(dnac!.subject).toBe("Dispozitive Numerice Și Arhitecturi De Calculatoare");

    // AFU → Anatomia Și Fiziologia Umană
    const afu = schedule.lessons.find((l) => l.raw_text.includes("AFU |"));
    expect(afu).toBeDefined();
    expect(afu!.subject).toBe("Anatomia Și Fiziologia Umană");

    // PADM → Proiectarea Asistată De Calculator A Dispozitivelor Medicale
    const padm = schedule.lessons.find((l) => l.raw_text.includes("PADM 0,5 gr. |"));
    expect(padm).toBeDefined();
    expect(padm!.subject).toBe("Proiectarea Asistată De Calculator A Dispozitivelor Medicale");
  });

  it("resolves SCS typo in R-251 Vineri 13:30 to Structuri De Calcul Și De Comunicare while raw_text preserves SCS", () => {
    const { schedule } = seedArtifactsAnulII;
    const scsLesson = schedule.lessons.find(
      (l) => l.day === "Vineri" && l.start_time === "13:30" && l.groups.includes("R-251"),
    );
    expect(scsLesson).toBeDefined();
    expect(scsLesson!.subject).toBe("Structuri De Calcul Și De Comunicare");
    expect(scsLesson!.teacher).toBe("Munteanu S.");
    expect(scsLesson!.room).toBe("215");
    expect(scsLesson!.raw_text).toBe("SCS | Munteanu S. | 215");
    expect(scsLesson!.raw_text).toContain("SCS");

    // Verify all SCC lessons resolve to exactly the same canonical subject
    const sccLessons = schedule.lessons.filter((l) => l.raw_text.startsWith("SCC |"));
    expect(sccLessons.length).toBeGreaterThan(0);
    for (const l of sccLessons) {
      expect(l.subject).toBe("Structuri De Calcul Și De Comunicare");
    }

    // Total Structuri De Calcul Și De Comunicare lessons: 13 (SCC/Struct.) + 1 (SCS) = 14
    const allStructuri = schedule.lessons.filter((l) => l.subject === "Structuri De Calcul Și De Comunicare");
    expect(allStructuri).toHaveLength(14);
  });

  it("leaves no confirmed bare abbreviation as a standalone final subject", () => {
    const { schedule } = seedArtifactsAnulII;
    const confirmedBare = new Set([
      "POO",
      "MS",
      "APA",
      "ASDN",
      "ASCS",
      "BD",
      "BSD",
      "SCC",
      "DEMTPI",
      "CEI",
      "TSA",
      "DNAC",
      "FCS",
      "ME",
      "PADM",
      "PAE",
      "AFU",
      "CDE",
    ]);

    const unexpanded = schedule.lessons.filter((lesson) => confirmedBare.has(lesson.subject));
    expect(unexpanded).toHaveLength(0);

    // All confirmed bare abbreviations and their malformed variants are now fully resolved
    const residualAnomalies = schedule.lessons
      .filter((l) => Array.from(confirmedBare).some((abbr) => l.subject.includes(abbr)))
      .map((l) => l.subject);
    const uniqueResidual = Array.from(new Set(residualAnomalies)).sort();
    expect(uniqueResidual).toEqual([]);
  });

  it("regression 1: resolves MS | L. Stanciu to Matematici Speciale with teacher L. Stanciu", () => {
    const { schedule } = seedArtifactsAnulII;
    const stanciuLessons = schedule.lessons.filter((l) => l.raw_text.includes("L. Stanciu"));
    expect(stanciuLessons).toHaveLength(3);
    for (const l of stanciuLessons) {
      expect(l.subject).toBe("Matematici Speciale");
      expect(l.teacher).toBe("L. Stanciu");
      expect(l.raw_text).toContain("MS | L. Stanciu");
    }
  });

  it("regression 2: resolves CDE | Bîrnaz to Circuite Și Dispozitive Electronice with teacher Bîrnaz A.", () => {
    const { schedule } = seedArtifactsAnulII;
    const birnazLesson = schedule.lessons.find(
      (l) => l.day === "Marți" && l.start_time === "09:45" && l.groups.includes("AI-251") && l.raw_text.includes("Bîrnaz"),
    );
    expect(birnazLesson).toBeDefined();
    expect(birnazLesson!.subject).toBe("Circuite Și Dispozitive Electronice");
    expect(birnazLesson!.teacher).toBe("Bîrnaz A.");
    expect(birnazLesson!.room).toBe("524");
    expect(birnazLesson!.raw_text).toBe("CDE | Bîrnaz | 524");
  });

  it("regression 3: resolves Lab.PAE with missing whitespace to Proiectarea Asistată În Electronică with lab type", () => {
    const { schedule } = seedArtifactsAnulII;
    const labPaeLesson = schedule.lessons.find((l) => l.raw_text.includes("Lab.PAE"));
    expect(labPaeLesson).toBeDefined();
    expect(labPaeLesson!.subject).toBe("Proiectarea Asistată În Electronică");
    expect(labPaeLesson!.lesson_type).toBe("lab");
    expect(labPaeLesson!.teacher).toBe("Bîrnaz A.");
    expect(labPaeLesson!.room).toBe("427");
    expect(labPaeLesson!.raw_text).toBe("Lab.PAE | Bîrnaz A. | 427");
  });

  it("regression 4: expands decorated aliases (1) CDE, 2) MS, PAE 1/l, PADM 1/e, PADM 1/l)", () => {
    const { schedule } = seedArtifactsAnulII;

    // 1) CDE and 2) MS share the same split cell for IBM-251 Marți 08:00
    const cellLessons = schedule.lessons.filter((l) => l.raw_text.includes("1) CDE | Chiriac M."));
    expect(cellLessons).toHaveLength(2);
    expect(cellLessons[0].subject).toBe("1) Circuite Și Dispozitive Electronice");
    expect(cellLessons[0].teacher).toBe("Chiriac M.");
    expect(cellLessons[1].subject).toBe("2) Matematici Speciale");
    expect(cellLessons[1].teacher).toBe("Litra D.");

    // PAE 1/l
    const pae1l = schedule.lessons.filter((l) => l.raw_text.includes("PAE 1/l"));
    expect(pae1l.length).toBeGreaterThan(0);
    for (const l of pae1l) {
      expect(l.subject).toBe("Proiectarea Asistată În Electronică 1/l");
    }

    // PADM 1/e
    const padm1e = schedule.lessons.find((l) => l.raw_text.includes("PADM 1/e"));
    expect(padm1e).toBeDefined();
    expect(padm1e!.subject).toBe("Proiectarea Asistată De Calculator A Dispozitivelor Medicale 1/e");

    // PADM 1/l
    const padm1l = schedule.lessons.find((l) => l.raw_text.includes("PADM 1/l"));
    expect(padm1l).toBeDefined();
    expect(padm1l!.subject).toBe("Proiectarea Asistată De Calculator A Dispozitivelor Medicale 1/l");
  });

  it("regression 5: handles multiple teachers separated by semicolon (Bostan V.; Cojuhari E.)", () => {
    const { schedule } = seedArtifactsAnulII;
    const multiTeacher = schedule.lessons.find((l) => l.raw_text.includes("Bostan V. ; Cojuhari E."));
    expect(multiTeacher).toBeDefined();
    expect(multiTeacher!.subject).toBe("Matematici Speciale");
    expect(multiTeacher!.teacher).toBe("Bostan V.; Cojuhari E.");
    expect(multiTeacher!.room).toBe("3-3 Amdaris");
    expect(multiTeacher!.raw_text).toBe("c. Matematici Speciale | Bostan V. ; Cojuhari E. | 3-3 Amdaris");
  });

  it("regression 6: distinguishes languages from initial-first teachers (L. Engleză vs L. Stanciu)", () => {
    const { schedule } = seedArtifactsAnulII;

    // L. Engleză is a language subject, not teacher
    const langLessons = schedule.lessons.filter((l) => l.raw_text.startsWith("L. Engleză |"));
    expect(langLessons.length).toBeGreaterThan(0);
    for (const l of langLessons) {
      expect(l.subject).toBe("Limba Engleză");
      expect(l.lesson_type).toBe("language");
      expect(l.teacher).not.toBe("L. Engleză");
    }

    // L. Stanciu is a teacher, not a subject
    const stanciuLessons = schedule.lessons.filter((l) => l.raw_text.includes("L. Stanciu"));
    expect(stanciuLessons.length).toBeGreaterThan(0);
    for (const l of stanciuLessons) {
      expect(l.teacher).toBe("L. Stanciu");
      expect(l.subject).toBe("Matematici Speciale");
    }
  });

  it("regression 7: expands MDPS in real PDF to canonical title case while raw_text preserves MDPS", () => {
    const { schedule } = artifacts;
    const mdpsLessons = schedule.lessons.filter((l) => l.raw_text.includes("MDPS"));
    expect(mdpsLessons.length).toBe(86);
    for (const l of mdpsLessons) {
      expect(l.subject).toBe("Matematică Discretă, Probabilitate Și Statistică Aplicată");
      expect(l.raw_text).toMatch(/\bMDPS\b/);
    }
  });

  it("regression 8: normalizes BÎrnaz A. typo variant to Bîrnaz A. (lab. PAE | BÎrnaz A. | 404)", () => {
    const { schedule } = seedArtifactsAnulII;
    const lesson = schedule.lessons.find((l) => l.raw_text.includes("BÎrnaz A."));
    expect(lesson).toBeDefined();
    expect(lesson!.subject).toBe("Proiectarea Asistată În Electronică");
    expect(lesson!.teacher).toBe("Bîrnaz A.");
    expect(lesson!.room).toBe("404");
    expect(lesson!.raw_text).toBe("lab. PAE | BÎrnaz A. | 404");
  });

  it("regression 9: recognizes comma-separated multi-teacher list in Anul I PCAS lesson", () => {
    const { schedule } = seedArtifacts;
    const pcasLesson = schedule.lessons.find((l) => l.raw_text.includes("Gavrilița M."));
    expect(pcasLesson).toBeDefined();
    expect(pcasLesson!.subject).toBe("Proiectarea Conceptuală A Unei Aplicații Software");
    expect(pcasLesson!.teacher).toBe("Gavrilița M., Cazacu C., Graur E., Malîi A., Trubca D., Capitan P.");
    expect(pcasLesson!.room).toBe("6-2");
    expect(pcasLesson!.raw_text).toBe("Proiect PCAS | Gavrilița M., Cazacu C., Graur E., Malîi A., Trubca D., Capitan P. | 6-2");
  });

  it("regression 10: expands embedded SI in Cadrul Legal al SI to canonical title while raw_text preserves original", () => {
    const { schedule } = seedArtifactsAnulII;
    const siLessons = schedule.lessons.filter((l) => l.raw_text.includes("Cadrul Legal al SI"));
    expect(siLessons).toHaveLength(2);
    for (const l of siLessons) {
      expect(l.subject).toBe("Cadrul Legal Al Securității Informaționale");
      expect(l.teacher).toBe("Bulai I.");
      expect(l.raw_text).toContain("c. Cadrul Legal al SI");
    }
  });

  it("regression 11: resolves all Filosofia/Filosofie și Gândire/Gândirea Critică variants to Filosofie Și Gândire Critică", () => {
    const { schedule } = seedArtifactsAnulII;

    // c. Filosofia și Gândire Critică (AI-251, AI-252)
    const var1 = schedule.lessons.find((l) => l.raw_text.includes("c. Filosofia și Gândire Critică"));
    expect(var1).toBeDefined();
    expect(var1!.subject).toBe("Filosofie Și Gândire Critică");
    expect(var1!.raw_text).toContain("c. Filosofia și Gândire Critică");

    // c. Filosofia și Gândirea Critică (CR-251, CR-252, CR-253)
    const var2 = schedule.lessons.find((l) => l.raw_text.includes("c. Filosofia și Gândirea Critică"));
    expect(var2).toBeDefined();
    expect(var2!.subject).toBe("Filosofie Și Gândire Critică");
    expect(var2!.raw_text).toContain("c. Filosofia și Gândirea Critică");

    // Filosofia GC (e.g. TI-251..TI-255 seminar/discussion)
    const gcLessons = schedule.lessons.filter((l) => l.raw_text.includes("Filosofia GC"));
    expect(gcLessons.length).toBeGreaterThan(0);
    for (const l of gcLessons) {
      expect(l.subject).toBe("Filosofie Și Gândire Critică");
      expect(l.raw_text).toContain("Filosofia GC");
    }

    // All 9 critical thinking philosophy lessons now converge to the single canonical title
    const allCritica = schedule.lessons.filter((l) => l.subject === "Filosofie Și Gândire Critică");
    expect(allCritica).toHaveLength(9);
  });

  it("regression 12: resolves Dreptul de Proprietate Intelectuală to Dreptul Proprietății Intelectuale in Anul II", () => {
    const { schedule } = seedArtifactsAnulII;
    const lesson = schedule.lessons.find((l) => l.raw_text.includes("Dreptul de Proprietate Intelectuală"));
    expect(lesson).toBeDefined();
    expect(lesson!.subject).toBe("Dreptul Proprietății Intelectuale");
    expect(lesson!.raw_text).toContain("c. Dreptul de Proprietate Intelectuală");
    // All 2 intellectual property law lessons converge to the canonical title
    const allLaw = schedule.lessons.filter((l) => l.subject === "Dreptul Proprietății Intelectuale");
    expect(allLaw).toHaveLength(2);
  });

  it("regression 13: resolves Circuite și Dispozitive Electrice to Circuite Și Dispozitive Electronice in Anul II", () => {
    const { schedule } = seedArtifactsAnulII;
    const elecLessons = schedule.lessons.filter((l) => l.raw_text.includes("Circuite și Dispozitive Electrice"));
    expect(elecLessons).toHaveLength(3);
    for (const l of elecLessons) {
      expect(l.subject).toBe("Circuite Și Dispozitive Electronice");
      expect(l.raw_text).toContain("Circuite și Dispozitive Electrice");
    }
    // Total CDE lessons in Anul II now equals 29 (26 + 3)
    const allCde = schedule.lessons.filter((l) => l.subject === "Circuite Și Dispozitive Electronice");
    expect(allCde).toHaveLength(29);
  });

  it("regression 14: resolves Proiectarea Conceptelor AS to Proiectarea Conceptuală A Unei Aplicații Software in Anul I", () => {
    const { schedule } = seedArtifacts;
    const pcasVar = schedule.lessons.filter((l) => l.raw_text.includes("Proiectarea conceptelor AS"));
    expect(pcasVar).toHaveLength(2);
    for (const l of pcasVar) {
      expect(l.subject).toBe("Proiectarea Conceptuală A Unei Aplicații Software");
      expect(l.raw_text).toContain("c. Proiectarea conceptelor AS");
    }
    const allPcas = schedule.lessons.filter((l) => l.subject === "Proiectarea Conceptuală A Unei Aplicații Software");
    expect(allPcas).toHaveLength(3);
  });

  it("regression 15: resolves Ed. Fizică and Fizica to Educație Fizică and Fizică in Anul I", () => {
    const { schedule } = seedArtifacts;

    // Ed. Fizică -> Educație Fizică (36 total: 29 printed "Ed. fizică", 6 spelled out, 1 articulated)
    const edFiz = schedule.lessons.filter((l) => l.raw_text.toLowerCase().includes("ed. fizică"));
    expect(edFiz).toHaveLength(29);
    for (const l of edFiz) {
      expect(l.subject).toBe("Educație Fizică");
      expect(l.raw_text.toLowerCase()).toContain("ed. fizică");
    }
    const allPe = schedule.lessons.filter((l) => l.subject === "Educație Fizică");
    expect(allPe).toHaveLength(36);

    // Fizica -> Fizică (27 total in -18: 16 + 11, including recovered IBM-261 lab)
    const fizica = schedule.lessons.filter((l) => l.raw_text.includes("Fizica"));
    expect(fizica).toHaveLength(16);
    for (const l of fizica) {
      expect(l.subject).toBe("Fizică");
      expect(l.raw_text).toContain("Fizica");
    }
    const allFiz = schedule.lessons.filter((l) => l.subject === "Fizică");
    expect(allFiz).toHaveLength(27);
  });

  it("regression 16: resolves Algebră Liniară and Etica și Integritatea Academică in Anul I", () => {
    const { schedule } = seedArtifacts;

    // c. Algebră Liniară și Geometrie Analitică (1 lesson) -> Algebra Liniară Și Geometria Analitică (43 total)
    const algaVar = schedule.lessons.find((l) => l.raw_text.includes("Algebră Liniară și Geometrie Analitică"));
    expect(algaVar).toBeDefined();
    expect(algaVar!.subject).toBe("Algebra Liniară Și Geometria Analitică");
    expect(algaVar!.raw_text).toContain("c. Algebră Liniară și Geometrie Analitică");
    const allAlga = schedule.lessons.filter((l) => l.subject === "Algebra Liniară Și Geometria Analitică");
    expect(allAlga).toHaveLength(43);

    // c. Etica și integritatea academică (1 lesson) -> Etică Și Integritate Academică (9 total)
    const eiaVar = schedule.lessons.find((l) => l.raw_text.includes("Etica și integritatea academică"));
    expect(eiaVar).toBeDefined();
    expect(eiaVar!.subject).toBe("Etică Și Integritate Academică");
    expect(eiaVar!.raw_text).toContain("c. Etica și integritatea academică");
    const allEia = schedule.lessons.filter((l) => l.subject === "Etică Și Integritate Academică");
    expect(allEia).toHaveLength(9);
  });

  it("regression 17: resolves security/ethics variants and formats Activități in Anul I", () => {
    const { schedule } = seedArtifacts;

    // All security/ethics variants converge to Etică Și Securitatea Umană (26 total)
    const allEsu = schedule.lessons.filter((l) => l.subject === "Etică Și Securitatea Umană");
    expect(allEsu).toHaveLength(26);

    const esuVar1 = schedule.lessons.find((l) => l.raw_text.includes("Etica și Securitate Umană"));
    expect(esuVar1).toBeDefined();
    expect(esuVar1!.subject).toBe("Etică Și Securitatea Umană");

    const esuVar2 = schedule.lessons.filter((l) => l.raw_text.includes("Etică și Securitate umană"));
    expect(esuVar2).toHaveLength(5);
    for (const l of esuVar2) {
      expect(l.subject).toBe("Etică Și Securitatea Umană");
    }

    const esuVar3 = schedule.lessons.filter(
      (l) => l.raw_text.includes("Etica și securitatea umană") || l.raw_text.includes("Etica și Securitatea umană"),
    );
    expect(esuVar3).toHaveLength(6);
    for (const l of esuVar3) {
      expect(l.subject).toBe("Etică Și Securitatea Umană");
    }

    // Activități Individuale/În Grup (4 total)
    const act = schedule.lessons.filter((l) => l.subject === "Activități Individuale/În Grup");
    expect(act).toHaveLength(4);
    for (const l of act) {
      expect(l.raw_text).toBe("Activități individuale/ în | grup");
    }
  });

  it("regression 18: resolves all Limba Engleză 1 lessons to Limba Engleză in Anul I", () => {
    const { schedule } = seedArtifacts;

    // 6 lessons in Anul I with raw_text starting with L. Engleză 1 or L.Engleza 1
    const eng1Lessons = schedule.lessons.filter(
      (l) => l.raw_text.includes("L. Engleză 1") || l.raw_text.includes("L.Engleza 1"),
    );
    expect(eng1Lessons).toHaveLength(6);
    for (const l of eng1Lessons) {
      expect(l.subject).toBe("Limba Engleză");
    }

    // Proves raw_text is preserved exactly as printed
    const sample1 = eng1Lessons.find((l) => l.raw_text.includes("L.Engleza 1"));
    expect(sample1).toBeDefined();
    expect(sample1!.raw_text).toBe("L.Engleza 1 | 720/624 | Tintiuc C., Șișianu A.");
    expect(sample1!.subject).toBe("Limba Engleză");

    // Total Limba Engleză lessons in Anul I now equals 35 (29 + 6)
    const allEng = schedule.lessons.filter((l) => l.subject === "Limba Engleză");
    expect(allEng).toHaveLength(35);

    // No lessons remain with Limba Engleză 1
    const residual = schedule.lessons.filter((l) => l.subject === "Limba Engleză 1");
    expect(residual).toHaveLength(0);
  });
});
