import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const NEW_SEED_HASH = "a4c610d24dd53bbf87c5da312ffebf7aabc112c7f28338587e18e1eb0526b79a";
const tempDir = await mkdtemp(path.join(tmpdir(), "fcim-test-"));
const packagedSeedPath = path.join(tempDir, "packaged-seed.pdf");
process.env.SCHEDULE_DATA_DIR = tempDir;
process.env.DATABASE_URL = "";
process.env.SCHEDULE_WAYBACK_FALLBACK = "0";
process.env.SCHEDULE_SEED_PDF = packagedSeedPath;
process.env.SCHEDULE_ADMIN_TOKEN = "test-admin-token";
const SEED_MIRROR_URL = "https://raw.githubusercontent.com/barbalatv/utm-curs-i-orar-2027/main/data/seed/anul_i_semestrul_i-18.pdf";
process.env.SCHEDULE_SEED_PDF_MIRROR_URL = SEED_MIRROR_URL;
process.env.SCHEDULE_SEED_PDF_SHA256 = NEW_SEED_HASH;

const { NextRequest: NextRequestCtor } = await import("next/server");
const { discoverPdf, semesterForSeason } = await import("@/lib/source/discovery");
const { pdfRevisionFromUrl } = await import("@/lib/source/revision");
const { isAllowedSourceUrl, isOfficialTimetablePdfUrl, fetchPdf, SourceFetchError } =
  await import("@/lib/source/downloader");
const { checkForUpdates, refreshFromExplicitPdf } = await import("@/lib/services/updater");
const {
  getCurrentSchedule,
  getSourceState,
  replaceCurrentSchedule,
  resetStorageCache,
  saveSourceState,
} = await import("@/lib/storage");
const { parsePdf, sha256 } = await import("@/lib/parser");
const { validateSchedule } = await import("@/lib/parser/validator");
const { buildStatus } = await import("@/lib/services/schedule-service");
const adminRefresh = (await import("@/app/api/admin/refresh/route")).POST;

const PAGE_FIXTURE = path.join(__dirname, "fixtures", "orar-page.html");
const PDF_FIXTURE = path.join(__dirname, "fixtures", "anul_i_semestrul_ii-1.pdf");
const PDF_FIXTURE_B = path.join(__dirname, "fixtures", "anul_i_semestrul_i-3.pdf");
const OLD_SEED_FIXTURE = path.join(__dirname, "fixtures", "anul_i_semestrul_i-5.pdf");
const NEW_SEED_FIXTURE = path.join(__dirname, "..", "data", "seed", "anul_i_semestrul_i-18.pdf");
const PAGE_URL = "https://fcim.utm.md/procesul-de-studii/orar/";
const WORDPRESS_URL = "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view";
const PDF_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/03/anul_i_semestrul_ii-1.pdf";
const OLD_SEED_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-5.pdf";
const NEW_SEED_URL = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf";
const SPRING_2026 = new Date("2026-03-01T12:00:00.000Z");

let pageHtml: string;
let pdfBytes: Uint8Array;
let pdfBytesB: Uint8Array;
let oldSeedBytes: Uint8Array;
let newSeedBytes: Uint8Array;
let oldSeedSchedule: Awaited<ReturnType<typeof parsePdf>>["schedule"];

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(SPRING_2026);
  const [html, fixture, fixtureB, oldSeed, newSeed] = await Promise.all([
    readFile(PAGE_FIXTURE, "utf8"),
    readFile(PDF_FIXTURE),
    readFile(PDF_FIXTURE_B),
    readFile(OLD_SEED_FIXTURE),
    readFile(NEW_SEED_FIXTURE),
  ]);
  pageHtml = html;
  pdfBytes = new Uint8Array(fixture);
  pdfBytesB = new Uint8Array(fixtureB);
  oldSeedBytes = new Uint8Array(oldSeed);
  newSeedBytes = new Uint8Array(newSeed);
  ({ schedule: oldSeedSchedule } = await parsePdf(oldSeedBytes, {
    source_page_url: PAGE_URL,
    source_pdf_url: OLD_SEED_URL,
    source_kind: "seed",
    downloaded_at: "2026-09-01T00:00:00.000Z",
  }));
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all([
    rm(path.join(tempDir, "courses", "1", "current_schedule.json"), { force: true }),
    rm(path.join(tempDir, "courses", "1", "metadata.json"), { force: true }),
    rm(packagedSeedPath, { force: true }),
  ]);
  resetStorageCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  vi.useRealTimers();
  await rm(tempDir, { recursive: true, force: true });
});

type Route = { status?: number; body?: Uint8Array | string; headers?: Record<string, string> };

/** Stub global fetch with a tiny router; records requests for assertions. */
function stubFetch(routes: Record<string, Route | ((init: RequestInit) => Route)>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      calls.push({ url, headers });
      const route = routes[url];
      if (!route) return new Response("not found", { status: 404 });
      const resolved = typeof route === "function" ? route(init ?? {}) : route;
      const body = resolved.body instanceof Uint8Array ? new Uint8Array(resolved.body) : resolved.body ?? "";
      return new Response(resolved.status === 304 ? null : body, { status: resolved.status ?? 200, headers: resolved.headers ?? {} });
    }),
  );
  return calls;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cloudflareDiscoveryRoutes(): Record<string, Route> {
  return {
    [PAGE_URL]: {
      status: 403,
      body: "Just a moment...",
      headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
    },
    [WORDPRESS_URL]: {
      status: 403,
      body: "Just a moment...",
      headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
    },
  };
}

async function persistOldSchedule(sourceKind: "seed" | "live" | "manual" = "seed") {
  const schedule = {
    ...oldSeedSchedule,
    metadata: { ...oldSeedSchedule.metadata, source_kind: sourceKind },
  };
  await replaceCurrentSchedule(1, schedule);
  await saveSourceState(1, {
    current_pdf_url: OLD_SEED_URL,
    current_pdf_hash: schedule.metadata.source_pdf_hash,
    last_check_at: "2026-09-01T00:00:00.000Z",
    last_success_at: "2026-09-01T00:00:00.000Z",
    last_result: sourceKind === "seed" ? "seeded" : "updated",
    academic_year: schedule.metadata.academic_year,
    semester: schedule.metadata.semester,
  });
  return schedule;
}

function adminRequest(body: unknown, token = "test-admin-token"): NextRequest {
  return new NextRequestCtor("http://localhost:8000/api/admin/refresh", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function responseJson<T>(response: Response, status = 200): Promise<T> {
  const payload = (await response.json()) as T;
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload;
}

describe("test_schedule_page_discovery", () => {
  it("finds the Anul I semester PDF inside the Ciclul I full-time section", () => {
    const found = discoverPdf(pageHtml, 1, SPRING_2026);
    expect(found.pdf_url).toBe(PDF_URL);
    expect(found.link_text).toMatch(/^Anul I\b/);
    expect(found.academic_year).toBe("2025/2026");
    expect(found.semester).toBe("Semestrul II");
    // The link itself reads "Anul I semestrul II"; nothing had to be inferred.
    expect(found.semester_source).toBe("explicit");
    expect(found.section_title).toMatch(/Ciclul I, Licență/);
    expect(found.parity_note).toMatch(/Prima săptămână/);
  });

  it("resolves other course years without touching Anul I", () => {
    expect(discoverPdf(pageHtml, 2, SPRING_2026).pdf_url).toMatch(/anul_ii_/);
    expect(discoverPdf(pageHtml, 3, SPRING_2026).pdf_url).toMatch(/anul_iii_/);
    expect(discoverPdf(pageHtml, 2, SPRING_2026).semester).toBe("Semestrul IV");
    expect(discoverPdf(pageHtml, 3, SPRING_2026).semester).toBe("Semestrul VI");
  });

  it("fails loudly when the section is missing", () => {
    expect(() => discoverPdf("<html><body><p>nothing</p></body></html>")).toThrow(/not found/);
  });
});

describe("semester derived from a season-only row label", () => {
  const AUTUMN_2026 = new Date("2026-09-15T12:00:00.000Z");
  const SPRING_2027 = new Date("2027-03-15T12:00:00.000Z");
  const UPLOADS = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09";

  /**
   * How FCIM actually publishes the timetable: the row names the season, the link
   * names only the course year. The semester number has to come from both.
   */
  function seasonPage(linkText = "Anul II"): string {
    const title = "Ciclul I, Licență - învățământ cu frecvență";
    const row = (season: string, file: string) =>
      `<tr><td>Orar Semestrul de ${season} a.u.2026/2027</td>` +
      `<td><a href="${UPLOADS}/${file}">${linkText}</a></td></tr>`;
    return (
      `<html><body><div class="togglecontainer"><p data-title="${title}">${title}</p><table><tbody>` +
      `${row("TOAMNĂ", "autumn.pdf")}${row("PRIMĂVARĂ", "spring.pdf")}</tbody></table></div></body></html>`
    );
  }

  it.each([
    [1, "Anul I", AUTUMN_2026, "autumn.pdf", "Semestrul I"],
    [1, "Anul I", SPRING_2027, "spring.pdf", "Semestrul II"],
    [2, "Anul II", AUTUMN_2026, "autumn.pdf", "Semestrul III"],
    [2, "Anul II", SPRING_2027, "spring.pdf", "Semestrul IV"],
  ])("maps course year %s to %s", (courseYear, linkText, now, file, expected) => {
    const found = discoverPdf(seasonPage(linkText), courseYear, now);
    expect(found.pdf_url).toBe(`${UPLOADS}/${file}`);
    expect(found.semester).toBe(expected);
    expect(found.semester_source).toBe("inferred");
  });

  it("keeps the arithmetic generic beyond the years the app ships with", () => {
    expect(semesterForSeason(3, "autumn")).toBe("Semestrul V");
    expect(semesterForSeason(3, "spring")).toBe("Semestrul VI");
    expect(semesterForSeason(5, "autumn")).toBe("Semestrul IX");
    expect(semesterForSeason(6, "spring")).toBe("Semestrul XII");
  });

  it("prefers a semester printed on the link over the one the season implies", () => {
    const title = "Ciclul I, Licență - învățământ cu frecvență";
    const page =
      `<html><body><div class="togglecontainer"><p data-title="${title}">${title}</p><table><tbody>` +
      `<tr><td>Orar Semestrul de TOAMNĂ a.u.2026/2027</td>` +
      `<td><a href="${UPLOADS}/anul_ii_semestrul_iii-8.pdf">Anul II semestrul III</a></td>` +
      `</tr></tbody></table></div></body></html>`;
    const found = discoverPdf(page, 2, AUTUMN_2026);
    expect(found.semester).toBe("Semestrul III");
    expect(found.semester_source).toBe("explicit");
  });
});

describe("test_discovery_prefers_newest_revision", () => {
  const AUTUMN_2026 = new Date("2026-09-15T12:00:00.000Z");
  const UPLOADS = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09";
  const file = (name: string) => `${UPLOADS}/${name}`;

  interface Row {
    label: string;
    links: { text: string; href: string }[];
  }

  /** Minimal stand-in for the FCIM toggle section so link order is fully controlled. */
  function schedulePage(rows: Row[]): string {
    const body = rows
      .map(
        (row) =>
          `<tr><td>${row.label}</td>${row.links
            .map((link) => `<td><a href="${link.href}">${link.text}</a></td>`)
            .join("")}</tr>`,
      )
      .join("");
    const title = "Ciclul I, Licență - învățământ cu frecvență";
    return `<html><body><div class="togglecontainer"><p data-title="${title}">${title}</p><table><tbody>${body}</tbody></table></div></body></html>`;
  }

  /** The autumn 2026/2027 row, i.e. the one a September check is supposed to pick. */
  function autumnRow(hrefs: string[]): Row {
    return {
      label: "Orar Semestrul de TOAMNĂ a.u.2026/2027",
      links: hrefs.map((href) => ({ text: "Anul I semestrul I", href })),
    };
  }

  const revisions = (...names: string[]) => schedulePage([autumnRow(names.map(file))]);

  it("splits a published file name into its family and numeric revision", () => {
    expect(pdfRevisionFromUrl(file("anul_i_semestrul_i-10.pdf"))).toEqual({ family: "anul_i_semestrul_i", revision: 10 });
    expect(pdfRevisionFromUrl(file("anul_i_semestrul_i.pdf"))).toEqual({ family: "anul_i_semestrul_i", revision: 0 });
    expect(pdfRevisionFromUrl(`${file("anul_i_semestrul_i-10.pdf")}?ver=123`)).toEqual({
      family: "anul_i_semestrul_i",
      revision: 10,
    });
    expect(pdfRevisionFromUrl(file("orar_special_anul_i-20.pdf"))?.family).toBe("orar_special_anul_i");
    expect(pdfRevisionFromUrl("not a url")).toBeNull();
    expect(pdfRevisionFromUrl(file("anul_i_semestrul_i-10.txt"))).toBeNull();
  });

  it("picks the newer revision when the page still links the superseded one", () => {
    const page = revisions("anul_i_semestrul_i-9.pdf", "anul_i_semestrul_i-10.pdf");
    expect(discoverPdf(page, 1, AUTUMN_2026).pdf_url).toBe(file("anul_i_semestrul_i-10.pdf"));
  });

  it("compares revisions numerically, so -11 beats -10 beats -9", () => {
    const page = revisions("anul_i_semestrul_i-9.pdf", "anul_i_semestrul_i-10.pdf", "anul_i_semestrul_i-11.pdf");
    expect(discoverPdf(page, 1, AUTUMN_2026).pdf_url).toBe(file("anul_i_semestrul_i-11.pdf"));
  });

  it("returns the same PDF whatever order the page lists the revisions in", () => {
    const names = ["anul_i_semestrul_i-9.pdf", "anul_i_semestrul_i-10.pdf", "anul_i_semestrul_i-11.pdf"];
    const newest = file("anul_i_semestrul_i-11.pdf");
    expect(discoverPdf(revisions(...names), 1, AUTUMN_2026).pdf_url).toBe(newest);
    expect(discoverPdf(revisions(...[...names].reverse()), 1, AUTUMN_2026).pdf_url).toBe(newest);
    expect(discoverPdf(revisions(names[1], names[2], names[0]), 1, AUTUMN_2026).pdf_url).toBe(newest);
  });

  it("treats a file published without a suffix as revision 0 of its family", () => {
    const newest = file("anul_i_semestrul_i-2.pdf");
    expect(discoverPdf(revisions("anul_i_semestrul_i.pdf", "anul_i_semestrul_i-2.pdf"), 1, AUTUMN_2026).pdf_url).toBe(newest);
    expect(discoverPdf(revisions("anul_i_semestrul_i-2.pdf", "anul_i_semestrul_i.pdf"), 1, AUTUMN_2026).pdf_url).toBe(newest);
  });

  it("keeps the current semester even when another semester carries a higher revision", () => {
    const spring: Row = {
      label: "Orar Semestrul de PRIMĂVARĂ a.u.2026/2027",
      links: [{ text: "Anul I semestrul II", href: file("anul_i_semestrul_ii-99.pdf") }],
    };
    const autumn = autumnRow([file("anul_i_semestrul_i-10.pdf")]);
    for (const rows of [[autumn, spring], [spring, autumn]]) {
      const found = discoverPdf(schedulePage(rows), 1, AUTUMN_2026);
      expect(found.pdf_url).toBe(file("anul_i_semestrul_i-10.pdf"));
      expect(found.semester).toBe("Semestrul I");
    }
  });

  it("keeps the current academic year even when a past year carries a higher revision", () => {
    // Same file family on purpose: only the academic-year filter can rule the old one out.
    const past: Row = {
      label: "Orar Semestrul de TOAMNĂ a.u.2025/2026",
      links: [{ text: "Anul I semestrul I", href: file("anul_i_semestrul_i-100.pdf") }],
    };
    const found = discoverPdf(schedulePage([past, autumnRow([file("anul_i_semestrul_i-10.pdf")])]), 1, AUTUMN_2026);
    expect(found.pdf_url).toBe(file("anul_i_semestrul_i-10.pdf"));
    expect(found.academic_year).toBe("2026/2027");
  });

  it("keeps the requested course year even when another year carries a higher revision", () => {
    // The Anul II link deliberately reuses the Anul I file family and a larger suffix.
    const row: Row = {
      label: "Orar Semestrul de TOAMNĂ a.u.2026/2027",
      links: [
        { text: "Anul I semestrul I", href: file("anul_i_semestrul_i-10.pdf") },
        { text: "Anul II semestrul III", href: file("anul_i_semestrul_i-100.pdf") },
      ],
    };
    const found = discoverPdf(schedulePage([row]), 1, AUTUMN_2026);
    expect(found.pdf_url).toBe(file("anul_i_semestrul_i-10.pdf"));
    expect(found.link_text).toMatch(/^Anul I\b/);
  });

  it("does not promote an unrelated file name just because its suffix is larger", () => {
    const row: Row = {
      label: "Orar Semestrul de TOAMNĂ a.u.2026/2027",
      links: [
        { text: "Anul I semestrul I", href: file("anul_i_semestrul_i-10.pdf") },
        { text: "Anul I semestrul I", href: file("orar_special_anul_i-20.pdf") },
      ],
    };
    expect(discoverPdf(schedulePage([row]), 1, AUTUMN_2026).pdf_url).toBe(file("anul_i_semestrul_i-10.pdf"));
  });

  it("reads the revision from the path, not from the query string", () => {
    const versioned = `${file("anul_i_semestrul_i-10.pdf")}?v=2`;
    const older = file("anul_i_semestrul_i-9.pdf");
    const row = (hrefs: string[]): Row => ({
      label: "Orar Semestrul de TOAMNĂ a.u.2026/2027",
      links: hrefs.map((href) => ({ text: "Anul I semestrul I", href })),
    });
    expect(discoverPdf(schedulePage([row([older, versioned])]), 1, AUTUMN_2026).pdf_url).toBe(versioned);
    expect(discoverPdf(schedulePage([row([versioned, older])]), 1, AUTUMN_2026).pdf_url).toBe(versioned);
  });

  it("still resolves a single eligible link exactly as before", () => {
    expect(discoverPdf(revisions("anul_i_semestrul_i-9.pdf"), 1, AUTUMN_2026).pdf_url).toBe(
      file("anul_i_semestrul_i-9.pdf"),
    );
  });
});

describe("automatic update follows a newly published revision", () => {
  it("downloads the -2 revision while the page still links -1", async () => {
    resetStorageCache();
    const superseded = PDF_URL;
    const republished = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/03/anul_i_semestrul_ii-2.pdf";
    const links = [superseded, republished]
      .map((href) => `<td><a href="${href}">Anul I semestrul II</a></td>`)
      .join("");
    const title = "Ciclul I, Licență - învățământ cu frecvență";
    const page =
      `<html><body><div class="togglecontainer"><p data-title="${title}">${title}</p><table><tbody>` +
      `<tr><td>Orar Semestrul de PRIMĂVARĂ a.u.2025/2026</td>${links}</tr></tbody></table></div></body></html>`;

    // Only the newer revision is routed: choosing -1 would surface as a fetch error.
    const calls = stubFetch({
      [PAGE_URL]: { body: page, headers: { "content-type": "text/html" } },
      [republished]: { body: pdfBytes, headers: { "content-type": "application/pdf", etag: '"v10"' } },
    });

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("updated");
    expect(result.pdf_url).toBe(republished);
    expect(calls.some((call) => call.url === republished)).toBe(true);
    expect(calls.some((call) => call.url === superseded)).toBe(false);
    expect((await getCurrentSchedule(1))!.metadata.source_pdf_url).toBe(republished);
    expect((await getSourceState(1)).current_pdf_url).toBe(republished);
  });
});

describe("test_pdf_download", () => {
  it("only allows https URLs on FCIM/UTM hosts", () => {
    expect(isAllowedSourceUrl(PDF_URL)).toBe(true);
    expect(isAllowedSourceUrl("https://utm.md/x.pdf")).toBe(true);
    expect(isAllowedSourceUrl("http://fcim.utm.md/x.pdf")).toBe(false);
    expect(isAllowedSourceUrl("https://evil.com/fcim.utm.md/x.pdf")).toBe(false);
    expect(isAllowedSourceUrl("https://fcim.utm.md.evil.com/x.pdf")).toBe(false);
    expect(isAllowedSourceUrl("https://127.0.0.1/x.pdf")).toBe(false);
  });

  it("accepts only the exact official FCIM timetable-PDF URL shape for explicit recovery", () => {
    expect(isOfficialTimetablePdfUrl(NEW_SEED_URL)).toBe(true);
    expect(isOfficialTimetablePdfUrl("https://example.com/wp-content/uploads/sites/24/2026/09/x.pdf")).toBe(false);
    expect(isOfficialTimetablePdfUrl("https://localhost/wp-content/uploads/sites/24/2026/09/x.pdf")).toBe(false);
    expect(isOfficialTimetablePdfUrl("https://127.0.0.1/wp-content/uploads/sites/24/2026/09/x.pdf")).toBe(false);
    expect(isOfficialTimetablePdfUrl("http://fcim.utm.md/wp-content/uploads/sites/24/2026/09/x.pdf")).toBe(false);
    expect(isOfficialTimetablePdfUrl("https://fcim.utm.md/other/x.pdf")).toBe(false);
    expect(isOfficialTimetablePdfUrl("https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/x.txt")).toBe(false);
    expect(isOfficialTimetablePdfUrl("https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/..%2fprivate.pdf")).toBe(false);
  });

  it("downloads a PDF, keeps validators and rejects non-PDF bodies", async () => {
    stubFetch({
      [PDF_URL]: { body: pdfBytes, headers: { "content-type": "application/pdf", etag: '"abc"', "last-modified": "Mon, 01 Sep 2026 10:00:00 GMT" } },
      "https://fcim.utm.md/fake.pdf": { body: "<html>challenge</html>", headers: { "content-type": "text/html" } },
    });
    const resource = await fetchPdf(PDF_URL, {});
    expect(resource.bytes.byteLength).toBe(pdfBytes.byteLength);
    expect(resource.etag).toBe('"abc"');
    await expect(fetchPdf("https://fcim.utm.md/fake.pdf", {})).rejects.toBeInstanceOf(SourceFetchError);
    await expect(fetchPdf("https://example.com/x.pdf", {})).rejects.toThrow(/allow-list/);
  });

  it("reports a Cloudflare challenge before treating its body as source content", async () => {
    stubFetch({
      [PDF_URL]: {
        status: 200,
        body: "<html>Just a moment...</html>",
        headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
      },
    });
    await expect(fetchPdf(PDF_URL, {})).rejects.toThrow(/Cloudflare challenge/);
  });
});

describe("test_hash_change_detection & test_invalid_pdf_keeps_old_schedule", () => {
  it("bootstraps, detects unchanged hash, applies a changed PDF and keeps the old schedule on failure", async () => {
    resetStorageCache();

    // 1. Cold start: page + PDF available → schedule created.
    stubFetch({
      [PAGE_URL]: { body: pageHtml, headers: { "content-type": "text/html" } },
      [PDF_URL]: { body: pdfBytes, headers: { "content-type": "application/pdf", etag: '"v1"' } },
    });
    const first = await checkForUpdates(1);
    expect(first.outcome).toBe("updated");
    const initial = await getCurrentSchedule(1);
    expect(initial).not.toBeNull();
    expect(initial!.metadata.source_pdf_url).toBe(PDF_URL);
    expect(initial!.metadata.source_pdf_hash).toBe(sha256(pdfBytes));
    expect(initial!.lessons.length).toBeGreaterThan(300);

    // 2. Same hash → nothing happens, conditional headers are sent.
    const calls = stubFetch({
      [PAGE_URL]: { body: pageHtml, headers: { "content-type": "text/html" } },
      [PDF_URL]: { body: pdfBytes, headers: { "content-type": "application/pdf", etag: '"v1"' } },
    });
    const second = await checkForUpdates(1);
    expect(second.outcome).toBe("unchanged");
    expect(calls.find((call) => call.url === PDF_URL)?.headers["if-none-match"]).toBe('"v1"');

    // 3. Server answers 304 → unchanged without download.
    stubFetch({
      [PAGE_URL]: { body: pageHtml, headers: { "content-type": "text/html" } },
      [PDF_URL]: { status: 304, headers: { etag: '"v1"' } },
    });
    expect((await checkForUpdates(1)).outcome).toBe("unchanged");

    // 4. New PDF content at the same URL → hash differs → re-parsed and replaced.
    stubFetch({
      [PAGE_URL]: { body: pageHtml, headers: { "content-type": "text/html" } },
      [PDF_URL]: { body: pdfBytesB, headers: { "content-type": "application/pdf", etag: '"v2"' } },
    });
    const fourth = await checkForUpdates(1);
    expect(fourth.outcome).toBe("updated");
    const replaced = await getCurrentSchedule(1);
    expect(replaced!.metadata.source_pdf_hash).toBe(sha256(pdfBytesB));
    expect(replaced!.metadata.pdf_title).toMatch(/SEMESTRUL I$/);

    // 5. Corrupt PDF → parse fails → previous schedule kept, error recorded.
    stubFetch({
      [PAGE_URL]: { body: pageHtml, headers: { "content-type": "text/html" } },
      [PDF_URL]: { body: new TextEncoder().encode("%PDF-1.7 garbage garbage garbage"), headers: { "content-type": "application/pdf", etag: '"v3"' } },
    });
    const fifth = await checkForUpdates(1);
    expect(fifth.outcome).toBe("rejected");
    const kept = await getCurrentSchedule(1);
    expect(kept!.metadata.source_pdf_hash).toBe(sha256(pdfBytesB));
    const state = await getSourceState(1);
    expect(state.last_result).toBe("rejected");
    expect(state.last_error).toMatch(/parser failed/);
    expect(state.current_pdf_hash).toBe(sha256(pdfBytesB));

    // 6. Site unreachable (Cloudflare 403) → error recorded, schedule still served.
    stubFetch({ [PAGE_URL]: { status: 403, body: "Just a moment...", headers: { "cf-mitigated": "challenge" } } });
    const sixth = await checkForUpdates(1);
    expect(sixth.outcome).toBe("error");
    expect(sixth.message).toMatch(/Cloudflare challenge/);
    expect((await getCurrentSchedule(1))!.metadata.source_pdf_hash).toBe(sha256(pdfBytesB));
    const discoveryFailure = await getSourceState(1);
    expect(discoveryFailure.last_result).toBe("error");
    expect(discoveryFailure.last_error).toMatch(/Cloudflare challenge/);
    expect(discoveryFailure.last_error_at).not.toBeNull();

    // Cache files exist on disk and survive a cold in-memory reset.
    resetStorageCache();
    const reloaded = await getCurrentSchedule(1);
    expect(reloaded!.metadata.source_pdf_hash).toBe(sha256(pdfBytesB));
  });
});

describe("test_parser_upgrade_reparses_cached_pdf", () => {
  it("re-parses an unchanged PDF when the cache came from an older parser", async () => {
    resetStorageCache();
    stubFetch({
      [PAGE_URL]: { body: pageHtml, headers: { "content-type": "text/html" } },
      [PDF_URL]: { body: pdfBytes, headers: { "content-type": "application/pdf", etag: '"v1"' } },
    });
    expect((await checkForUpdates(1)).outcome).toBe("updated");

    // Pretend the cache on disk was written by the previous parser release. Fixing a
    // parsing bug must reach users without waiting for the university to republish.
    const cached = await getCurrentSchedule(1);
    await replaceCurrentSchedule(1, { ...cached!, metadata: { ...cached!.metadata, parser_version: "0.0.1" } });
    resetStorageCache();

    const calls = stubFetch({
      [PAGE_URL]: { body: pageHtml, headers: { "content-type": "text/html" } },
      [PDF_URL]: { body: pdfBytes, headers: { "content-type": "application/pdf", etag: '"v1"' } },
    });
    const upgraded = await checkForUpdates(1);
    expect(upgraded.outcome).toBe("updated");
    // The conditional headers are dropped, otherwise a 304 would hide the PDF body.
    expect(calls.find((call) => call.url === PDF_URL)?.headers["if-none-match"]).toBeUndefined();
    expect((await getCurrentSchedule(1))!.metadata.parser_version).not.toBe("0.0.1");

    // A second run finds a matching parser version again and stops re-parsing.
    stubFetch({
      [PAGE_URL]: { body: pageHtml, headers: { "content-type": "text/html" } },
      [PDF_URL]: { body: pdfBytes, headers: { "content-type": "application/pdf", etag: '"v1"' } },
    });
    expect((await checkForUpdates(1)).outcome).toBe("unchanged");
  });
});

describe("automatic update queueing", () => {
  it("runs a force refresh after an in-flight ordinary check and preserves force semantics", async () => {
    const firstPageStarted = deferred();
    const releaseFirstPage = deferred();
    const events: string[] = [];
    const pdfHeaders: Headers[] = [];
    let pageRequests = 0;
    let pdfRequests = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === PAGE_URL) {
          const request = ++pageRequests;
          events.push(`page-${request}-start`);
          if (request === 1) {
            firstPageStarted.resolve();
            await releaseFirstPage.promise;
          }
          events.push(`page-${request}-response`);
          return new Response(pageHtml, { headers: { "content-type": "text/html" } });
        }
        if (url === PDF_URL) {
          const request = ++pdfRequests;
          events.push(`pdf-${request}`);
          pdfHeaders.push(new Headers(init?.headers));
          return new Response(new Uint8Array(pdfBytes), {
            headers: { "content-type": "application/pdf", etag: '"queue-v1"' },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const ordinary = checkForUpdates(1);
    await firstPageStarted.promise;
    const forced = checkForUpdates(1, { force: true });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["page-1-start"]);

    releaseFirstPage.resolve();
    const ordinaryResult = await ordinary;
    const forcedResult = await forced;

    expect(events).toEqual([
      "page-1-start",
      "page-1-response",
      "pdf-1",
      "page-2-start",
      "page-2-response",
      "pdf-2",
    ]);
    expect(ordinaryResult.outcome).toBe("updated");
    // The second run sees the same hash but still reparses because its force flag survived queueing.
    expect(forcedResult.outcome).toBe("updated");
    expect(forcedResult.source_pdf_hash).toBe(sha256(pdfBytes));
    expect(pageRequests).toBe(2);
    expect(pdfRequests).toBe(2);
    expect(pdfHeaders[1]?.get("if-none-match")).toBeNull();
  });

  it("continues to coalesce overlapping ordinary automatic checks", async () => {
    const firstPageStarted = deferred();
    const releaseFirstPage = deferred();
    let pageRequests = 0;
    let pdfRequests = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === PAGE_URL) {
          pageRequests += 1;
          firstPageStarted.resolve();
          await releaseFirstPage.promise;
          return new Response(pageHtml, { headers: { "content-type": "text/html" } });
        }
        if (url === PDF_URL) {
          pdfRequests += 1;
          return new Response(new Uint8Array(pdfBytes), { headers: { "content-type": "application/pdf" } });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const first = checkForUpdates(1);
    await firstPageStarted.promise;
    const second = checkForUpdates(1);
    await Promise.resolve();
    expect(pageRequests).toBe(1);

    releaseFirstPage.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.outcome).toBe("updated");
    expect(pageRequests).toBe(1);
    expect(pdfRequests).toBe(1);
  });
});

describe("test_remote_seed_bootstrap", () => {
  it("installs the packaged seed on a cold start when discovery is unavailable", async () => {
    // The counterpart of the wrong-course guard: an Anul I deployment, an Anul I seed.
    await writeFile(packagedSeedPath, newSeedBytes);
    resetStorageCache();
    const calls = stubFetch(cloudflareDiscoveryRoutes());

    const result = await checkForUpdates(1);

    expect(result).toMatchObject({ outcome: "seeded", pdf_url: NEW_SEED_URL, source_pdf_hash: NEW_SEED_HASH });
    const schedule = await getCurrentSchedule(1);
    expect(schedule?.metadata).toMatchObject({ course_year: 1, source_kind: "seed", source_pdf_hash: NEW_SEED_HASH });
    expect(schedule?.groups).toHaveLength(41);
    expect(schedule?.lessons).toHaveLength(452);
    // A seed on disk means the repository mirror is never contacted.
    expect(calls.some((call) => call.url === SEED_MIRROR_URL)).toBe(false);
    expect((await getSourceState(1))).toMatchObject({ last_result: "seeded", current_pdf_url: NEW_SEED_URL });
  });

  it("loads the repository mirror when the live sources and local seed are unavailable", async () => {
    await Promise.all([
      rm(path.join(tempDir, "courses", "1", "current_schedule.json"), { force: true }),
      rm(path.join(tempDir, "courses", "1", "metadata.json"), { force: true }),
    ]);
    resetStorageCache();

    const calls = stubFetch({
      [PAGE_URL]: { status: 403, body: "Just a moment...", headers: { "cf-mitigated": "challenge" } },
      [WORDPRESS_URL]: { status: 403, body: "Just a moment...", headers: { "cf-mitigated": "challenge" } },
      [SEED_MIRROR_URL]: { body: newSeedBytes, headers: { "content-type": "application/octet-stream" } },
    });

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("seeded");
    expect(calls.some((call) => call.url === SEED_MIRROR_URL)).toBe(true);
    const schedule = await getCurrentSchedule(1);
    expect(schedule?.metadata.source_kind).toBe("seed");
    expect(schedule?.metadata.source_pdf_hash).toBe(NEW_SEED_HASH);
    expect(schedule?.metadata.course_year).toBe(1);
    expect(schedule?.groups).toHaveLength(41);
    expect(schedule?.lessons).toHaveLength(452);
  });

  it("rejects changed mirror bytes without claiming the official seed provenance", async () => {
    expect(sha256(pdfBytes)).not.toBe(NEW_SEED_HASH);
    const calls = stubFetch({
      ...cloudflareDiscoveryRoutes(),
      [SEED_MIRROR_URL]: { body: pdfBytes, headers: { "content-type": "application/pdf" } },
    });

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("error");
    expect(result.message).toMatch(/seed mirror SHA-256 mismatch/);
    expect(calls.some((call) => call.url === SEED_MIRROR_URL)).toBe(true);
    expect(await getCurrentSchedule(1)).toBeNull();

    const failedState = await getSourceState(1);
    expect(failedState).toMatchObject({
      current_pdf_url: null,
      current_pdf_hash: null,
      last_result: "error",
    });
    expect(failedState.last_error).toMatch(/Cloudflare challenge/);
    expect(failedState.last_error).toMatch(/seed mirror SHA-256 mismatch/);

    // A known-good schedule prevents cold-start fallback entirely and remains untouched.
    const previous = await persistOldSchedule("live");
    const cachedCalls = stubFetch({
      ...cloudflareDiscoveryRoutes(),
      [SEED_MIRROR_URL]: { body: pdfBytes, headers: { "content-type": "application/pdf" } },
    });
    expect((await checkForUpdates(1)).outcome).toBe("error");
    expect(cachedCalls.some((call) => call.url === SEED_MIRROR_URL)).toBe(false);
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(previous.metadata.source_pdf_hash);
  });
});

describe("authenticated explicit-PDF recovery", () => {
  it("requires the configured administrator token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("an unauthorized request must not reach the network");
      }),
    );
    const payload = await responseJson<{ error: string }>(await adminRefresh(adminRequest({}, "wrong-token")), 401);
    expect(payload.error).toBe("Unauthorized");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-FCIM, local, IP, HTTP and non-timetable URLs before fetching", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("a rejected URL must not reach the network");
      }),
    );
    const invalidUrls = [
      "https://example.com/wp-content/uploads/sites/24/2026/09/x.pdf",
      "https://localhost/wp-content/uploads/sites/24/2026/09/x.pdf",
      "https://127.0.0.1/wp-content/uploads/sites/24/2026/09/x.pdf",
      "http://fcim.utm.md/wp-content/uploads/sites/24/2026/09/x.pdf",
      "https://fcim.utm.md/private/x.pdf",
    ];
    for (const pdfUrl of invalidUrls) {
      const payload = await responseJson<{ error: string }>(
        await adminRefresh(adminRequest({ course: 1, pdf_url: pdfUrl, force: true })),
        400,
      );
      expect(payload.error).toMatch(/HTTPS fcim\.utm\.md timetable PDF/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a redirect off the strict source and challenge HTML without changing the schedule", async () => {
    const old = await persistOldSchedule("live");
    const redirectCalls = stubFetch({
      [NEW_SEED_URL]: {
        status: 302,
        headers: { location: "https://example.com/redirected.pdf" },
      },
    });
    const redirected = await refreshFromExplicitPdf(1, { pdfUrl: NEW_SEED_URL, force: true });
    expect(redirected.outcome).toBe("error");
    expect(redirected.message).toMatch(/allow-list|official FCIM timetable PDF path/);
    expect(redirectCalls.map((call) => call.url)).toEqual([NEW_SEED_URL]);
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(old.metadata.source_pdf_hash);

    stubFetch({
      [NEW_SEED_URL]: {
        body: "<html>Just a moment...</html>",
        headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
      },
    });
    const challenged = await refreshFromExplicitPdf(1, { pdfUrl: NEW_SEED_URL, force: true });
    expect(challenged.outcome).toBe("error");
    expect(challenged.message).toMatch(/Cloudflare challenge/);
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(old.metadata.source_pdf_hash);

    stubFetch({
      [NEW_SEED_URL]: {
        body: "<html>not really a PDF</html>",
        headers: { "content-type": "application/pdf" },
      },
    });
    const masquerading = await refreshFromExplicitPdf(1, { pdfUrl: NEW_SEED_URL, force: true });
    expect(masquerading.outcome).toBe("error");
    expect(masquerading.message).toMatch(/not a PDF/);
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(old.metadata.source_pdf_hash);
  });

  it("keeps the previous schedule when the explicit PDF cannot be parsed", async () => {
    const old = await persistOldSchedule("live");
    stubFetch({
      [NEW_SEED_URL]: {
        body: new TextEncoder().encode("%PDF-1.7 invalid timetable"),
        headers: { "content-type": "application/pdf" },
      },
    });
    const result = await refreshFromExplicitPdf(1, { pdfUrl: NEW_SEED_URL, force: true });
    expect(result.outcome).toBe("rejected");
    expect(result.message).toMatch(/parser failed/);
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(old.metadata.source_pdf_hash);
  });

  it("keeps the previous schedule when real parsing succeeds but validation rejects the candidate", async () => {
    const old = await persistOldSchedule("live");
    const inflated = { ...old, lessons: [...old.lessons, ...old.lessons] };
    await replaceCurrentSchedule(1, inflated);
    stubFetch({
      [NEW_SEED_URL]: {
        body: newSeedBytes,
        headers: { "content-type": "application/pdf" },
      },
    });

    const result = await refreshFromExplicitPdf(1, { pdfUrl: NEW_SEED_URL, force: true });
    expect(result.outcome).toBe("rejected");
    expect(result.message).toMatch(/validation failed: lesson count dropped/);
    expect((await getCurrentSchedule(1))?.lessons).toHaveLength(inflated.lessons.length);
  });

  it("recovers through the real pipeline while preserving the discovery failure diagnostic", async () => {
    const old = await persistOldSchedule("seed");
    stubFetch(cloudflareDiscoveryRoutes());
    const automatic = await checkForUpdates(1);
    expect(automatic.outcome).toBe("error");
    expect((await getSourceState(1)).last_error).toMatch(/Cloudflare challenge/);

    stubFetch({
      [NEW_SEED_URL]: {
        body: newSeedBytes,
        headers: { "content-type": "application/pdf", etag: '"seed-16"' },
      },
    });
    const result = await responseJson<{
      outcome: string;
      pdf_url: string;
      source_pdf_hash: string;
      groups: number;
      lessons: number;
    }>(await adminRefresh(adminRequest({ course: 1, pdf_url: NEW_SEED_URL, force: true })));
    expect(result).toMatchObject({
      outcome: "updated",
      pdf_url: NEW_SEED_URL,
      source_pdf_hash: NEW_SEED_HASH,
      groups: 41,
      lessons: 452,
    });

    const served = await getCurrentSchedule(1);
    expect(served?.metadata).toMatchObject({
      source_pdf_url: NEW_SEED_URL,
      source_pdf_hash: NEW_SEED_HASH,
      source_kind: "manual",
    });
    expect(served?.groups).toHaveLength(41);
    expect(served?.lessons).toHaveLength(452);
    expect(validateSchedule(served!, { previousLessonCount: old.lessons.length }).ok).toBe(true);

    const state = await getSourceState(1);
    expect(state).toMatchObject({
      current_pdf_url: NEW_SEED_URL,
      current_pdf_hash: NEW_SEED_HASH,
      last_result: "error",
    });
    expect(state.last_error).toMatch(/Cloudflare challenge/);

    const status = await buildStatus(1);
    expect(status.schedule).toMatchObject({
      source_pdf_url: NEW_SEED_URL,
      source_pdf_hash: NEW_SEED_HASH,
      source_kind: "manual",
      groups: 41,
      lessons: 452,
    });
    expect(status.source.last_result).toBe("error");
    expect(status.source.last_error).toMatch(/Cloudflare challenge/);
  });
});

describe("packaged seed promotion", () => {
  it("promotes persisted -5 seed to validated -18 seed even when discovery is challenged", async () => {
    await writeFile(packagedSeedPath, newSeedBytes);
    await persistOldSchedule("seed");
    stubFetch(cloudflareDiscoveryRoutes());

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("error");
    expect(result.message).toMatch(/Cloudflare challenge/);

    const served = await getCurrentSchedule(1);
    expect(served?.metadata).toMatchObject({
      source_pdf_url: NEW_SEED_URL,
      source_pdf_hash: NEW_SEED_HASH,
      source_kind: "seed",
    });
    expect(served?.groups).toHaveLength(41);
    expect(served?.lessons).toHaveLength(452);
    expect(served?.lessons.filter((lesson) => lesson.uncertain)).toHaveLength(0);

    const status = await buildStatus(1);
    expect(status.schedule).toMatchObject({
      source_pdf_url: NEW_SEED_URL,
      source_pdf_hash: NEW_SEED_HASH,
      groups: 41,
      lessons: 452,
    });
    expect(status.source).toMatchObject({
      current_pdf_url: NEW_SEED_URL,
      last_result: "error",
    });
    expect(status.source.last_error).toMatch(/Cloudflare challenge/);
  });

  it.each(["live", "manual"] as const)("never overwrites a valid %s schedule with the bundled seed", async (sourceKind) => {
    await writeFile(packagedSeedPath, newSeedBytes);
    const current = await persistOldSchedule(sourceKind);
    stubFetch(cloudflareDiscoveryRoutes());

    expect((await checkForUpdates(1)).outcome).toBe("error");
    const served = await getCurrentSchedule(1);
    expect(served?.metadata).toMatchObject({
      source_pdf_url: OLD_SEED_URL,
      source_pdf_hash: current.metadata.source_pdf_hash,
      source_kind: sourceKind,
    });
  });
});
