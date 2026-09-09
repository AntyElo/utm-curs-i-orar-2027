/**
 * Runtime configuration. Every knob is overridable through environment variables;
 * defaults are safe for local development and the production container.
 */
import path from "node:path";
import { DEFAULT_ODD_WEEK_ANCHOR } from "@/lib/client/time";

const MINUTE_MS = 60_000;
const MEGABYTE = 1024 * 1024;
const DEFAULT_SCHEDULE_PAGE_URL = "https://fcim.utm.md/procesul-de-studii/orar/";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function wordpressApiUrl(pageUrl: string): string {
  const page = new URL(pageUrl);
  const slug = page.pathname.split("/").filter(Boolean).at(-1) ?? "orar";
  const api = new URL("/wp-json/wp/v2/pages", page.origin);
  api.searchParams.set("slug", slug);
  api.searchParams.set("context", "view");
  return api.toString();
}

const schedulePageUrl = process.env.SCHEDULE_PAGE_URL ?? DEFAULT_SCHEDULE_PAGE_URL;

export const config = {
  /** Source of truth: the official FCIM schedule page. PDF URLs are discovered from it. */
  schedulePageUrl,
  /** Hosts from which the PDF may be downloaded (SSRF guard). */
  allowedHosts: envList("SCHEDULE_ALLOWED_HOSTS", ["fcim.utm.md", "utm.md"]),
  /** Use the official WordPress API when the rendered page is blocked by Cloudflare. */
  wordpressFallbackEnabled: envBool("SCHEDULE_WORDPRESS_FALLBACK", true),
  wordpressApiUrl: process.env.SCHEDULE_WORDPRESS_API_URL ?? wordpressApiUrl(schedulePageUrl),
  /** Use the Wayback Machine as a final read-only mirror when both live endpoints are unreachable. */
  waybackFallbackEnabled: envBool("SCHEDULE_WAYBACK_FALLBACK", true),
  waybackHost: "web.archive.org",
  refreshIntervalMs: envInt("SCHEDULE_REFRESH_MINUTES", 30) * MINUTE_MS,
  httpTimeoutMs: envInt("SCHEDULE_HTTP_TIMEOUT_MS", 20_000),
  maxRedirects: envInt("SCHEDULE_MAX_REDIRECTS", 5),
  maxPdfBytes: envInt("SCHEDULE_MAX_PDF_MB", 25) * MEGABYTE,
  userAgent:
    process.env.SCHEDULE_USER_AGENT ??
    "Mozilla/5.0 (compatible; fcim-schedule-bot/1.0; +https://github.com/fcim-schedule)",
  /** Root of the per-course cache: data/courses/<year>/{current_schedule,metadata}.json. */
  dataDir: path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.SCHEDULE_DATA_DIR ?? "data"),
  /** Monday of a week the university counts as odd, as "YYYY-MM-DD". One calendar per deployment,
   *  shared by every course: FCIM publishes a single week-parity announcement. */
  oddWeekAnchor: process.env.SCHEDULE_ODD_WEEK_ANCHOR ?? DEFAULT_ODD_WEEK_ANCHOR,
  /** Token required for POST /api/admin/refresh. Empty = endpoint disabled. */
  adminToken: process.env.SCHEDULE_ADMIN_TOKEN ?? "",
  /** Sanity check: reject a new parse if lesson count drops below this share of the previous one. */
  minLessonRatio: 0.6,
  minGroups: 5,
  minLessons: 30,
  /** Bump on every parser behaviour change: a cached schedule parsed by an older
   *  version is re-parsed on the next check even when the PDF itself is unchanged. */
  parserVersion: "1.3.0",
  timezone: "Europe/Chisinau",
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** Cloudflare Worker + R2 schedule broker base URL (e.g. https://broker.example.workers.dev). Unset = direct FCIM.
   *  Kept verbatim: `parseAndValidateBrokerUrl` inspects the configured string *before* any
   *  normalisation, because trimming is exactly what would hide a traversal segment from it. */
  brokerUrl: (process.env.SCHEDULE_BROKER_URL ?? "").trim(),
  /** Bearer secret token for authenticating durable accepted-state writes to the broker. */
  brokerSecret: process.env.SCHEDULE_BROKER_SECRET ?? "",
  /** Timeout for broker requests during cold-start bootstrap and sync (default 3000 ms). */
  brokerTimeoutMs: envInt("SCHEDULE_BROKER_TIMEOUT_MS", 3000),
} as const;

export type AppConfig = typeof config;
