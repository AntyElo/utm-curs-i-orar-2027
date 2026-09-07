/**
 * Supported course years. One deployment serves every course listed here, and each
 * course owns an independent schedule aggregate: its own PDF, storage files, source
 * state and version history. Nothing is ever merged across courses.
 *
 * Two rules run through this module:
 *
 *  - Configuration fails fast. A malformed SCHEDULE_COURSES / SCHEDULE_DEFAULT_COURSE
 *    stops the process at import time with a message naming the offending value; it is
 *    never normalised into "course 1 only", because a deployment that silently serves
 *    the wrong set of courses is worse than one that refuses to start.
 *  - Public input is parsed strictly. An omitted `?course=` means the default course
 *    (the pre-multi-course contract); everything else must be exactly "1" or "2".
 *
 * Adding another course later means adding one CATALOG entry (plus a seed, if a
 * verified bundled PDF exists for it) — no other module hard-codes a course year.
 */
import path from "node:path";

/** A bundled real FCIM PDF used for a cold start when the live source is unreachable. */
export interface CourseSeed {
  /** Packaged copy inside the data directory, which may be a mounted volume. */
  pdfPath: string;
  /** Container-safe copy kept outside SCHEDULE_DATA_DIR so a mounted cache cannot hide it. */
  imagePdfPath: string;
  /** Official URL this file was published at; the provenance a seed may claim. */
  originalUrl: string;
  /** Public copy for hosts that do not preserve image files at runtime. */
  mirrorUrl: string;
  /** Expected bytes of the mirror before it may claim the official provenance. */
  sha256: string;
}

export interface CourseDefinition {
  year: number;
  /** Roman numeral as FCIM prints it: "Anul I", "Anul II". */
  roman: string;
  label: string;
  /** null = no verified bundled PDF; a cold start without network leaves the course unavailable. */
  seed: CourseSeed | null;
}

/** Startup configuration is wrong; the process must not continue with a guess. */
export class CourseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourseConfigError";
  }
}

/** A course year reached a stateful boundary without passing validation first. */
export class UnsupportedCourseError extends Error {
  constructor(readonly courseYear: unknown) {
    super(
      `course year ${JSON.stringify(courseYear)} is not served by this deployment ` +
        `(supported: ${SUPPORTED_COURSE_YEARS.join(", ")})`,
    );
    this.name = "UnsupportedCourseError";
  }
}

/**
 * The verified bundled PDF of each course: a real, previously published FCIM timetable,
 * used only as a cold-start fallback when the live source cannot be reached. It is never
 * the live update source, and the course-year guard still checks every parsed candidate.
 *
 * Every course carries its own file, URL and hash. Nothing is shared or derived between
 * courses — an Anul II seed must never be describable by an Anul I setting.
 */
const BUNDLED_SEEDS: Record<number, { fileName: string; originalUrl: string; sha256: string }> = {
  1: {
    fileName: "anul_i_semestrul_i-18.pdf",
    originalUrl: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
    sha256: "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a",
  },
  2: {
    fileName: "anul_ii_semestrul_iii-11.pdf",
    originalUrl: "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-11.pdf",
    sha256: "3728f5ab165b6fe5095609d9aeff54da687c8312ed0ec1e89a9a951807a0a23b",
  },
};

/** This repository's own copy of a bundled seed, for hosts that drop image files at runtime. */
function repositoryMirrorUrl(fileName: string): string {
  return `https://raw.githubusercontent.com/barbalatv/utm-curs-i-orar-2027/main/data/seed/${fileName}`;
}

/**
 * Canonical decimal course year: no sign, no leading zero, no fraction, no padding,
 * no surrounding whitespace. Deliberately not Number.parseInt, which happily reads
 * "1x" as 1 and "01" as 1 — exactly the silent resolution this must prevent.
 */
const STRICT_COURSE_TOKEN = /^[1-9][0-9]*$/;

function resolveFromCwd(relative: string): string {
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), relative);
}

/**
 * Seed overrides are per course and never shared. Course 1 keeps the historical
 * unsuffixed variable names; every other course uses the same names with `_<year>`
 * appended, so `SCHEDULE_SEED_PDF_2` can only ever describe Anul II. Setting a course 1
 * variable must not silently change what Anul II installs, and vice versa.
 */
function seedEnv(env: NodeJS.ProcessEnv, courseYear: number, name: string): string | undefined {
  return courseYear === 1 ? env[name] : env[`${name}_${courseYear}`];
}

/**
 * The bundled seed of one course, with its overridable knobs resolved. A course with no
 * entry in BUNDLED_SEEDS has no cold-start fallback and stays unavailable until the live
 * source answers — it never borrows another course's file.
 */
function seedFor(env: NodeJS.ProcessEnv, courseYear: number): CourseSeed | null {
  const bundled = BUNDLED_SEEDS[courseYear];
  if (!bundled) return null;

  const defaultMirrorUrl = repositoryMirrorUrl(bundled.fileName);
  const originalUrl = seedEnv(env, courseYear, "SCHEDULE_SEED_PDF_URL") ?? bundled.originalUrl;
  const mirrorUrl = seedEnv(env, courseYear, "SCHEDULE_SEED_PDF_MIRROR_URL") ?? defaultMirrorUrl;
  return {
    pdfPath: resolveFromCwd(seedEnv(env, courseYear, "SCHEDULE_SEED_PDF") ?? `data/seed/${bundled.fileName}`),
    // Fixed in-image location: the Dockerfile copies data/seed to /app/seed so the seed
    // survives a mounted (initially empty) volume over /app/data. Deliberately not derived
    // from the override above, which points at the writable data directory.
    imagePdfPath: resolveFromCwd(`seed/${bundled.fileName}`),
    originalUrl,
    mirrorUrl,
    // A custom seed must bring its own hash: the bundled one only describes the bundled file.
    sha256:
      seedEnv(env, courseYear, "SCHEDULE_SEED_PDF_SHA256") ??
      (originalUrl === bundled.originalUrl && mirrorUrl === defaultMirrorUrl ? bundled.sha256 : ""),
  };
}

/** Every course this application knows how to serve. */
function catalog(env: NodeJS.ProcessEnv): readonly CourseDefinition[] {
  return [
    { year: 1, roman: "I", label: "Anul I", seed: seedFor(env, 1) },
    { year: 2, roman: "II", label: "Anul II", seed: seedFor(env, 2) },
  ];
}

const KNOWN_COURSE_YEARS = [1, 2];

/**
 * Parse one strictly formatted course year, or return null. Used for public input and
 * for configuration alike so both reject the same shapes.
 */
export function parseStrictCourse(raw: string): number | null {
  if (!STRICT_COURSE_TOKEN.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function parseConfiguredList(raw: string, variable: string, known: readonly number[]): number[] {
  if (raw.trim() === "") {
    throw new CourseConfigError(`${variable} is set but empty. Remove it, or list course years, e.g. "1,2".`);
  }
  const years = raw.split(",").map((entry) => {
    // Padding around a comma is formatting in a .env file, so it is trimmed once here.
    // Everything the token still contains after that must be the number itself — unlike
    // the public query parameter, where whitespace is part of the value and is rejected.
    const token = entry.trim();
    if (token === "") {
      throw new CourseConfigError(`${variable}="${raw}" contains an empty entry. Expected a list like "1,2".`);
    }
    const year = parseStrictCourse(token);
    if (year === null) {
      throw new CourseConfigError(
        `${variable}="${raw}" contains "${token}", which is not a course year. ` +
          `Expected plain decimal numbers, e.g. "1,2".`,
      );
    }
    if (!known.includes(year)) {
      throw new CourseConfigError(
        `${variable}="${raw}" names course year ${year}, which this application does not implement ` +
          `(known: ${known.join(", ")}).`,
      );
    }
    return year;
  });

  const duplicate = years.find((year, index) => years.indexOf(year) !== index);
  if (duplicate !== undefined) {
    throw new CourseConfigError(`${variable}="${raw}" lists course year ${duplicate} more than once.`);
  }
  return years;
}

export interface CourseSelection {
  /** Enabled course years, in the order the operator configured them. */
  years: number[];
  /** The course an omitted `?course=` resolves to. */
  defaultYear: number;
}

/**
 * Resolve the deployment's course configuration, or throw CourseConfigError.
 * Pure: it reads nothing but the env object handed to it, so the rules are testable
 * without restarting a process.
 */
export function resolveCourseSelection(
  env: NodeJS.ProcessEnv,
  known: readonly number[] = KNOWN_COURSE_YEARS,
): CourseSelection {
  // SCHEDULE_COURSE_YEAR pinned a single-course deployment before multi-course support.
  // Honouring it would serve one course while the rest of the configuration says two, and
  // ignoring it would silently change what a deployment serves — so it is a hard stop.
  const legacy = env.SCHEDULE_COURSE_YEAR;
  if (legacy !== undefined && legacy.trim() !== "") {
    throw new CourseConfigError(
      `SCHEDULE_COURSE_YEAR="${legacy}" is no longer supported: one deployment now serves several ` +
        `course years. Replace it with SCHEDULE_COURSES (e.g. SCHEDULE_COURSES=${legacy.trim()} to keep ` +
        `serving only that course, or SCHEDULE_COURSES=1,2 for both) and, if needed, ` +
        `SCHEDULE_DEFAULT_COURSE. See .env.example.`,
    );
  }

  const years =
    env.SCHEDULE_COURSES === undefined
      ? [...known]
      : parseConfiguredList(env.SCHEDULE_COURSES, "SCHEDULE_COURSES", known);

  if (env.SCHEDULE_DEFAULT_COURSE === undefined) return { years, defaultYear: years[0] };

  const requested = parseConfiguredList(env.SCHEDULE_DEFAULT_COURSE, "SCHEDULE_DEFAULT_COURSE", known);
  if (requested.length !== 1) {
    throw new CourseConfigError(
      `SCHEDULE_DEFAULT_COURSE="${env.SCHEDULE_DEFAULT_COURSE}" must name exactly one course year.`,
    );
  }
  if (!years.includes(requested[0])) {
    throw new CourseConfigError(
      `SCHEDULE_DEFAULT_COURSE=${requested[0]} is not among the enabled courses (${years.join(", ")}). ` +
        `Add it to SCHEDULE_COURSES or pick an enabled course year.`,
    );
  }
  return { years, defaultYear: requested[0] };
}

const selection = resolveCourseSelection(process.env);
const CATALOG = catalog(process.env);

/** Courses this deployment serves, in configured order. */
export const SUPPORTED_COURSES: readonly CourseDefinition[] = selection.years.map(
  (year) => CATALOG.find((course) => course.year === year) as CourseDefinition,
);

export const SUPPORTED_COURSE_YEARS: readonly number[] = SUPPORTED_COURSES.map((course) => course.year);

/** The course an omitted `?course=` parameter resolves to; Anul I keeps the historical default. */
export const DEFAULT_COURSE_YEAR: number = selection.defaultYear;

export function isSupportedCourse(courseYear: unknown): courseYear is number {
  return typeof courseYear === "number" && SUPPORTED_COURSE_YEARS.includes(courseYear);
}

/**
 * Gate for every exported stateful boundary (storage, updater, read services). An
 * unsupported year throws instead of being normalised, so no code path can create or
 * read a namespace like `data/courses/3`.
 */
export function assertSupportedCourse(courseYear: unknown): number {
  if (!isSupportedCourse(courseYear)) throw new UnsupportedCourseError(courseYear);
  return courseYear;
}

/** Throws for an unsupported year: callers reaching this point have already validated input. */
export function courseDefinition(courseYear: number): CourseDefinition {
  assertSupportedCourse(courseYear);
  return SUPPORTED_COURSES.find((item) => item.year === courseYear) as CourseDefinition;
}

export function courseSeed(courseYear: number): CourseSeed | null {
  return courseDefinition(courseYear).seed;
}

export function courseLabel(courseYear: number): string {
  return courseDefinition(courseYear).label;
}

export type CourseParamResult =
  | { ok: true; courseYear: number; supplied: boolean }
  | { ok: false; reason: string };

/**
 * Resolve the public `course` selector of a request.
 *
 *   absent            → the default course (pre-multi-course clients keep working)
 *   "1" / "2"         → that course
 *   anything else     → rejected, including an empty value, whitespace, "01", "1.0",
 *                       "0", "-1", "3" and a repeated parameter
 *
 * A present-but-unusable value is never treated as absent: `?course=` asks a question
 * this deployment cannot answer, and answering it with course 1 is the silent
 * resolution this whole module exists to prevent.
 */
export function resolveCourseParam(params: URLSearchParams): CourseParamResult {
  const values = params.getAll("course");
  if (values.length === 0) return { ok: true, courseYear: DEFAULT_COURSE_YEAR, supplied: false };
  if (values.length > 1) {
    return { ok: false, reason: `course was given ${values.length} times; supply it at most once` };
  }
  return resolveCourseValue(values[0]);
}

/** The single-value half of `resolveCourseParam`, for callers holding a raw value (e.g. a JSON body). */
export function resolveCourseValue(raw: string): CourseParamResult {
  const courseYear = parseStrictCourse(raw);
  if (courseYear === null || !isSupportedCourse(courseYear)) {
    return { ok: false, reason: `unknown course ${JSON.stringify(raw)}` };
  }
  return { ok: true, courseYear, supplied: true };
}
