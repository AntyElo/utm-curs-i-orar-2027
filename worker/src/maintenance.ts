import { CURRENT_KEY, OPERATION_PREFIX, PENDING_PREFIX, SNAPSHOT_PREFIX, snapshotManifestKey } from "./keys";
import { parseCurrentPointer, SNAPSHOT_ID_REGEX } from "./pointer";
import type { Env, R2Bucket } from "./types";

export const PENDING_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const RETENTION_AGE_MS = 24 * 60 * 60 * 1000;
export const SNAPSHOT_KEEP_PREDECESSORS = 2;
export const GC_PREFIXES_PER_NAMESPACE = 8;
export const GC_MAX_PREFIX_DELETIONS = 4;
export const GC_MAX_OBJECTS_PER_PREFIX = 64;
/** Operation records are one flat object each, so they are swept by object, not by prefix. */
export const GC_MAX_OPERATION_DELETIONS = 64;
export const RECONCILE_SCAN_PAGES = 3;
export const RECONCILE_PAGE_SIZE = 100;

/** Reject impossible calendar dates as well as malformed IDs before making age decisions. */
export function snapshotIdInstant(snapshotId: string): number | null {
  if (!SNAPSHOT_ID_REGEX.test(snapshotId)) return null;
  const stamp = snapshotId.slice(0, 24);
  const iso = `${stamp.slice(0, 13)}:${stamp.slice(14, 16)}:${stamp.slice(17, 19)}.${stamp.slice(20, 23)}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString() === iso ? ms : null;
}

export function snapshotWorkExpired(snapshotId: string, now = Date.now()): boolean {
  const created = snapshotIdInstant(snapshotId);
  return created === null || now - created > PENDING_MAX_AGE_MS;
}

const cursorKey = (name: string) => `maintenance/${name}.json`;

export async function readScanCursor(bucket: R2Bucket, name: string): Promise<string | undefined> {
  const object = await bucket.get(cursorKey(name));
  if (!object) return undefined;
  const value: unknown = await object.json();
  return typeof value === "string" ? value : undefined;
}

export async function writeScanCursor(bucket: R2Bucket, name: string, cursor?: string): Promise<void> {
  await bucket.put(cursorKey(name), JSON.stringify(cursor ?? null));
}

/**
 * Incremental mark-and-sweep over expired prefixes only. Publication stages stop after six hours;
 * the 24-hour threshold leaves 18 hours for in-flight writes to finish (Queue wall limit: 15 min).
 * This grace is part of correctness: never lower it to the publication deadline itself.
 * No lifecycle rule can safely express the current-pointer exclusion.
 *
 * R2 delete accepts string[] (<=1000 keys), is strongly consistent and is idempotent for missing
 * keys. Each sweep deletes at most 4 * 64 objects. Partial prefixes are revisited after cursor wrap;
 * a crash before saving a cursor merely repeats safe deletion. Cursors are hints, never authority.
 */
export async function runRetention(env: Env): Promise<{ deleted_objects: number }> {
  const bucket = env.R2_BUCKET;
  const currentObject = await bucket.get(CURRENT_KEY);
  const protectedIds = new Set<string>();
  let currentId: string | null = null;
  if (currentObject) {
    const parsed = parseCurrentPointer(await currentObject.text());
    if (!parsed.ok) return { deleted_objects: 0 }; // cannot safely identify live data
    currentId = parsed.pointer.snapshot_id;
    protectedIds.add(currentId);
    let id = currentId;
    for (let n = 0; n < SNAPSHOT_KEEP_PREDECESSORS; n++) {
      const object = await bucket.get(snapshotManifestKey(id));
      if (!object) return { deleted_objects: 0 };
      let manifest;
      try { manifest = await object.json<{ snapshot_id: string; previous_snapshot_id: string | null }>(); }
      catch { return { deleted_objects: 0 }; }
      if (!manifest || manifest.snapshot_id !== id) return { deleted_objects: 0 };
      const previous = manifest.previous_snapshot_id;
      if (previous === null) break;
      if (typeof previous !== "string" || snapshotIdInstant(previous) === null || protectedIds.has(previous)) {
        return { deleted_objects: 0 };
      }
      protectedIds.add(previous);
      id = previous;
    }
  }

  const now = Date.now();
  let deletedObjects = 0;
  let deletedPrefixes = 0;
  for (const prefix of [PENDING_PREFIX, SNAPSHOT_PREFIX]) {
    const name = prefix === PENDING_PREFIX ? "gc-pending" : "gc-snapshots";
    const cursor = await readScanCursor(bucket, name);
    const listing = await bucket.list({ prefix, delimiter: "/", limit: GC_PREFIXES_PER_NAMESPACE, cursor });
    if (listing.truncated && !listing.cursor) throw new Error(`R2 ${name} listing truncated without cursor`);
    for (const childPrefix of listing.delimitedPrefixes) {
      if (deletedPrefixes >= GC_MAX_PREFIX_DELETIONS) break;
      const id = childPrefix.slice(prefix.length, -1);
      const created = snapshotIdInstant(id);
      if (created === null || now - created <= RETENTION_AGE_MS) continue;
      if (id === currentId || (prefix === SNAPSHOT_PREFIX && protectedIds.has(id))) continue;

      // Expired snapshots cannot become current. If publication advanced while we read its
      // predecessor chain, defer all remaining deletion to a fresh, coherent sweep.
      const latest = await bucket.head(CURRENT_KEY);
      if ((latest?.etag ?? null) !== (currentObject?.etag ?? null)) return { deleted_objects: deletedObjects };
      const objects = await bucket.list({ prefix: childPrefix, limit: GC_MAX_OBJECTS_PER_PREFIX });
      const keys = objects.objects.map((object) => object.key);
      if (keys.length) {
        await bucket.delete(keys);
        deletedObjects += keys.length;
        deletedPrefixes++;
      }
    }
    await writeScanCursor(bucket, name, listing.truncated ? listing.cursor : undefined);
  }
  deletedObjects += await sweepOperations(bucket, now);
  return { deleted_objects: deletedObjects };
}

/**
 * Expire the create-only attempt→snapshot records under `operations/`.
 *
 * These are the one namespace with no prefix structure and no timestamp in the key, so they are
 * aged by the object's own upload time and swept one bounded page per invocation, with a cursor
 * of their own. Nothing about pending or snapshot retention changes.
 *
 * Deleting one is safe well before this threshold: a publication may only live for six hours, so
 * a record older than the 24-hour retention age can no longer be resumed, and its id — a random
 * UUIDv4 the client generated once — will never be presented again. Keeping them forever would
 * make `operations/` the one namespace that grows without bound.
 */
async function sweepOperations(bucket: R2Bucket, now: number): Promise<number> {
  const cursor = await readScanCursor(bucket, "gc-operations");
  const listing = await bucket.list({
    prefix: OPERATION_PREFIX,
    limit: GC_MAX_OPERATION_DELETIONS,
    cursor,
  });
  if (listing.truncated && !listing.cursor) throw new Error("R2 gc-operations listing truncated without cursor");

  const expired = listing.objects
    .filter((object) => now - object.uploaded.getTime() > RETENTION_AGE_MS)
    .map((object) => object.key);
  // One bulk delete, so a sweep of this namespace stays a single bounded operation.
  if (expired.length > 0) await bucket.delete(expired);

  // Persist the cursor last: a crash re-scans this page rather than skipping the next one.
  await writeScanCursor(bucket, "gc-operations", listing.truncated ? listing.cursor : undefined);
  return expired.length;
}
