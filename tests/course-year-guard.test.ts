/**
 * Each course slot holds exactly one course year's timetable. Whatever happens to
 * discovery, seeding or an authenticated recovery, a schedule that belongs to another
 * course year must never be installed — and one course's failure must never disturb
 * the other's data.
 *
 * Everything here runs on a deployment that serves Anul I *and* Anul II while the only
 * real PDF available anywhere — packaged seed, repository mirror, even the discovered
 * document — is the bundled Anul I timetable. Nothing may reach Anul II readers in that
 * situation, and Anul I must keep working throughout.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Type-only: erased at compile time, so it cannot import the app before the env below is set.
import type { NextRequest } from "next/server";
import type { Schedule } from "@/lib/models";

const SEED_HASH = "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a";
const SEED_MIRROR_URL =
  "https://raw.githubusercontent.com/barbalatv/utm-curs-i-orar-2027/main/data/seed/anul_i_semestrul_i-18.pdf";
const ANUL_II_MIRROR_URL =
  "https://raw.githubusercontent.com/barbalatv/utm-curs-i-orar-2027/main/data/seed/anul_ii_semestrul_iii-11.pdf";
const tempDir = await mkdtemp(path.join(tmpdir(), "fcim-course2-"));
const packagedSeedPath = path.join(tempDir, "packaged-seed.pdf");
/** Anul II's own packaged seed slot; these tests control what is placed in it. */
const packagedSeedTwoPath = path.join(tempDir, "packaged-seed-anul-ii.pdf");

process.env.SCHEDULE_COURSES = "1,2";
process.env.SCHEDULE_DATA_DIR = tempDir;
process.env.DATABASE_URL = "";
process.env.SCHEDULE_WAYBACK_FALLBACK = "0";
process.env.SCHEDULE_ADMIN_TOKEN = "test-admin-token";
process.env.SCHEDULE_SEED_PDF = packagedSeedPath;
process.env.SCHEDULE_SEED_PDF_MIRROR_URL = SEED_MIRROR_URL;
process.env.SCHEDULE_SEED_PDF_SHA256 = SEED_HASH;
process.env.SCHEDULE_SEED_PDF_2 = packagedSeedTwoPath;

const { NextRequest: NextRequestCtor } = await import("next/server");
const { courseSeed, SUPPORTED_COURSE_YEARS } = await import("@/lib/courses");
const { parsePdf, sha256 } = await import("@/lib/parser");
const { checkForUpdates } = await import("@/lib/services/updater");
const { buildStatus } = await import("@/lib/services/schedule-service");
const { getCurrentSchedule, getSourceState, replaceCurrentSchedule, resetStorageCache, saveSourceState } =
  await import("@/lib/storage");
const scheduleRoute = (await import("@/app/api/schedule/route")).GET;
const adminRefresh = (await import("@/app/api/admin/refresh/route")).POST;

/** The bundled Anul I PDF, i.e. the seed Anul II must never receive. */
const ANUL_I_SEED = path.join(__dirname, "..", "data", "seed", "anul_i_semestrul_i-18.pdf");
/** An older published Anul I timetable, used as pre-existing cache content. */
const ANUL_I_OLD = path.join(__dirname, "fixtures", "anul_i_semestrul_i-5.pdf");
const PAGE_URL = "https://fcim.utm.md/procesul-de-studii/orar/";
const WORDPRESS_URL = "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view";
const OLD_SEED_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-5.pdf";
const NEW_SEED_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf";
const ANUL_II_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-11.pdf";
const AUTUMN_2026 = new Date("2026-09-15T12:00:00.000Z");

let seedBytes: Uint8Array;
let oldBytes: Uint8Array;
let oldSchedule: Schedule;

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(AUTUMN_2026);
  const [seed, old] = await Promise.all([readFile(ANUL_I_SEED), readFile(ANUL_I_OLD)]);
  seedBytes = new Uint8Array(seed);
  oldBytes = new Uint8Array(old);
  ({ schedule: oldSchedule } = await parsePdf(oldBytes, {
    source_page_url: PAGE_URL,
    source_pdf_url: OLD_SEED_URL,
    source_kind: "seed",
    downloaded_at: "2026-09-01T00:00:00.000Z",
  }));
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all([
    rm(path.join(tempDir, "courses"), { recursive: true, force: true }),
    rm(packagedSeedPath, { force: true }),
    rm(packagedSeedTwoPath, { force: true }),
  ]);
  resetStorageCache();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  vi.useRealTimers();
  await rm(tempDir, { recursive: true, force: true });
});

type Route = { status?: number; body?: Uint8Array | string; headers?: Record<string, string> };

function stubFetch(routes: Record<string, Route>) {
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

/** Both official endpoints behind a Cloudflare challenge: automatic discovery is unavailable. */
function blockedDiscovery(): Record<string, Route> {
  const challenge: Route = {
    status: 403,
    body: "Just a moment...",
    headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
  };
  return { [PAGE_URL]: challenge, [WORDPRESS_URL]: challenge };
}

function adminRequest(body: unknown): NextRequest {
  return new NextRequestCtor(new URL("/api/admin/refresh", "http://localhost:8000"), {
    method: "POST",
    headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

/** Nothing may reach a reader of a course that has no schedule of its own course year. */
async function expectNothingServed(courseYear: number) {
  expect(await getCurrentSchedule(courseYear)).toBeNull();
  const status = await buildStatus(courseYear);
  expect(status.has_schedule).toBe(false);
  expect(status.schedule).toBeNull();

  const request = new NextRequestCtor(
    new URL(`/api/schedule?course=${courseYear}`, "http://localhost:8000"),
  ) as NextRequest;
  const response = await scheduleRoute(request);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toMatch(/SI-261/);
}

describe("wrong-course installation guard", () => {
  it("gives each course its own seed, described by its own settings", () => {
    expect([...SUPPORTED_COURSE_YEARS]).toEqual([1, 2]);
    // Both courses now ship a verified PDF; neither is describable by the other's knobs.
    expect(courseSeed(1)?.pdfPath).toBe(packagedSeedPath);
    expect(courseSeed(2)?.pdfPath).toBe(packagedSeedTwoPath);
    expect(courseSeed(1)?.mirrorUrl).toBe(SEED_MIRROR_URL);
    expect(courseSeed(2)?.mirrorUrl).toBe(ANUL_II_MIRROR_URL);
  });

  it("installs nothing for Anul II when the Anul I timetable is placed in its seed slot", async () => {
    // Both courses' packaged files hold Anul I bytes. Course 2's must be refused outright.
    await Promise.all([writeFile(packagedSeedPath, seedBytes), writeFile(packagedSeedTwoPath, seedBytes)]);
    const calls = stubFetch(blockedDiscovery());

    const result = await checkForUpdates(2);

    expect(result.course_year).toBe(2);
    expect(result.outcome).not.toBe("seeded");
    expect(result.message).toMatch(/course year mismatch/);
    // Anul II never reaches into Anul I's mirror to look for something usable.
    expect(calls).not.toContain(SEED_MIRROR_URL);
    await expectNothingServed(2);

    const state = await getSourceState(2);
    expect(state).toMatchObject({ current_pdf_url: null, current_pdf_hash: null });
    expect(state.last_error).toMatch(/Cloudflare challenge/);
    expect(state.last_error_at).not.toBeNull();
  });

  it("never reaches for the Anul I repository mirror on behalf of Anul II", async () => {
    // No packaged and no image seed on disk: for course 1 this is where the mirror is fetched.
    const calls = stubFetch({ ...blockedDiscovery(), [SEED_MIRROR_URL]: { body: seedBytes } });

    const result = await checkForUpdates(2);

    expect(sha256(seedBytes)).toBe(SEED_HASH);
    expect(calls).not.toContain(SEED_MIRROR_URL);
    expect(result.outcome).toBe("error");
    await expectNothingServed(2);
  });

  it("refuses a discovered PDF whose contents belong to another course year", async () => {
    // The page advertises an Anul II document; the bytes behind it are the Anul I timetable.
    const title = "Ciclul I, Licență - învățământ cu frecvență";
    const page =
      `<html><body><div class="togglecontainer"><p data-title="${title}">${title}</p><table><tbody>` +
      `<tr><td>Orar Semestrul de TOAMNĂ a.u.2026/2027</td>` +
      `<td><a href="${ANUL_II_URL}">Anul II</a></td></tr></tbody></table></div></body></html>`;
    stubFetch({
      [PAGE_URL]: { body: page, headers: { "content-type": "text/html" } },
      [ANUL_II_URL]: { body: seedBytes, headers: { "content-type": "application/pdf" } },
    });

    const result = await checkForUpdates(2);

    expect(result.outcome).toBe("rejected");
    expect(result.message).toMatch(/course year mismatch/);
    expect(result.message).toMatch(/course year 1/);
    await expectNothingServed(2);
    const state = await getSourceState(2);
    expect(state.last_result).toBe("rejected");
    expect(state.last_error).toMatch(/course year mismatch/);
  });

  it("refuses an authenticated Anul I recovery requested for Anul II and leaves both courses alone", async () => {
    // Anul I is healthy and cached; Anul II holds nothing.
    await writeFile(packagedSeedPath, seedBytes);
    stubFetch(blockedDiscovery());
    expect((await checkForUpdates(1)).outcome).toBe("seeded");
    const anulIHash = (await getCurrentSchedule(1))?.metadata.source_pdf_hash;
    const anulIState = { ...(await getSourceState(1)) };

    stubFetch({ [NEW_SEED_URL]: { body: seedBytes, headers: { "content-type": "application/pdf" } } });
    const payload = await (await adminRefresh(adminRequest({ course: 2, pdf_url: NEW_SEED_URL }))).json();

    expect(payload).toMatchObject({ course_year: 2, outcome: "rejected" });
    expect(payload.message).toMatch(/course year mismatch/);
    await expectNothingServed(2);
    // Anul I is untouched: same schedule, same source state.
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(anulIHash);
    expect({ ...(await getSourceState(1)) }).toEqual(anulIState);
  });

  it("requires an explicit course before it will recover from a PDF URL", async () => {
    const response = await adminRefresh(adminRequest({ pdf_url: NEW_SEED_URL }));
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; supported_courses: number[] };
    expect(payload.error).toMatch(/course is required/);
    expect(payload.supported_courses).toEqual([1, 2]);
  });

  it("rejects a refresh for a course this deployment does not serve", async () => {
    const response = await adminRefresh(adminRequest({ course: 3 }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/unknown course "3"/);
  });

  it("keeps the Anul I seed path working when Anul II has nothing to install", async () => {
    // Only Anul I's slot is filled here (production ships both — see seed-cold-start), so
    // Anul II must fail on its own rather than reaching for what Anul I has.
    await writeFile(packagedSeedPath, seedBytes);
    stubFetch(blockedDiscovery());

    const anulI = await checkForUpdates(1);
    const anulII = await checkForUpdates(2);

    expect(anulI).toMatchObject({ course_year: 1, outcome: "seeded", pdf_url: NEW_SEED_URL });
    const served = await getCurrentSchedule(1);
    expect(served?.metadata).toMatchObject({ course_year: 1, source_kind: "seed" });
    expect(served?.groups).toHaveLength(41);
    expect(anulII.outcome).toBe("error");
    await expectNothingServed(2);
  });

  it("never promotes another course's packaged seed over a cached schedule", async () => {
    // Anul II holds a seed-sourced schedule of its own course year; the packaged Anul I
    // seed is newer by revision. Promotion is the one seed path that runs with a schedule
    // already present, and it must not cross course boundaries.
    await writeFile(packagedSeedPath, seedBytes);
    const anulIICache: Schedule = {
      ...oldSchedule,
      metadata: { ...oldSchedule.metadata, course_year: 2, source_pdf_url: OLD_SEED_URL, source_kind: "seed" },
    };
    await replaceCurrentSchedule(2, anulIICache);
    await saveSourceState(2, {
      current_pdf_url: OLD_SEED_URL,
      current_pdf_hash: anulIICache.metadata.source_pdf_hash,
      last_result: "seeded",
    });
    stubFetch(blockedDiscovery());

    expect((await checkForUpdates(2)).outcome).toBe("error");

    const served = await getCurrentSchedule(2);
    expect(served?.metadata.source_pdf_hash).toBe(anulIICache.metadata.source_pdf_hash);
    expect(served?.metadata.source_pdf_url).toBe(OLD_SEED_URL);
    expect(served?.metadata.course_year).toBe(2);
    expect(sha256(seedBytes)).not.toBe(served?.metadata.source_pdf_hash);
    expect(oldBytes.byteLength).toBeGreaterThan(0);
    expect((await getSourceState(2)).current_pdf_url).toBe(OLD_SEED_URL);
  });

  it("refuses to write a schedule into a slot of a different course year", async () => {
    // The last line of defence, below the updater's guard: storage checks the document itself.
    await expect(replaceCurrentSchedule(2, oldSchedule)).rejects.toThrow(/course year 1 schedule under course year 2/);
    expect(await getCurrentSchedule(2)).toBeNull();
  });
});
