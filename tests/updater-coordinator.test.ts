/**
 * The update coordinator must be process-global, not module-global.
 *
 * Next.js bundles the instrumentation hook (which runs the scheduler) separately from the
 * route handlers (which serve /api/admin/refresh and cold-start reads), so this module is
 * evaluated more than once inside one Node process. With the queue in module scope, the
 * scheduler and the API each got their own — two "serialized" writers running at the same
 * time, and two ordinary checks of the same course downloading and parsing in parallel.
 *
 * `vi.resetModules()` reproduces that exactly: the next import re-evaluates the module in
 * the same process, giving a second instance whose globals are shared but whose module
 * scope is not. Everything below asserts that the second instance coordinates with the
 * first. The deployment stays single-process; nothing here is a distributed lock.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tempDir = await mkdtemp(path.join(tmpdir(), "fcim-coord-"));
process.env.SCHEDULE_COURSES = "1,2";
process.env.SCHEDULE_DATA_DIR = tempDir;
process.env.DATABASE_URL = "";
process.env.SCHEDULE_WAYBACK_FALLBACK = "0";
process.env.SCHEDULE_WORDPRESS_FALLBACK = "0";
// Both courses now ship a seed, so point course 2's at a path that does not exist: these
// tests are about coordination, and a successful seed fallback would mask a failed run.
process.env.SCHEDULE_SEED_PDF_2 = path.join(tempDir, "absent-anul-ii-seed.pdf");

/** Stands in for the bundle that runs the scheduler. */
const scheduler = await import("@/lib/services/updater");
const { resetStorageCache } = await import("@/lib/storage");

const PAGE_FIXTURE = path.join(__dirname, "fixtures", "orar-page-autumn-2026.html");
/** The two documents orar-page-autumn-2026.html actually links to. These tests exercise the
 *  live path, so they follow the captured page rather than whichever seed the app ships. */
const ANUL_I_PDF = path.join(__dirname, "fixtures", "anul_i_semestrul_i-9.pdf");
const ANUL_II_PDF = path.join(__dirname, "fixtures", "anul_ii_semestrul_iii-8.pdf");
const PAGE_URL = "https://fcim.utm.md/procesul-de-studii/orar/";
const ANUL_I_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-9.pdf";
const ANUL_II_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-8.pdf";

let pageHtml: string;
let anulIBytes: Uint8Array;
let anulIIBytes: Uint8Array;

/** A second evaluation of the same module, as the route-handler bundle would produce. */
async function loadSecondBundle(): Promise<typeof scheduler> {
  vi.resetModules();
  return import("@/lib/services/updater");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
  const [html, one, two] = await Promise.all([
    readFile(PAGE_FIXTURE, "utf8"),
    readFile(ANUL_I_PDF),
    readFile(ANUL_II_PDF),
  ]);
  pageHtml = html;
  anulIBytes = new Uint8Array(one);
  anulIIBytes = new Uint8Array(two);
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  await rm(path.join(tempDir, "courses"), { recursive: true, force: true });
  resetStorageCache();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  vi.useRealTimers();
  await rm(tempDir, { recursive: true, force: true });
});

/** Serves the page and both PDFs; the first page request is held open by the test. */
function stubSource(hold: { promise: Promise<void> }, started: { resolve: () => void }) {
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
          await hold.promise;
        }
        return new Response(pageHtml, { headers: { "content-type": "text/html" } });
      }
      if (url === ANUL_I_URL || url === ANUL_II_URL) {
        events.push(url === ANUL_I_URL ? "pdf-i" : "pdf-ii");
        const bytes = url === ANUL_I_URL ? anulIBytes : anulIIBytes;
        return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf" } });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return events;
}

describe("two module instances in one process", () => {
  it("share the coordinator that lives on globalThis", async () => {
    const api = await loadSecondBundle();

    expect(api).not.toBe(scheduler);
    expect(api.checkForUpdates).not.toBe(scheduler.checkForUpdates);
    expect(scheduler.updateCoordinatorState().shared).toBe(true);
    expect(api.updateCoordinatorState().shared).toBe(true);
  });

  it("coalesce a scheduler check and an API check of the same course", async () => {
    const api = await loadSecondBundle();
    const started = deferred();
    const release = deferred();
    const events = stubSource(release, started);

    // The scheduler bundle starts an ordinary check for course 1...
    const fromScheduler = scheduler.checkForUpdates(1);
    await started.promise;
    // ...and while it is in flight, a request reaches the route-handler bundle.
    const fromApi = api.checkForUpdates(1);

    // Same operation, not two parallel downloads of the same PDF.
    expect(fromApi).toBe(fromScheduler);
    expect(api.updateCoordinatorState().inFlightCourses).toEqual([1]);
    expect(scheduler.updateCoordinatorState().inFlightCourses).toEqual([1]);

    release.resolve();
    const [a, b] = await Promise.all([fromScheduler, fromApi]);
    expect(a).toBe(b);
    expect(a.outcome).toBe("updated");
    expect(events).toEqual(["page-1", "pdf-i"]);
    expect(scheduler.updateCoordinatorState().inFlightCourses).toEqual([]);
  });

  it("keep different courses distinct across bundles", async () => {
    const api = await loadSecondBundle();
    const started = deferred();
    const release = deferred();
    stubSource(release, started);

    const courseOne = scheduler.checkForUpdates(1);
    await started.promise;
    const courseTwo = api.checkForUpdates(2);

    expect(courseTwo).not.toBe(courseOne);
    expect(scheduler.updateCoordinatorState().inFlightCourses.sort()).toEqual([1, 2]);

    release.resolve();
    const [one, two] = await Promise.all([courseOne, courseTwo]);
    expect(one.course_year).toBe(1);
    expect(two.course_year).toBe(2);
    expect(one.pdf_url).toBe(ANUL_I_URL);
    expect(two.pdf_url).toBe(ANUL_II_URL);
  });

  it("queue an API force behind an in-flight scheduler check of the same course", async () => {
    const api = await loadSecondBundle();
    const started = deferred();
    const release = deferred();
    const events = stubSource(release, started);

    const ordinary = scheduler.checkForUpdates(1);
    await started.promise;
    const forced = api.checkForUpdates(1, { force: true });

    // A force is always its own operation, never a join of the in-flight ordinary run.
    expect(forced).not.toBe(ordinary);
    // ...and it waits: the second discovery has not started while the first is held.
    await Promise.resolve();
    expect(events).toEqual(["page-1"]);

    release.resolve();
    const [first, second] = await Promise.all([ordinary, forced]);
    expect(events).toEqual(["page-1", "pdf-i", "page-2", "pdf-i"]);
    expect(first.outcome).toBe("updated");
    // The forced run re-parses the identical document rather than reporting "unchanged".
    expect(second.outcome).toBe("updated");
  });

  it("serialize an API explicit refresh behind a scheduler check", async () => {
    const api = await loadSecondBundle();
    const started = deferred();
    const release = deferred();
    const events = stubSource(release, started);

    const ordinary = scheduler.checkForUpdates(1);
    await started.promise;
    const explicit = api.refreshFromExplicitPdf(2, { pdfUrl: ANUL_II_URL });

    await Promise.resolve();
    // The explicit refresh has not begun downloading while the scheduler holds the queue.
    expect(events).toEqual(["page-1"]);

    release.resolve();
    const [automatic, manual] = await Promise.all([ordinary, explicit]);
    expect(automatic.outcome).toBe("updated");
    expect(manual).toMatchObject({ course_year: 2, outcome: "updated" });
    expect(events).toEqual(["page-1", "pdf-i", "pdf-ii"]);
  });

  it("release the in-flight slot when a run fails", async () => {
    const api = await loadSecondBundle();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));

    // Course 2's seed path is deliberately empty in this file and its mirror is not routed,
    // so an unreachable source really does end in an error rather than a seeded fallback.
    const failed = await scheduler.checkForUpdates(2);
    expect(failed.outcome).toBe("error");
    // A settled run must not leave a poisoned promise every later caller would join.
    expect(scheduler.updateCoordinatorState().inFlightCourses).toEqual([]);
    expect(api.updateCoordinatorState().inFlightCourses).toEqual([]);

    // The next ordinary caller gets a fresh operation, from either bundle.
    const retry = api.checkForUpdates(2);
    expect(retry).not.toBe(failed);
    expect((await retry).outcome).toBe("error");
    expect(api.updateCoordinatorState().inFlightCourses).toEqual([]);
  });
});
