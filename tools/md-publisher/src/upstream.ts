/**
 * FCIM access.
 *
 * This is the only file in the whole system that is allowed to make a request to fcim.utm.md, and
 * it is deliberately narrow:
 *
 * - the Page API is one exact canonical URL, taken from the shared policy module, and a redirect
 *   from it is an error rather than something to follow;
 * - a PDF URL must satisfy the official-timetable policy before the request, and every redirect
 *   hop must satisfy it again afterwards, so a redirect can only move between two URLs that would
 *   have been accepted as the original target.
 *
 * Between them, those two rules are what stop the laptop from being usable as an SSRF helper by
 * anything that can influence a URL — including the broker's own plan.
 */

import fs from "node:fs";
import crypto from "node:crypto";

import {
  CANONICAL_PAGE_API_URL,
  isOfficialTimetablePdfUrl,
  resolveOfficialTimetablePdfRedirect,
} from "../../../worker-shared/fcim-policy";
import { UpstreamError, type Transport } from "./types";

/** Same ceiling the broker enforces on an uploaded Page API payload. */
export const MAX_PAGE_API_BYTES = 1024 * 1024;

/** Same ceiling the broker enforces on an uploaded PDF. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

const MAX_PDF_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

export const PAGE_API_URL = CANONICAL_PAGE_API_URL;

/** FCIM answers with a present-but-empty `etag:`. An empty validator is not a validator. */
export function validatorOrNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export interface PageApiResult {
  status: number;
  notModified: boolean;
  bytes: Uint8Array | null;
  etag: string | null;
  lastModified: string | null;
}

export async function fetchPageApi(
  transport: Transport,
  timeoutMs: number,
  conditional: { etag?: string | null; lastModified?: string | null } = {},
): Promise<PageApiResult> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (conditional.etag) headers["If-None-Match"] = conditional.etag;
  if (conditional.lastModified) headers["If-Modified-Since"] = conditional.lastModified;

  const response = await transport.get(PAGE_API_URL, headers, timeoutMs);

  if (REDIRECT_STATUSES.has(response.status)) {
    await response.cancel();
    throw new UpstreamError(
      `Page API answered with redirect HTTP ${response.status}; the approved endpoint must answer directly`,
      response.status,
    );
  }

  if (response.status === 304) {
    await response.cancel();
    return {
      status: 304,
      notModified: true,
      bytes: null,
      etag: validatorOrNull(response.headers.get("etag")),
      lastModified: validatorOrNull(response.headers.get("last-modified")),
    };
  }

  if (response.status !== 200) {
    await response.cancel();
    throw new UpstreamError(`Page API returned HTTP ${response.status}`, response.status);
  }

  const bytes = await readWithin(response.body, MAX_PAGE_API_BYTES, "Page API");
  return {
    status: 200,
    notModified: false,
    bytes,
    etag: validatorOrNull(response.headers.get("etag")),
    lastModified: validatorOrNull(response.headers.get("last-modified")),
  };
}

async function readWithin(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  if (!body) throw new UpstreamError(`${label} returned an empty body`);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UpstreamError(`${label} body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Issue one policy-checked PDF request, resolving redirects manually.
 * The response body is returned unread; the caller decides whether to stream or discard it.
 */
async function requestPdf(
  transport: Transport,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
) {
  let target = url;
  for (let hop = 0; hop <= MAX_PDF_REDIRECTS; hop++) {
    if (!isOfficialTimetablePdfUrl(target)) {
      throw new UpstreamError(`Refusing a PDF URL outside the official FCIM policy: ${target}`);
    }
    const response = await transport.get(target, headers, timeoutMs);
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: target };
    }
    await response.cancel();
    const location = response.headers.get("location");
    if (!location) {
      throw new UpstreamError(`PDF redirect from ${target} had no Location`, response.status);
    }
    const next = resolveOfficialTimetablePdfRedirect(location, target);
    if (!next) {
      throw new UpstreamError(
        `PDF redirect from ${target} left the approved FCIM origin policy`,
        response.status,
      );
    }
    target = next;
  }
  throw new UpstreamError(`PDF ${url} exceeded ${MAX_PDF_REDIRECTS} redirects`);
}

export interface RevalidateResult {
  status: number;
  changed: boolean;
  etag: string | null;
  lastModified: string | null;
}

/**
 * Conditionally revalidate one mirrored PDF without reading its body.
 *
 * A 304 means unchanged. A 200 means FCIM replaced the document in place under the same URL,
 * which is a publication trigger even when the page itself never moved. Anything else means the
 * upstream state is unknown, which is never "unchanged".
 */
export async function revalidatePdf(
  transport: Transport,
  url: string,
  conditional: { etag: string | null; lastModified: string | null },
  timeoutMs: number,
): Promise<RevalidateResult> {
  const headers: Record<string, string> = { Accept: "application/pdf" };
  if (conditional.etag) headers["If-None-Match"] = conditional.etag;
  if (conditional.lastModified) headers["If-Modified-Since"] = conditional.lastModified;

  const { response } = await requestPdf(transport, url, headers, timeoutMs);
  await response.cancel();

  if (response.status === 304) {
    return { status: 304, changed: false, etag: conditional.etag, lastModified: conditional.lastModified };
  }
  if (response.status === 200) {
    return {
      status: 200,
      changed: true,
      etag: validatorOrNull(response.headers.get("etag")),
      lastModified: validatorOrNull(response.headers.get("last-modified")),
    };
  }
  throw new UpstreamError(`Conditional check for ${url} returned HTTP ${response.status}`, response.status);
}

export interface DownloadedPdf {
  path: string;
  size: number;
  sha256: string;
  etag: string | null;
  lastModified: string | null;
}

/**
 * Stream one PDF to a temporary file, hashing and validating as the bytes arrive.
 *
 * Nothing is kept in memory, the byte cap is enforced from bytes actually read, and a body that
 * does not begin with `%PDF-` fails before the file can be handed to the broker.
 */
export async function downloadPdf(
  transport: Transport,
  url: string,
  destination: string,
  timeoutMs: number,
): Promise<DownloadedPdf> {
  const { response } = await requestPdf(transport, url, { Accept: "application/pdf" }, timeoutMs);

  if (response.status !== 200) {
    await response.cancel();
    throw new UpstreamError(`PDF ${url} returned HTTP ${response.status}`, response.status);
  }
  if (!response.body) {
    throw new UpstreamError(`PDF ${url} returned an empty body`);
  }

  const hash = crypto.createHash("sha256");
  const handle = fs.createWriteStream(destination);
  const reader = response.body.getReader();
  let size = 0;
  let magicChecked = false;
  let magicPrefix = Buffer.alloc(0);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const chunk = Buffer.from(value);
      if (!magicChecked) {
        magicPrefix = Buffer.concat([magicPrefix, chunk.subarray(0, PDF_MAGIC.length)]);
        if (magicPrefix.length >= PDF_MAGIC.length) {
          if (!magicPrefix.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
            throw new UpstreamError(`PDF ${url} does not begin with a %PDF- signature`);
          }
          magicChecked = true;
        }
      }

      size += chunk.byteLength;
      if (size > MAX_PDF_BYTES) {
        throw new UpstreamError(`PDF ${url} exceeds the ${MAX_PDF_BYTES} byte limit`);
      }
      hash.update(chunk);
      if (!handle.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          handle.once("drain", resolve);
          handle.once("error", reject);
        });
      }
    }

    if (!magicChecked) {
      throw new UpstreamError(`PDF ${url} is shorter than a %PDF- signature`);
    }
  } catch (err) {
    handle.destroy();
    await reader.cancel().catch(() => {});
    fs.rmSync(destination, { force: true });
    throw err;
  }

  await new Promise<void>((resolve, reject) => {
    handle.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });

  return {
    path: destination,
    size,
    sha256: hash.digest("hex"),
    etag: validatorOrNull(response.headers.get("etag")),
    lastModified: validatorOrNull(response.headers.get("last-modified")),
  };
}
