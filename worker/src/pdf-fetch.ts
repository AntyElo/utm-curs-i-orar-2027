/**
 * Upstream PDF transport.
 *
 * Redirects are handled manually and every hop is re-checked against the official timetable PDF
 * policy, so a redirect can only ever move us between two URLs we would have accepted as the
 * original target. Unlike the Page API — which must answer directly — WordPress uploads do
 * legitimately move between https variants, so a validated hop is allowed here.
 */

import {
  FcimEgressClientError,
  egressErrorDetail,
  egressErrorKind,
  fetchThroughStockholmEgress,
} from "./fcim-egress-client";
import type { Env } from "./types";
import { isOfficialTimetablePdfUrl } from "../../worker-shared/fcim-policy";

/** Upper bound on a single mirrored timetable; the largest real FCIM PDF is ~1.3 MB. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

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
  env: Env,
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  if (!isOfficialTimetablePdfUrl(url)) {
    throw new PdfFetchError(`Unsafe PDF URL rejected by allowlist: ${url}`);
  }

  const conditional = {
    etag: extraHeaders?.["If-None-Match"],
    lastModified: extraHeaders?.["If-Modified-Since"],
  };

  let response: Response;
  try {
    response = await fetchThroughStockholmEgress(env, "PDF", url, conditional);
  } catch (err) {
    if (err instanceof FcimEgressClientError) {
      throw new PdfFetchError(`PDF ${err.message}`, err.status);
    }
    throw new PdfFetchError(`PDF network error for ${url}: ${(err as Error).message}`);
  }

  const relayError = egressErrorKind(response);
  if (relayError) {
    const detail = await egressErrorDetail(response);
    throw new PdfFetchError(
      `PDF Stockholm transport rejected the request (${relayError})${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  return response;
}
