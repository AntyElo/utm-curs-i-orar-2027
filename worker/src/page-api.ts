/**
 * Authoritative FCIM Page API access.
 *
 * The Page API is the one endpoint the broker trusts to say which timetable PDFs exist, so it is
 * fetched with `redirect: "manual"` and any redirect is refused outright. This endpoint is stable;
 * a 3xx from it means either the site moved or something is redirecting us, and neither is a thing
 * a transport broker should resolve on its own. Following a redirect here would let a changed
 * upstream configuration decide which host we take our catalogue of PDFs from.
 */

import {
  FcimEgressClientError,
  egressErrorDetail,
  egressErrorKind,
  fetchThroughStockholmEgress,
} from "./fcim-egress-client";
import { validatorOrNull } from "./http";
import type { Env } from "./types";
import {
  CANONICAL_PAGE_API_URL,
  FCIM_UPSTREAM_CF_RAY_HEADER,
  isAllowedPageApiUrl,
} from "../../worker-shared/fcim-policy";

export const DEFAULT_PAGE_API_URL = CANONICAL_PAGE_API_URL;

/** WordPress page payloads are small; a much larger body is not the document we asked for. */
export const MAX_PAGE_API_BYTES = 4 * 1024 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class PageApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "PageApiError";
    this.status = status;
  }
}

export interface PageApiResponse {
  /** `true` when the upstream answered 304 and no body was transferred. */
  notModified: boolean;
  status: number;
  bytes: Uint8Array | null;
  etag: string | null;
  lastModified: string | null;
}

/**
 * Resolve the configured Page API URL, refusing anything outside the exact approved endpoint.
 */
export function resolvePageApiUrl(configured: string | undefined): string {
  const url = configured ?? DEFAULT_PAGE_API_URL;
  if (!isAllowedPageApiUrl(url)) {
    throw new PageApiError(`Invalid Page API URL: ${url}`);
  }
  return url;
}

/**
 * Fetch the Page API. Redirects are rejected, not followed; non-200/304 statuses are errors
 * (a 403 challenge and a 500 both mean "we do not know the upstream state", never "unchanged").
 */
export async function fetchPageApi(
  env: Env,
  url: string,
  conditional: { etag?: string | null; lastModified?: string | null } = {},
): Promise<PageApiResponse> {
  if (!isAllowedPageApiUrl(url)) {
    throw new PageApiError(`Invalid Page API URL: ${url}`);
  }

  let response: Response;
  try {
    response = await fetchThroughStockholmEgress(env, "PAGE_API", url, {
      etag: conditional.etag,
      lastModified: conditional.lastModified,
    });
  } catch (err) {
    if (err instanceof FcimEgressClientError) {
      throw new PageApiError(`Page API ${err.message}`, err.status);
    }
    throw new PageApiError(`Page API network error: ${(err as Error).message}`);
  }

  const relayError = egressErrorKind(response);
  if (relayError) {
    const detail = await egressErrorDetail(response);
    throw new PageApiError(
      `Page API Stockholm transport rejected the request (${relayError})${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }

  if (REDIRECT_STATUSES.has(response.status)) {
    const location = response.headers.get("Location") ?? "(none)";
    throw new PageApiError(
      `Page API answered with redirect HTTP ${response.status} to ${location}; the approved endpoint must answer directly`,
      response.status,
    );
  }

  if (response.status === 304) {
    return {
      notModified: true,
      status: 304,
      bytes: null,
      etag: validatorOrNull(response.headers.get("ETag")),
      lastModified: validatorOrNull(response.headers.get("Last-Modified")),
    };
  }

  if (response.status !== 200) {
    // FCIM sits behind Cloudflare and challenges some edge locations, so the upstream ray id is
    // the difference between "the site is down" and "this colo is being refused" when reading logs.
    const ray = response.headers.get(FCIM_UPSTREAM_CF_RAY_HEADER);
    throw new PageApiError(
      `Page API returned HTTP ${response.status}${ray ? ` (upstream cf-ray ${ray})` : ""}`,
      response.status,
    );
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_PAGE_API_BYTES) {
    throw new PageApiError(`Page API body exceeds ${MAX_PAGE_API_BYTES} bytes`, 200);
  }

  return {
    notModified: false,
    status: 200,
    bytes: new Uint8Array(buffer),
    etag: validatorOrNull(response.headers.get("ETag")),
    lastModified: validatorOrNull(response.headers.get("Last-Modified")),
  };
}

export interface PageApiDocument {
  pageId: number | null;
  pageModifiedGmt: string | null;
  renderedHtml: string;
}

/**
 * Pull the three fields the broker is allowed to care about out of a WordPress page payload.
 * Everything else in the document — and every timetable meaning of it — belongs to Render.
 */
export function readPageApiDocument(rawText: string): PageApiDocument {
  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch (err) {
    throw new PageApiError(`Page API returned invalid JSON: ${(err as Error).message}`);
  }

  const item = Array.isArray(payload) ? payload[0] : payload;
  if (!item || typeof item !== "object") {
    throw new PageApiError("Page API payload is not a page object");
  }

  const record = item as { id?: unknown; modified_gmt?: unknown; content?: { rendered?: unknown } };
  const rendered = record.content?.rendered;
  if (typeof rendered !== "string") {
    throw new PageApiError("Page API payload has no rendered content");
  }

  const pageId =
    typeof record.id === "number" && Number.isSafeInteger(record.id) && record.id > 0 ? record.id : null;

  return {
    pageId,
    pageModifiedGmt: typeof record.modified_gmt === "string" ? record.modified_gmt : null,
    renderedHtml: rendered,
  };
}
