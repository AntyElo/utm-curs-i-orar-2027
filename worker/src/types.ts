/**
 * Cloudflare Worker and R2 broker types.
 */

export interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  uploadedBefore?: Date;
  uploadedAfter?: Date;
}

export interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface R2PutOptions {
  onlyIf?: R2Conditional | Headers;
  httpMetadata?: R2HTTPMetadata | Headers;
  customMetadata?: Record<string, string>;
  /**
   * Server-side content checksum (DF-05). R2 validates the uploaded bytes against this digest
   * and rejects the write when they disagree, so unverified bytes never become a final object.
   * Hex string or raw digest bytes.
   */
  sha256?: string | ArrayBuffer;
}

export interface R2ListOptions {
  prefix?: string;
  delimiter?: string;
  limit?: number;
  cursor?: string;
}

export interface R2Object {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

export interface R2Objects {
  objects: R2Object[];
  delimitedPrefixes: string[];
  truncated: boolean;
  cursor?: string;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  blob(): Promise<Blob>;
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: R2ListOptions): Promise<R2Objects>;
}

/** Cloudflare Queues producer binding. */
export interface Queue<Body = unknown> {
  send(body: Body, options?: { delaySeconds?: number; contentType?: string }): Promise<void>;
  sendBatch(
    messages: Iterable<{ body: Body; delaySeconds?: number; contentType?: string }>,
    options?: { delaySeconds?: number },
  ): Promise<void>;
}

/** Cloudflare Queues consumer message. */
export interface QueueMessage<Body = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: Body;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueMessageBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly QueueMessage<Body>[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface ScheduledEvent {
  cron: string;
  type: string;
  scheduledTime: number;
}

/** Minimal HTTP Service Binding surface used by the Stockholm transport Worker. */
export interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface Env {
  R2_BUCKET: R2Bucket;
  PUBLICATION_QUEUE: Queue<PublicationJob>;
  FCIM_EGRESS: ServiceBinding;
  /** Accepted-state credential. Render only. Never accepted by a publisher route. */
  SCHEDULE_BROKER_SECRET?: string;
  /** MD Publisher credential. Transport only. Never accepted by an accepted-state route. */
  MD_PUBLISHER_TOKEN?: string;
  /** Previous MD Publisher credential, honoured during rotation only. */
  MD_PUBLISHER_TOKEN_PREVIOUS?: string;
  /** Hours an incoming Page API `modified_gmt` may lead broker time before it is refused. */
  MAX_PAGE_FUTURE_SKEW_HOURS?: string;
  FCIM_PAGE_API_URL?: string;
  SCHEDULE_PAGE_URL?: string;
  RECONCILIATION_INTERVAL_MINUTES?: string;
}

/* ------------------------------------------------------------------ *
 * Split publication job contracts
 * ------------------------------------------------------------------ */

/** Attempt to close a pending snapshot: verify completeness, write manifest, CAS current.json. */
export interface FinalizeJob {
  schema_version: 1;
  kind: "finalize";
  snapshot_id: string;
}

/** Re-drive pending snapshots whose finalize never ran, and run bounded retention. */
export interface ReconcileJob {
  schema_version: 1;
  kind: "reconcile";
}

/**
 * The complete set of background work the broker performs.
 *
 * Gate F removed `discover` and `ingest_pdf`: no queue or cron path may reach FCIM. Candidate
 * bytes now arrive only through authenticated MD Publisher requests, so the background handlers
 * are limited to closing and reconciling snapshots that already exist in storage.
 */
export type PublicationJob = FinalizeJob | ReconcileJob;

/* ------------------------------------------------------------------ *
 * Snapshot state
 * ------------------------------------------------------------------ */

export interface SnapshotSource {
  page_api_url: string;
  page_id: number | null;
  page_modified_gmt: string | null;
  retrieved_at: string;
  etag: string | null;
  last_modified: string | null;
}

/** One expected transport object, fixed when the publication is opened. */
export interface PendingFile {
  file_id: string;
  filename: string;
  source_url: string;
  r2_key: string;
}

/**
 * Immutable pending-snapshot descriptor written when a publication is opened.
 * Fixes the complete expected file set before any PDF body is uploaded.
 *
 * The broker derives every field itself from the raw Page API bytes the publisher supplied.
 * A publisher cannot choose a snapshot id, an R2 key, a filename or a PDF source URL.
 */
export interface PendingDescriptor {
  schema_version: 1;
  snapshot_id: string;
  previous_snapshot_id: string | null;
  created_at: string;
  /** R2 ETag of current.json observed when the publication opened; finalize must still match it. */
  current_etag: string | null;
  /** Client-generated publication attempt identity (DF-01). Never the Page API hash. */
  operation_id: string;
  /** SHA-256 of the exact Page API bytes this publication was opened with (provenance only). */
  page_api_sha256: string;
  /** Which subsystem authored this publication. */
  origin: "md_publisher";
  source: SnapshotSource;
  files: PendingFile[];
}

/**
 * Create-only record binding one client publication attempt to one broker snapshot (DF-01/DF-06).
 *
 * Identity is the client's UUIDv4, not the Page API hash: the same page bytes may legitimately be
 * republished when FCIM replaces a PDF in place under an unchanged URL, and two different attempts
 * must never collapse onto one snapshot.
 */
export interface OperationRecord {
  schema_version: 1;
  operation_id: string;
  snapshot_id: string;
  page_api_sha256: string;
  created_at: string;
}

/** Bounded publisher liveness record. Never carries secrets. */
export interface PublisherHeartbeat {
  schema_version: 1;
  /** Stamped by the broker. The client clock is informational only. */
  received_at: string;
  client_reported_at: string | null;
  status: "ok" | "error";
  outcome: string | null;
  operation_id: string | null;
  snapshot_id: string | null;
  page_modified_gmt: string | null;
  pdf_count: number | null;
  saw_drift: boolean | null;
  duration_ms: number | null;
  error: string | null;
  logon_model: string | null;
  publisher_version: string | null;
}

/**
 * Immutable per-file completion marker. Concurrent uploads write disjoint keys,
 * so a completion can never be lost the way a shared mutable counter can.
 *
 * DF-02: `upstream_etag` and `upstream_last_modified` are the *trusted* validators Render is
 * allowed to short-circuit on, and a publisher-observed validator is not one of them. For
 * MD-published files both are always null; whatever the publisher saw is recorded separately
 * under `publisher_observed_*`, which nothing on Render reads.
 */
export interface CompletionMarker {
  schema_version: 1;
  snapshot_id: string;
  file_id: string;
  filename: string;
  source_url: string;
  r2_key: string;
  content_type: string | null;
  size: number | null;
  upstream_etag: string | null;
  upstream_last_modified: string | null;
  publisher_observed_etag?: string | null;
  publisher_observed_last_modified?: string | null;
  content_sha256?: string | null;
  completed_at: string;
}

export interface SnapshotFile {
  filename: string;
  source_url: string;
  r2_key: string;
  content_type: string | null;
  size: number | null;
  /** Always null for MD-published files: a publisher-controlled validator is never trusted. */
  upstream_etag: string | null;
  /** Always null for MD-published files: a publisher-controlled validator is never trusted. */
  upstream_last_modified: string | null;
  /** Informational provenance only. Render neither reads nor short-circuits on these. */
  publisher_observed_etag?: string | null;
  publisher_observed_last_modified?: string | null;
  content_sha256?: string | null;
}

export interface SnapshotManifest {
  schema_version: 1;
  snapshot_id: string;
  previous_snapshot_id: string | null;
  created_at: string;
  source: SnapshotSource;
  files: SnapshotFile[];
}

/**
 * Pointer to the newest complete snapshot. Small, flat, and strictly validated:
 * every field is required, nested values are forbidden, and no field is ever
 * recovered from a malformed document.
 */
export interface CurrentPointer {
  schema_version: 1;
  snapshot_id: string;
  updated_at: string;
  published_at: string;
  manifest_r2_key: string;
  page_modified_gmt: string | null;
  page_id: number | null;
  pdf_count: number;
}

/**
 * Normalized representation of the exact four-field pointer emitted by the original
 * monolithic broker. `published_at` is equivalent to its `updated_at`; Page API and PDF
 * metadata deliberately remain absent and must be read from the immutable manifest.
 */
export interface LegacyCurrentPointer {
  schema_version: 1;
  snapshot_id: string;
  updated_at: string;
  published_at: string;
  manifest_r2_key: string;
  page_modified_gmt?: never;
  page_id?: never;
  pdf_count?: never;
}

export type ParsedCurrentPointer = CurrentPointer | LegacyCurrentPointer;

/* ------------------------------------------------------------------ *
 * Accepted state
 * ------------------------------------------------------------------ */

export interface AcceptedPointer {
  schema_version: 1;
  course_year: number;
  accepted_id: string;
  payload_key: string;
  payload_sha256: string;
  source_snapshot_id: string;
  source_pdf_url: string;
  source_pdf_hash: string;
  parser_version: string;
  accepted_at: string;
}

export interface AcceptedPointerWriteRequest {
  expected_previous_accepted_id: string | null;
  pointer: AcceptedPointer;
}

export interface AcceptedPayloadMetadata {
  course_year: string;
  source_pdf_hash: string;
  source_pdf_url: string;
  snapshot_id: string;
  parser_version: string;
  payload_sha256: string;
  accepted_at: string;
}

export interface AcceptedRecord {
  schema_version: 1;
  course_year: number;
  snapshot_id: string;
  source_pdf_url: string;
  source_pdf_hash: string;
  accepted_at: string;
  schedule: Record<string, unknown>;
}

export interface AcceptedWriteRequest {
  expected_previous_hash: string | null;
  state: AcceptedRecord;
}

/* ------------------------------------------------------------------ *
 * Stage results
 * ------------------------------------------------------------------ */

/** One entry of the broker-generated upload plan handed back to the publisher. */
export interface PublicationPlanFile {
  file_id: string;
  filename: string;
  source_url: string;
  upload_path: string;
  status: "needed" | "stored";
}

export interface PublicationPlan {
  snapshot_id: string;
  operation_id: string;
  page_api_sha256: string;
  created_at: string;
  expires_at: string;
  files: PublicationPlanFile[];
}

export type OpenPublicationResult =
  | { ok: true; status: "created" | "resumed"; plan: PublicationPlan }
  | { ok: false; status: number; code: string; error: string };

export type FinalizeOutcome =
  | "published"
  | "already_current"
  | "incomplete"
  | "superseded"
  | "error";

export interface FinalizeResult {
  outcome: FinalizeOutcome;
  snapshot_id: string;
  missing?: string[];
  error?: string;
  retryable?: boolean;
}

export type ReconcileOutcome = "idle" | "requeued" | "error";

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  pending_examined: number;
  requeued_finalizes: number;
  error?: string;
  retryable?: boolean;
}
