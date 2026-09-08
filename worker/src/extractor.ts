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

const HREF_PDF_REGEX =
  /href\s*=\s*["']([^"']*(?:\/wp-content\/uploads\/sites\/24\/\d{4}\/(?:0[1-9]|1[0-2])\/[^"'\s<>]+\.pdf))["']/gi;
const RAW_URL_REGEX =
  /(?:^|[\s"'<>])(https:\/\/fcim\.utm\.md\/wp-content\/uploads\/sites\/24\/\d{4}\/(?:0[1-9]|1[0-2])\/[a-zA-Z0-9_\-.]+\.pdf)(?=[\s"'<>&,]|$)/gi;

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
  if (!rawUrl.startsWith("https://fcim.utm.md/")) {
    return false;
  }

  // Pathname is strictly everything after "https://fcim.utm.md" (length 19)
  const pathname = rawUrl.slice(19);

  // Check pathname matches approved directory structure and basename
  return OFFICIAL_TIMETABLE_PDF_PATH.test(pathname);
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

  if (!rawUrl.startsWith("https://fcim.utm.md/wp-json/wp/v2/pages?")) {
    return false;
  }

  const queryStr = rawUrl.slice(40); // "https://fcim.utm.md/wp-json/wp/v2/pages?".length === 40
  return queryStr === "slug=orar&context=view" || queryStr === "context=view&slug=orar";
}

/**
 * Extract official timetable PDF URLs from HTML without using cheerio or heavy DOM libraries.
 * Scans for anchor hrefs matching official FCIM timetable PDF paths.
 */
export function extractOfficialPdfUrls(html: string, baseUrl = "https://fcim.utm.md"): string[] {
  const urlSet = new Set<string>();

  HREF_PDF_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = HREF_PDF_REGEX.exec(html)) !== null) {
    const candidateHref = match[1].trim();
    let resolved: string;
    if (candidateHref.startsWith("https://fcim.utm.md/")) {
      resolved = candidateHref;
    } else if (candidateHref.startsWith("/")) {
      resolved = `https://fcim.utm.md${candidateHref}`;
    } else {
      try {
        resolved = new URL(candidateHref, baseUrl).toString();
      } catch {
        continue;
      }
    }
    if (isOfficialTimetablePdfUrl(resolved)) {
      urlSet.add(resolved);
    }
  }

  // Fallback: scan raw URLs ONLY if href matching returned nothing
  if (urlSet.size === 0) {
    RAW_URL_REGEX.lastIndex = 0;
    while ((match = RAW_URL_REGEX.exec(html)) !== null) {
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
