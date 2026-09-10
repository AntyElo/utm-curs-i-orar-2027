/**
 * Test doubles for the Cloudflare runtime the broker Worker runs on.
 *
 * The R2 double models conditional PUT faithfully — `etagMatches` and `etagDoesNotMatch: "*"`
 * are the entire basis of the broker's create-only and compare-and-swap guarantees, so a mock
 * that quietly accepted every write would make the interesting tests vacuous.
 *
 * The queue double delivers one message per invocation, exactly as `max_batch_size = 1` does in
 * production, and honours `retry()` with a bounded attempt count and a dead-letter list.
 */

import stockholmEgressWorker from "../../worker-egress/src/index";
import type {
  Env,
  ExecutionContext,
  PublicationJob,
  Queue,
  QueueMessage,
  QueueMessageBatch,
  R2Bucket,
  R2ListOptions,
  R2Object,
  R2ObjectBody,
  R2Objects,
  R2PutOptions,
  ServiceBinding,
} from "../../worker/src/types";

export interface EgressRequestRecord {
  url: string;
  method: string;
  body: string;
}

/**
 * In-process HTTP Service Binding. It records the main Worker's internal fetch and dispatches it
 * to the backend's real default.fetch handler; only that backend reaches the test's global fetch.
 */
export class MockServiceBinding implements ServiceBinding {
  readonly requests: EgressRequestRecord[] = [];

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    this.requests.push({
      url: request.url,
      method: request.method,
      body: await request.clone().text(),
    });
    return stockholmEgressWorker.fetch(request);
  }
}

interface StoredObject {
  data: Uint8Array;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  contentType?: string;
  customMetadata?: Record<string, string>;
}

export class MockR2Bucket implements R2Bucket {
  private storage = new Map<string, StoredObject>();
  readonly listings: R2ListOptions[] = [];
  readonly deletions: string[][] = [];
  /** R2 may return fewer than the requested limit. */
  listPageSize = 1000;

  async head(key: string): Promise<R2Object | null> {
    const item = this.storage.get(key);
    return item ? this.toObject(key, item) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const item = this.storage.get(key);
    if (!item) return null;

    const data = item.data;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });

    return {
      ...this.toObject(key, item),
      body,
      bodyUsed: false,
      arrayBuffer: async () =>
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(data),
      json: async <T = unknown>() => JSON.parse(new TextDecoder().decode(data)) as T,
      blob: async () => new Blob([Buffer.from(data)]),
    };
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    const existing = this.storage.get(key);

    if (options?.onlyIf) {
      if (options.onlyIf instanceof Headers) {
        if (options.onlyIf.get("If-None-Match") === "*" && existing) return null;
      } else {
        const cond = options.onlyIf;
        if (cond.etagMatches && (!existing || existing.etag !== cond.etagMatches)) return null;
        if (cond.etagDoesNotMatch === "*" && existing) return null;
        if (cond.etagDoesNotMatch && existing && existing.etag === cond.etagDoesNotMatch) return null;
      }
    }

    // Read the body BEFORE committing: a stream that errors half-way (an over-sized upload)
    // must leave no object behind, exactly as R2 abandons a failed multipart upload.
    const bytes = await readValue(value);

    // DF-05: R2 validates a declared content checksum server-side and rejects the write when the
    // bytes disagree. Modelling that here is what makes "unverified bytes never become a final
    // object" a testable property rather than an assumption about the client.
    if (options?.sha256 !== undefined) {
      const declared = typeof options.sha256 === "string"
        ? options.sha256.toLowerCase()
        : hex(new Uint8Array(options.sha256));
      if (!/^[a-f0-9]{64}$/.test(declared)) {
        throw new Error("put: The SHA-256 checksum you specified is not valid.");
      }
      if ((await sha256Hex(bytes)) !== declared) {
        throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
      }
    }

    const etag = crypto.randomUUID().replace(/-/g, "");
    const item: StoredObject = {
      data: bytes,
      etag,
      httpEtag: `"${etag}"`,
      uploaded: new Date(),
      contentType:
        options?.httpMetadata instanceof Headers
          ? (options.httpMetadata.get("Content-Type") ?? undefined)
          : options?.httpMetadata?.contentType,
      customMetadata: options?.customMetadata,
    };
    this.storage.set(key, item);
    return this.toObject(key, item);
  }

  async delete(keys: string | string[]): Promise<void> {
    const batch = Array.isArray(keys) ? keys : [keys];
    if (batch.length > 1000) throw new Error("R2 bulk delete limit exceeded");
    this.deletions.push([...batch]);
    for (const key of batch) {
      this.storage.delete(key);
    }
  }

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    this.listings.push({ ...options });
    const prefix = options.prefix ?? "";
    const delimiter = options.delimiter;
    const objects: R2Object[] = [];
    const prefixes = new Set<string>();

    for (const [key, item] of this.storage) {
      if (!key.startsWith(prefix)) continue;
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx !== -1) {
          prefixes.add(prefix + rest.slice(0, idx + delimiter.length));
          continue;
        }
      }
      objects.push(this.toObject(key, item));
    }

    // One lexicographic stream for objects AND grouped prefixes. The opaque continuation
    // represents the last emitted key, so deleting earlier keys cannot shift page offsets.
    const entries = [
      ...objects.map((object) => ({ key: object.key, object })),
      ...Array.from(prefixes).map((key) => ({ key, object: null })),
    ].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const after = options.cursor ? JSON.parse(atob(options.cursor)) as string : null;
    const remaining = entries.filter((entry) => after === null || entry.key > after);
    const page = remaining.slice(0, Math.min(options.limit ?? 1000, this.listPageSize));
    const truncated = remaining.length > page.length;
    return {
      objects: page.flatMap((entry) => entry.object ? [entry.object] : []),
      delimitedPrefixes: page.filter((entry) => !entry.object).map((entry) => entry.key),
      truncated,
      ...(truncated ? { cursor: btoa(JSON.stringify(page[page.length - 1].key)) } : {}),
    };
  }

  /* --- test affordances --- */

  has(key: string): boolean {
    return this.storage.has(key);
  }

  keys(): string[] {
    return Array.from(this.storage.keys()).sort();
  }

  bytes(key: string): Uint8Array | null {
    return this.storage.get(key)?.data ?? null;
  }

  text(key: string): string | null {
    const item = this.storage.get(key);
    return item ? new TextDecoder().decode(item.data) : null;
  }

  json<T>(key: string): T | null {
    const raw = this.text(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  metadata(key: string): Record<string, string> | undefined {
    return this.storage.get(key)?.customMetadata;
  }

  /** Write a raw object without any conditional check, to set up a starting state. */
  seed(key: string, body: string, customMetadata?: Record<string, string>): void {
    const etag = crypto.randomUUID().replace(/-/g, "");
    this.storage.set(key, {
      data: new TextEncoder().encode(body),
      etag,
      httpEtag: `"${etag}"`,
      uploaded: new Date(),
      customMetadata,
    });
  }

  private toObject(key: string, item: StoredObject): R2Object {
    return {
      key,
      version: item.etag,
      size: item.data.byteLength,
      etag: item.etag,
      httpEtag: item.httpEtag,
      uploaded: item.uploaded,
      httpMetadata: item.contentType ? { contentType: item.contentType } : undefined,
      customMetadata: item.customMetadata,
    };
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", view)));
}

async function readValue(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value && typeof value === "object" && "getReader" in value) {
    const reader = (value as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (chunk) {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  return new Uint8Array(0);
}

export interface QueuedMessage {
  body: PublicationJob;
  delaySeconds?: number;
  retryDelaySeconds?: number;
  attempts: number;
}

export class MockQueue implements Queue<PublicationJob> {
  /** Everything ever sent, in order — useful for asserting what a stage scheduled. */
  readonly sent: PublicationJob[] = [];
  readonly pending: QueuedMessage[] = [];
  readonly deadLettered: QueuedMessage[] = [];

  async send(body: PublicationJob, options?: { delaySeconds?: number }): Promise<void> {
    this.sent.push(body);
    this.pending.push({ body, delaySeconds: options?.delaySeconds, attempts: 0 });
  }

  async sendBatch(
    messages: Iterable<{ body: PublicationJob; delaySeconds?: number }>,
  ): Promise<void> {
    for (const message of messages) {
      await this.send(message.body, { delaySeconds: message.delaySeconds });
    }
  }

  ofKind(kind: PublicationJob["kind"]): PublicationJob[] {
    return this.sent.filter((job) => job.kind === kind);
  }
}

/** A publisher credential that satisfies the deployed minimum length. */
export const TEST_PUBLISHER_TOKEN = "md-publisher-token-0123456789abcdef";

export function createExecutionContext(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} };
}

export interface WorkerHarness {
  env: Env;
  bucket: MockR2Bucket;
  queue: MockQueue;
  egress: MockServiceBinding;
  ctx: ExecutionContext;
}

export function createHarness(overrides: Partial<Env> = {}): WorkerHarness {
  const bucket = new MockR2Bucket();
  const queue = new MockQueue();
  const egress = new MockServiceBinding();
  const env: Env = {
    R2_BUCKET: bucket,
    PUBLICATION_QUEUE: queue,
    FCIM_EGRESS: egress,
    SCHEDULE_BROKER_SECRET: "test-secret",
    MD_PUBLISHER_TOKEN: TEST_PUBLISHER_TOKEN,
    ...overrides,
  };
  return { env, bucket, queue, egress, ctx: createExecutionContext() };
}

export interface DrainResult {
  delivered: number;
  acked: number;
  retried: number;
  deadLettered: number;
  retryDelays: number[];
}

type QueueHandler = (
  batch: QueueMessageBatch<PublicationJob>,
  env: Env,
  ctx: ExecutionContext,
) => Promise<void>;

/**
 * Deliver queued jobs one per invocation until the queue is idle, honouring `retry()` up to
 * `maxRetries` and then dead-lettering — the same shape as the deployed consumer configuration.
 */
export async function drainQueue(
  harness: WorkerHarness,
  handler: QueueHandler,
  options: { maxRetries?: number; maxDeliveries?: number } = {},
): Promise<DrainResult> {
  const maxRetries = options.maxRetries ?? 3;
  const maxDeliveries = options.maxDeliveries ?? 300;
  const result: DrainResult = { delivered: 0, acked: 0, retried: 0, deadLettered: 0, retryDelays: [] };
  let counter = 0;

  while (harness.queue.pending.length > 0 && result.delivered < maxDeliveries) {
    const queued = harness.queue.pending.shift()!;
    queued.attempts += 1;
    result.delivered += 1;

    let acked = false;
    let retried = false;
    const message: QueueMessage<PublicationJob> = {
      id: `msg-${++counter}`,
      timestamp: new Date(),
      body: queued.body,
      attempts: queued.attempts,
      ack: () => {
        acked = true;
      },
      retry: (retryOptions) => {
        retried = true;
        queued.retryDelaySeconds = retryOptions?.delaySeconds;
        if (retryOptions?.delaySeconds !== undefined) {
          result.retryDelays.push(retryOptions.delaySeconds);
        }
      },
    };

    const batch: QueueMessageBatch<PublicationJob> = {
      queue: "fcim-broker-publication",
      messages: [message],
      ackAll: () => {
        acked = true;
      },
      retryAll: () => {
        retried = true;
      },
    };

    await handler(batch, harness.env, harness.ctx);

    if (retried) {
      result.retried += 1;
      if (queued.attempts > maxRetries) {
        harness.queue.deadLettered.push(queued);
        result.deadLettered += 1;
      } else {
        harness.queue.pending.push(queued);
      }
    } else if (acked) {
      result.acked += 1;
    }
  }

  return result;
}
