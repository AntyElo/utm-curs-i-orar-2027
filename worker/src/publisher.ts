/**
 * Cloudflare Worker candidate snapshot publisher.
 *
 * Implements strict publication ordering:
 * 1. read current.json metadata/ETag
 * 2. resolve previous_snapshot_id
 * 3. fetch authoritative FCIM Page API (with conditional headers)
 * 4. identify valid official timetable PDF URLs
 * 5. write all new immutable PDF objects via streaming
 * 6. write page-api.json
 * 7. write manifest.json
 * 8. CAS current.json LAST
 */

import {
  extractOfficialPdfUrls,
  getPdfFilename,
  isAllowedPageApiUrl,
  isOfficialTimetablePdfUrl,
} from "./extractor";
import type {
  CurrentPointer,
  Env,
  PublishResult,
  R2PutOptions,
  SnapshotFile,
  SnapshotManifest,
} from "./types";

const DEFAULT_PAGE_API_URL = "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view";
const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB cap

/**
 * Generate a collision-safe snapshot identifier.
 * Format: YYYY-MM-DDTHH-mm-ss-sssZ-<random-8>
 */
export function generateSnapshotId(now = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const randomSuffix = crypto.randomUUID().slice(0, 8);
  return `${iso}-${randomSuffix}`;
}

/**
 * Safe fetch with redirect validation against strict official timetable URL policy.
 */
async function fetchSafePdf(url: string, headers: HeadersInit = {}): Promise<Response> {
  let currentUrl = url;
  let redirects = 0;
  const maxRedirects = 5;

  while (redirects <= maxRedirects) {
    if (!isOfficialTimetablePdfUrl(currentUrl)) {
      throw new Error(`Unsafe PDF URL rejected by allowlist: ${currentUrl}`);
    }

    const response = await fetch(currentUrl, {
      method: "GET",
      headers,
      redirect: "manual",
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (!location) {
        throw new Error(`Redirect from ${currentUrl} has no Location header`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      redirects++;
      continue;
    }

    return response;
  }

  throw new Error(`Too many redirects fetching PDF: ${url}`);
}

/**
 * Execute candidate publication pipeline.
 */
export async function publishCandidateSnapshot(
  env: Env,
  options: { force?: boolean } = {},
): Promise<PublishResult> {
  const pageApiUrl = env.FCIM_PAGE_API_URL ?? DEFAULT_PAGE_API_URL;
  if (!isAllowedPageApiUrl(pageApiUrl)) {
    return { published: false, error: `Invalid Page API URL: ${pageApiUrl}` };
  }

  // Step 1 & 2: Read current.json metadata / ETag and resolve previous_snapshot_id
  const currentObj = await env.R2_BUCKET.get("current.json");
  const currentEtag = currentObj?.etag ?? null;
  let previousSnapshotId: string | null = null;
  let previousManifest: SnapshotManifest | null = null;

  if (currentObj) {
    try {
      const currentPointer = (await currentObj.json()) as CurrentPointer;
      previousSnapshotId = currentPointer.snapshot_id;
      const prevManifestObj = await env.R2_BUCKET.get(currentPointer.manifest_r2_key);
      if (prevManifestObj) {
        previousManifest = (await prevManifestObj.json()) as SnapshotManifest;
      }
    } catch (err) {
      console.warn("Failed to parse existing current.json or manifest:", err);
    }
  }

  // Step 3: Fetch authoritative FCIM Page API (with conditional headers when available)
  const pageHeaders: Record<string, string> = {
    Accept: "application/json",
  };
  if (!options.force && previousManifest?.source.etag) {
    pageHeaders["If-None-Match"] = previousManifest.source.etag;
  }
  if (!options.force && previousManifest?.source.last_modified) {
    pageHeaders["If-Modified-Since"] = previousManifest.source.last_modified;
  }

  let pageApiResponse: Response;
  try {
    pageApiResponse = await fetch(pageApiUrl, { headers: pageHeaders });
  } catch (err) {
    return { published: false, error: `Failed to fetch FCIM Page API: ${(err as Error).message}` };
  }

  let pageApiNotModified = pageApiResponse.status === 304;
  let pageApiPayload: unknown = null;
  let pageApiEtag = pageApiResponse.headers.get("ETag");
  let pageApiLastModified = pageApiResponse.headers.get("Last-Modified");

  // Step 9: PDF freshness check when page API itself is unchanged (304)
  if (!options.force && pageApiNotModified && previousManifest) {
    let pdfChanged = false;
    for (const file of previousManifest.files) {
      try {
        const condHeaders: HeadersInit = {};
        if (file.upstream_etag) condHeaders["If-None-Match"] = file.upstream_etag;
        if (file.upstream_last_modified) condHeaders["If-Modified-Since"] = file.upstream_last_modified;

        const headRes = await fetchSafePdf(file.source_url, condHeaders);
        if (headRes.status === 200) {
          pdfChanged = true;
          break;
        }
      } catch (err) {
        console.warn(`Conditional check failed for ${file.source_url}:`, err);
      }
    }

    if (!pdfChanged) {
      return { published: false, reason: "unchanged (page 304 and PDFs 304)" };
    }
    // A PDF changed! We must proceed with new publication. Fetch full Page API body.
    const fullPageRes = await fetch(pageApiUrl, { headers: { Accept: "application/json" } });
    if (!fullPageRes.ok) {
      return { published: false, error: `Failed to fetch full Page API: HTTP ${fullPageRes.status}` };
    }
    pageApiPayload = await fullPageRes.json();
    pageApiEtag = fullPageRes.headers.get("ETag") ?? pageApiEtag;
    pageApiLastModified = fullPageRes.headers.get("Last-Modified") ?? pageApiLastModified;
    pageApiNotModified = false;
  } else if (!pageApiNotModified) {
    if (!pageApiResponse.ok) {
      return { published: false, error: `Page API returned HTTP ${pageApiResponse.status}` };
    }
    try {
      pageApiPayload = await pageApiResponse.json();
    } catch (err) {
      return { published: false, error: `Invalid JSON from Page API: ${(err as Error).message}` };
    }
  }

  // Extract rendered HTML from WordPress API payload
  const pageItem = Array.isArray(pageApiPayload) ? pageApiPayload[0] : pageApiPayload;
  const pageId = typeof pageItem === "object" && pageItem && "id" in pageItem ? Number(pageItem.id) : null;
  const pageModifiedGmt =
    typeof pageItem === "object" && pageItem && "modified_gmt" in pageItem ? String(pageItem.modified_gmt) : null;
  const renderedContent =
    typeof pageItem === "object" && pageItem && "content" in pageItem
      ? (pageItem as { content?: { rendered?: unknown } }).content?.rendered
      : null;

  if (typeof renderedContent !== "string") {
    return { published: false, error: "Page API payload has no rendered content" };
  }

  // Step 4: Identify valid official timetable PDF URLs
  const pdfUrls = extractOfficialPdfUrls(renderedContent);
  if (pdfUrls.length === 0) {
    return { published: false, error: "No official timetable PDF URLs found in Page API rendered content" };
  }

  const snapshotId = generateSnapshotId();
  const snapshotCreated = new Date().toISOString();
  const snapshotFiles: SnapshotFile[] = [];

  // Step 5: Write all new immutable PDF objects via streaming
  for (const pdfUrl of pdfUrls) {
    const filename = getPdfFilename(pdfUrl);
    const r2Key = `snapshots/${snapshotId}/pdfs/${filename}`;

    let pdfRes: Response;
    try {
      pdfRes = await fetchSafePdf(pdfUrl);
    } catch (err) {
      console.error(`Failed to fetch PDF ${pdfUrl}:`, err);
      return { published: false, error: `Failed to fetch PDF ${pdfUrl}: ${(err as Error).message}` };
    }

    if (!pdfRes.ok) {
      return { published: false, error: `PDF ${pdfUrl} returned HTTP ${pdfRes.status}` };
    }

    // Sanity checks on headers
    const contentType = pdfRes.headers.get("Content-Type");
    const contentLength = pdfRes.headers.get("Content-Length");
    const sizeBytes = contentLength ? Number(contentLength) : null;
    if (sizeBytes !== null && sizeBytes > MAX_PDF_BYTES) {
      return { published: false, error: `PDF ${pdfUrl} exceeds size limit (${sizeBytes} bytes)` };
    }

    const upstreamEtag = pdfRes.headers.get("ETag");
    const upstreamLastModified = pdfRes.headers.get("Last-Modified");

    if (!pdfRes.body) {
      return { published: false, error: `PDF ${pdfUrl} returned empty body` };
    }

    // Stream directly into R2.put() without buffering in worker memory
    const r2Put = await env.R2_BUCKET.put(r2Key, pdfRes.body, {
      httpMetadata: {
        contentType: contentType ?? "application/pdf",
      },
      customMetadata: {
        source_url: pdfUrl,
        upstream_etag: upstreamEtag ?? "",
        upstream_last_modified: upstreamLastModified ?? "",
      },
    });

    if (!r2Put) {
      return { published: false, error: `Failed to write PDF object ${r2Key} to R2` };
    }

    snapshotFiles.push({
      filename,
      source_url: pdfUrl,
      r2_key: r2Key,
      content_type: contentType,
      size: sizeBytes ?? r2Put.size,
      upstream_etag: upstreamEtag,
      upstream_last_modified: upstreamLastModified,
    });
  }

  // Step 6: Write page-api.json
  const pageApiKey = `snapshots/${snapshotId}/page-api.json`;
  const pageApiWritten = await env.R2_BUCKET.put(pageApiKey, JSON.stringify(pageApiPayload, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  if (!pageApiWritten) {
    return { published: false, error: "Failed to write page-api.json to R2" };
  }

  // Step 7: Write manifest.json
  const manifest: SnapshotManifest = {
    schema_version: 1,
    snapshot_id: snapshotId,
    previous_snapshot_id: previousSnapshotId,
    created_at: snapshotCreated,
    source: {
      page_api_url: pageApiUrl,
      page_id: pageId,
      page_modified_gmt: pageModifiedGmt,
      retrieved_at: snapshotCreated,
      etag: pageApiEtag,
      last_modified: pageApiLastModified,
    },
    files: snapshotFiles,
  };

  const manifestKey = `snapshots/${snapshotId}/manifest.json`;
  const manifestWritten = await env.R2_BUCKET.put(manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  if (!manifestWritten) {
    return { published: false, error: "Failed to write manifest.json to R2" };
  }

  // Step 8: CAS current.json LAST
  const nextPointer: CurrentPointer = {
    schema_version: 1,
    snapshot_id: snapshotId,
    updated_at: snapshotCreated,
    manifest_r2_key: manifestKey,
  };

  const putOptions: R2PutOptions = currentEtag
    ? { onlyIf: { etagMatches: currentEtag } }
    : { onlyIf: new Headers({ "If-None-Match": "*" }) };

  const casResult = await env.R2_BUCKET.put(
    "current.json",
    JSON.stringify(nextPointer, null, 2),
    putOptions,
  );

  if (!casResult) {
    // CAS conflict! Another publisher won!
    console.warn("CAS conflict on current.json; snapshot orphan left in snapshots/", snapshotId);
    return {
      published: false,
      conflict: true,
      snapshot_id: snapshotId,
      error: "CAS conflict writing current.json",
    };
  }

  return {
    published: true,
    snapshot_id: snapshotId,
  };
}
