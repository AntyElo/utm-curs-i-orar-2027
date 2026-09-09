/**
 * Upstream PDF transport.
 *
 * Redirects are handled manually and every hop is re-checked against the official timetable PDF
 * policy, so a redirect can only ever move us between two URLs we would have accepted as the
 * original target. Unlike the Page API — which must answer directly — WordPress uploads do
 * legitimately move between https variants, so a validated hop is allowed here.
 */

import { isOfficialTimetablePdfUrl } from "./extractor";
import { BROKER_USER_AGENT } from "./http";

/** Upper bound on a single mirrored timetable; the largest real FCIM PDF is ~1.3 MB. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const BASE_PDF_FETCH_OPTIONS: RequestInit = {
  method: "GET",
  redirect: "manual",
  cf: {
    cacheEverything: true,
    cacheTtl: 3600,
  },
} as RequestInit;

export class PdfFetchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "PdfFetchError";
    this.status = status;
  }
}

/**
 * GET an official timetable PDF, validating the URL before every request.
 * The response body is returned unread so the caller can stream it straight into R2.
 */
export async function fetchOfficialPdf(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isOfficialTimetablePdfUrl(currentUrl)) {
      throw new PdfFetchError(`Unsafe PDF URL rejected by allowlist: ${currentUrl}`);
    }

    const headers: Record<string, string> = {
      Accept: "application/pdf,*/*;q=0.8",
      "User-Agent": BROKER_USER_AGENT,
      ...extraHeaders,
    };

    let response: Response;
    try {
      response = await fetch(currentUrl, { ...BASE_PDF_FETCH_OPTIONS, headers });
    } catch (err) {
      throw new PdfFetchError(`PDF network error for ${currentUrl}: ${(err as Error).message}`);
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("Location");
    if (!location) {
      throw new PdfFetchError(`Redirect from ${currentUrl} has no Location header`, response.status);
    }
    try {
      currentUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new PdfFetchError(`Redirect from ${currentUrl} has an unparseable Location: ${location}`);
    }
  }

  throw new PdfFetchError(`Too many redirects fetching PDF: ${url}`);
}
