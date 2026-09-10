/**
 * Publisher credential boundary.
 *
 * The MD Publisher and Render hold two different credentials with two different powers, and the
 * separation is the whole trust model: the publisher may only hand the broker raw bytes, and
 * Render may only write accepted state. Neither credential is ever accepted on the other's routes.
 *
 * The separation is enforced, not assumed. If an operator ever configures `MD_PUBLISHER_TOKEN`
 * (or its rotation predecessor) to the value of `SCHEDULE_BROKER_SECRET`, the publisher routes
 * fail closed rather than silently granting a transport credential accepted-state authority.
 */

const MIN_PUBLISHER_TOKEN_LENGTH = 32;

export const PUBLISHER_AUTH_UNAVAILABLE = "publisher_credentials_misconfigured";
export const PUBLISHER_AUTH_UNAUTHORIZED = "unauthorized";

export type PublisherAuthResult =
  | { ok: true; credential: "current" | "previous" }
  | { ok: false; status: 401 | 503; code: string; error: string };

/**
 * Compare two secrets without leaking either their contents or their lengths through timing.
 *
 * Both values are reduced to a fixed 32-byte digest first, so the comparison loop runs the same
 * number of iterations for every input; a plain byte-wise compare over the raw strings would
 * still leak the length through the loop bound.
 */
export async function secretEquals(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** Extract the bearer value without revealing anything about it in the failure path. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const value = trimmed.slice(7).trim();
  return value.length > 0 ? value : null;
}

interface PublisherEnv {
  MD_PUBLISHER_TOKEN?: string;
  MD_PUBLISHER_TOKEN_PREVIOUS?: string;
  SCHEDULE_BROKER_SECRET?: string;
}

/**
 * Authorize a request against the MD Publisher credentials only.
 *
 * Never logs, echoes or hashes a token into a response. The caller receives "yes" or a status,
 * and every failure mode is indistinguishable from the outside apart from misconfiguration,
 * which is deliberately reported so an operator can see that the deployment is fail-closed.
 */
export async function authorizePublisher(
  request: Request,
  env: PublisherEnv,
): Promise<PublisherAuthResult> {
  const current = env.MD_PUBLISHER_TOKEN;
  const previous = env.MD_PUBLISHER_TOKEN_PREVIOUS;
  const acceptedSecret = env.SCHEDULE_BROKER_SECRET;

  if (typeof current !== "string" || current.length === 0) {
    console.error("MD_PUBLISHER_TOKEN is not configured; publisher routes are closed");
    return {
      ok: false,
      status: 503,
      code: PUBLISHER_AUTH_UNAVAILABLE,
      error: "Publisher credentials are not configured",
    };
  }

  if (current.length < MIN_PUBLISHER_TOKEN_LENGTH) {
    console.error(
      `MD_PUBLISHER_TOKEN is shorter than ${MIN_PUBLISHER_TOKEN_LENGTH} characters; publisher routes are closed`,
    );
    return {
      ok: false,
      status: 503,
      code: PUBLISHER_AUTH_UNAVAILABLE,
      error: `Publisher credential must be at least ${MIN_PUBLISHER_TOKEN_LENGTH} characters`,
    };
  }

  // Authorization separation. A shared value would make one credential silently grant both
  // powers, which is exactly the failure this whole split exists to prevent.
  if (typeof acceptedSecret === "string" && acceptedSecret.length > 0) {
    if (current === acceptedSecret || (typeof previous === "string" && previous === acceptedSecret)) {
      console.error(
        "MD_PUBLISHER_TOKEN must differ from SCHEDULE_BROKER_SECRET; publisher routes are closed",
      );
      return {
        ok: false,
        status: 503,
        code: PUBLISHER_AUTH_UNAVAILABLE,
        error: "Publisher and accepted-state credentials must differ",
      };
    }
  }

  const presented = bearerToken(request);
  if (presented === null) {
    return {
      ok: false,
      status: 401,
      code: PUBLISHER_AUTH_UNAUTHORIZED,
      error: "Unauthorized",
    };
  }

  if (await secretEquals(presented, current)) {
    return { ok: true, credential: "current" };
  }

  if (typeof previous === "string" && previous.length >= MIN_PUBLISHER_TOKEN_LENGTH) {
    if (await secretEquals(presented, previous)) {
      return { ok: true, credential: "previous" };
    }
  }

  return { ok: false, status: 401, code: PUBLISHER_AUTH_UNAUTHORIZED, error: "Unauthorized" };
}
