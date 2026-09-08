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
  R2Object,
  R2ObjectBody,
  R2PutOptions,
  SnapshotFile,
  SnapshotManifest,
} from "./types";

const DEFAULT_PAGE_API_URL = "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view";
const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB cap
const IF_NONE_MATCH_COND = { etagDoesNotMatch: "*" };

/**
 * Generate a collision-safe snapshot identifier.
 * Format: YYYY-MM-DDTHH-mm-ss-sssZ-<random-8>
 */
export function generateSnapshotId(now = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const randomSuffix = crypto.randomUUID().slice(0, 8);
  return `${iso}-${randomSuffix}`;
}

const BASE_PDF_FETCH_OPTIONS = {
  method: "GET",
  redirect: "manual" as const,
  cf: {
    cacheEverything: true,
    cacheTtl: 3600,
  },
};

/**
 * Safe fetch with redirect validation against strict official timetable URL policy.
 */
async function fetchSafePdf(url: string, headers?: HeadersInit): Promise<Response> {
  let currentUrl = url;
  let redirects = 0;
  const maxRedirects = 5;

  while (redirects <= maxRedirects) {
    if (!isOfficialTimetablePdfUrl(currentUrl)) {
      throw new Error(`Unsafe PDF URL rejected by allowlist: ${currentUrl}`);
    }

    const fetchOptions = headers
      ? { ...BASE_PDF_FETCH_OPTIONS, headers }
      : BASE_PDF_FETCH_OPTIONS;

    const response = await fetch(currentUrl, fetchOptions as RequestInit);

    const status = response.status;
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
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
 * Transport-level course categories supported by the schedule system.
 * Currently supports Licență Course 1 (Anul I) and Course 2 (Anul II).
 * Future course expansion (e.g. Anul III, Anul IV) is explicitly configurable.
 */
export const DEFAULT_TRANSPORT_COURSES = [1, 2] as const;

const COURSE_ROMAN_MAP: Record<number, string> = {
  1: "i",
  2: "ii",
  3: "iii",
  4: "iv",
};

const DEFAULT_SUPPORTED_COURSE_REGEX = /\/anul_(?:i|ii)[_.-].*\.pdf$/i;

/**
 * Pure transport-level filter ensuring all candidate PDFs for supported courses
 * are transported into the candidate snapshot.
 *
 * Invariants preserved:
 * 1. Render's discoverPdf() remains the sole semantic authority.
 * 2. Every candidate that discoverPdf() could select for supported courses is guaranteed present.
 * 3. Master and session timetables are not undergraduate course timetables and cannot be substituted.
 * 4. Future extension remains explicit (by expanding supportedCourseYears).
 * 5. Does NOT select by revision or filename ("highest revision" selection is forbidden).
 */
export function filterSupportedCoursePdfs(
  pdfUrls: string[],
  supportedCourseYears: readonly number[] = DEFAULT_TRANSPORT_COURSES,
): string[] {
  if (supportedCourseYears.length === 0) return pdfUrls;

  const regex =
    supportedCourseYears === DEFAULT_TRANSPORT_COURSES
      ? DEFAULT_SUPPORTED_COURSE_REGEX
      : new RegExp(
          `/anul_(?:${supportedCourseYears.map((y) => COURSE_ROMAN_MAP[y]).filter(Boolean).join("|")})[_.-].*\\.pdf$`,
          "i",
        );

  const filtered = pdfUrls.filter((url) => regex.test(url));

  // Fail-safe: if pattern matching returned nothing, retain all official PDFs so discoverPdf is never starved.
  return filtered.length > 0 ? filtered : pdfUrls;
}

/**
 * Execute candidate publication pipeline.
 */
export async function publishCandidateSnapshot(
  env: Env,
  options: { force?: boolean } = {},
): Promise<PublishResult> {
  const pageApiUrl = env.FCIM_PAGE_API_URL ?? DEFAULT_PAGE_API_URL;
  if (pageApiUrl !== DEFAULT_PAGE_API_URL && !isAllowedPageApiUrl(pageApiUrl)) {
    return { published: false, error: `Invalid Page API URL: ${pageApiUrl}` };
  }

  let currentObj: R2ObjectBody | null = null;
  let pageApiResponse: Response;
  let currentEtag: string | null = null;
  let previousSnapshotId: string | null = null;
  let previousManifest: SnapshotManifest | null = null;

  if (options.force) {
    try {
      const [cObj, pRes] = await Promise.all([
        env.R2_BUCKET.get("current.json"),
        fetch(pageApiUrl, {
          headers: { Accept: "application/json" },
          cf: { cacheTtl: 60 },
        } as RequestInit),
      ]);
      currentObj = cObj;
      pageApiResponse = pRes;
      currentEtag = currentObj?.etag ?? null;
      if (currentObj) {
        try {
          const text = await currentObj.text();
          const match = /"snapshot_id"\s*:\s*"([^"]+)"/.exec(text);
          if (match) {
            previousSnapshotId = match[1];
          }
        } catch (err) {
          console.warn("Failed to parse existing current.json:", err);
        }
      }
    } catch (err) {
      return { published: false, error: `Failed to fetch FCIM Page API: ${(err as Error).message}` };
    }
  } else {
    currentObj = await env.R2_BUCKET.get("current.json");
    currentEtag = currentObj?.etag ?? null;

    if (currentObj) {
      try {
        const currentPointer = (await currentObj.json()) as CurrentPointer;
        previousSnapshotId = currentPointer.snapshot_id;
        if (currentPointer.manifest_r2_key) {
          const prevManifestObj = await env.R2_BUCKET.get(currentPointer.manifest_r2_key);
          if (prevManifestObj) {
            previousManifest = (await prevManifestObj.json()) as SnapshotManifest;
          }
        }
      } catch (err) {
        console.warn("Failed to parse existing current.json or manifest:", err);
      }
    }

    const pageHeaders: Record<string, string> = {
      Accept: "application/json",
    };
    if (previousManifest?.source.etag) {
      pageHeaders["If-None-Match"] = previousManifest.source.etag;
    }
    if (previousManifest?.source.last_modified) {
      pageHeaders["If-Modified-Since"] = previousManifest.source.last_modified;
    }

    try {
      pageApiResponse = await fetch(pageApiUrl, { headers: pageHeaders });
    } catch (err) {
      return { published: false, error: `Failed to fetch FCIM Page API: ${(err as Error).message}` };
    }
  }

  let pageApiNotModified = pageApiResponse.status === 304;
  let pageApiPayload: unknown = null;
  let pageApiRawText = "";
  let pageApiEtag = pageApiResponse.headers.get("ETag");
  let pageApiLastModified = pageApiResponse.headers.get("Last-Modified");

  if (pageApiNotModified && previousManifest) {
    // If upstream Page API returned HTTP 304, we need full body if a PDF changed
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
        } else if (headRes.status !== 304) {
          return {
            published: false,
            error: `Conditional check for PDF ${file.source_url} returned HTTP ${headRes.status}`,
          };
        }
      } catch (err) {
        return {
          published: false,
          error: `Conditional check for PDF ${file.source_url} failed: ${(err as Error).message}`,
        };
      }
    }

    if (!options.force && !pdfChanged) {
      return { published: false, reason: "unchanged (page 304 and PDFs 304)" };
    }
    // A PDF changed or force! Fetch full Page API body.
    const fullPageRes = await fetch(pageApiUrl, { headers: { Accept: "application/json" } });
    if (!fullPageRes.ok) {
      return { published: false, error: `Failed to fetch full Page API: HTTP ${fullPageRes.status}` };
    }
    try {
      pageApiRawText = await fullPageRes.text();
      pageApiPayload = JSON.parse(pageApiRawText);
    } catch (err) {
      return { published: false, error: `Invalid JSON from Page API: ${(err as Error).message}` };
    }
    pageApiEtag = fullPageRes.headers.get("ETag") ?? pageApiEtag;
    pageApiLastModified = fullPageRes.headers.get("Last-Modified") ?? pageApiLastModified;
    pageApiNotModified = false;
  } else if (!pageApiNotModified) {
    if (!pageApiResponse.ok) {
      return { published: false, error: `Page API returned HTTP ${pageApiResponse.status}` };
    }
    try {
      pageApiRawText = await pageApiResponse.text();
      pageApiPayload = JSON.parse(pageApiRawText);
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

  // Step 4: Check if WordPress page and all PDFs are unchanged
  const pageUnchanged =
    pageApiNotModified ||
    Boolean(
      previousManifest &&
        pageModifiedGmt &&
        previousManifest.source.page_modified_gmt === pageModifiedGmt,
    );

  if (!options.force && pageUnchanged && previousManifest) {
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
        } else if (headRes.status !== 304) {
          return {
            published: false,
            error: `Conditional check for PDF ${file.source_url} returned HTTP ${headRes.status}`,
          };
        }
      } catch (err) {
        return {
          published: false,
          error: `Conditional check for PDF ${file.source_url} failed: ${(err as Error).message}`,
        };
      }
    }

    if (!pdfChanged) {
      return { published: false, reason: "unchanged (page and PDFs 304/unchanged)" };
    }
  }

  // Step 4: Identify valid official timetable PDF URLs and apply transport filter
  const allPdfUrls = extractOfficialPdfUrls(renderedContent);
  if (allPdfUrls.length === 0) {
    return { published: false, error: "No official timetable PDF URLs found in Page API rendered content" };
  }
  const pdfUrls = filterSupportedCoursePdfs(allPdfUrls);
  const snapshotId = generateSnapshotId();
  const snapshotCreated = new Date().toISOString();
  const pageApiKey = `snapshots/${snapshotId}/page-api.json`;

  // Step 5: Write all new immutable PDF objects and page-api.json concurrently via streaming with create-only semantics
  let snapshotFiles: SnapshotFile[];
  let pageApiWritten: R2Object | null;
  try {
    const pageApiPutPromise = env.R2_BUCKET.put(pageApiKey, pageApiRawText, {
      onlyIf: IF_NONE_MATCH_COND,
      httpMetadata: { contentType: "application/json" },
    });

    const pdfsPromise = Promise.all(
      pdfUrls.map(async (pdfUrl) => {
        const filename = getPdfFilename(pdfUrl);
        const r2Key = `snapshots/${snapshotId}/pdfs/${filename}`;

        const pdfRes = await fetchSafePdf(pdfUrl);
        if (!pdfRes.ok) {
          throw new Error(`PDF ${pdfUrl} returned HTTP ${pdfRes.status}`);
        }

        if (!pdfRes.body) {
          throw new Error(`PDF ${pdfUrl} returned empty body`);
        }

        const upstreamEtag = pdfRes.headers.get("ETag");
        const upstreamLastModified = pdfRes.headers.get("Last-Modified");
        const contentType = pdfRes.headers.get("Content-Type") || "application/pdf";
        const contentLength = pdfRes.headers.get("Content-Length");
        const sizeBytes = contentLength ? Number.parseInt(contentLength, 10) : null;
        if (sizeBytes !== null && sizeBytes > MAX_PDF_BYTES) {
          throw new Error(`PDF ${pdfUrl} exceeds size limit (${sizeBytes} bytes)`);
        }

        // Stream directly into R2 with etagDoesNotMatch: * (create-only)
        const r2Put = await env.R2_BUCKET.put(r2Key, pdfRes.body, {
          onlyIf: IF_NONE_MATCH_COND,
          httpMetadata: { contentType },
        });

        if (!r2Put) {
          throw new Error(`COLLISION:PDF ${r2Key} already exists under immutable snapshot`);
        }

        return {
          filename,
          source_url: pdfUrl,
          r2_key: r2Key,
          content_type: contentType,
          size: sizeBytes ?? r2Put.size,
          upstream_etag: upstreamEtag,
          upstream_last_modified: upstreamLastModified,
        };
      }),
    );

    [snapshotFiles, pageApiWritten] = await Promise.all([
      pdfsPromise,
      pageApiPutPromise,
    ]);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith("COLLISION:")) {
      return {
        published: false,
        conflict: true,
        error: msg.slice("COLLISION:".length),
      };
    }
    return {
      published: false,
      error: msg,
    };
  }

  if (!pageApiWritten) {
    return {
      published: false,
      conflict: true,
      error: `Collision: ${pageApiKey} already exists under immutable snapshot`,
    };
  }

  // Step 6: Write manifest.json with create-only semantics
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

  const manifestWritten = await env.R2_BUCKET.put(manifestKey, JSON.stringify(manifest), {
    onlyIf: IF_NONE_MATCH_COND,
    httpMetadata: { contentType: "application/json" },
  });

  if (!manifestWritten) {
    return {
      published: false,
      conflict: true,
      error: `Collision: ${manifestKey} already exists under immutable snapshot`,
    };
  }

  // Step 8: CAS current.json LAST (compact JSON)
  const nextPointer: CurrentPointer = {
    schema_version: 1,
    snapshot_id: snapshotId,
    updated_at: snapshotCreated,
    manifest_r2_key: manifestKey,
  };

  const putOptions: R2PutOptions = currentEtag
    ? { onlyIf: { etagMatches: currentEtag } }
    : { onlyIf: IF_NONE_MATCH_COND };

  const casResult = await env.R2_BUCKET.put(
    "current.json",
    JSON.stringify(nextPointer),
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
