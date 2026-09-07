/**
 * Stage 8: normalisation helpers – time formats, whitespace, diacritics
 * variants and canonical lesson field cleanup. Pure functions, easy to test.
 */

/** "8.00" | "8:00" | "08.00" → "08:00" */
export function normalizeTime(raw: string): string {
  const match = /^(\d{1,2})[.:](\d{2})$/.exec(raw.trim());
  if (!match) throw new Error(`Unrecognised time value: "${raw}"`);
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) throw new Error(`Time out of range: "${raw}"`);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/** Collapse whitespace and unify Romanian cedilla/comma-below diacritics. */
export function cleanText(raw: string): string {
  return raw
    .replace(/\u00a0/g, " ")
    .replace(/ş/g, "ș")
    .replace(/Ş/g, "Ș")
    .replace(/ţ/g, "ț")
    .replace(/Ţ/g, "Ț")
    .replace(/\s+/g, " ")
    .trim();
}

/** Evidence-backed teacher variants where timetable cells omit initials or misspell names. */
export const KNOWN_TEACHER_ALIASES = new Map<string, string>([
  ["Bîrnaz", "Bîrnaz A."],
  ["BÎrnaz A.", "Bîrnaz A."],
]);

function normalizeSingleTeacher(raw: string): string {
  const trimmed = raw.trim();
  if (KNOWN_TEACHER_ALIASES.has(trimmed)) {
    return KNOWN_TEACHER_ALIASES.get(trimmed)!;
  }
  const cleaned = cleanText(trimmed).replace(/\s*\.\s*/g, ". ").replace(/\s+$/, "").trim();
  const match = /^(.+?)\s+([A-Za-zĂÂÎȘȚăâîșț]{1,3})\.?$/.exec(cleaned);
  if (!match) return cleaned;
  const initials = match[2].charAt(0).toUpperCase() + match[2].slice(1);
  return `${match[1]} ${initials}.`;
}

/** "Costaș A" → "Costaș A." ; "Prozor-Barbalat l." → "Prozor-Barbalat L." ; "Bostan V. ; Cojuhari E." → "Bostan V.; Cojuhari E." */
export function normalizeTeacher(raw: string): string {
  if (raw.includes(";")) {
    return raw
      .split(";")
      .map((part) => normalizeSingleTeacher(part))
      .filter((part) => part.length > 0)
      .join("; ");
  }
  if (raw.includes(",")) {
    return raw
      .split(",")
      .map((part) => normalizeSingleTeacher(part))
      .filter((part) => part.length > 0)
      .join(", ");
  }
  return normalizeSingleTeacher(raw);
}

/** "D 01-03" → "D01-03", "5 - 114" → "5-114", "D-01 / D-03" → "D-01/D-03" */
export function normalizeRoom(raw: string): string {
  return cleanText(raw)
    .replace(/\s*-\s*/g, "-")
    .replace(/\s*\/\s*/g, "/")
    .replace(/^([A-Za-z])\s+(\d)/, "$1$2")
    .replace(/\s+/g, " ");
}

/** "0,5 gr." | "05,gr." | "0.5 gr." → "0.5 gr." */
export function normalizeSubgroup(raw: string): string {
  const cleaned = cleanText(raw).toLowerCase();
  if (/^0?[.,]?5\s*[,.]?\s*gr\.?$/.test(cleaned) || /^05\s*,\s*gr\.?$/.test(cleaned)) return "0.5 gr.";
  return cleanText(raw);
}

/** Capitalise first letter of a subject and drop redundant type prefixes. */
export function normalizeSubject(raw: string): string {
  const cleaned = cleanText(raw).replace(/\s+([,.;])/g, "$1");
  if (!cleaned) return cleaned;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Canonical Subject Title Case:
 * Capitalises each lexical word while preserving the remainder of the token.
 * E.g., "și" → "Și", "TWeb" → "TWeb", "UX/UI" → "UX/UI", "1) CDE" → "1) CDE".
 * Uppercases the first alphabetic character while leaving the rest unchanged.
 */
export function toCanonicalSubjectTitle(raw: string): string {
  const cleaned = cleanText(raw);
  if (!cleaned) return cleaned;
  return cleaned
    .split(" ")
    .map((token) => {
      if (/^\d/.test(token)) return token;
      return token.replace(/\p{L}/u, (char) => char.toUpperCase());
    })
    .join(" ");
}
