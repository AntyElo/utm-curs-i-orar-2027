/**
 * The contract between publication stages.
 *
 * A job carries only validated, immutable identifiers — never a decision. An ingest job cannot
 * ask for a URL the discovery stage did not already prove to be an official timetable PDF, and
 * it cannot ask for an R2 key outside its own snapshot: both are re-derived and re-checked here,
 * on receipt, because a queue message is input like any other.
 */

import { isOfficialTimetablePdfUrl } from "./extractor";
import { snapshotPdfKey } from "./keys";
import { SNAPSHOT_ID_REGEX } from "./pointer";
import type { DiscoverJob, FinalizeJob, IngestPdfJob, PublicationJob, ReconcileJob } from "./types";

const FILE_ID_REGEX = /^f\d{1,3}$/;
const PDF_FILENAME_REGEX = /^[a-zA-Z0-9_\-.]{1,128}\.pdf$/;

export type JobValidation =
  | { ok: true; job: PublicationJob }
  | { ok: false; error: string };

function fail(error: string): JobValidation {
  return { ok: false, error };
}

/** Deterministic per-snapshot file identifier, assigned once by discovery. */
export function fileIdForIndex(index: number): string {
  return `f${index}`;
}

export function buildIngestJob(input: {
  snapshotId: string;
  fileId: string;
  filename: string;
  sourceUrl: string;
}): IngestPdfJob {
  return {
    schema_version: 1,
    kind: "ingest_pdf",
    snapshot_id: input.snapshotId,
    file_id: input.fileId,
    filename: input.filename,
    source_url: input.sourceUrl,
    r2_key: snapshotPdfKey(input.snapshotId, input.filename),
  };
}

export function buildFinalizeJob(snapshotId: string): FinalizeJob {
  return { schema_version: 1, kind: "finalize", snapshot_id: snapshotId };
}

export function buildReconcileJob(): ReconcileJob {
  return { schema_version: 1, kind: "reconcile" };
}

export function buildDiscoverJob(force = false): DiscoverJob {
  return { schema_version: 1, kind: "discover", force };
}

/** Validate a job received from the queue before any stage acts on it. */
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

    case "discover": {
      if (typeof job.force !== "boolean") {
        return fail("discover job force must be a boolean");
      }
      return { ok: true, job: { schema_version: 1, kind: "discover", force: job.force } };
    }

    case "finalize": {
      const snapshotId = job.snapshot_id;
      if (typeof snapshotId !== "string" || !SNAPSHOT_ID_REGEX.test(snapshotId)) {
        return fail("finalize job has an invalid snapshot_id");
      }
      return { ok: true, job: { schema_version: 1, kind: "finalize", snapshot_id: snapshotId } };
    }

    case "ingest_pdf": {
      const snapshotId = job.snapshot_id;
      if (typeof snapshotId !== "string" || !SNAPSHOT_ID_REGEX.test(snapshotId)) {
        return fail("ingest job has an invalid snapshot_id");
      }
      const fileId = job.file_id;
      if (typeof fileId !== "string" || !FILE_ID_REGEX.test(fileId)) {
        return fail("ingest job has an invalid file_id");
      }
      const filename = job.filename;
      if (typeof filename !== "string" || !PDF_FILENAME_REGEX.test(filename)) {
        return fail("ingest job has an invalid filename");
      }
      const sourceUrl = job.source_url;
      if (typeof sourceUrl !== "string" || !isOfficialTimetablePdfUrl(sourceUrl)) {
        return fail("ingest job source_url is not an official timetable PDF URL");
      }
      const expectedKey = snapshotPdfKey(snapshotId, filename);
      if (job.r2_key !== expectedKey) {
        return fail("ingest job r2_key does not address this snapshot's own PDF object");
      }
      // The stored name is the URL's basename, or that basename qualified with its upload month
      // when two folders publish the same basename. Nothing else may name the object.
      const basename = sourceUrl.slice(sourceUrl.lastIndexOf("/") + 1);
      const month = /\/(\d{4})\/(\d{2})\//.exec(sourceUrl);
      const qualified = month ? `${month[1]}-${month[2]}-${basename}` : null;
      if (filename !== basename && filename !== qualified) {
        return fail("ingest job filename does not derive from its source_url");
      }
      return {
        ok: true,
        job: {
          schema_version: 1,
          kind: "ingest_pdf",
          snapshot_id: snapshotId,
          file_id: fileId,
          filename,
          source_url: sourceUrl,
          r2_key: expectedKey,
        },
      };
    }

    default:
      return fail(`unknown job kind ${JSON.stringify(job.kind)}`);
  }
}
