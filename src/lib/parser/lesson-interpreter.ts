/**
 * Stage 7: lesson interpretation. Converts the text lines of a reconstructed
 * cell into one or more lessons (subject / teacher / room / type / subgroup).
 * The line *roles* are decided by small classifiers; layout order is never
 * assumed blindly, and anything ambiguous is flagged as uncertain.
 */
import { createHash } from "node:crypto";
import type { Lesson, LessonType, WeekParity } from "@/lib/models";
import type { TableCell } from "./cell-builder";
import { normalizeRoom, normalizeSubgroup, normalizeSubject, normalizeTeacher, toCanonicalSubjectTitle, cleanText, KNOWN_TEACHER_ALIASES } from "./normalizer";
import { resolveSubjectAlias } from "./subject-aliases";

/** One room: "606", "606a", "3-3", "5-114", "D01", "D-01", "A03" – but not "A1" (language level). */
const ROOM_ATOM = String.raw`(?:[A-Z]\s?-?\s?\d{2,3}[a-z]?|\d\s?-\s?\d{1,3}[a-z]?|\d{3}[a-z]?)`;
/** Follow-up room in a list, which may drop the block letter: "D02/04", "110/112". */
const ROOM_TAIL = String.raw`(?:${ROOM_ATOM}|\d{2}[a-z]?)`;
/**
 * One room, or the list of rooms a split lesson runs in. Labs shared by two
 * subgroups are written "D02/04", "D-01 / D-03", "110/112" or "301-304" – one
 * lesson in two rooms, not two lessons.
 */
const ROOM_RE = new RegExp(`^${ROOM_ATOM}(?:\\s*[-/,]\\s*${ROOM_TAIL})*$`, "i");
/** Auditoriums carry their patron's name after the number: "3-3 Amdaris", "Aula 6-2 Henri Coandă". */
const VENUE_WORD = String.raw`[A-ZĂÂÎȘȚ][A-Za-zĂÂÎȘȚăâîșț0-9.-]*`;
const VENUE_ROOM_RE = new RegExp(`^(?:(?:aula|sala|sală)\\s+)?${ROOM_ATOM}(?:\\s+${VENUE_WORD})+$`, "i");
/** A venue named instead of numbered: "Sala sportivă", "Terenul sportiv". */
const NAMED_VENUE_RE = /^(?:sal[aă]|aul[aă]|teren(?:ul)?|stadion(?:ul)?)\s+[A-Za-zĂÂÎȘȚăâîșț][A-Za-zĂÂÎȘȚăâîșț\s.-]*$/i;
const NAME_WORD = "[A-ZĂÂÎȘȚ][a-zăâîșț]+(?:-[A-Za-zĂÂÎȘȚăâîșț][a-zăâîșț]+)?";
const TEACHER_RE = new RegExp(`^${NAME_WORD}(?: ${NAME_WORD})?(?:\\s+(?:[A-ZĂÂÎȘȚ][a-zăâîșț]{0,2}\\.?|[a-z]\\.)|[A-ZĂÂÎȘȚ]\\.)$`);
/** A few cells put the initial first instead: "P. Russu", "P.Russu", "L. Stanciu". */
const INITIAL_FIRST_TEACHER_RE = new RegExp(`^[A-ZĂÂÎȘȚ]\\.\\s?${NAME_WORD}$`);
/**
 * Initial-first abbreviations for subjects: "C. Fizica" (curs), "T. Web" (tehnologii).
 * Language abbreviations starting with "L." ("L. Engleză") are excluded by LANGUAGE_RE,
 * allowing legitimate initial-first teachers such as "L. Stanciu" to be recognized.
 */
const SUBJECT_INITIAL_RE = /^[ct]\s*\./i;
const SUBGROUP_RE = /(?:\b0\s*[.,]\s*5\s*[,.]?\s*gr\.?|\b05\s*,\s*gr\.?)/i;
const LONE_MARKER_RE = /^(c|lab|sem|pr|proiect)\.?$/i;
const PHYS_ED_RE = /^(?:ed\.?|educa[țt]i[ae])\s*fizic[aă](?![a-zăâîșț])/i;
const LANGUAGE_RE = /^(?:l\.?\s*|limba\s+|limbă\s+)?(?:engleză|engleza|română|romana|rom\.?|străină|straina|franceză|germană)(?![a-zăâîșț])/i;
/** Slots the timetable fills with unsupervised work – no teacher or room is expected. */
const SELF_STUDY_RE = /^(?:activit[ăa][țt]i|lucru\s+individual|studiu\s+individual)/i;

const TYPE_PREFIXES: { pattern: RegExp; type: LessonType }[] = [
  { pattern: /^c\.\s*/i, type: "lecture" },
  { pattern: /^curs\b\.?\s*/i, type: "lecture" },
  { pattern: /^lab(?:orator)?(?:\.\s*|\s+)/i, type: "lab" },
  { pattern: /^sem(?:inar)?(?:\.\s*|\s+)/i, type: "seminar" },
  { pattern: /^pr(?:act)?(?:\.\s*|\s+)/i, type: "practice" },
  { pattern: /^proiect(?:\.\s*|\s+)/i, type: "project" },
];

interface Segment {
  subjectLines: string[];
  teacher: string | null;
  room: string | null;
  subgroup: string | null;
  leadingType: LessonType | null;
  /** A type marker on its own line ("Proiect", "lab."), kept in case it is all there is. */
  marker: string | null;
}

function emptySegment(): Segment {
  return { subjectLines: [], teacher: null, room: null, subgroup: null, leadingType: null, marker: null };
}

export function isRoom(text: string): boolean {
  return ROOM_RE.test(text.trim());
}

/** A room given with the auditorium's name ("3-3 Amdaris") or by name only ("Sala sportivă"). */
export function isVenue(text: string): boolean {
  const value = text.trim();
  return VENUE_ROOM_RE.test(value) || NAMED_VENUE_RE.test(value);
}

function isSingleTeacher(text: string): boolean {
  const value = text.trim();
  if (LANGUAGE_RE.test(value)) return false;
  if (KNOWN_TEACHER_ALIASES.has(value)) return true;
  if (TEACHER_RE.test(value)) return true;
  return INITIAL_FIRST_TEACHER_RE.test(value) && !SUBJECT_INITIAL_RE.test(value);
}

export function isTeacher(text: string): boolean {
  const value = text.trim();
  if (value.includes(";")) {
    const parts = value.split(";").map((p) => p.trim()).filter((p) => p.length > 0);
    return parts.length > 1 && parts.every(isSingleTeacher);
  }
  if (value.includes(",")) {
    const parts = value.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    return parts.length > 1 && parts.every(isSingleTeacher);
  }
  return isSingleTeacher(value);
}

/** Split the visual lines of a cell into logical lessons. */
export function segmentLines(lines: string[]): Segment[] {
  const segments: Segment[] = [];
  let current = emptySegment();
  let pendingType: LessonType | null = null;

  const hasContent = (segment: Segment) =>
    segment.subjectLines.length > 0 || segment.teacher !== null || segment.room !== null;

  const startNew = () => {
    if (hasContent(current)) segments.push(current);
    current = emptySegment();
  };

  for (const rawLine of lines) {
    let line = cleanText(rawLine);
    const subgroupMatch = SUBGROUP_RE.exec(line);
    if (subgroupMatch) {
      line = cleanText(line.replace(subgroupMatch[0], ""));
      if (current.room !== null && current.subjectLines.length > 0) startNew();
      current.subgroup = normalizeSubgroup(subgroupMatch[0]);
      if (!line) continue;
    }

    const loneMarker = LONE_MARKER_RE.exec(line);
    if (loneMarker) {
      pendingType = TYPE_PREFIXES.find((entry) => entry.pattern.test(`${line} `))?.type ?? null;
      // "Proiect" on its own is both the kind of class and its name; keep the word in
      // case no subject line follows.
      if (current.subjectLines.length === 0) {
        current.marker = line;
        current.leadingType = current.leadingType ?? pendingType;
      }
      continue;
    }

    for (const part of splitMixedLine(line)) {
      if (isRoom(part) || isVenue(part)) {
        if (current.room !== null) startNew();
        current.room = normalizeRoom(part);
      } else if (isTeacher(part)) {
        if (current.teacher !== null) startNew();
        current.teacher = normalizeTeacher(part);
      } else {
        if (current.teacher !== null || current.room !== null) startNew();
        if (pendingType && current.subjectLines.length === 0) {
          current.leadingType = pendingType;
          pendingType = null;
        }
        current.subjectLines.push(part);
      }
    }
  }
  if (hasContent(current)) segments.push(current);
  return mergeContinuations(segments);
}

/**
 * A cell can name the second room (or teacher) of a split lesson on its own line:
 * "L. Engleză" / "720" / "601". Such a trailing fragment continues the lesson above
 * instead of becoming a second, subject-less one.
 */
function mergeContinuations(segments: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && segment.subjectLines.length === 0) {
      if (segment.room) previous.room = previous.room ? `${previous.room}/${segment.room}` : segment.room;
      if (segment.teacher) previous.teacher = previous.teacher ? `${previous.teacher}, ${segment.teacher}` : segment.teacher;
      previous.subgroup = previous.subgroup ?? segment.subgroup;
      continue;
    }
    merged.push(segment);
  }
  return merged;
}

/** "5-511 Cuciuc V" → ["5-511", "Cuciuc V"]; otherwise the line stays whole. */
function splitMixedLine(line: string): string[] {
  const tokens = line.split(" ");
  if (tokens.length < 2) return [line];
  for (let split = 1; split < tokens.length; split += 1) {
    const head = tokens.slice(0, split).join(" ");
    const tail = tokens.slice(split).join(" ");
    // Only a room glued to a teacher may be split. In "3-3 Amdaris" the trailing word
    // is the auditorium's name, and splitting it would invent a subject-less lesson.
    if ((isRoom(head) && isTeacher(tail)) || (isTeacher(head) && isRoom(tail))) return [head, tail];
  }
  return [line];
}

export function classifyType(subject: string, leadingType: LessonType | null): { type: LessonType; subject: string } {
  let text = subject;
  let type: LessonType | null = leadingType;
  for (const entry of TYPE_PREFIXES) {
    if (entry.pattern.test(text)) {
      type = entry.type;
      text = text.replace(entry.pattern, "");
      break;
    }
  }
  if (type === null) {
    if (PHYS_ED_RE.test(text)) type = "physical_education";
    else if (LANGUAGE_RE.test(text)) type = "language";
  }
  return { type: type ?? "unknown", subject: text };
}

export function interpretCell(cell: TableCell): Lesson[] {
  if (cell.rows.length === 0 || cell.groups.length === 0) return [];
  const segments = segmentLines(cell.lines);
  const rawText = cell.lines.join(" | ");
  const firstRow = cell.rows[0];
  const lastRow = cell.rows[cell.rows.length - 1];
  const lessons: Lesson[] = [];

  const notes: string[] = [];
  const parity = parityFromPosition(cell.position);
  if (parity === "odd") notes.push("Jumătatea de sus a celulei – săptămâna impară");
  if (parity === "even") notes.push("Jumătatea de jos a celulei – săptămâna pară");
  if (cell.rows.length > 1) notes.push(`Ocupă ${cell.rows.length} intervale consecutive`);
  if (cell.background) notes.push(`Evidențiat în PDF (${cell.background})`);

  segments.forEach((segment, index) => {
    const joinedSubject = segment.subjectLines.length > 0 ? segment.subjectLines.join(" ") : (segment.marker ?? "");
    const { type, subject } = classifyType(joinedSubject, segment.leadingType);
    // The abbreviation is expanded once the class-type prefix is off and the text is
    // normalised, so the alias table only ever sees the subject itself.
    const resolvedSubject = resolveSubjectAlias(normalizeSubject(subject), cell.groups);
    const canonicalSubject = toCanonicalSubjectTitle(resolvedSubject);
    const hasSubject = canonicalSubject.length > 0;
    // Uncertain means the *subject* could not be read: it is missing, or it is really a
    // room, or – with no teacher found – a teacher name, so the lines were given the
    // wrong roles. A missing teacher or room is not a parsing failure: that is simply how
    // the timetable prints sports, languages and shared labs.
    const misread =
      isRoom(canonicalSubject) || isVenue(canonicalSubject) || (segment.teacher === null && isTeacher(canonicalSubject));
    const uncertain = !hasSubject || misread;
    const confidence = scoreConfidence(hasSubject, segment, type, canonicalSubject, segments.length);

    lessons.push({
      id: lessonId(cell, index),
      day: firstRow.day,
      slot_index: firstRow.index,
      slot_span: cell.rows.length,
      start_time: firstRow.start_time,
      end_time: lastRow.end_time,
      groups: cell.groups,
      subject: hasSubject ? canonicalSubject : rawText || "Nerecunoscut",
      teacher: segment.teacher,
      room: segment.room,
      lesson_type: type,
      subgroup: segment.subgroup,
      week_parity: parity,
      notes: uncertain ? [...notes, "Materia nu a putut fi separată de profesor și sală"] : notes,
      raw_text: rawText,
      geometry: { page: cell.page, ...cell.bounds },
      confidence,
      uncertain,
    });
  });

  return lessons;
}

/**
 * UTM timetables split a slot cell horizontally when a lesson alternates weekly:
 * upper half = odd (impar) week, lower half = even (par) week. A full-height
 * cell happens every week. This is a geometric fact of the PDF, not a guess.
 */
function parityFromPosition(position: TableCell["position"]): WeekParity {
  if (position === "top") return "odd";
  if (position === "bottom") return "even";
  return "both";
}

/** Sports, languages and self-study slots omit the room or the teacher on purpose. */
function isSelfContained(type: LessonType, subject: string): boolean {
  return type === "physical_education" || type === "language" || SELF_STUDY_RE.test(subject);
}

function scoreConfidence(
  hasSubject: boolean,
  segment: Segment,
  type: LessonType,
  subject: string,
  segmentCount: number,
): number {
  if (!hasSubject) return 0.3;
  let score = 0.6;
  if (segment.teacher) score += 0.2;
  if (segment.room) score += 0.15;
  if (type !== "unknown") score += 0.05;
  if (segmentCount > 1) score -= 0.1;
  // Nothing is missing when the timetable never prints it for this kind of slot.
  if (isSelfContained(type, subject) && !segment.teacher) score += 0.2;
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

function lessonId(cell: TableCell, index: number): string {
  const seed = `${cell.page}:${cell.key}:${index}:${cell.lines.join("|")}`;
  return createHash("sha1").update(seed).digest("hex").slice(0, 12);
}
