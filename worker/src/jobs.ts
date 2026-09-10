/**
 * The contract between publication stages, and the canonical shape of one planned transport file.
 *
 * A job carries only validated, immutable identifiers — never a decision. Gate F removed the two
 * job kinds that reached the Internet (`discover`, `ingest_pdf`); the queue now carries nothing
 * but "close this snapshot" and "reconcile", so a queue message can no longer name a URL at all.
 *
 * `validatePendingFile()` keeps the GE-N01 filename/URL/key policy in one place. Publication
 * planning, descriptor validation and publisher uploads all re-derive the same answer from it,
 * on receipt, because a stored descriptor is input like any other.
 */

import { isOfficialTimetablePdfUrl } from "./extractor";
import { isSafeOfficialPdfFilename, MAX_OFFICIAL_PDF_FILENAME_LENGTH } from "../../worker-shared/fcim-policy";
import { snapshotPdfKey } from "./keys";
import { SNAPSHOT_ID_REGEX } from "./pointer";
import type { FinalizeJob, PublicationJob, ReconcileJob } from "./types";

export const FILE_ID_REGEX = /^f\d{1,3}$/;

/** Keep the extension and canonical length even when qualifying a boundary-length basename. */
export function qualifiedPdfFilename(sourceUrl: string, fileId?: string): string {
  const basename = sourceUrl.slice(sourceUrl.lastIndexOf("/") + 1);
  const month = /\/(\d{4})\/(\d{2})\//.exec(sourceUrl)!;
  const prefix = `${fileId ? `${fileId}-` : ""}${month[1]}-${month[2]}-`;
  const stem = basename.slice(0, -4).slice(0, MAX_OFFICIAL_PDF_FILENAME_LENGTH - 4 - prefix.length).replace(/\.+$/, "");
  return prefix + stem + basename.slice(-4);
}

export type JobValidation =
  | { ok: true; job: PublicationJob }
  | { ok: false; error: string };

function fail(error: string): JobValidation {
  return { ok: false, error };
}

/** Deterministic per-snapshot file identifier, assigned once when the publication opens. */
export function fileIdForIndex(index: number): string {
  return `f${index}`;
}

export function buildFinalizeJob(snapshotId: string): FinalizeJob {
  return { schema_version: 1, kind: "finalize", snapshot_id: snapshotId };
}

export function buildReconcileJob(): ReconcileJob {
  return { schema_version: 1, kind: "reconcile" };
}

export type PendingFileValidation = { ok: true } | { ok: false; error: string };

/**
 * The single source of truth for what a planned transport file may look like.
 *
 * Every rule here is load-bearing: the R2 key must address this snapshot's own PDF object, the
 * stored name must derive from the URL (basename, or that basename qualified with its upload
 * month when two folders publish the same one), and the URL must satisfy the official FCIM
 * timetable policy. Nothing a client sends can widen any of them.
 */
export function validatePendingFile(entry: {
  snapshot_id: unknown;
  file_id: unknown;
  filename: unknown;
  source_url: unknown;
  r2_key: unknown;
}): PendingFileValidation {
  const snapshotId = entry.snapshot_id;
  if (typeof snapshotId !== "string" || !SNAPSHOT_ID_REGEX.test(snapshotId)) {
    return { ok: false, error: "invalid snapshot_id" };
  }
  const fileId = entry.file_id;
  if (typeof fileId !== "string" || !FILE_ID_REGEX.test(fileId)) {
    return { ok: false, error: "invalid file_id" };
  }
  const filename = entry.filename;
  if (typeof filename !== "string" || !isSafeOfficialPdfFilename(filename)) {
    return { ok: false, error: "invalid filename" };
  }
  const sourceUrl = entry.source_url;
  if (typeof sourceUrl !== "string" || !isOfficialTimetablePdfUrl(sourceUrl)) {
    return { ok: false, error: "source_url is not an official timetable PDF URL" };
  }
  if (entry.r2_key !== snapshotPdfKey(snapshotId, filename)) {
    return { ok: false, error: "r2_key does not address this snapshot's own PDF object" };
  }
  const basename = sourceUrl.slice(sourceUrl.lastIndexOf("/") + 1);
  if (
    filename !== basename &&
    filename !== qualifiedPdfFilename(sourceUrl) &&
    filename !== qualifiedPdfFilename(sourceUrl, fileId)
  ) {
    return { ok: false, error: "filename does not derive from its source_url" };
  }
  return { ok: true };
}

/**
 * Validate a job received from the queue before any stage acts on it.
 *
 * `discover` and `ingest_pdf` are gone. A surviving message of either kind — a pre-cutover
 * delivery, or a replay — is a deterministic poison message: it is refused here and acked by the
 * consumer, so no background invocation can perform an FCIM request ever again.
 */
export function validateJob(body: unknown): JobValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("job must be a JSON object");
  }

  const job = body as Record<string, unknown>;
  if (job.schema_version !== 1) {
    return fail(`unsupported job schema_version ${JSON.stringify(job.schema_version)}`);
  }

  switch (job.kind) {
    case "reconcile":
      return { ok: true, job: { schema_version: 1, kind: "reconcile" } };

    case "finalize": {
      const snapshotId = job.snapshot_id;
      if (typeof snapshotId !== "string" || !SNAPSHOT_ID_REGEX.test(snapshotId)) {
        return fail("finalize job has an invalid snapshot_id");
      }
      return { ok: true, job: { schema_version: 1, kind: "finalize", snapshot_id: snapshotId } };
    }

    case "discover":
    case "ingest_pdf":
      return fail(
        `job kind ${JSON.stringify(job.kind)} was removed: the broker performs no upstream acquisition`,
      );

    default:
      return fail(`unknown job kind ${JSON.stringify(job.kind)}`);
  }
}
