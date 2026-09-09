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

import { isOfficialTimetablePdfUrl } from "../../worker-shared/fcim-policy";

export {
  isAllowedPageApiUrl,
  isOfficialTimetablePdfUrl,
} from "../../worker-shared/fcim-policy";

const HREF_PDF_REGEX =
  /href\s*=\s*["']([^"']*(?:\/wp-content\/uploads\/sites\/24\/\d{4}\/(?:0[1-9]|1[0-2])\/[^"'\s<>]+\.pdf))["']/gi;
const RAW_URL_REGEX =
  /(?:^|[\s"'<>])(https:\/\/fcim\.utm\.md\/wp-content\/uploads\/sites\/24\/\d{4}\/(?:0[1-9]|1[0-2])\/[a-zA-Z0-9_\-.]+\.pdf)(?=[\s"'<>&,]|$)/gi;

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
