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
  /^\/wp-content\/uploads\/sites\/24\/\d{4}\/(?:0[1-9]|1[0-2])\/[^/]+\.pdf$/i;

/**
 * Strict policy for official timetable PDF URLs.
 * Rejects non-https, external hosts, directory traversal, credentials, non-standard ports.
 */
export function isOfficialTimetablePdfUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  // Traversal and encoding checks
  if (/%2f|%5c/i.test(url.pathname) || url.pathname.includes("..")) {
    return false;
  }

  return (
    url.protocol === "https:" &&
    url.hostname.toLowerCase() === "fcim.utm.md" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    OFFICIAL_TIMETABLE_PDF_PATH.test(url.pathname)
  );
}

/**
 * Strict policy for WordPress Page API URL.
 */
export function isAllowedPageApiUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  return (
    url.protocol === "https:" &&
    (url.hostname.toLowerCase() === "fcim.utm.md" || url.hostname.toLowerCase() === "utm.md") &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

/**
 * Extract official timetable PDF URLs from HTML without using cheerio or heavy DOM libraries.
 * Scans for anchor hrefs matching official FCIM timetable PDF paths.
 */
export function extractOfficialPdfUrls(html: string, baseUrl = "https://fcim.utm.md"): string[] {
  const urls: string[] = [];
  // Match href attributes in anchor tags or direct links: href=["']([^"']+)["']
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = hrefRegex.exec(html)) !== null) {
    const candidateHref = match[1].trim();
    try {
      const resolved = new URL(candidateHref, baseUrl).toString();
      if (isOfficialTimetablePdfUrl(resolved) && !urls.includes(resolved)) {
        urls.push(resolved);
      }
    } catch {
      // Ignore unparseable hrefs
    }
  }

  // Fallback: also scan raw URLs matching the pattern in text if anchors were stripped or escaped
  const rawUrlRegex = /https:\/\/fcim\.utm\.md\/wp-content\/uploads\/sites\/24\/\d{4}\/(?:0[1-9]|1[0-2])\/[a-zA-Z0-9_\-.]+\.pdf/gi;
  while ((match = rawUrlRegex.exec(html)) !== null) {
    const rawMatch = match[0];
    if (isOfficialTimetablePdfUrl(rawMatch) && !urls.includes(rawMatch)) {
      urls.push(rawMatch);
    }
  }

  return urls;
}

/**
 * Extract filename from a valid official timetable PDF URL.
 */
export function getPdfFilename(urlStr: string): string {
  const url = new URL(urlStr);
  const parts = url.pathname.split("/").filter(Boolean);
  return parts.at(-1) ?? "timetable.pdf";
}
