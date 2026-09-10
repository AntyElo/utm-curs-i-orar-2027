/**
 * Every R2 key the broker writes or reads, in one place.
 *
 * Snapshot children live under an immutable `snapshots/<id>/` prefix and are only ever
 * created, never rewritten. The `pending/<id>/` prefix holds the scaffolding a snapshot
 * needs while it is still being assembled; nothing under it is ever served to Render.
 */

export const CURRENT_KEY = "current.json";

export const SNAPSHOT_PREFIX = "snapshots/";
export const PENDING_PREFIX = "pending/";
export const OPERATION_PREFIX = "operations/";

/** Publisher liveness. The one small mutable object outside `current.json`. */
export const PUBLISHER_HEARTBEAT_KEY = "publisher/heartbeat.json";

/**
 * Create-only binding from one client publication attempt to one broker snapshot.
 * The id is a client-generated UUIDv4 and is validated before it ever reaches this function.
 */
export function operationKey(operationId: string): string {
  return `${OPERATION_PREFIX}${operationId}.json`;
}

export function snapshotPageApiKey(snapshotId: string): string {
  return `${SNAPSHOT_PREFIX}${snapshotId}/page-api.json`;
}

export function snapshotManifestKey(snapshotId: string): string {
  return `${SNAPSHOT_PREFIX}${snapshotId}/manifest.json`;
}

export function snapshotPdfKey(snapshotId: string, filename: string): string {
  return `${SNAPSHOT_PREFIX}${snapshotId}/pdfs/${filename}`;
}

export function pendingDescriptorKey(snapshotId: string): string {
  return `${PENDING_PREFIX}${snapshotId}/descriptor.json`;
}

export function pendingCompletionKey(snapshotId: string, fileId: string): string {
  return `${PENDING_PREFIX}${snapshotId}/completed/${fileId}.json`;
}

export function acceptedPointerKey(courseYear: number): string {
  return `accepted/course-${courseYear}.json`;
}

export function acceptedPayloadKey(courseYear: number, acceptedId: string): string {
  return `accepted-payloads/course-${courseYear}/${acceptedId}.json`;
}
