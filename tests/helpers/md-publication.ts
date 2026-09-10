/**
 * Drive the MD Publisher ingestion API the way the real laptop does: over the Worker's own HTTP
 * routes, with a bearer credential, one PDF body at a time, and a declared SHA-256 for every
 * upload. Nothing here reaches into the broker's internals, so a test that publishes through this
 * helper is exercising the same boundary a compromised or confused publisher would have to cross.
 */

import worker from "../../worker/src/index";
import type { Env, ExecutionContext } from "../../worker/src/types";
import { TEST_PUBLISHER_TOKEN, type WorkerHarness } from "./worker-doubles";

export const PAGE_API_URL = "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view";
export const UPLOAD_BASE = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09";

export function pdfBody(marker = "default"): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4 fake timetable body ${marker}`);
}

export interface PageOptions {
  modifiedGmt?: string;
  filenames?: string[];
  urls?: string[];
  pageId?: number;
}

export function pagePayload(options: PageOptions = {}): string {
  const urls =
    options.urls ??
    (options.filenames ?? ["anul_i_semestrul_i-19.pdf", "anul_ii_semestrul_iii-13.pdf"]).map(
      (name) => `${UPLOAD_BASE}/${name}`,
    );
  const anchors = urls.map((url) => `<a href="${url}">${url}</a>`).join("\n");
  return JSON.stringify([
    {
      id: options.pageId ?? 1739,
      modified_gmt: options.modifiedGmt ?? "2026-09-08T12:57:59",
      content: { rendered: `<p>Orar</p>${anchors}` },
    },
  ]);
}

/** `BodyInit` does not accept a typed-array view under the strict typed-array lib. */
export function asBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function call(env: Env, ctx: ExecutionContext, request: Request): Promise<Response> {
  return worker.fetch(request, env, ctx);
}

export interface OpenOptions {
  operationId?: string;
  token?: string | null;
  pageSha256?: string;
  contentType?: string;
  contentLength?: string;
}

export async function openPublication(
  h: WorkerHarness,
  pageBody: string,
  options: OpenOptions = {},
): Promise<Response> {
  const bytes = new TextEncoder().encode(pageBody);
  const headers: Record<string, string> = {
    "Content-Type": options.contentType ?? "application/json",
    "Content-Length": options.contentLength ?? String(bytes.byteLength),
    "X-Publication-Operation-Id": options.operationId ?? crypto.randomUUID(),
    "X-Page-Sha256": options.pageSha256 ?? (await sha256Hex(bytes)),
  };
  const token = options.token === undefined ? TEST_PUBLISHER_TOKEN : options.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;

  return call(
    h.env,
    h.ctx,
    new Request("https://broker.test/publications", { method: "POST", headers, body: asBody(bytes) }),
  );
}

export interface UploadOptions {
  token?: string | null;
  sha256?: string;
  contentType?: string;
  contentLength?: string;
  observedEtag?: string;
  observedLastModified?: string;
}

export async function uploadPublicationFile(
  h: WorkerHarness,
  snapshotId: string,
  fileId: string,
  body: Uint8Array,
  options: UploadOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": options.contentType ?? "application/pdf",
    "Content-Length": options.contentLength ?? String(body.byteLength),
    "X-Content-Sha256": options.sha256 ?? (await sha256Hex(body)),
  };
  const token = options.token === undefined ? TEST_PUBLISHER_TOKEN : options.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (options.observedEtag) headers["X-Publisher-Observed-Etag"] = options.observedEtag;
  if (options.observedLastModified) {
    headers["X-Publisher-Observed-Last-Modified"] = options.observedLastModified;
  }

  return call(
    h.env,
    h.ctx,
    new Request(`https://broker.test/publications/${snapshotId}/files/${fileId}`, {
      method: "PUT",
      headers,
      body: asBody(body),
    }),
  );
}

export async function completePublication(
  h: WorkerHarness,
  snapshotId: string,
  options: { token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TEST_PUBLISHER_TOKEN : options.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return call(
    h.env,
    h.ctx,
    new Request(`https://broker.test/publications/${snapshotId}/complete`, { method: "POST", headers }),
  );
}

export async function getPublication(
  h: WorkerHarness,
  snapshotId: string,
  options: { token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TEST_PUBLISHER_TOKEN : options.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return call(h.env, h.ctx, new Request(`https://broker.test/publications/${snapshotId}`, { headers }));
}

export async function publicationStatus(
  h: WorkerHarness,
  options: { token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TEST_PUBLISHER_TOKEN : options.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return call(h.env, h.ctx, new Request("https://broker.test/publication-status", { headers }));
}

export async function putHeartbeat(
  h: WorkerHarness,
  payload: Record<string, unknown>,
  options: { token?: string | null } = {},
): Promise<Response> {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(body.byteLength),
  };
  const token = options.token === undefined ? TEST_PUBLISHER_TOKEN : options.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return call(
    h.env,
    h.ctx,
    new Request("https://broker.test/publisher/heartbeat", { method: "PUT", headers, body: asBody(body) }),
  );
}

export interface PlanFileResponse {
  file_id: string;
  filename: string;
  source_url: string;
  upload_path: string;
  status: "needed" | "stored";
}

export interface PlanResponse {
  ok: boolean;
  status: string;
  snapshot_id: string;
  operation_id: string;
  page_api_sha256: string;
  files: PlanFileResponse[];
}

export interface PublishThroughApiOptions {
  page?: string;
  /** Body used for every PDF, unless `bodies` names one for a specific filename. */
  body?: Uint8Array;
  bodies?: Record<string, Uint8Array>;
  operationId?: string;
  observedEtag?: string;
}

export interface PublishThroughApiResult {
  snapshotId: string;
  plan: PlanResponse;
  complete: Response;
  completeBody: { ok?: boolean; status?: string; code?: string };
}

/**
 * The whole happy path: open, upload every planned file, complete.
 * Returns the raw completion response so a test can assert on `published` vs `superseded`.
 */
export async function publishThroughApi(
  h: WorkerHarness,
  options: PublishThroughApiOptions = {},
): Promise<PublishThroughApiResult> {
  const page = options.page ?? pagePayload();
  const open = await openPublication(h, page, { operationId: options.operationId });
  if (open.status !== 201 && open.status !== 200) {
    throw new Error(`open failed: HTTP ${open.status} ${await open.text()}`);
  }
  const plan = (await open.json()) as PlanResponse;

  for (const file of plan.files) {
    if (file.status === "stored") continue;
    const body = options.bodies?.[file.filename] ?? options.body ?? pdfBody(file.filename);
    const response = await uploadPublicationFile(h, plan.snapshot_id, file.file_id, body, {
      observedEtag: options.observedEtag,
    });
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`upload ${file.file_id} failed: HTTP ${response.status} ${await response.text()}`);
    }
  }

  const complete = await completePublication(h, plan.snapshot_id);
  const completeBody = (await complete.clone().json()) as { ok?: boolean; status?: string; code?: string };
  return { snapshotId: plan.snapshot_id, plan, complete, completeBody };
}
