/**
 * One deployment, two independent schedule aggregates.
 *
 * Everything here runs against the real autumn 2026/2027 FCIM page and the two real
 * timetables it links (Anul I semestrul I, Anul II semestrul III), so "course 1 and
 * course 2 do not interfere" is proven on genuine documents rather than on fabricated
 * ones. What is asserted throughout: a write for one course never changes the other's
 * schedule, source state, conditional-request metadata or diagnostics.
 */
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Type-only: erased at compile time, so it cannot import the app before the env below is set.
import type { NextRequest } from "next/server";
import type { Schedule, SourceState } from "@/lib/models";

const tempDir = await mkdtemp(path.join(tmpdir(), "fcim-multi-"));
const packagedSeedPath = path.join(tempDir, "packaged-seed.pdf");

process.env.SCHEDULE_COURSES = "1,2";
process.env.SCHEDULE_DEFAULT_COURSE = "1";
process.env.SCHEDULE_DATA_DIR = tempDir;
process.env.DATABASE_URL = "";
process.env.SCHEDULE_WAYBACK_FALLBACK = "0";
process.env.SCHEDULE_WORDPRESS_FALLBACK = "0";
process.env.SCHEDULE_ADMIN_TOKEN = "";
process.env.SCHEDULE_SEED_PDF = packagedSeedPath;

const { NextRequest: NextRequestCtor } = await import("next/server");
const { DEFAULT_COURSE_YEAR, SUPPORTED_COURSE_YEARS, resolveCourseParam } = await import("@/lib/courses");
const { discoverPdf } = await import("@/lib/source/discovery");
const { parsePdf, sha256 } = await import("@/lib/parser");
const { checkForUpdates } = await import("@/lib/services/updater");
const { buildStatus } = await import("@/lib/services/schedule-service");
const { getCurrentSchedule, getSourceState, replaceCurrentSchedule, resetStorageCache, saveSourceState } =
  await import("@/lib/storage");

const health = (await import("@/app/api/health/route")).GET;
const statusRoute = (await import("@/app/api/status/route")).GET;
const groupsRoute = (await import("@/app/api/groups/route")).GET;
const scheduleRoute = (await import("@/app/api/schedule/route")).GET;
const groupScheduleRoute = (await import("@/app/api/schedule/[group]/route")).GET;
const groupTodayRoute = (await import("@/app/api/schedule/[group]/today/route")).GET;
const sourceRoute = (await import("@/app/api/source/route")).GET;

const PAGE_FIXTURE = path.join(__dirname, "fixtures", "orar-page-autumn-2026.html");
/** The two documents orar-page-autumn-2026.html actually links to. These tests exercise the
 *  live path, so they follow the captured page rather than whichever seed the app ships. */
const ANUL_I_PDF = path.join(__dirname, "fixtures", "anul_i_semestrul_i-9.pdf");
const ANUL_II_PDF = path.join(__dirname, "fixtures", "anul_ii_semestrul_iii-8.pdf");
const PAGE_URL = "https://fcim.utm.md/procesul-de-studii/orar/";
const ANUL_I_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf";
const ANUL_II_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-8.pdf";
const AUTUMN_2026 = new Date("2026-09-15T12:00:00.000Z");
/** A group that exists only in Anul I, and one that exists only in Anul II. */
const ANUL_I_GROUP = "SI-261";
const ANUL_II_GROUP = "SI-251";

let pageHtml: string;
let anulIBytes: Uint8Array;
let anulIIBytes: Uint8Array;
let anulISchedule: Schedule;
let anulIISchedule: Schedule;

async function parseFixture(bytes: Uint8Array, url: string, courseYear: number): Promise<Schedule> {
  const { schedule } = await parsePdf(bytes, {
    source_page_url: PAGE_URL,
    source_pdf_url: url,
    source_kind: "live",
    downloaded_at: "2026-09-01T00:00:00.000Z",
    course_year: courseYear,
  });
  return schedule;
}

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(AUTUMN_2026);
  const [html, anulI, anulII] = await Promise.all([
    readFile(PAGE_FIXTURE, "utf8"),
    readFile(ANUL_I_PDF),
    readFile(ANUL_II_PDF),
  ]);
  pageHtml = html;
  anulIBytes = new Uint8Array(anulI);
  anulIIBytes = new Uint8Array(anulII);
  anulISchedule = await parseFixture(anulIBytes, ANUL_I_URL, 1);
  anulIISchedule = await parseFixture(anulIIBytes, ANUL_II_URL, 2);
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  await rm(path.join(tempDir, "courses"), { recursive: true, force: true });
  await Promise.all([
    rm(path.join(tempDir, "current_schedule.json"), { force: true }),
    rm(path.join(tempDir, "metadata.json"), { force: true }),
    rm(packagedSeedPath, { force: true }),
  ]);
  resetStorageCache();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  vi.useRealTimers();
  await rm(tempDir, { recursive: true, force: true });
});

type Route = { status?: number; body?: Uint8Array | string; headers?: Record<string, string> };

function stubFetch(routes: Record<string, Route | ((init: RequestInit) => Route)>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
      const route = routes[url];
      if (!route) return new Response("not found", { status: 404 });
      const resolved = typeof route === "function" ? route(init ?? {}) : route;
      const body = resolved.body instanceof Uint8Array ? new Uint8Array(resolved.body) : resolved.body ?? "";
      return new Response(resolved.status === 304 ? null : body, {
        status: resolved.status ?? 200,
        headers: resolved.headers ?? {},
      });
    }),
  );
  return calls;
}

/** The live page plus both timetables, each PDF carrying its own validators. */
function bothCoursesOnline(overrides: Record<string, Route | ((init: RequestInit) => Route)> = {}) {
  return stubFetch({
    [PAGE_URL]: { body: pageHtml, headers: { "content-type": "text/html" } },
    [ANUL_I_URL]: { body: anulIBytes, headers: { "content-type": "application/pdf", etag: '"anul-i-v1"' } },
    [ANUL_II_URL]: { body: anulIIBytes, headers: { "content-type": "application/pdf", etag: '"anul-ii-v1"' } },
    ...overrides,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function get(url: string): NextRequest {
  return new NextRequestCtor(new URL(url, "http://localhost:8000")) as NextRequest;
}

function params(group: string) {
  return { params: Promise.resolve({ group }) };
}

async function body<T>(response: Response, expectedStatus = 200): Promise<T> {
  const payload = (await response.json()) as T;
  expect(response.status, `unexpected status; body: ${JSON.stringify(payload).slice(0, 300)}`).toBe(expectedStatus);
  return payload;
}

/** Put both courses on disk without any network traffic. */
async function installBothCourses() {
  await replaceCurrentSchedule(1, anulISchedule);
  await replaceCurrentSchedule(2, anulIISchedule);
  await saveSourceState(1, {
    current_pdf_url: ANUL_I_URL,
    current_pdf_hash: anulISchedule.metadata.source_pdf_hash,
    last_result: "updated",
    last_check_at: "2026-09-01T00:00:00.000Z",
    last_success_at: "2026-09-01T00:00:00.000Z",
    academic_year: "2026/2027",
    semester: "Semestrul I",
  });
  await saveSourceState(2, {
    current_pdf_url: ANUL_II_URL,
    current_pdf_hash: anulIISchedule.metadata.source_pdf_hash,
    last_result: "updated",
    last_check_at: "2026-09-01T00:00:00.000Z",
    last_success_at: "2026-09-01T00:00:00.000Z",
    academic_year: "2026/2027",
    semester: "Semestrul III",
  });
}

describe("supported course configuration", () => {
  it("serves Anul I and Anul II with Anul I as the compatibility default", () => {
    expect([...SUPPORTED_COURSE_YEARS]).toEqual([1, 2]);
    expect(DEFAULT_COURSE_YEAR).toBe(1);
  });

  it("resolves an omitted course to the default and rejects every other shape", () => {
    const resolve = (query: string) => resolveCourseParam(new URLSearchParams(query));

    // Absent is the only implicit case: pre-multi-course clients keep working.
    expect(resolve("")).toEqual({ ok: true, courseYear: 1, supplied: false });
    expect(resolve("group=SI-261")).toEqual({ ok: true, courseYear: 1, supplied: false });
    expect(resolve("course=1")).toEqual({ ok: true, courseYear: 1, supplied: true });
    expect(resolve("course=2")).toEqual({ ok: true, courseYear: 2, supplied: true });

    // A present-but-unusable value is an error, never a silent fall back to course 1.
    for (const query of [
      "course=",
      "course=%20",
      "course=%20%20",
      "course=01",
      "course=1.0",
      "course=1x",
      "course=+1",
      "course=abc",
      "course=0",
      "course=-1",
      "course=3",
      "course=%201",
      "course=1%20",
    ]) {
      expect(resolve(query).ok, query).toBe(false);
    }

    // A repeated parameter is ambiguous; neither value may win.
    expect(resolve("course=1&course=2").ok).toBe(false);
    expect(resolve("course=&course=2").ok).toBe(false);
    expect(resolve("course=2&course=2").ok).toBe(false);
  });
});

describe("storage isolation", () => {
  it("keeps two schedules side by side, each in its own file", async () => {
    await replaceCurrentSchedule(1, anulISchedule);
    await replaceCurrentSchedule(2, anulIISchedule);

    const [one, two] = await Promise.all([getCurrentSchedule(1), getCurrentSchedule(2)]);
    expect(one?.metadata.course_year).toBe(1);
    expect(one?.metadata.semester).toBe("Semestrul I");
    expect(one?.groups).toHaveLength(41);
    expect(one?.lessons).toHaveLength(449);
    expect(two?.metadata.course_year).toBe(2);
    expect(two?.metadata.semester).toBe("Semestrul III");
    expect(two?.groups).toHaveLength(26);
    expect(two?.lessons).toHaveLength(288);
    // The group columns of the two documents are genuinely different sets.
    expect(one?.groups.map((group) => group.name)).toContain(ANUL_I_GROUP);
    expect(one?.groups.map((group) => group.name)).not.toContain(ANUL_II_GROUP);
    expect(two?.groups.map((group) => group.name)).toContain(ANUL_II_GROUP);
    expect(two?.groups.map((group) => group.name)).not.toContain(ANUL_I_GROUP);

    await expect(stat(path.join(tempDir, "courses", "1", "current_schedule.json"))).resolves.toBeDefined();
    await expect(stat(path.join(tempDir, "courses", "2", "current_schedule.json"))).resolves.toBeDefined();
  });

  it("survives a cold read from disk with the memory cache dropped", async () => {
    await replaceCurrentSchedule(1, anulISchedule);
    await replaceCurrentSchedule(2, anulIISchedule);
    resetStorageCache();

    expect((await getCurrentSchedule(2))?.metadata.source_pdf_hash).toBe(anulIISchedule.metadata.source_pdf_hash);
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(anulISchedule.metadata.source_pdf_hash);
  });

  it("writing one course's source state leaves the other's untouched", async () => {
    await saveSourceState(1, {
      current_pdf_url: ANUL_I_URL,
      current_pdf_hash: "hash-one",
      etag: '"anul-i-v1"',
      last_modified: "Mon, 01 Sep 2026 00:00:00 GMT",
      last_result: "updated",
      last_success_at: "2026-09-01T00:00:00.000Z",
      semester: "Semestrul I",
    });
    const beforeCourseTwo = { ...(await getSourceState(1)) };

    await saveSourceState(2, {
      current_pdf_url: ANUL_II_URL,
      current_pdf_hash: "hash-two",
      etag: '"anul-ii-v1"',
      last_modified: "Tue, 02 Sep 2026 00:00:00 GMT",
      last_result: "error",
      last_error: "boom",
      last_error_at: "2026-09-02T00:00:00.000Z",
      semester: "Semestrul III",
    });

    expect({ ...(await getSourceState(1)) }).toEqual(beforeCourseTwo);
    const two = await getSourceState(2);
    expect(two.current_pdf_hash).toBe("hash-two");
    expect(two.last_error).toBe("boom");
    // Course 1 never inherits course 2's failure.
    expect((await getSourceState(1)).last_error).toBeNull();
    expect((await getSourceState(1)).last_result).toBe("updated");
  });

  it("refuses to store a schedule under a slot of another course year", async () => {
    await expect(replaceCurrentSchedule(2, anulISchedule)).rejects.toThrow(/course year 1 schedule under course year 2/);
    await expect(replaceCurrentSchedule(1, anulIISchedule)).rejects.toThrow(/course year 2 schedule under course year 1/);
    expect(await getCurrentSchedule(1)).toBeNull();
    expect(await getCurrentSchedule(2)).toBeNull();
  });
});

describe("legacy single-course cache", () => {
  /** The pre-multi-course layout: files directly in the data directory. */
  async function writeLegacyCache(schedule: Schedule, state: Partial<SourceState>) {
    await mkdir(tempDir, { recursive: true });
    await writeFile(path.join(tempDir, "current_schedule.json"), JSON.stringify(schedule), "utf8");
    await writeFile(path.join(tempDir, "metadata.json"), JSON.stringify({ ...EMPTY_STATE, ...state }), "utf8");
  }

  const EMPTY_STATE: SourceState = {
    current_pdf_url: null,
    current_pdf_hash: null,
    etag: null,
    last_modified: null,
    last_check_at: null,
    last_success_at: null,
    last_error: null,
    last_error_at: null,
    last_result: "never",
    academic_year: null,
    semester: null,
    parity_note: null,
  };

  it("adopts an Anul I cache for course 1, with its source state", async () => {
    await writeLegacyCache(anulISchedule, {
      current_pdf_url: ANUL_I_URL,
      current_pdf_hash: anulISchedule.metadata.source_pdf_hash,
      etag: '"legacy-etag"',
      last_result: "updated",
    });

    const adopted = await getCurrentSchedule(1);
    expect(adopted?.metadata.source_pdf_hash).toBe(anulISchedule.metadata.source_pdf_hash);
    expect((await getSourceState(1)).etag).toBe('"legacy-etag"');
    // The adoption is a copy into the scoped layout; the legacy files stay where they were.
    await expect(stat(path.join(tempDir, "courses", "1", "current_schedule.json"))).resolves.toBeDefined();
    await expect(stat(path.join(tempDir, "current_schedule.json"))).resolves.toBeDefined();
  });

  it("never adopts an Anul I cache for course 2", async () => {
    await writeLegacyCache(anulISchedule, {
      current_pdf_url: ANUL_I_URL,
      etag: '"legacy-etag"',
      last_result: "updated",
    });

    expect(await getCurrentSchedule(2)).toBeNull();
    // Not even the conditional-request metadata leaks across: a stale ETag would make
    // the next Anul II check answer 304 for a document course 2 does not have.
    expect((await getSourceState(2)).etag).toBeNull();
    await expect(stat(path.join(tempDir, "courses", "2", "current_schedule.json"))).rejects.toThrow();
  });

  it("leaves a scoped cache alone when a legacy file is also present", async () => {
    await replaceCurrentSchedule(1, anulISchedule);
    resetStorageCache();
    const older = await parseFixture(
      new Uint8Array(await readFile(path.join(__dirname, "fixtures", "anul_i_semestrul_i-5.pdf"))),
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-5.pdf",
      1,
    );
    await writeLegacyCache(older, { current_pdf_url: "https://example.invalid/old.pdf" });

    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(anulISchedule.metadata.source_pdf_hash);
  });
});

describe("discovery per course", () => {
  it("resolves both timetables from the same official page without shared state", () => {
    const one = discoverPdf(pageHtml, 1, AUTUMN_2026);
    const two = discoverPdf(pageHtml, 2, AUTUMN_2026);
    const oneAgain = discoverPdf(pageHtml, 1, AUTUMN_2026);

    expect(one.pdf_url).toBe(ANUL_I_URL);
    expect(two.pdf_url).toBe(ANUL_II_URL);
    expect(one.academic_year).toBe("2026/2027");
    expect(two.academic_year).toBe("2026/2027");
    // Discovering course 2 in between cannot change what course 1 resolves to.
    expect(oneAgain).toEqual(one);
  });
});

describe("update isolation", () => {
  it("keeps each course's conditional metadata across the other's activity", async () => {
    const calls = bothCoursesOnline();

    const first = await checkForUpdates(1);
    const second = await checkForUpdates(2);
    const third = await checkForUpdates(1);

    expect(first).toMatchObject({ course_year: 1, outcome: "updated", pdf_url: ANUL_I_URL, groups: 41 });
    expect(second).toMatchObject({ course_year: 2, outcome: "updated", pdf_url: ANUL_II_URL, groups: 26 });
    // The third call is a plain re-check of course 1: its own ETag survived course 2's update.
    expect(third).toMatchObject({ course_year: 1, outcome: "unchanged" });
    const conditional = calls.filter((call) => call.url === ANUL_I_URL && call.headers["if-none-match"]);
    expect(conditional.at(-1)?.headers["if-none-match"]).toBe('"anul-i-v1"');

    const [stateOne, stateTwo] = await Promise.all([getSourceState(1), getSourceState(2)]);
    expect(stateOne).toMatchObject({ current_pdf_url: ANUL_I_URL, etag: '"anul-i-v1"', semester: "Semestrul I" });
    expect(stateTwo).toMatchObject({ current_pdf_url: ANUL_II_URL, etag: '"anul-ii-v1"', semester: "Semestrul III" });
    expect((await getCurrentSchedule(1))?.lessons).toHaveLength(449);
    expect((await getCurrentSchedule(2))?.lessons).toHaveLength(288);
  });

  it("lets one course fail while the other stays healthy, each with its own diagnostics", async () => {
    await installBothCourses();
    // Only the Anul II document is unreachable; discovery and Anul I keep working.
    bothCoursesOnline({ [ANUL_II_URL]: { status: 503, body: "upstream down" } });

    const one = await checkForUpdates(1);
    const two = await checkForUpdates(2);

    expect(one.outcome).toBe("unchanged");
    expect(two.outcome).toBe("error");

    const [stateOne, stateTwo] = await Promise.all([getSourceState(1), getSourceState(2)]);
    expect(stateOne.last_result).toBe("unchanged");
    expect(stateOne.last_error).toBeNull();
    expect(stateTwo.last_result).toBe("error");
    expect(stateTwo.last_error).toBeTruthy();
    // Both last-known-good schedules are still served.
    expect((await getCurrentSchedule(1))?.lessons).toHaveLength(449);
    expect((await getCurrentSchedule(2))?.lessons).toHaveLength(288);
    expect((await buildStatus(1)).has_schedule).toBe(true);
    expect((await buildStatus(2)).has_schedule).toBe(true);
  });

  it("isolates the failure the other way round as well", async () => {
    await installBothCourses();
    bothCoursesOnline({ [ANUL_I_URL]: { status: 503, body: "upstream down" } });

    expect((await checkForUpdates(2)).outcome).toBe("unchanged");
    expect((await checkForUpdates(1)).outcome).toBe("error");

    expect((await getSourceState(2)).last_error).toBeNull();
    expect((await getSourceState(1)).last_error).toBeTruthy();
    expect((await getCurrentSchedule(1))?.lessons).toHaveLength(449);
    expect((await getCurrentSchedule(2))?.lessons).toHaveLength(288);
  });
});

describe("update concurrency", () => {
  it("coalesces two overlapping ordinary checks of the same course", async () => {
    const started = deferred();
    const release = deferred();
    let pageRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === PAGE_URL) {
          pageRequests += 1;
          started.resolve();
          await release.promise;
          return new Response(pageHtml, { headers: { "content-type": "text/html" } });
        }
        if (url === ANUL_I_URL) {
          return new Response(new Uint8Array(anulIBytes), { headers: { "content-type": "application/pdf" } });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const first = checkForUpdates(1);
    await started.promise;
    const second = checkForUpdates(1);
    expect(second).toBe(first);

    release.resolve();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two);
    expect(one.outcome).toBe("updated");
    expect(pageRequests).toBe(1);
  });

  it("never shares a run between two different courses", async () => {
    const started = deferred();
    const release = deferred();
    const pdfRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === PAGE_URL) {
          if (pdfRequests.length === 0) {
            started.resolve();
            await release.promise;
          }
          return new Response(pageHtml, { headers: { "content-type": "text/html" } });
        }
        if (url === ANUL_I_URL || url === ANUL_II_URL) {
          pdfRequests.push(url);
          const bytes = url === ANUL_I_URL ? anulIBytes : anulIIBytes;
          return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf" } });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const one = checkForUpdates(1);
    await started.promise;
    const two = checkForUpdates(2);
    expect(two).not.toBe(one);

    release.resolve();
    const [resultOne, resultTwo] = await Promise.all([one, two]);
    expect(resultOne.course_year).toBe(1);
    expect(resultTwo.course_year).toBe(2);
    expect(resultOne.pdf_url).toBe(ANUL_I_URL);
    expect(resultTwo.pdf_url).toBe(ANUL_II_URL);
    expect(resultOne).not.toEqual(resultTwo);
    // Both documents were actually downloaded: neither course inherited the other's result.
    expect(pdfRequests).toEqual([ANUL_I_URL, ANUL_II_URL]);
    expect((await getCurrentSchedule(1))?.metadata.course_year).toBe(1);
    expect((await getCurrentSchedule(2))?.metadata.course_year).toBe(2);
  });

  it("queues a forced check of a course behind its own in-flight ordinary check", async () => {
    const started = deferred();
    const release = deferred();
    const events: string[] = [];
    let pageRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === PAGE_URL) {
          const request = ++pageRequests;
          events.push(`page-${request}`);
          if (request === 1) {
            started.resolve();
            await release.promise;
          }
          return new Response(pageHtml, { headers: { "content-type": "text/html" } });
        }
        if (url === ANUL_I_URL) {
          events.push("pdf");
          return new Response(new Uint8Array(anulIBytes), { headers: { "content-type": "application/pdf" } });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const ordinary = checkForUpdates(1);
    await started.promise;
    const forced = checkForUpdates(1, { force: true });
    expect(forced).not.toBe(ordinary);

    release.resolve();
    const [ordinaryResult, forcedResult] = await Promise.all([ordinary, forced]);
    expect(events).toEqual(["page-1", "pdf", "page-2", "pdf"]);
    expect(ordinaryResult.outcome).toBe("updated");
    // The forced run re-parses the identical document instead of reporting "unchanged".
    expect(forcedResult.outcome).toBe("updated");
  });
});

describe("public API course selection", () => {
  beforeEach(async () => {
    await installBothCourses();
    resetStorageCache();
    // Every request below must be answered from disk; the read path may not go online.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("the read path must not touch the network");
    }));
  });

  it("serves a different dataset per course from the same process", async () => {
    const one = await body<{ course_year: number; groups: string[]; count: number; metadata: Schedule["metadata"] }>(
      await scheduleRoute(get("/api/schedule?course=1")),
    );
    const two = await body<{ course_year: number; groups: string[]; count: number; metadata: Schedule["metadata"] }>(
      await scheduleRoute(get("/api/schedule?course=2")),
    );

    expect(one.course_year).toBe(1);
    expect(one.count).toBe(449);
    expect(one.groups).toHaveLength(41);
    expect(one.metadata.semester).toBe("Semestrul I");
    expect(two.course_year).toBe(2);
    expect(two.count).toBe(288);
    expect(two.groups).toHaveLength(26);
    expect(two.metadata.semester).toBe("Semestrul III");
    expect(one.groups).not.toEqual(two.groups);
  });

  it("defaults an omitted course to Anul I", async () => {
    const payload = await body<{ course_year: number; count: number }>(await scheduleRoute(get("/api/schedule")));
    expect(payload).toMatchObject({ course_year: 1, count: 449 });
  });

  it("lists only the active course's groups", async () => {
    const one = await body<{ groups: { name: string }[] }>(await groupsRoute(get("/api/groups?course=1")));
    const two = await body<{ groups: { name: string }[] }>(await groupsRoute(get("/api/groups?course=2")));
    expect(one.groups.map((group) => group.name)).toContain(ANUL_I_GROUP);
    expect(one.groups.map((group) => group.name)).not.toContain(ANUL_II_GROUP);
    expect(two.groups.map((group) => group.name)).toContain(ANUL_II_GROUP);
    expect(two.groups.map((group) => group.name)).not.toContain(ANUL_I_GROUP);
  });

  it("reports each course's own status with no cross-contamination", async () => {
    const one = await body<{ course_year: number; schedule: { semester: string; lessons: number } }>(
      await statusRoute(get("/api/status?course=1")),
    );
    const two = await body<{
      course_year: number;
      course_label: string;
      supported_courses: { course_year: number }[];
      schedule: { semester: string; lessons: number; source_pdf_url: string };
    }>(await statusRoute(get("/api/status?course=2")));

    expect(one).toMatchObject({ course_year: 1, schedule: { semester: "Semestrul I", lessons: 449 } });
    expect(two).toMatchObject({ course_year: 2, schedule: { semester: "Semestrul III", lessons: 288 } });
    expect(two.course_label).toBe("Anul II");
    expect(two.schedule.source_pdf_url).toBe(ANUL_II_URL);
    expect(two.supported_courses.map((course) => course.course_year)).toEqual([1, 2]);
  });

  it("reports each course's own provenance", async () => {
    const one = await body<{ pdf_url: string }>(await sourceRoute(get("/api/source?course=1")));
    const two = await body<{ pdf_url: string }>(await sourceRoute(get("/api/source?course=2")));
    expect(one.pdf_url).toBe(ANUL_I_URL);
    expect(two.pdf_url).toBe(ANUL_II_URL);
  });

  it("projects a group onto the course it was asked for", async () => {
    const payload = await body<{ group: string; course_year: number; count: number }>(
      await groupScheduleRoute(get(`/api/schedule/${ANUL_II_GROUP}?course=2`), params(ANUL_II_GROUP)),
    );
    expect(payload).toMatchObject({ group: ANUL_II_GROUP, course_year: 2 });
    expect(payload.count).toBeGreaterThan(0);

    const today = await body<{ group: string; course_year: number }>(
      await groupTodayRoute(get(`/api/schedule/${ANUL_II_GROUP}/today?course=2`), params(ANUL_II_GROUP)),
    );
    expect(today).toMatchObject({ group: ANUL_II_GROUP, course_year: 2 });
  });

  it("does not resolve a group against a course it does not belong to", async () => {
    // The Anul II group must not be found in the Anul I timetable, and vice versa.
    const wrongCourse = await groupScheduleRoute(get(`/api/schedule/${ANUL_II_GROUP}?course=1`), params(ANUL_II_GROUP));
    expect(wrongCourse.status).toBe(404);
    const other = await groupScheduleRoute(get(`/api/schedule/${ANUL_I_GROUP}?course=2`), params(ANUL_I_GROUP));
    expect(other.status).toBe(404);
  });

  it("rejects every unusable course selector instead of falling back to Anul I", async () => {
    // Empty, padded and zero-padded values are the dangerous ones: a lenient parse turns
    // them into course 1 and answers a question the caller did not ask.
    const rejected = [
      "course=3",
      "course=abc",
      "course=0",
      "course=-1",
      "course=1.5",
      "course=",
      "course=%20",
      "course=01",
      "course=1x",
      "course=%201",
      "course=1&course=2",
      "course=&course=2",
    ];
    for (const query of rejected) {
      const response = await scheduleRoute(get(`/api/schedule?${query}`));
      const payload = (await response.json()) as { error: string; supported_courses: number[] };
      expect(response.status, query).toBe(400);
      expect(payload.error, query).toMatch(/Invalid course selector/);
      expect(payload.supported_courses).toEqual([1, 2]);
      // Nothing of either course's data may leak through a rejected request.
      expect(JSON.stringify(payload), query).not.toMatch(/SI-261|TI-251/);
    }

    for (const route of [groupsRoute, statusRoute, sourceRoute]) {
      for (const query of ["course=9", "course=", "course=01", "course=1&course=2"]) {
        expect((await route(get(`/api/x?${query}`))).status, query).toBe(400);
      }
    }
    for (const query of ["course=9", "course=", "course=01", "course=1&course=2"]) {
      expect(
        (await groupScheduleRoute(get(`/api/schedule/${ANUL_I_GROUP}?${query}`), params(ANUL_I_GROUP))).status,
        query,
      ).toBe(400);
      expect(
        (await groupTodayRoute(get(`/api/schedule/${ANUL_I_GROUP}/today?${query}`), params(ANUL_I_GROUP))).status,
        query,
      ).toBe(400);
    }
  });

  it("reports deployment health per course", async () => {
    const payload = await body<{ ok: boolean; has_schedule: boolean; courses: { course_year: number; has_schedule: boolean }[] }>(
      await health(),
    );
    expect(payload).toMatchObject({ ok: true, has_schedule: true });
    expect(payload.courses).toEqual([
      { course_year: 1, has_schedule: true },
      { course_year: 2, has_schedule: true },
    ]);
  });

  it("stays operational when only one course has data", async () => {
    await rm(path.join(tempDir, "courses", "2"), { recursive: true, force: true });
    resetStorageCache();

    const payload = await body<{ ok: boolean; has_schedule: boolean; courses: { course_year: number; has_schedule: boolean }[] }>(
      await health(),
    );
    expect(payload.ok).toBe(true);
    expect(payload.has_schedule).toBe(true);
    expect(payload.courses).toEqual([
      { course_year: 1, has_schedule: true },
      { course_year: 2, has_schedule: false },
    ]);
    // The per-course endpoint is where the missing timetable is visible.
    expect((await statusRoute(get("/api/status?course=1"))).status).toBe(200);
    const two = await body<{ has_schedule: boolean }>(await statusRoute(get("/api/status?course=2")));
    expect(two.has_schedule).toBe(false);
  });
});

describe("sanity of the fixtures behind these assertions", () => {
  it("uses two genuinely different official documents", () => {
    expect(anulISchedule.metadata.pdf_title).toMatch(/ANUL I, SEMESTRUL I/);
    expect(anulIISchedule.metadata.pdf_title).toMatch(/ANUL II, SEMESTRUL III/);
    expect(sha256(anulIBytes)).not.toBe(sha256(anulIIBytes));
    expect(anulIISchedule.warnings).toEqual([]);
    expect(anulIISchedule.lessons.filter((lesson) => lesson.uncertain)).toHaveLength(0);
  });
});
