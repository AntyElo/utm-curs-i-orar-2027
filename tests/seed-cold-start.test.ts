/**
 * Cold start with no network — the situation production is actually in.
 *
 * Render receives a Cloudflare challenge (HTTP 403) for both the rendered FCIM page and
 * its WordPress representation, and the archive mirror only holds last year's page. Every
 * course therefore reaches its bundled seed on a cold start, and a course without one
 * stays empty. That is exactly how Anul II came up blank in production.
 *
 * Each course must bootstrap from *its own* verified PDF: the same file the university
 * published, at the same URL, with the same SHA-256 — and never from another course's.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tempDir = await mkdtemp(path.join(tmpdir(), "fcim-seed-"));
const packagedSeedOne = path.join(tempDir, "packaged-anul-i.pdf");
const packagedSeedTwo = path.join(tempDir, "packaged-anul-ii.pdf");

process.env.SCHEDULE_COURSES = "1,2";
process.env.SCHEDULE_DATA_DIR = tempDir;
process.env.DATABASE_URL = "";
process.env.SCHEDULE_WAYBACK_FALLBACK = "0";
// Per-course seed overrides: course 1 keeps the historical names, course 2 uses the
// `_2` suffix. Neither may describe the other's file.
process.env.SCHEDULE_SEED_PDF = packagedSeedOne;
process.env.SCHEDULE_SEED_PDF_2 = packagedSeedTwo;

const { courseSeed } = await import("@/lib/courses");
const { sha256 } = await import("@/lib/parser");
const { checkForUpdates } = await import("@/lib/services/updater");
const { getCurrentSchedule, getSourceState, replaceCurrentSchedule, resetStorageCache, saveSourceState } =
  await import("@/lib/storage");
const { parsePdf } = await import("@/lib/parser");

const ANUL_I_SEED = path.join(__dirname, "..", "data", "seed", "anul_i_semestrul_i-18.pdf");
const ANUL_II_SEED = path.join(__dirname, "..", "data", "seed", "anul_ii_semestrul_iii-11.pdf");
/** The revisions these two replaced - what a long-lived volume still holds. */
const PREVIOUS_ANUL_I_SEED = path.join(__dirname, "fixtures", "anul_i_semestrul_i-16.pdf");
const PREVIOUS_ANUL_II_SEED = path.join(__dirname, "fixtures", "anul_ii_semestrul_iii-10.pdf");
const PAGE_URL = "https://fcim.utm.md/procesul-de-studii/orar/";
const WORDPRESS_URL = "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view";
const ANUL_I_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf";
const ANUL_II_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-11.pdf";
const ANUL_I_HASH = "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a";
const ANUL_II_HASH = "3728f5ab165b6fe5095609d9aeff54da687c8312ed0ec1e89a9a951807a0a23b";
const PREVIOUS_ANUL_I_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-16.pdf";
const PREVIOUS_ANUL_II_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-10.pdf";

let anulIBytes: Uint8Array;
let anulIIBytes: Uint8Array;

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
  const [one, two] = await Promise.all([readFile(ANUL_I_SEED), readFile(ANUL_II_SEED)]);
  anulIBytes = new Uint8Array(one);
  anulIIBytes = new Uint8Array(two);
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  await rm(path.join(tempDir, "courses"), { recursive: true, force: true });
  await Promise.all([rm(packagedSeedOne, { force: true }), rm(packagedSeedTwo, { force: true })]);
  resetStorageCache();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  vi.useRealTimers();
  await rm(tempDir, { recursive: true, force: true });
});

type Route = { status?: number; body?: Uint8Array | string; headers?: Record<string, string> };

function stubFetch(routes: Record<string, Route> = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      const route = routes[url];
      if (!route) return new Response("not found", { status: 404 });
      const body = route.body instanceof Uint8Array ? new Uint8Array(route.body) : route.body ?? "";
      return new Response(body, { status: route.status ?? 200, headers: route.headers ?? {} });
    }),
  );
  return calls;
}

/** Production's failure mode: both official endpoints behind a Cloudflare challenge. */
function cloudflareBlocked(extra: Record<string, Route> = {}): Record<string, Route> {
  const challenge: Route = {
    status: 403,
    body: "Just a moment...",
    headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
  };
  return { [PAGE_URL]: challenge, [WORDPRESS_URL]: challenge, ...extra };
}

describe("each course has its own verified seed", () => {
  it("describes two different official documents", () => {
    const one = courseSeed(1);
    const two = courseSeed(2);

    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(one!.originalUrl).toBe(ANUL_I_URL);
    expect(two!.originalUrl).toBe(ANUL_II_URL);
    expect(one!.sha256).toBe(ANUL_I_HASH);
    expect(two!.sha256).toBe(ANUL_II_HASH);
    // No field of one course's seed may name the other's file.
    expect(two!.pdfPath).not.toBe(one!.pdfPath);
    expect(two!.imagePdfPath).not.toBe(one!.imagePdfPath);
    expect(two!.mirrorUrl).not.toBe(one!.mirrorUrl);
    expect(two!.imagePdfPath).toMatch(/[\\/]seed[\\/]anul_ii_semestrul_iii-11\.pdf$/);
    expect(one!.imagePdfPath).toMatch(/[\\/]seed[\\/]anul_i_semestrul_i-18\.pdf$/);
  });

  it("ships bytes matching the hash each seed claims", () => {
    expect(sha256(anulIBytes)).toBe(ANUL_I_HASH);
    expect(sha256(anulIIBytes)).toBe(ANUL_II_HASH);
  });

  it("reads per-course overrides from per-course variables only", () => {
    // SCHEDULE_SEED_PDF was set for course 1 and SCHEDULE_SEED_PDF_2 for course 2.
    expect(courseSeed(1)!.pdfPath).toBe(packagedSeedOne);
    expect(courseSeed(2)!.pdfPath).toBe(packagedSeedTwo);
  });
});

describe("Anul II offline cold start", () => {
  it("bootstraps from the bundled Anul II PDF when discovery is blocked", async () => {
    await writeFile(packagedSeedTwo, anulIIBytes);
    const calls = stubFetch(cloudflareBlocked());

    const result = await checkForUpdates(2);

    expect(result).toMatchObject({
      course_year: 2,
      outcome: "seeded",
      pdf_url: ANUL_II_URL,
      source_pdf_hash: ANUL_II_HASH,
      groups: 26,
      lessons: 288,
    });

    const schedule = await getCurrentSchedule(2);
    expect(schedule?.metadata).toMatchObject({
      course_year: 2,
      academic_year: "2026/2027",
      semester: "Semestrul III",
      source_kind: "seed",
      source_pdf_url: ANUL_II_URL,
      source_pdf_hash: ANUL_II_HASH,
    });
    expect(schedule?.groups).toHaveLength(26);
    expect(schedule?.lessons).toHaveLength(288);
    expect(schedule?.warnings).toEqual([]);

    const state = await getSourceState(2);
    expect(state).toMatchObject({ last_result: "seeded", current_pdf_url: ANUL_II_URL, semester: "Semestrul III" });
    // A packaged file on disk means no mirror request at all.
    expect(calls).not.toContain(courseSeed(2)!.mirrorUrl);
    // Anul I is untouched by an Anul II bootstrap.
    expect(await getCurrentSchedule(1)).toBeNull();
  });

  it("falls back to its own repository mirror, hash-checked, when no file is packaged", async () => {
    const mirrorUrl = courseSeed(2)!.mirrorUrl;
    const calls = stubFetch(cloudflareBlocked({ [mirrorUrl]: { body: anulIIBytes } }));

    const result = await checkForUpdates(2);

    expect(result.outcome).toBe("seeded");
    expect(calls).toContain(mirrorUrl);
    // It must never reach for the Anul I mirror on Anul II's behalf.
    expect(calls).not.toContain(courseSeed(1)!.mirrorUrl);
    expect((await getCurrentSchedule(2))?.lessons).toHaveLength(288);
  });

  it("refuses mirror bytes that do not match the configured SHA-256", async () => {
    const mirrorUrl = courseSeed(2)!.mirrorUrl;
    const tampered = new Uint8Array(anulIIBytes);
    tampered[tampered.length - 1] ^= 0xff;
    stubFetch(cloudflareBlocked({ [mirrorUrl]: { body: tampered } }));

    const result = await checkForUpdates(2);

    expect(result.outcome).toBe("error");
    expect(result.message).toMatch(/SHA-256 mismatch/);
    expect(await getCurrentSchedule(2)).toBeNull();
  });
});

describe("a seed can only serve the course it belongs to", () => {
  it("rejects the Anul I timetable offered as the Anul II seed", async () => {
    // The exact confusion the course guard exists for: right shape, wrong document.
    await writeFile(packagedSeedTwo, anulIBytes);
    stubFetch(cloudflareBlocked());

    const result = await checkForUpdates(2);

    expect(result.outcome).not.toBe("seeded");
    expect(result.message).toMatch(/course year mismatch/);
    expect(result.message).toMatch(/course year 1/);
    expect(await getCurrentSchedule(2)).toBeNull();
    expect((await getSourceState(2)).current_pdf_url).toBeNull();
  });

  it("rejects the Anul II timetable offered as the Anul I seed", async () => {
    await writeFile(packagedSeedOne, anulIIBytes);
    stubFetch(cloudflareBlocked());

    const result = await checkForUpdates(1);

    expect(result.outcome).not.toBe("seeded");
    expect(result.message).toMatch(/course year mismatch/);
    expect(result.message).toMatch(/course year 2/);
    expect(await getCurrentSchedule(1)).toBeNull();
  });

  it("rejects Anul I bytes arriving from the Anul II mirror even with a matching hash", async () => {
    // A mirror that serves the wrong document cannot buy its way in with a hash override.
    const mirrorUrl = courseSeed(2)!.mirrorUrl;
    process.env.SCHEDULE_SEED_PDF_SHA256_2 = ANUL_I_HASH;
    vi.resetModules();
    const { checkForUpdates: freshCheck } = await import("@/lib/services/updater");
    const { resetStorageCache: freshReset, getCurrentSchedule: freshRead } = await import("@/lib/storage");
    freshReset();
    stubFetch(cloudflareBlocked({ [mirrorUrl]: { body: anulIBytes } }));

    try {
      const result = await freshCheck(2);
      expect(result.outcome).not.toBe("seeded");
      expect(result.message).toMatch(/course year mismatch/);
      expect(await freshRead(2)).toBeNull();
    } finally {
      delete process.env.SCHEDULE_SEED_PDF_SHA256_2;
      vi.resetModules();
    }
  });
});

describe("both courses bootstrap offline in the same process", () => {
  it("installs each course's own timetable, independently", async () => {
    await Promise.all([writeFile(packagedSeedOne, anulIBytes), writeFile(packagedSeedTwo, anulIIBytes)]);
    stubFetch(cloudflareBlocked());

    const one = await checkForUpdates(1);
    const two = await checkForUpdates(2);

    expect(one).toMatchObject({ course_year: 1, outcome: "seeded", groups: 41, lessons: 452 });
    expect(two).toMatchObject({ course_year: 2, outcome: "seeded", groups: 26, lessons: 288 });

    const [scheduleOne, scheduleTwo] = await Promise.all([getCurrentSchedule(1), getCurrentSchedule(2)]);
    expect(scheduleOne?.metadata).toMatchObject({ course_year: 1, semester: "Semestrul I", source_pdf_hash: ANUL_I_HASH });
    expect(scheduleTwo?.metadata).toMatchObject({ course_year: 2, semester: "Semestrul III", source_pdf_hash: ANUL_II_HASH });
    // Two genuinely different documents, side by side.
    const groupsOne = scheduleOne!.groups.map((group) => group.name);
    const groupsTwo = scheduleTwo!.groups.map((group) => group.name);
    expect(groupsOne.filter((name) => groupsTwo.includes(name))).toEqual([]);

    // Each course's source state describes its own document.
    expect((await getSourceState(1)).current_pdf_url).toBe(ANUL_I_URL);
    expect((await getSourceState(2)).current_pdf_url).toBe(ANUL_II_URL);
  });

  it("leaves the other course alone when one seed is missing", async () => {
    await writeFile(packagedSeedOne, anulIBytes);
    stubFetch(cloudflareBlocked());

    expect((await checkForUpdates(1)).outcome).toBe("seeded");
    // Course 2 has neither a packaged file nor a routed mirror here.
    expect((await checkForUpdates(2)).outcome).toBe("error");

    expect((await getCurrentSchedule(1))?.lessons).toHaveLength(452);
    expect(await getCurrentSchedule(2)).toBeNull();
    // Course 1 ends on its seed; the discovery failure stays recorded as a truthful
    // diagnostic rather than being erased, and course 2's own failure is separate.
    expect((await getSourceState(1)).last_result).toBe("seeded");
    expect((await getSourceState(1)).current_pdf_url).toBe(ANUL_I_URL);
    expect((await getSourceState(2)).last_result).toBe("error");
    expect((await getSourceState(2)).last_error).toMatch(/no bundled seed|not found|404/i);
  });
});

/**
 * The deployment situation this update creates: a long-lived Render volume still holds the
 * seed of the previous revision, the container ships a newer one, and FCIM is still behind
 * a Cloudflare challenge. Discovery keeps failing — the packaged baseline must move forward
 * anyway, for both courses, without either one borrowing the other's document.
 */
describe("a persisted older seed is promoted to the packaged one", () => {
  async function persistPreviousSeed(courseYear: number, file: string, url: string) {
    const { schedule } = await parsePdf(new Uint8Array(await readFile(file)), {
      source_page_url: PAGE_URL,
      source_pdf_url: url,
      source_kind: "seed",
      downloaded_at: "2026-09-01T00:00:00.000Z",
      course_year: courseYear,
    });
    await replaceCurrentSchedule(courseYear, schedule);
    await saveSourceState(courseYear, {
      current_pdf_url: url,
      current_pdf_hash: schedule.metadata.source_pdf_hash,
      last_check_at: "2026-09-01T00:00:00.000Z",
      last_success_at: "2026-09-01T00:00:00.000Z",
      last_result: "seeded",
      academic_year: schedule.metadata.academic_year,
      semester: schedule.metadata.semester,
    });
    return schedule;
  }

  it("moves Anul I -16 to -18 and Anul II -10 to -11 with the live source unreachable", async () => {
    await Promise.all([writeFile(packagedSeedOne, anulIBytes), writeFile(packagedSeedTwo, anulIIBytes)]);
    const [before, beforeTwo] = await Promise.all([
      persistPreviousSeed(1, PREVIOUS_ANUL_I_SEED, PREVIOUS_ANUL_I_URL),
      persistPreviousSeed(2, PREVIOUS_ANUL_II_SEED, PREVIOUS_ANUL_II_URL),
    ]);
    expect(before.lessons).toHaveLength(451);
    expect(beforeTwo.lessons).toHaveLength(288);

    stubFetch(cloudflareBlocked());

    // Discovery still fails. Promotion is independent of it.
    expect((await checkForUpdates(1)).outcome).toBe("error");
    expect((await checkForUpdates(2)).outcome).toBe("error");

    const [one, two] = await Promise.all([getCurrentSchedule(1), getCurrentSchedule(2)]);
    expect(one?.metadata).toMatchObject({
      source_pdf_url: ANUL_I_URL,
      source_pdf_hash: ANUL_I_HASH,
      source_kind: "seed",
      course_year: 1,
      semester: "Semestrul I",
    });
    expect(one?.groups).toHaveLength(41);
    expect(one?.lessons).toHaveLength(452);
    expect(one?.lessons.filter((lesson) => lesson.uncertain)).toHaveLength(0);

    expect(two?.metadata).toMatchObject({
      source_pdf_url: ANUL_II_URL,
      source_pdf_hash: ANUL_II_HASH,
      source_kind: "seed",
      course_year: 2,
      semester: "Semestrul III",
    });
    expect(two?.groups).toHaveLength(26);
    expect(two?.lessons).toHaveLength(288);
    expect(two?.lessons.filter((lesson) => lesson.uncertain)).toHaveLength(0);

    // Each course's recorded source moved to its own new document.
    expect((await getSourceState(1)).current_pdf_url).toBe(ANUL_I_URL);
    expect((await getSourceState(1)).current_pdf_hash).toBe(ANUL_I_HASH);
    expect((await getSourceState(2)).current_pdf_url).toBe(ANUL_II_URL);
    expect((await getSourceState(2)).current_pdf_hash).toBe(ANUL_II_HASH);
  });

  it("keeps a persisted seed that is already the packaged revision", async () => {
    await writeFile(packagedSeedOne, anulIBytes);
    await persistPreviousSeed(1, ANUL_I_SEED, ANUL_I_URL);
    stubFetch(cloudflareBlocked());

    expect((await checkForUpdates(1)).outcome).toBe("error");
    const served = await getCurrentSchedule(1);
    expect(served?.metadata).toMatchObject({ source_pdf_url: ANUL_I_URL, source_pdf_hash: ANUL_I_HASH });
    expect(served?.lessons).toHaveLength(452);
  });
});
