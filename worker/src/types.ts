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

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  blob(): Promise<Blob>;
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
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
  SCHEDULE_BROKER_SECRET?: string;
  FCIM_PAGE_API_URL?: string;
  SCHEDULE_PAGE_URL?: string;
  RECONCILIATION_INTERVAL_MINUTES?: string;
}

export interface SnapshotSource {
  page_api_url: string;
  page_id: number | null;
  page_modified_gmt: string | null;
  retrieved_at: string;
  etag: string | null;
  last_modified: string | null;
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

export interface CurrentPointer {
  schema_version: 1;
  snapshot_id: string;
  updated_at: string;
  manifest_r2_key: string;
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

export interface PublishResult {
  published: boolean;
  snapshot_id?: string;
  reason?: string;
  conflict?: boolean;
  error?: string;
}
