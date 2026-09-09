/**
 * Pure FCIM transport policy shared by both Workers and their tests.
 *
 * This module deliberately has no Cloudflare runtime or fetch dependencies. The broker validates
 * targets before crossing the Service Binding, and the Stockholm backend independently applies
 * the same policy before it creates an Internet request.
 */

export const CANONICAL_PAGE_API_URL =
  "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view";

export const FCIM_EGRESS_INTERNAL_ORIGIN = "https://fcim-egress.internal";
export const FCIM_EGRESS_PAGE_API_PATH = "/page-api";
export const FCIM_EGRESS_PDF_PATH = "/pdf";
export const FCIM_EGRESS_ERROR_HEADER = "X-FCIM-Egress-Error";
export const FCIM_EGRESS_SERVICE_HEADER = "X-FCIM-Egress-Service";
export const FCIM_EGRESS_SERVICE_VALUE = "fcim-stockholm-egress";
export const FCIM_PLACEMENT_HEADER = "X-FCIM-Placement";
export const FCIM_UPSTREAM_CF_RAY_HEADER = "X-FCIM-Upstream-CF-Ray";

const OFFICIAL_ORIGIN = "https://fcim.utm.md";
const SAFE_PDF_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,190}\.pdf$/i;
export const MAX_OFFICIAL_PDF_FILENAME_LENGTH = 195;

/** Canonical policy for both upstream basenames and stored/served PDF names. */
export function isSafeOfficialPdfFilename(filename: string): boolean {
  return SAFE_PDF_FILENAME.exec(filename)?.[0] === filename && !filename.includes("..");
}
const OFFICIAL_TIMETABLE_PDF_PATH =
  /^\/wp-content\/uploads\/sites\/24\/(\d{4})\/(0[1-9]|1[0-2])\/([^/]+)$/;

// Reject double-encoding, traversal encodings, raw traversal, encoded separators, and
// backslashes before URL normalization can erase the evidence that they were present.
const DANGEROUS_RAW_PATTERN = /(?:%25|%2e|%2f|%5c|\.\.|\\)/i;

/** The Page API is one exact endpoint, including query order and the absence of a fragment. */
export function isAllowedPageApiUrl(rawUrl: string): boolean {
  return rawUrl === CANONICAL_PAGE_API_URL;
}

/** Strict allowlist for the authoritative Page API's dynamic timetable PDF inventory. */
export function isOfficialTimetablePdfUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 2048) return false;
  if (DANGEROUS_RAW_PATTERN.test(rawUrl) || rawUrl.includes("?") || rawUrl.includes("#")) {
    return false;
  }
  if (!rawUrl.startsWith(`${OFFICIAL_ORIGIN}/`)) return false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  const pathMatch = OFFICIAL_TIMETABLE_PDF_PATH.exec(parsed.pathname);
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === "fcim.utm.md" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.origin === OFFICIAL_ORIGIN &&
    parsed.toString() === rawUrl &&
    pathMatch !== null &&
    isSafeOfficialPdfFilename(pathMatch[3])
  );
}

/**
 * Resolve a PDF redirect without allowing URL normalization to conceal a hostile raw Location.
 * Returns null unless both the raw Location and the resolved absolute URL satisfy the policy.
 */
export function resolveOfficialTimetablePdfRedirect(
  rawLocation: string,
  currentUrl: string,
): string | null {
  if (
    rawLocation.length === 0 ||
    rawLocation.length > 2048 ||
    DANGEROUS_RAW_PATTERN.test(rawLocation) ||
    rawLocation.includes("?") ||
    rawLocation.includes("#")
  ) {
    return null;
  }

  let resolved: string;
  try {
    resolved = new URL(rawLocation, currentUrl).toString();
  } catch {
    return null;
  }
  return isOfficialTimetablePdfUrl(resolved) ? resolved : null;
}
