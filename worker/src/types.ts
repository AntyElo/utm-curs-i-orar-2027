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

export interface Env {
  R2_BUCKET: R2Bucket;
  PUBLICATION_QUEUE: Queue<PublicationJob>;
  SCHEDULE_BROKER_SECRET?: string;
  FCIM_PAGE_API_URL?: string;
  SCHEDULE_PAGE_URL?: string;
  RECONCILIATION_INTERVAL_MINUTES?: string;
}

/* ------------------------------------------------------------------ *
 * Split publication job contracts
 * ------------------------------------------------------------------ */

/** Fetch one upstream PDF into an immutable snapshot child object. */
export interface IngestPdfJob {
  schema_version: 1;
  kind: "ingest_pdf";
  snapshot_id: string;
  file_id: string;
  filename: string;
  source_url: string;
  r2_key: string;
}

/** Re-run discovery in its own invocation, with the queue supplying retry and backoff. */
export interface DiscoverJob {
  schema_version: 1;
  kind: "discover";
  force: boolean;
}

/** Attempt to close a pending snapshot: verify completeness, write manifest, CAS current.json. */
export interface FinalizeJob {
  schema_version: 1;
  kind: "finalize";
  snapshot_id: string;
}

/** Re-drive pending snapshots whose ingest jobs never completed. */
export interface ReconcileJob {
  schema_version: 1;
  kind: "reconcile";
}

export type PublicationJob = DiscoverJob | IngestPdfJob | FinalizeJob | ReconcileJob;

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

/** One expected transport object, fixed at discovery time. */
export interface PendingFile {
  file_id: string;
  filename: string;
  source_url: string;
  r2_key: string;
}

/**
 * Immutable pending-snapshot descriptor written by discovery.
 * Fixes the complete expected file set before any PDF body is fetched.
 */
export interface PendingDescriptor {
  schema_version: 1;
  snapshot_id: string;
  previous_snapshot_id: string | null;
  created_at: string;
  /** R2 ETag of current.json observed at discovery; the CAS token finalize must still match. */
  current_etag: string | null;
  source: SnapshotSource;
  files: PendingFile[];
}

/**
 * Immutable per-file completion marker. Concurrent ingest jobs write disjoint keys,
 * so a completion can never be lost the way a shared mutable counter can.
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
  completed_at: string;
}

export interface SnapshotFile {
  filename: string;
  source_url: string;
  r2_key: string;
  content_type: string | null;
  size: number | null;
  upstream_etag: string | null;
  upstream_last_modified: string | null;
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

export type DiscoveryOutcome = "unchanged" | "scheduled" | "error";

export interface DiscoveryResult {
  outcome: DiscoveryOutcome;
  snapshot_id?: string;
  previous_snapshot_id?: string | null;
  reason?: string;
  error?: string;
  retryable?: boolean;
  files?: number;
}

export type IngestOutcome = "ingested" | "already_ingested" | "conflict" | "error";

export interface IngestResult {
  outcome: IngestOutcome;
  snapshot_id: string;
  file_id: string;
  r2_key?: string;
  size?: number | null;
  error?: string;
  retryable?: boolean;
}

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
  requeued_ingests: number;
  requeued_finalizes: number;
  error?: string;
  retryable?: boolean;
}
