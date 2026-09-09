/** HTTP Service Binding client for the Stockholm FCIM transport Worker. */

import {
  FCIM_EGRESS_ERROR_HEADER,
  FCIM_EGRESS_INTERNAL_ORIGIN,
  FCIM_EGRESS_PAGE_API_PATH,
  FCIM_EGRESS_PDF_PATH,
  FCIM_EGRESS_SERVICE_HEADER,
  FCIM_EGRESS_SERVICE_VALUE,
  FCIM_PLACEMENT_HEADER,
  FCIM_UPSTREAM_CF_RAY_HEADER,
} from "../../worker-shared/fcim-policy";
import type { Env } from "./types";

export interface EgressConditional {
  etag?: string | null;
  lastModified?: string | null;
}

export class FcimEgressClientError extends Error {
  readonly status: number | null;
  readonly kind: string;

  constructor(message: string, status: number | null, kind: string) {
    super(message);
    this.name = "FcimEgressClientError";
    this.status = status;
    this.kind = kind;
  }
}

function contractBody(
  operation: "PAGE_API" | "PDF",
  targetUrl: string,
  conditional: EgressConditional,
): string {
  const contract: Record<string, string | number> = { schema_version: 1 };
  // The Page API target is intentionally absent: the backend owns its one canonical endpoint.
  if (operation === "PDF") contract.target_url = targetUrl;
  if (conditional.etag) contract.if_none_match = conditional.etag;
  if (conditional.lastModified) contract.if_modified_since = conditional.lastModified;
  return JSON.stringify(contract);
}

/**
 * Invoke the downstream Worker's default fetch handler. The fully-qualified host is logical only;
 * the configured Service Binding carries the request without using workers.dev or public egress.
 */
export async function fetchThroughStockholmEgress(
  env: Env,
  operation: "PAGE_API" | "PDF",
  targetUrl: string,
  conditional: EgressConditional = {},
): Promise<Response> {
  const path = operation === "PAGE_API" ? FCIM_EGRESS_PAGE_API_PATH : FCIM_EGRESS_PDF_PATH;
  let response: Response;
  try {
    response = await env.FCIM_EGRESS.fetch(
      new Request(`${FCIM_EGRESS_INTERNAL_ORIGIN}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: contractBody(operation, targetUrl, conditional),
      }),
    );
  } catch (err) {
    throw new FcimEgressClientError(
      `Stockholm Service Binding network error: ${(err as Error).message}`,
      null,
      "network",
    );
  }

  const service = response.headers.get(FCIM_EGRESS_SERVICE_HEADER);
  if (service !== FCIM_EGRESS_SERVICE_VALUE) {
    await response.body?.cancel().catch(() => {});
    throw new FcimEgressClientError(
      `Stockholm Service Binding returned an invalid transport identity`,
      400,
      "invalid-service-response",
    );
  }

  console.log(
    "fcim-service-binding:",
    JSON.stringify({
      operation,
      status: response.status,
      cf_placement: response.headers.get(FCIM_PLACEMENT_HEADER),
      upstream_cf_ray: response.headers.get(FCIM_UPSTREAM_CF_RAY_HEADER),
    }),
  );
  return response;
}

export function egressErrorKind(response: Response): string | null {
  return response.headers.get(FCIM_EGRESS_ERROR_HEADER);
}

/** Read only the backend's small deterministic JSON error body; PDF success bodies stay unread. */
export async function egressErrorDetail(response: Response): Promise<string | null> {
  try {
    const raw = await response.text();
    if (raw.length > 4096) return null;
    const parsed = JSON.parse(raw) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.length <= 2048 ? parsed.error : null;
  } catch {
    return null;
  }
}
