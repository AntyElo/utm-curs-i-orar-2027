/**
 * Small HTTP conventions shared by every upstream fetch the broker makes.
 */

/**
 * Normalise a cache validator.
 *
 * FCIM answers with a present-but-empty `etag:` header. An empty validator is not a validator —
 * echoing it back as `If-None-Match: ""` would make every revalidation look like a change, and
 * republish the whole catalogue on every cron tick.
 */
export function validatorOrNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Network failures and the upstream statuses which can recover without changing the job. */
export function isRetryableUpstreamFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") {
    return status === 403 || status === 429 || status >= 500;
  }
  return status === null && /network error/i.test((error as Error).message);
}

export function isRetryableUpstreamStatus(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}
