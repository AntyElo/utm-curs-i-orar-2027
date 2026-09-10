/**
 * The authoritative freshness baseline.
 *
 * There is exactly one correct answer to "what is the broker serving right now", and it is the
 * snapshot `current.json` names — never what this laptop happens to remember. That distinction is
 * the whole point of this file, and it is what stops the following wedge:
 *
 *   1. the publisher observes upstream state B and opens a publication for it;
 *   2. another publication A wins the `current.json` CAS while B is still uploading;
 *   3. B completes as `superseded`, which is a normal outcome and not an error;
 *   4. a laptop that recorded B as its baseline then sees FCIM still at B, calls it "unchanged",
 *      and the broker stays on A forever.
 *
 * Step 4 is impossible here: a local record is consulted only when it is *anchored*, meaning it
 * carries the id of the snapshot `current.json` names at this moment. Anything else is ignored
 * and the baseline is rebuilt from the broker's own immutable manifest, so an unanchored,
 * corrupted, stale or entirely absent state directory costs at most one extra publication.
 */

import type { BrokerClient } from "./broker";
import { sha256Hex } from "./hash";
import type { StateStore } from "./state";
import type {
  BaselinePdf,
  FreshnessBaseline,
  LastRunState,
  ResolvedBaseline,
} from "./types";

const WP_GMT_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** Read `modified_gmt` out of a page payload for reporting only; the broker re-derives its own. */
export function pageModifiedGmtOf(bytes: Uint8Array): string | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    const value = (item as { modified_gmt?: unknown } | null)?.modified_gmt;
    return typeof value === "string" && WP_GMT_REGEX.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Build the baseline from one broker snapshot's own immutable objects.
 *
 * The manifest describes the bytes that snapshot actually holds — including the SHA-256 of every
 * mirrored PDF — and `page-api.json` is the exact payload it was opened with. Comparing FCIM
 * against those two is comparing it against what the broker is really serving.
 *
 * `null` means this snapshot cannot supply a usable baseline (missing objects, or a file with no
 * recorded digest). That is deliberately not an error: it simply means nothing can be proven
 * unchanged, so the caller publishes, and the snapshot that publication creates carries the
 * digests the next run needs.
 */
export async function brokerSnapshotBaseline(
  broker: BrokerClient,
  snapshotId: string,
): Promise<FreshnessBaseline | null> {
  const manifest = await broker.readManifest(snapshotId);
  if (!manifest || manifest.files.length === 0) return null;

  const pdfs: BaselinePdf[] = [];
  for (const file of manifest.files) {
    // Without a digest there is nothing to compare bytes against, and a publisher-observed
    // validator alone is not enough to call an unseen file unchanged.
    if (!file.content_sha256) return null;
    pdfs.push({
      source_url: file.source_url,
      // A validator the broker recorded next to this exact digest, in the same upload, describes
      // these exact bytes. It is a cheap way to ask FCIM "still the same document?" and a 200
      // answer is treated as a change, never the other way round.
      etag: file.publisher_observed_etag,
      last_modified: file.publisher_observed_last_modified,
      sha256: file.content_sha256,
    });
  }

  const pageBytes = await broker.readSnapshotPageApi(snapshotId);
  if (!pageBytes) return null;

  return {
    origin: "broker_snapshot",
    broker_snapshot_id: snapshotId,
    page_api_sha256: sha256Hex(pageBytes),
    // The snapshot records no trusted page validator (DF-02), so the next Page API request is
    // unconditional and decided by hash. Strictly stronger evidence than a validator.
    page_etag: null,
    page_last_modified: null,
    page_modified_gmt: manifest.page_modified_gmt ?? pageModifiedGmtOf(pageBytes),
    pdfs,
  };
}

function baselineFromCache(last: LastRunState): FreshnessBaseline {
  return {
    origin: "local_cache",
    broker_snapshot_id: last.broker_snapshot_id,
    page_api_sha256: last.page_api_sha256,
    page_etag: last.page_etag,
    page_last_modified: last.page_last_modified,
    page_modified_gmt: last.page_modified_gmt,
    pdfs: last.pdfs.map((pdf) => ({
      source_url: pdf.source_url,
      etag: pdf.etag,
      last_modified: pdf.last_modified,
      sha256: pdf.sha256,
    })),
  };
}

/**
 * Decide what this run is allowed to compare FCIM against.
 *
 * Always starts at `current.json`. The local cache is an optimization layered on top of that
 * answer and is used only when it names the very snapshot the broker is serving; otherwise it is
 * ignored, whatever it claims to know.
 */
export async function resolveBaseline(
  broker: BrokerClient,
  state: StateStore,
  log: (line: string) => void,
): Promise<ResolvedBaseline> {
  const current = await broker.readCurrentPointer();
  if (!current) {
    return {
      baseline: null,
      current_snapshot_id: null,
      reason: "the broker has no current snapshot",
    };
  }

  const last = state.readLastRun();
  if (last && last.broker_snapshot_id === current.snapshot_id && last.pdfs.length > 0) {
    return {
      baseline: baselineFromCache(last),
      current_snapshot_id: current.snapshot_id,
      reason: `local baseline is anchored to broker current ${current.snapshot_id}`,
    };
  }
  if (last) {
    // The wedge, refused out loud: this laptop's memory describes a snapshot the broker is not
    // serving, so it says nothing at all about whether the broker is up to date.
    log(
      `ignoring the local freshness cache: it describes ${last.broker_snapshot_id ?? "an unknown snapshot"}, ` +
        `broker current is ${current.snapshot_id}`,
    );
  }

  const derived = await brokerSnapshotBaseline(broker, current.snapshot_id);
  if (!derived) {
    return {
      baseline: null,
      current_snapshot_id: current.snapshot_id,
      reason: `broker current ${current.snapshot_id} has no usable manifest baseline`,
    };
  }
  return {
    baseline: derived,
    current_snapshot_id: current.snapshot_id,
    reason: `baseline derived from broker current ${current.snapshot_id}`,
  };
}

/** Shape a baseline for on-disk caching. Only ever called with a baseline proven to be current. */
export function lastRunFrom(
  baseline: FreshnessBaseline,
  outcome: string,
  completedAt: string,
): LastRunState {
  return {
    schema_version: 2,
    broker_snapshot_id: baseline.broker_snapshot_id,
    page_etag: baseline.page_etag,
    page_last_modified: baseline.page_last_modified,
    page_api_sha256: baseline.page_api_sha256,
    page_modified_gmt: baseline.page_modified_gmt,
    pdfs: baseline.pdfs.map((pdf) => ({
      source_url: pdf.source_url,
      etag: pdf.etag,
      last_modified: pdf.last_modified,
      sha256: pdf.sha256,
    })),
    outcome,
    completed_at: completedAt,
  };
}

export interface CacheRefresh {
  status: "refreshed" | "invalidated";
  /** The snapshot the broker was serving when the cache was rebuilt, if it could be read. */
  broker_snapshot_id: string | null;
}

/**
 * Re-derive the cached baseline from the broker after an attempt closed, whatever it closed as.
 *
 * Never from the attempt's own observations. A `published` attempt re-reads `current.json` to
 * confirm the broker really is serving its snapshot; a `superseded` one finds someone else's
 * snapshot there and caches *that* instead, which is exactly what makes the next run notice the
 * drift it still has to publish. Anything unexpected invalidates the cache rather than guessing:
 * an absent cache is always safe, because the next run rebuilds it from the broker.
 */
export async function refreshCacheFromBroker(
  broker: BrokerClient,
  state: StateStore,
  outcome: string,
  completedAt: string,
  expectedSnapshotId: string | null,
  log: (line: string) => void,
): Promise<CacheRefresh> {
  try {
    const current = await broker.readCurrentPointer();
    if (!current) {
      state.clearLastRun();
      return { status: "invalidated", broker_snapshot_id: null };
    }
    if (expectedSnapshotId && current.snapshot_id !== expectedSnapshotId) {
      log(
        `broker current is ${current.snapshot_id}, not the snapshot this run closed ` +
          `(${expectedSnapshotId}); recording the broker's state instead`,
      );
    }
    const derived = await brokerSnapshotBaseline(broker, current.snapshot_id);
    if (!derived) {
      state.clearLastRun();
      return { status: "invalidated", broker_snapshot_id: current.snapshot_id };
    }
    state.writeLastRun(lastRunFrom(derived, outcome, completedAt));
    return { status: "refreshed", broker_snapshot_id: current.snapshot_id };
  } catch (err: unknown) {
    // The cache is an optimization. Losing it costs one extra publication; keeping a wrong one
    // costs freshness, so a failure here always drops it.
    log(`could not refresh the local freshness cache: ${(err as Error).message}`);
    state.clearLastRun();
    return { status: "invalidated", broker_snapshot_id: null };
  }
}
