/**
 * Runtime smoke test for the whole read path:
 *
 *   real FCIM PDF → parser → atomic storage files on disk → route handler → JSON response
 *
 * The parser and updater suites cover the write side in depth; this one proves the part no
 * other suite touches: that a schedule sitting in the data directory is actually served, with
 * the shape the UI consumes, by every route the app exposes. Handlers are imported and invoked
 * directly instead of through a browser — the UI is a client component that only calls
 * /api/schedule and /api/status, so driving those two contracts is what a browser test would
 * assert anyway, without a headless-browser dependency in CI.
 *
 * No network: the store is populated before the first request, so `requireSchedule()` never
 * falls through to `checkForUpdates(1)`. A stubbed-out fetch guards that invariant.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// Type-only: erased at compile time, so it cannot import the app before the env below is set.
import type { NextRequest } from "next/server";

const tempDir = await mkdtemp(path.join(tmpdir(), "fcim-smoke-"));
process.env.SCHEDULE_DATA_DIR = tempDir;
process.env.DATABASE_URL = "";
process.env.SCHEDULE_ADMIN_TOKEN = "";
process.env.SCHEDULE_DISABLE_SCHEDULER = "1";

const { NextRequest: NextRequestCtor } = await import("next/server");
const { parsePdf, sha256 } = await import("@/lib/parser");
const { ScheduleSchema } = await import("@/lib/models");
const { replaceCurrentSchedule, resetStorageCache, saveSourceState } = await import("@/lib/storage");
const { config } = await import("@/lib/config");
const { courseSeed } = await import("@/lib/courses");
/** The Anul I seed this deployment ships with. */
const SEED_SOURCE = courseSeed(1)!;

const health = (await import("@/app/api/health/route")).GET;
const status = (await import("@/app/api/status/route")).GET;
const groups = (await import("@/app/api/groups/route")).GET;
const schedule = (await import("@/app/api/schedule/route")).GET;
const groupSchedule = (await import("@/app/api/schedule/[group]/route")).GET;
const groupToday = (await import("@/app/api/schedule/[group]/today/route")).GET;
const source = (await import("@/app/api/source/route")).GET;
const adminRefresh = (await import("@/app/api/admin/refresh/route")).POST;

/** The bundled real FCIM PDF: autumn 2026/2027, the schedule the app ships with. */
const SEED = path.join(__dirname, "..", "data", "seed", "anul_i_semestrul_i-18.pdf");
/** A lesson recorded from that PDF – present iff the whole chain kept the data intact. */
const KNOWN_GROUP = "SI-261";
const KNOWN_LESSON = { day: "Luni", start_time: "11:30", subject: "Analiza Matematică", teacher: "Costaș A." };

function get(url: string): NextRequest {
  return new NextRequestCtor(new URL(url, "http://localhost:8000"));
}

function params(group: string) {
  return { params: Promise.resolve({ group }) };
}

/** Read a handler's response, failing loudly instead of letting withErrorHandling hide a 500. */
async function body<T>(response: Response, expectedStatus = 200): Promise<T> {
  const payload = (await response.json()) as T;
  expect(response.status, `unexpected status; body: ${JSON.stringify(payload).slice(0, 400)}`).toBe(expectedStatus);
  return payload;
}

let pdfBytes: Uint8Array;
let lessonCount: number;
let groupNames: string[];

beforeAll(async () => {
  pdfBytes = new Uint8Array(await readFile(SEED));
  const { schedule: parsed } = await parsePdf(pdfBytes, {
    source_page_url: config.schedulePageUrl,
    source_pdf_url: SEED_SOURCE.originalUrl,
    source_kind: "seed",
    downloaded_at: "2026-09-01T00:00:00.000Z",
  });
  lessonCount = parsed.lessons.length;
  groupNames = parsed.groups.map((group) => group.name);

  await replaceCurrentSchedule(1, parsed);
  await saveSourceState(1, {
    current_pdf_url: SEED_SOURCE.originalUrl,
    current_pdf_hash: sha256(pdfBytes),
    last_check_at: "2026-09-01T00:00:00.000Z",
    last_success_at: "2026-09-01T00:00:00.000Z",
    last_result: "seeded",
    academic_year: "2026/2027",
    semester: "Semestrul I",
  });

  // Drop the in-memory copy: every request below has to come off the files on disk.
  resetStorageCache();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("test_smoke_stored_schedule_is_served", () => {
  it("serves the schedule that is on disk, not one it goes and fetches", async () => {
    // Any outbound request here means the read path fell through to the updater.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("the read path must not touch the network");
    }));

    const payload = await body<{ lessons: unknown[]; groups: string[]; count: number }>(await schedule(get("/api/schedule")));
    expect(payload.count).toBe(lessonCount);
    expect(payload.groups).toEqual(groupNames);
  });

  it("answers liveness with the schedule present", async () => {
    const payload = await body<{ ok: boolean; status: string; has_schedule: boolean }>(await health());
    expect(payload).toMatchObject({ ok: true, status: "ok", has_schedule: true });
  });
});

describe("test_smoke_schedule_api_shape", () => {
  it("returns the payload shape the UI is typed against", async () => {
    const payload = await body<import("@/lib/client/types").ScheduleResponse>(await schedule(get("/api/schedule")));

    // The response must still satisfy the model the storage layer validates against.
    const round = ScheduleSchema.safeParse({
      metadata: payload.metadata,
      groups: payload.groups.map((name) => ({ name, program: name.split("-")[0], x0: 0, x1: 1 })),
      days: payload.days,
      time_slots: payload.time_slots,
      lessons: payload.lessons,
      warnings: payload.warnings,
    });
    expect(round.error?.message ?? "ok").toBe("ok");

    expect(payload.days).toEqual(["Luni", "Marți", "Miercuri", "Joi", "Vineri"]);
    expect(payload.time_slots.length).toBeGreaterThan(0);
    expect(payload.time_slots[0]).toMatchObject({ start_time: expect.stringMatching(/^\d{2}:\d{2}$/) });
    expect(payload.metadata).toMatchObject({
      course_year: 1,
      source_kind: "seed",
      parser_version: config.parserVersion,
      source_pdf_hash: sha256(pdfBytes),
    });
    expect(payload.count).toBe(payload.lessons.length);

    for (const lesson of payload.lessons) {
      expect(lesson.groups.length).toBeGreaterThan(0);
      expect(lesson.start_time < lesson.end_time).toBe(true);
    }
  });

  it("reports the same schedule through /api/status with the week anchor the UI needs", async () => {
    const payload = await body<import("@/lib/client/types").StatusResponse>(await status(get("/api/status")));
    expect(payload.ok).toBe(true);
    expect(payload.has_schedule).toBe(true);
    expect(payload.schedule).toMatchObject({
      academic_year: "2026/2027",
      semester: "Semestrul I",
      source_kind: "seed",
      groups: groupNames.length,
      lessons: lessonCount,
    });
    // The client counts semester weeks from this value; without it the parity badge is wrong.
    expect(payload.source.odd_week_anchor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.source.last_result).toBe("seeded");
    expect(payload.timezone).toBe("Europe/Chisinau");
  });

  it("lists the discovered groups with their lesson counts", async () => {
    const payload = await body<import("@/lib/client/types").GroupsResponse>(await groups(get("/api/groups")));
    expect(payload.count).toBe(groupNames.length);
    expect(payload.groups.map((group) => group.name)).toEqual(groupNames);
    const known = payload.groups.find((group) => group.name === KNOWN_GROUP);
    expect(known, `${KNOWN_GROUP} missing from /api/groups`).toBeDefined();
    expect(known!.lessons).toBeGreaterThan(15);
    expect(known!.program).toBe("SI");
  });
});

describe("test_smoke_known_group_and_lesson", () => {
  it("finds the recorded lesson for the known group through the query API", async () => {
    const payload = await body<import("@/lib/client/types").ScheduleResponse>(
      await schedule(get(`/api/schedule?group=${KNOWN_GROUP}&day=Luni`)),
    );
    expect(payload.lessons.length).toBeGreaterThan(0);
    expect(payload.lessons.every((lesson) => lesson.day === "Luni" && lesson.groups.includes(KNOWN_GROUP))).toBe(true);

    const found = payload.lessons.find((lesson) => lesson.start_time === KNOWN_LESSON.start_time);
    expect(found, `no ${KNOWN_LESSON.start_time} lesson for ${KNOWN_GROUP} on Luni`).toBeDefined();
    expect(found).toMatchObject({ subject: KNOWN_LESSON.subject, teacher: KNOWN_LESSON.teacher, lesson_type: "lecture" });
  });

  it("projects one group onto its five days", async () => {
    const payload = await body<{ group: string; by_day: Record<string, unknown[]>; count: number; days: string[] }>(
      await groupSchedule(get(`/api/schedule/${KNOWN_GROUP}`), params(KNOWN_GROUP)),
    );
    expect(payload.group).toBe(KNOWN_GROUP);
    expect(Object.keys(payload.by_day)).toEqual(["Luni", "Marți", "Miercuri", "Joi", "Vineri"]);
    expect(Object.values(payload.by_day).reduce((total, day) => total + day.length, 0)).toBe(payload.count);
    expect(payload.count).toBeGreaterThan(15);
  });

  it("accepts a group typed in lower case", async () => {
    const lower = KNOWN_GROUP.toLowerCase();
    const payload = await body<{ group: string }>(await groupSchedule(get(`/api/schedule/${lower}`), params(lower)));
    expect(payload.group).toBe(KNOWN_GROUP);
  });

  it("serves today's lessons for the known group", async () => {
    const payload = await body<{ group: string; day: string | null; is_weekend: boolean; lessons: unknown[]; count: number }>(
      await groupToday(get(`/api/schedule/${KNOWN_GROUP}/today`), params(KNOWN_GROUP)),
    );
    expect(payload.group).toBe(KNOWN_GROUP);
    expect(payload.is_weekend).toBe(payload.day === null);
    expect(payload.count).toBe(payload.lessons.length);
    if (!payload.is_weekend) expect(["Luni", "Marți", "Miercuri", "Joi", "Vineri"]).toContain(payload.day);
  });

  it("reports where the served data came from", async () => {
    const payload = await body<{ pdf_url: string; pdf_hash: string; source_kind: string; academic_year: string }>(
      await source(get("/api/source")),
    );
    expect(payload).toMatchObject({
      pdf_url: SEED_SOURCE.originalUrl,
      pdf_hash: sha256(pdfBytes),
      source_kind: "seed",
      academic_year: "2026/2027",
    });
  });
});

describe("test_smoke_routes_reject_bad_input_cleanly", () => {
  it("rejects an unknown group with 404, not a crash", async () => {
    const payload = await body<{ error: string }>(
      await groupSchedule(get("/api/schedule/NOPE-999"), params("NOPE-999")),
      404,
    );
    expect(payload.error).toMatch(/Unknown group/);
  });

  it("rejects an unknown day with 400", async () => {
    const payload = await body<{ error: string }>(await schedule(get("/api/schedule?day=Sunday")), 400);
    expect(payload.error).toMatch(/Unknown day/);
  });

  it("hides the admin refresh hook while no token is configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("a disabled admin hook must not reach the network");
    }));
    const payload = await body<{ error: string }>(await adminRefresh(get("/api/admin/refresh")), 404);
    expect(payload.error).toBe("Not found");
  });
});
