/**
 * Worker-side transport URL policy and PDF URL extractor.
 *
 * Strict restrictions:
 * - NO cheerio
 * - NO pdfjs-dist
 * - NO canvas
 * - NO timetable parser / validator
 * - Pure regex and URL checks
 */

const OFFICIAL_TIMETABLE_PDF_PATH =
  /^\/wp-content\/uploads\/sites\/24\/\d{4}\/(?:0[1-9]|1[0-2])\/[a-zA-Z0-9_\-.]+\.pdf$/i;

// Rejects double-encoding, traversal encodings, and backslashes
const DANGEROUS_RAW_PATTERN = /(?:%25|%2e|%2f|%5c|\.\.|\\)/i;

/**
 * Strict policy for official timetable PDF URLs.
 * Rejects non-https, external hosts, directory traversal, credentials, non-standard ports,
 * queries, fragments, and malicious suffixes (e.g. .pdf.evil).
 */
export function isOfficialTimetablePdfUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return false;
  }

  // Pre-normalization checks on the raw string:
  // Reject traversal, double encoding, backslashes, query params, fragments
  if (DANGEROUS_RAW_PATTERN.test(rawUrl)) {
    return false;
  }
  if (rawUrl.includes("?") || rawUrl.includes("#")) {
    return false;
  }
  if (!rawUrl.startsWith("https://fcim.utm.md/") || !rawUrl.endsWith(".pdf")) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  // Strict structural invariants
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "fcim.utm.md" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return false;
  }

  // Check pathname matches approved directory structure
  if (!OFFICIAL_TIMETABLE_PDF_PATH.test(url.pathname)) {
    return false;
  }

  // Validate basename specifically
  const lastSlash = url.pathname.lastIndexOf("/");
  const basename = lastSlash !== -1 ? url.pathname.slice(lastSlash + 1) : url.pathname;
  if (!basename || !basename.toLowerCase().endsWith(".pdf")) {
    return false;
  }

  // Ensure no hidden traversal or secondary extension before .pdf
  if (basename.slice(0, -4).includes("..")) {
    return false;
  }

  return true;
}

/**
 * Strict policy for WordPress Page API URL.
 * Exactly requires:
 * - https://fcim.utm.md/wp-json/wp/v2/pages
 * - query parameters: slug=orar & context=view (no other parameters allowed)
 */
export function isAllowedPageApiUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return false;
  }

  if (DANGEROUS_RAW_PATTERN.test(rawUrl)) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "fcim.utm.md" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.pathname !== "/wp-json/wp/v2/pages"
  ) {
    return false;
  }

  // Strict query parameter checks: only slug=orar & context=view
  if (url.searchParams.get("slug") !== "orar" || url.searchParams.get("context") !== "view") {
    return false;
  }

  const queryKeys = Array.from(url.searchParams.keys());
  if (queryKeys.length !== 2) {
    return false;
  }

  return true;
}

/**
 * Extract official timetable PDF URLs from HTML without using cheerio or heavy DOM libraries.
 * Scans for anchor hrefs matching official FCIM timetable PDF paths.
 */
export function extractOfficialPdfUrls(html: string, baseUrl = "https://fcim.utm.md"): string[] {
  const urlSet = new Set<string>();

  // Match href attributes targeting uploads
  const hrefRegex = /href\s*=\s*["']([^"']*(?:\/wp-content\/uploads\/sites\/24\/\d{4}\/(?:0[1-9]|1[0-2])\/[^"'\s<>]+\.pdf))["']/gi;
  let match: RegExpExecArray | null;

  while ((match = hrefRegex.exec(html)) !== null) {
    const candidateHref = match[1].trim();
    try {
      const resolved = candidateHref.startsWith("https://") ? candidateHref : new URL(candidateHref, baseUrl).toString();
      if (isOfficialTimetablePdfUrl(resolved)) {
        urlSet.add(resolved);
      }
    } catch {
      // Ignore unparseable hrefs
    }
  }

  // Fallback: scan raw URLs ONLY if href matching returned nothing
  if (urlSet.size === 0) {
    const rawUrlRegex = /(?:^|[\s"'<>])(https:\/\/fcim\.utm\.md\/wp-content\/uploads\/sites\/24\/\d{4}\/(?:0[1-9]|1[0-2])\/[a-zA-Z0-9_\-.]+\.pdf)(?=[\s"'<>&,]|$)/gi;
    while ((match = rawUrlRegex.exec(html)) !== null) {
      const rawMatch = match[1];
      if (isOfficialTimetablePdfUrl(rawMatch)) {
        urlSet.add(rawMatch);
      }
    }
  }

  return Array.from(urlSet);
}

/**
 * Extract filename from a valid official timetable PDF URL.
 */
export function getPdfFilename(urlStr: string): string {
  const slashIdx = urlStr.lastIndexOf("/");
  if (slashIdx !== -1) {
    return urlStr.slice(slashIdx + 1);
  }
  return "timetable.pdf";
}
