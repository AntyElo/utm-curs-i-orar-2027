/**
 * MD Publisher contracts.
 *
 * The publisher is a transport. Nothing in this file describes a timetable, a course year or an
 * acceptance decision, because the laptop is never allowed to have an opinion about any of them.
 */

export interface PublisherConfig {
  /** Broker origin, e.g. https://broker.example.workers.dev */
  brokerUrl: string;
  /** MD_PUBLISHER_TOKEN. Never logged, never written to disk, never sent upstream. */
  token: string;
  /** Root of the publisher's local working state. */
  stateDir: string;
  /** Per-request timeout for both FCIM and broker calls. */
  timeoutMs: number;
  /** Reported in the heartbeat so an operator can see how the scheduled task is registered. */
  logonModel: string | null;
  /** Publisher build identity, reported in the heartbeat. */
  version: string;
}

export interface HttpResponseLike {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  /** Release an unread body so a revalidation does not hold the connection open. */
  cancel(): Promise<void>;
}

export interface HttpGet {
  (url: string, headers: Record<string, string>, timeoutMs: number): Promise<HttpResponseLike>;
}

export interface JsonRequest {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  timeoutMs: number;
}

export interface JsonResponse {
  status: number;
  headers: Headers;
  text: string;
}

export interface JsonRequestFn {
  (request: JsonRequest): Promise<JsonResponse>;
}

/** Stream a file from disk with an exact Content-Length. Never buffers the whole body. */
export interface FileUploadFn {
  (input: {
    url: string;
    headers: Record<string, string>;
    filePath: string;
    size: number;
    timeoutMs: number;
  }): Promise<JsonResponse>;
}

export interface Transport {
  get: HttpGet;
  json: JsonRequestFn;
  upload: FileUploadFn;
}

/* ------------------------------------------------------------------ *
 * Local state
 * ------------------------------------------------------------------ */

export interface RecordedPdf {
  source_url: string;
  etag: string | null;
  last_modified: string | null;
  sha256: string;
}

/**
 * Cached copy of the freshness baseline, valid only while it is anchored.
 *
 * This file is never correctness-authoritative. The authoritative baseline is the snapshot
 * `current.json` names right now, and this record may be consulted only when
 * `broker_snapshot_id` equals that snapshot's id — see `resolveBaseline()`. A record that is
 * not anchored to broker current is ignored outright, so deleting the state directory, copying
 * it between machines or losing it entirely can only cost one extra publication, never freshness.
 */
export interface LastRunState {
  schema_version: 2;
  /** The broker snapshot this baseline describes. Ignored unless it is `current.json`'s. */
  broker_snapshot_id: string;
  page_etag: string | null;
  page_last_modified: string | null;
  page_api_sha256: string;
  page_modified_gmt: string | null;
  pdfs: RecordedPdf[];
  outcome: string;
  completed_at: string;
}

/* ------------------------------------------------------------------ *
 * Authoritative freshness baseline
 * ------------------------------------------------------------------ */

/** What `current.json` says, reduced to the fields the publisher is allowed to act on. */
export interface CurrentPointerView {
  snapshot_id: string;
  published_at: string | null;
  page_modified_gmt: string | null;
}

/** One mirrored file as the broker-current snapshot actually holds it. */
export interface BaselinePdf {
  source_url: string;
  etag: string | null;
  last_modified: string | null;
  sha256: string;
}

/**
 * The state of the snapshot `current.json` names, expressed as something FCIM can be compared
 * against. Derived either from that snapshot's own immutable manifest, or from a local cache
 * that is anchored to exactly that snapshot id.
 */
export interface FreshnessBaseline {
  origin: "broker_snapshot" | "local_cache";
  broker_snapshot_id: string;
  page_api_sha256: string;
  page_etag: string | null;
  page_last_modified: string | null;
  page_modified_gmt: string | null;
  pdfs: BaselinePdf[];
}

export interface ResolvedBaseline {
  /** Null whenever nothing can be proven unchanged; the caller must then publish. */
  baseline: FreshnessBaseline | null;
  /** The snapshot `current.json` named when the baseline was resolved, if any. */
  current_snapshot_id: string | null;
  /** Human-readable account of where the baseline came from, or why there is none. */
  reason: string;
}

/** One file of an immutable snapshot manifest, as served by `/snapshots/:id/manifest.json`. */
export interface ManifestFileView {
  source_url: string;
  content_sha256: string | null;
  publisher_observed_etag: string | null;
  publisher_observed_last_modified: string | null;
}

export interface ManifestView {
  snapshot_id: string;
  page_modified_gmt: string | null;
  files: ManifestFileView[];
}

/** The attempt currently in flight. Present only between opening and completing a publication. */
export interface OperationState {
  schema_version: 1;
  operation_id: string;
  page_api_sha256: string;
  snapshot_id: string | null;
  started_at: string;
}

/* ------------------------------------------------------------------ *
 * Broker plan
 * ------------------------------------------------------------------ */

export interface PlanFile {
  file_id: string;
  filename: string;
  source_url: string;
  upload_path: string;
  status: "needed" | "stored";
}

export interface PublicationPlan {
  status: "created" | "resumed";
  snapshot_id: string;
  operation_id: string;
  page_api_sha256: string;
  created_at: string;
  expires_at: string;
  files: PlanFile[];
}

export type PublishOutcome =
  | "unchanged"
  | "published"
  | "superseded"
  | "dry_run"
  | "error";

/**
 * What became of the bounded liveness report for this run.
 *
 * `failed` never changes `outcome` or `exitCode`: a heartbeat is an observation about a run, and
 * losing the observation must not retroactively corrupt the transaction the run completed.
 */
export type HeartbeatDelivery = "delivered" | "failed" | "skipped";

export interface PublishResult {
  outcome: PublishOutcome;
  reason: string;
  snapshot_id: string | null;
  operation_id: string | null;
  page_modified_gmt: string | null;
  pdf_count: number;
  saw_drift: boolean;
  duration_ms: number;
  error: string | null;
  /** Where the freshness baseline this run compared against came from. */
  baseline_source: "broker_snapshot" | "local_cache" | "none";
  /** The snapshot `current.json` named when this run resolved its baseline. */
  broker_snapshot_id: string | null;
  heartbeat: HeartbeatDelivery;
  /** Process exit code. Every terminal *normal* outcome is 0. */
  exitCode: 0 | 1;
}

/** A broker refusal the publisher must react to by identity, not by message text. */
export class BrokerError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BrokerError";
    this.status = status;
    this.code = code;
  }
}

export class UpstreamError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}
