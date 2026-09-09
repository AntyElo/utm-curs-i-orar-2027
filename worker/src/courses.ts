/**
 * The one place the broker decides which course years it will store accepted state for.
 *
 * The broker is a transport, not a timetable authority: it never infers a course year from a
 * filename or a PDF body. The only course years it knows are the ones an operator wrote here,
 * and every accepted-state route re-checks against this list. Adding Anul III later is one edit
 * here plus a deliberate deployment, never an accident of a permissive `course > 0` test.
 */

export const SUPPORTED_COURSE_YEARS: readonly number[] = [1, 2];

/**
 * Parse a course year taken from a URL path.
 *
 * Deliberately stricter than `Number.parseInt`: the token must be the exact canonical decimal
 * spelling of a supported year. `"01"`, `"1 "`, `"+1"`, `"1.0"`, `"1x"`, `"0"`, `"3"`, `"99"`
 * and `"-1"` are all rejected rather than coerced.
 */
export function parseSupportedCourseYear(raw: string): number | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 3) {
    return null;
  }
  for (const year of SUPPORTED_COURSE_YEARS) {
    if (raw === String(year)) {
      return year;
    }
  }
  return null;
}

/** True when the value is exactly one of the supported course years. */
export function isSupportedCourseYear(value: unknown): value is number {
  return typeof value === "number" && SUPPORTED_COURSE_YEARS.includes(value);
}
