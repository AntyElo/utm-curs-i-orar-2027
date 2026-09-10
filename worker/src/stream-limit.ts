/**
 * Byte-counting stream guard.
 *
 * `Content-Length` is a claim, not a fact: a chunked upload can omit it entirely, and a
 * streaming proxy has no reason to believe it when it is present. The only number worth
 * enforcing is the one counted off the wire, which is what this does — without ever holding
 * the whole body in memory.
 */

export class ContentPrefixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentPrefixError";
  }
}

export class PayloadTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Body exceeded the limit of ${maxBytes} bytes`);
    this.name = "PayloadTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/**
 * Wrap a body stream so it errors the moment the counted bytes pass `maxBytes`.
 *
 * The consumer (R2) sees a failed stream and abandons the upload, so an over-sized body can
 * never leave a usable immutable object behind.
 */
export function limitStreamBytes(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  const guard = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new PayloadTooLargeError(maxBytes));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return source.pipeThrough(guard);
}

type FixedLengthStreamConstructor = new (
  length: number,
) => TransformStream<Uint8Array, Uint8Array>;

function fixedLengthStreamConstructor(): FixedLengthStreamConstructor | null {
  const candidate = (globalThis as typeof globalThis & {
    FixedLengthStream?: FixedLengthStreamConstructor;
  }).FixedLengthStream;
  return typeof candidate === "function" ? candidate : null;
}

async function readWithinLimit(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** The five bytes every PDF starts with. */
export const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

/**
 * Wrap a body stream so it errors unless it begins with the expected magic bytes.
 *
 * The check runs on the first bytes off the wire and holds nothing back, so a body that lies
 * about its type fails before R2 is ever asked to create an object from it. A body shorter than
 * the prefix fails too — a truncated upload is not a PDF either.
 */
export function requirePrefix(
  source: ReadableStream<Uint8Array>,
  prefix: Uint8Array,
  label: string,
): ReadableStream<Uint8Array> {
  let matched = 0;
  const guard = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (let i = 0; matched < prefix.length && i < chunk.byteLength; i++, matched++) {
        if (chunk[i] !== prefix[matched]) {
          controller.error(new ContentPrefixError(`Body does not start with the expected ${label} signature`));
          return;
        }
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (matched < prefix.length) {
        controller.error(new ContentPrefixError(`Body is shorter than the expected ${label} signature`));
      }
    },
  });
  return source.pipeThrough(guard);
}

/** True when the error (or any cause in its chain) is a content-signature rejection. */
export function isContentPrefixError(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor; depth++) {
    if (cursor instanceof ContentPrefixError) return true;
    const message = (cursor as { message?: unknown }).message;
    if (typeof message === "string" && message.includes("expected PDF signature")) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/** Parse an exact, usable Content-Length value; malformed or absent claims stay unknown. */
export function contentLengthOrNull(value: string | null): number | null {
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Feed a byte-limited source into an R2 write without losing the length metadata R2 requires.
 *
 * Workers' `FixedLengthStream` both advertises the declared length to R2 and errors if the
 * actual stream is shorter or longer. The counting transform remains in front of it, so the
 * configured maximum is enforced from bytes actually read. Tests and uncommon chunked inputs,
 * where no usable length exists, use a bounded in-memory fallback and still enforce the count.
 */
export async function putLimitedStream<T>(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  declaredLength: number | null,
  put: (body: ReadableStream<Uint8Array> | Uint8Array) => Promise<T>,
): Promise<T> {
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }

  const FixedLengthStream = fixedLengthStreamConstructor();
  if (!FixedLengthStream || declaredLength === null) {
    const body = await readWithinLimit(source, maxBytes);
    if (declaredLength !== null && body.byteLength !== declaredLength) {
      throw new Error(
        `Body length ${body.byteLength} did not match declared Content-Length ${declaredLength}`,
      );
    }
    return put(body);
  }

  const { readable, writable } = new FixedLengthStream(declaredLength);
  const abort = new AbortController();
  let transferSettled = false;
  const transfer = limitStreamBytes(source, maxBytes)
    .pipeTo(writable, { signal: abort.signal })
    .finally(() => {
      transferSettled = true;
    });

  let result: T;
  try {
    result = await put(readable);
  } catch (writeError) {
    abort.abort();
    try {
      await transfer;
    } catch (transferError) {
      if (isPayloadTooLarge(transferError)) throw transferError;
    }
    throw writeError;
  }

  // A failed create-only precondition may return before consuming the stream. Abort only in that
  // race so the producer cannot remain blocked forever; a successful R2 write consumes it fully.
  if (!transferSettled && result === null) abort.abort();
  try {
    await transfer;
  } catch (transferError) {
    if (result !== null || isPayloadTooLarge(transferError)) throw transferError;
  }
  return result;
}

/** True when the error (or any cause in its chain) is a byte-limit rejection. */
export function isPayloadTooLarge(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor; depth++) {
    if (cursor instanceof PayloadTooLargeError) return true;
    const message = (cursor as { message?: unknown }).message;
    if (typeof message === "string" && message.includes("exceeded the limit of")) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}
