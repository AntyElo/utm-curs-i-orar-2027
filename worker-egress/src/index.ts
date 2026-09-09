/**
 * Stockholm-placed FCIM network transport.
 *
 * This Worker has one fetch handler and no public route. It knows only a minimal internal HTTP
 * contract and the strict FCIM target policy; PDF bodies are passed through as streams.
 */

import {
  CANONICAL_PAGE_API_URL,
  FCIM_EGRESS_ERROR_HEADER,
  FCIM_EGRESS_INTERNAL_ORIGIN,
  FCIM_EGRESS_PAGE_API_PATH,
  FCIM_EGRESS_PDF_PATH,
  FCIM_EGRESS_SERVICE_HEADER,
  FCIM_EGRESS_SERVICE_VALUE,
  FCIM_PLACEMENT_HEADER,
  FCIM_UPSTREAM_CF_RAY_HEADER,
  isOfficialTimetablePdfUrl,
  resolveOfficialTimetablePdfRedirect,
} from "../../worker-shared/fcim-policy";

const MAX_CONTRACT_BYTES = 8 * 1024;
const MAX_PDF_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CONDITIONAL_KEYS = new Set(["schema_version", "if_none_match", "if_modified_since"]);
const PDF_KEYS = new Set([...CONDITIONAL_KEYS, "target_url"]);

interface ConditionalContract {
  schema_version: 1;
  if_none_match?: string;
  if_modified_since?: string;
}

interface PdfContract extends ConditionalContract {
  target_url: string;
}

function baseResponseHeaders(placement: string | null): Headers {
  const headers = new Headers({
    [FCIM_EGRESS_SERVICE_HEADER]: FCIM_EGRESS_SERVICE_VALUE,
  });
  if (placement) headers.set(FCIM_PLACEMENT_HEADER, placement);
  return headers;
}

function errorResponse(kind: string, message: string, status: number, placement: string | null): Response {
  const headers = baseResponseHeaders(placement);
  headers.set("Content-Type", "application/json");
  headers.set(FCIM_EGRESS_ERROR_HEADER, kind);
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeValidator(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes("\r") &&
    !value.includes("\n")
  );
}

async function readContract(
  request: Request,
  operation: "PAGE_API" | "PDF",
): Promise<ConditionalContract | PdfContract | string> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_CONTRACT_BYTES) {
    return "internal contract is too large";
  }
  if (request.headers.get("Content-Type") !== "application/json") {
    return "internal contract must use application/json";
  }

  let raw = "";
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_CONTRACT_BYTES) {
          await reader.cancel().catch(() => {});
          return "internal contract is too large";
        }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    }
  } catch {
    return "internal contract body could not be read";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "internal contract is not valid JSON";
  }
  const allowedKeys = operation === "PAGE_API" ? CONDITIONAL_KEYS : PDF_KEYS;
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => !allowedKeys.has(key))) {
    return "internal contract has an invalid shape";
  }
  if (parsed.schema_version !== 1) return "internal contract has an invalid schema version";
  if (
    (Object.hasOwn(parsed, "if_none_match") && !isSafeValidator(parsed.if_none_match)) ||
    (Object.hasOwn(parsed, "if_modified_since") && !isSafeValidator(parsed.if_modified_since))
  ) {
    return "internal contract has an invalid conditional validator";
  }
  if (operation === "PDF" && typeof parsed.target_url !== "string") {
    return "PDF contract has no target URL";
  }
  return parsed as unknown as ConditionalContract | PdfContract;
}

function upstreamHeaders(
  operation: "PAGE_API" | "PDF",
  contract: ConditionalContract,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: operation === "PAGE_API" ? "application/json" : "application/pdf",
  };
  if (contract.if_none_match) headers["If-None-Match"] = contract.if_none_match;
  if (contract.if_modified_since) headers["If-Modified-Since"] = contract.if_modified_since;
  return headers;
}

function safeUpstreamHeaders(upstream: Response, placement: string | null): Headers {
  const headers = baseResponseHeaders(placement);
  for (const name of ["Content-Type", "Content-Length", "Last-Modified", "ETag"]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const ray = upstream.headers.get("CF-Ray");
  if (ray) headers.set(FCIM_UPSTREAM_CF_RAY_HEADER, ray);
  return headers;
}

async function streamedResponse(upstream: Response, placement: string | null): Promise<Response> {
  const body = upstream.status === 200 ? upstream.body : null;
  if (body === null) await upstream.body?.cancel().catch(() => {});
  return new Response(body, {
    status: upstream.status,
    headers: safeUpstreamHeaders(upstream, placement),
  });
}

function logUpstream(
  operation: "PAGE_API" | "PDF",
  placement: string | null,
  upstream: Response,
  redirectHops: number,
): void {
  console.log(
    "fcim-stockholm-egress:",
    JSON.stringify({
      operation,
      cf_placement: placement,
      upstream_status: upstream.status,
      upstream_cf_ray: upstream.headers.get("CF-Ray"),
      upstream_content_type: upstream.headers.get("Content-Type"),
      cf_mitigated: upstream.headers.get("CF-Mitigated"),
      redirect_hops: redirectHops,
    }),
  );
}

async function fetchPageApi(
  contract: ConditionalContract,
  placement: string | null,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(CANONICAL_PAGE_API_URL, {
      method: "GET",
      headers: upstreamHeaders("PAGE_API", contract),
      redirect: "manual",
    });
  } catch (err) {
    return errorResponse(
      "network",
      `FCIM Page API network request failed: ${(err as Error).message}`,
      502,
      placement,
    );
  }

  if (REDIRECT_STATUSES.has(upstream.status)) {
    await upstream.body?.cancel().catch(() => {});
    return errorResponse(
      "page-api-redirect",
      `FCIM Page API returned redirect HTTP ${upstream.status}`,
      400,
      placement,
    );
  }

  logUpstream("PAGE_API", placement, upstream, 0);
  return streamedResponse(upstream, placement);
}

async function fetchPdf(contract: PdfContract, placement: string | null): Promise<Response> {
  if (!isOfficialTimetablePdfUrl(contract.target_url)) {
    return errorResponse(
      "invalid-url",
      "PDF target is outside the official timetable allowlist",
      400,
      placement,
    );
  }

  let currentUrl = contract.target_url;
  for (let hop = 0; hop <= MAX_PDF_REDIRECTS; hop++) {
    let upstream: Response;
    try {
      upstream = await fetch(currentUrl, {
        method: "GET",
        headers: upstreamHeaders("PDF", contract),
        redirect: "manual",
        cf: { cacheEverything: true, cacheTtl: 3600 },
      } as RequestInit);
    } catch (err) {
      return errorResponse(
        "network",
        `FCIM PDF network request failed: ${(err as Error).message}`,
        502,
        placement,
      );
    }

    if (!REDIRECT_STATUSES.has(upstream.status)) {
      logUpstream("PDF", placement, upstream, hop);
      return streamedResponse(upstream, placement);
    }

    const location = upstream.headers.get("Location");
    await upstream.body?.cancel().catch(() => {});
    if (!location) {
      return errorResponse("invalid-redirect", "FCIM PDF redirect has no Location", 400, placement);
    }
    const resolved = resolveOfficialTimetablePdfRedirect(location, currentUrl);
    if (!resolved) {
      return errorResponse(
        "invalid-redirect",
        "FCIM PDF redirect target is outside the official timetable allowlist",
        400,
        placement,
      );
    }
    currentUrl = resolved;
  }

  return errorResponse(
    "invalid-redirect",
    "FCIM PDF exceeded the redirect limit",
    400,
    placement,
  );
}

const worker = {
  async fetch(request: Request): Promise<Response> {
    const placement = request.headers.get("cf-placement");
    const url = new URL(request.url);
    const isPageApi = url.pathname === FCIM_EGRESS_PAGE_API_PATH;
    const isPdf = url.pathname === FCIM_EGRESS_PDF_PATH;
    if (
      request.method !== "POST" ||
      url.origin !== FCIM_EGRESS_INTERNAL_ORIGIN ||
      url.search !== "" ||
      url.hash !== "" ||
      (!isPageApi && !isPdf)
    ) {
      return errorResponse("invalid-contract", "unsupported internal egress request", 400, placement);
    }

    const operation = isPageApi ? "PAGE_API" : "PDF";
    const contract = await readContract(request, operation);
    if (typeof contract === "string") {
      return errorResponse("invalid-contract", contract, 400, placement);
    }
    if (operation === "PAGE_API") return fetchPageApi(contract, placement);
    return fetchPdf(contract as PdfContract, placement);
  },
};

export default worker;
