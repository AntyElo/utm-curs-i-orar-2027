/**
 * The publish and check flows.
 *
 * Two rules decide everything in this file.
 *
 * **The broker's current snapshot is the only freshness baseline.** Every normal run starts by
 * reading `current.json` and comparing FCIM against the snapshot it names — never against what
 * this laptop happens to remember. The local cache is consulted only while it is anchored to that
 * exact snapshot, and it is rebuilt from the broker after every attempt, whatever the attempt
 * closed as. A publication that lost the pointer race therefore cannot leave the laptop believing
 * it is up to date while the broker serves something else. See `baseline.ts`.
 *
 * **Change detection is conservative, in the Gate E sense:** a no-op is only reported when the
 * upstream can genuinely be treated as unchanged. In particular a PDF conditional request that
 * answers 200 triggers a publication even when the Page API bytes and the URL set did not move at
 * all — FCIM does replace a timetable in place under the same URL, and that is precisely the
 * change that must not be missed. When the upstream offers no usable validator for a PDF, the
 * only honest test left is the bytes themselves, so the body is downloaded and compared by hash.
 */

import { pageModifiedGmtOf, lastRunFrom, refreshCacheFromBroker, resolveBaseline } from "./baseline";
import { BrokerClient } from "./broker";
import { newOperationId, sha256Hex } from "./hash";
import { StateStore } from "./state";
import {
  downloadPdf,
  fetchPageApi,
  revalidatePdf,
  type DownloadedPdf,
} from "./upstream";
import {
  BrokerError,
  type FreshnessBaseline,
  type PublicationPlan,
  type PublishResult,
  type PublisherConfig,
  type ResolvedBaseline,
  type Transport,
} from "./types";

export interface RunOptions {
  dryRun?: boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

interface DetectionOutcome {
  changed: boolean;
  reason: string;
  pageBytes: Uint8Array;
  pageSha256: string;
  pageEtag: string | null;
  pageLastModified: string | null;
  /** Bodies already downloaded during detection, keyed by source URL. */
  downloaded: Map<string, DownloadedPdf>;
  /** Validators observed for URLs that were revalidated rather than downloaded. */
  observed: Map<string, { etag: string | null; lastModified: string | null }>;
}

/**
 * Compare FCIM against the baseline the broker's current snapshot supplies.
 *
 * A `null` baseline means nothing can be proven unchanged — no current snapshot, no readable
 * manifest, or a manifest with no digest to compare against — and the only safe answer to that
 * is to publish.
 */
async function detectChange(
  config: PublisherConfig,
  transport: Transport,
  state: StateStore,
  baseline: FreshnessBaseline | null,
  noBaselineReason: string,
): Promise<DetectionOutcome> {
  const downloaded = new Map<string, DownloadedPdf>();
  const observed = new Map<string, { etag: string | null; lastModified: string | null }>();

  const page = await fetchPageApi(transport, config.timeoutMs, {
    etag: baseline?.page_etag,
    lastModified: baseline?.page_last_modified,
  });

  const unconditionalPage = async () => {
    const full = await fetchPageApi(transport, config.timeoutMs);
    if (full.notModified || !full.bytes) {
      throw new Error("Page API answered 304 to an unconditional request");
    }
    return full;
  };

  if (!baseline || baseline.pdfs.length === 0) {
    const full = page.notModified || !page.bytes ? await unconditionalPage() : page;
    const bytes = full.bytes!;
    return {
      changed: true,
      reason: noBaselineReason,
      pageBytes: bytes,
      pageSha256: sha256Hex(bytes),
      pageEtag: full.etag,
      pageLastModified: full.lastModified,
      downloaded,
      observed,
    };
  }

  const pageChanged = page.notModified
    ? false
    : sha256Hex(page.bytes!) !== baseline.page_api_sha256;

  let pdfChanged = false;
  const reasons: string[] = [];
  if (pageChanged) reasons.push("Page API bytes changed");

  for (const pdf of baseline.pdfs) {
    if (pdf.etag || pdf.last_modified) {
      const result = await revalidatePdf(
        transport,
        pdf.source_url,
        { etag: pdf.etag, lastModified: pdf.last_modified },
        config.timeoutMs,
      );
      observed.set(pdf.source_url, { etag: result.etag, lastModified: result.lastModified });
      if (result.changed) {
        pdfChanged = true;
        reasons.push(`${pdf.source_url} answered 200 to a conditional request`);
      }
      continue;
    }

    // No usable validator was recorded. Compare the bytes: it is the only trustworthy test, and
    // the body is kept so the upload phase does not have to fetch it a second time.
    const body = await downloadPdf(
      transport,
      pdf.source_url,
      state.cachePathFor(pdf.source_url),
      config.timeoutMs,
    );
    downloaded.set(pdf.source_url, body);
    observed.set(pdf.source_url, { etag: body.etag, lastModified: body.lastModified });
    if (body.sha256 !== pdf.sha256) {
      pdfChanged = true;
      reasons.push(`${pdf.source_url} content hash changed`);
    }
  }

  const changed = pageChanged || pdfChanged;
  let bytes = page.bytes;
  let etag = page.etag;
  let lastModified = page.lastModified;
  if (changed && !bytes) {
    const full = await unconditionalPage();
    bytes = full.bytes;
    etag = full.etag;
    lastModified = full.lastModified;
  }

  return {
    changed,
    reason: changed
      ? reasons.join("; ")
      : `broker snapshot ${baseline.broker_snapshot_id} still matches the Page API and every mirrored PDF`,
    pageBytes: bytes ?? new Uint8Array(0),
    pageSha256: bytes ? sha256Hex(bytes) : baseline.page_api_sha256,
    pageEtag: etag,
    pageLastModified: lastModified,
    downloaded,
    observed,
  };
}

/**
 * Refresh a baseline that was just proven to still describe the broker's current snapshot.
 *
 * Only the *validators* move: the digests stay the broker's, because the bytes were proven equal
 * to the ones it stores. This is what lets an unchanged run stay a two-request no-op without ever
 * caching an observation the broker does not represent.
 */
function refreshedAnchoredBaseline(
  baseline: FreshnessBaseline,
  detection: DetectionOutcome,
): FreshnessBaseline {
  return {
    ...baseline,
    page_etag: detection.pageEtag ?? baseline.page_etag,
    page_last_modified: detection.pageLastModified ?? baseline.page_last_modified,
    pdfs: baseline.pdfs.map((pdf) => {
      const seen = detection.observed.get(pdf.source_url);
      return {
        ...pdf,
        etag: seen?.etag ?? pdf.etag,
        last_modified: seen?.lastModified ?? pdf.last_modified,
      };
    }),
  };
}

async function uploadPlanFiles(
  config: PublisherConfig,
  transport: Transport,
  broker: BrokerClient,
  state: StateStore,
  plan: PublicationPlan,
  detection: DetectionOutcome,
  log: (line: string) => void,
): Promise<void> {
  // One PDF at a time. Nothing is held in memory, and each temporary body is removed as soon as
  // the broker has it, so a large catalogue cannot fill the laptop's disk mid-run.
  for (const file of plan.files) {
    if (file.status === "stored") {
      // The broker already holds this file's immutable bytes and will not accept different ones,
      // so re-downloading it could only produce an observation about *some other* revision —
      // one that belongs to a future publication, never to this snapshot. Skip the traffic.
      log(`  ${file.filename}: already stored (not re-downloaded)`);
      continue;
    }

    const cached = detection.downloaded.get(file.source_url);
    let body: DownloadedPdf;
    let ownsTemp = false;

    if (cached) {
      body = cached;
    } else {
      log(`downloading ${file.filename}`);
      body = await downloadPdf(
        transport,
        file.source_url,
        state.runTempPathFor(file.file_id),
        config.timeoutMs,
      );
      ownsTemp = true;
    }

    log(`uploading ${file.filename} (${body.size} bytes)`);
    const result = await broker.uploadFile({
      uploadPath: file.upload_path,
      filePath: body.path,
      size: body.size,
      sha256: body.sha256,
      observedEtag: body.etag,
      observedLastModified: body.lastModified,
    });
    log(`  ${file.filename}: ${result.status}`);

    if (ownsTemp) state.removeTemp(body.path);
  }
}

function isFreshIdentityRequired(error: unknown): boolean {
  return (
    error instanceof BrokerError &&
    (error.code === "operation_payload_mismatch" || error.code === "operation_expired")
  );
}

function isUnrecoverable(error: unknown): boolean {
  return error instanceof BrokerError && error.code === "operation_state_corrupt";
}

/**
 * Run one publication attempt with a specific operation identity.
 * Never retries on its own — the caller owns the "mint a new id and try once more" rule.
 */
async function attemptPublication(
  config: PublisherConfig,
  transport: Transport,
  broker: BrokerClient,
  state: StateStore,
  detection: DetectionOutcome,
  operationId: string,
  startedAt: string,
  log: (line: string) => void,
): Promise<{ plan: PublicationPlan; completeStatus: string }> {
  state.startOperation(
    {
      schema_version: 1,
      operation_id: operationId,
      page_api_sha256: detection.pageSha256,
      snapshot_id: null,
      started_at: startedAt,
    },
    detection.pageBytes,
  );

  const plan = await broker.openPublication(operationId, detection.pageBytes, detection.pageSha256);
  log(`publication ${plan.status}: snapshot ${plan.snapshot_id}, ${plan.files.length} file(s)`);
  state.updateOperation({
    schema_version: 1,
    operation_id: operationId,
    page_api_sha256: detection.pageSha256,
    snapshot_id: plan.snapshot_id,
    started_at: startedAt,
  });

  await uploadPlanFiles(config, transport, broker, state, plan, detection, log);
  const completed = await broker.complete(plan.snapshot_id);
  log(`complete: ${completed.status}`);
  return { plan, completeStatus: completed.status };
}

/**
 * Resume an attempt that a previous run left open, or start a fresh one.
 *
 * A resumable attempt skips change detection entirely: the bytes it was opened with are on disk
 * and are the only bytes that attempt is allowed to send. Nothing observed while finishing it is
 * ever recorded as a freshness baseline — the baseline is re-derived from the broker afterwards.
 */
async function resumeDetection(state: StateStore): Promise<
  { operationId: string; detection: DetectionOutcome } | null
> {
  const resumable = state.readResumableOperation();
  if (!resumable) return null;
  return {
    operationId: resumable.operation.operation_id,
    detection: {
      changed: true,
      reason: "resuming an interrupted publication",
      pageBytes: resumable.pageBytes,
      pageSha256: resumable.operation.page_api_sha256,
      pageEtag: null,
      pageLastModified: null,
      downloaded: new Map(),
      observed: new Map(),
    },
  };
}

export async function runPublish(
  config: PublisherConfig,
  transport: Transport,
  options: RunOptions = {},
): Promise<PublishResult> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const startedMs = now().getTime();
  const state = new StateStore(config.stateDir);
  const broker = new BrokerClient(config, transport);

  let baselineSource: PublishResult["baseline_source"] = "none";
  let brokerSnapshotId: string | null = null;

  const base: PublishResult = {
    outcome: "error",
    reason: "",
    snapshot_id: null,
    operation_id: null,
    page_modified_gmt: null,
    pdf_count: 0,
    saw_drift: false,
    duration_ms: 0,
    error: null,
    baseline_source: "none",
    broker_snapshot_id: null,
    heartbeat: "skipped",
    exitCode: 1,
  };
  const finish = (result: Partial<PublishResult>): PublishResult => ({
    ...base,
    baseline_source: baselineSource,
    broker_snapshot_id: brokerSnapshotId,
    ...result,
    duration_ms: now().getTime() - startedMs,
  });

  /**
   * Every completed run reports itself, including the ones that failed before touching a
   * publication route: an FCIM 403, a timeout or a refused redirect has to become a
   * broker-visible failed run, or a laptop that can no longer reach FCIM at all looks exactly
   * like a laptop with nothing to do. A heartbeat that cannot be delivered is logged and
   * nothing more — it never rewrites the outcome of the work that already completed.
   */
  const deliver = async (result: PublishResult): Promise<PublishResult> => {
    if (options.dryRun) return result; // a dry run mutates nothing, here or at the broker
    result.heartbeat = (await sendHeartbeat(broker, config, result)) ? "delivered" : "failed";
    if (result.heartbeat === "failed") {
      log(`heartbeat not delivered; the run stands as ${result.outcome}`);
    }
    return result;
  };

  let detection: DetectionOutcome;
  let operationId: string;
  let resolved: ResolvedBaseline | null = null;
  /** Set only when this run inherited an attempt a previous run left open. */
  let resumedOperationId: string | null = null;
  try {
    const resumed = await resumeDetection(state);
    if (resumed) {
      log("resuming a previously interrupted publication");
      detection = resumed.detection;
      operationId = resumed.operationId;
      resumedOperationId = resumed.operationId;
    } else {
      // A leftover run directory that failed the resume test is not usable state; drop it before
      // anything else so a new attempt cannot inherit half of an old one.
      state.discardRun();

      // The authoritative baseline, read before FCIM is touched at all.
      resolved = await resolveBaseline(broker, state, log);
      baselineSource = resolved.baseline?.origin ?? "none";
      brokerSnapshotId = resolved.current_snapshot_id;
      log(resolved.reason);

      detection = await detectChange(config, transport, state, resolved.baseline, resolved.reason);
      operationId = newOperationId();

      if (!detection.changed) {
        state.clearCache();
        if (resolved.baseline) {
          // Anchored to the snapshot just proven current, with refreshed validators only.
          state.writeLastRun(
            lastRunFrom(
              refreshedAnchoredBaseline(resolved.baseline, detection),
              "unchanged",
              now().toISOString(),
            ),
          );
        }
        log(`unchanged: ${detection.reason}`);
        return await deliver(
          finish({
            outcome: "unchanged",
            reason: detection.reason,
            page_modified_gmt: pageModifiedGmtOf(detection.pageBytes) ?? resolved.baseline?.page_modified_gmt ?? null,
            saw_drift: false,
            exitCode: 0,
          }),
        );
      }
    }
  } catch (err: unknown) {
    state.clearCache();
    const message = (err as Error).message;
    const brokerSide = err instanceof BrokerError;
    const reason = brokerSide ? "broker baseline unavailable" : "upstream check failed";
    log(`${reason}: ${message}`);
    return await deliver(finish({ outcome: "error", reason, error: message, exitCode: 1 }));
  }

  const pageModifiedGmt = pageModifiedGmtOf(detection.pageBytes);

  if (options.dryRun) {
    // A dry run opens no publication, uploads nothing, completes nothing and writes no state or
    // heartbeat. It reads the broker's public pointer and manifest, because a dry run that
    // guessed its baseline would be answering a different question than `publish` does.
    //
    // It also leaves `run/` alone. A resumable attempt is pending work, not scratch: discarding
    // it because the invocation happened to be observation-only would strand an already-open
    // publication and force the next real run to open a second one for the same bytes. Leftover
    // state that fails the resume test is still cleared above, under the same rule a real run
    // uses — this is about not destroying an attempt that is still good.
    state.clearCache();
    log(
      resumedOperationId
        ? `dry run: would resume publication ${resumedOperationId} (${detection.reason})`
        : `dry run: would publish (${detection.reason})`,
    );
    return finish({
      outcome: "dry_run",
      reason: detection.reason,
      operation_id: resumedOperationId,
      page_modified_gmt: pageModifiedGmt,
      saw_drift: true,
      exitCode: 0,
    });
  }

  let attempt: Awaited<ReturnType<typeof attemptPublication>>;
  try {
    attempt = await attemptPublication(
      config, transport, broker, state, detection, operationId, new Date(startedMs).toISOString(), log,
    );
  } catch (err: unknown) {
    if (isUnrecoverable(err)) {
      // Never retried: the broker is telling us its own state disagrees with itself, and another
      // attempt cannot make that true. An operator has to look.
      const message = (err as Error).message;
      log(`fatal: ${message}`);
      state.clearCache();
      return await deliver(finish({
        outcome: "error", reason: "operation_state_corrupt", error: message, exitCode: 1,
        page_modified_gmt: pageModifiedGmt, saw_drift: true, operation_id: operationId,
      }));
    }

    if (!isFreshIdentityRequired(err)) {
      const message = (err as Error).message;
      log(`publication failed: ${message}`);
      state.clearCache();
      return await deliver(finish({
        outcome: "error", reason: "publication failed", error: message, exitCode: 1,
        page_modified_gmt: pageModifiedGmt, saw_drift: true, operation_id: operationId,
      }));
    }

    // The attempt's identity is unusable. Discard it, mint a new one, and try exactly once more.
    log(`attempt identity rejected (${(err as BrokerError).code}); retrying with a new operation id`);
    state.discardRun();
    const retryId = newOperationId();
    try {
      attempt = await attemptPublication(
        config, transport, broker, state, detection, retryId, new Date(startedMs).toISOString(), log,
      );
      operationId = retryId;
    } catch (retryErr: unknown) {
      const message = (retryErr as Error).message;
      log(`retry failed: ${message}`);
      state.clearCache();
      return await deliver(finish({
        outcome: "error", reason: "retry failed", error: message, exitCode: 1,
        page_modified_gmt: pageModifiedGmt, saw_drift: true, operation_id: retryId,
      }));
    }
  }

  const completedAt = now().toISOString();
  const outcome = attempt.completeStatus === "superseded" ? "superseded" : "published";
  state.discardRun();
  state.clearCache();

  // The freshness baseline is re-derived from the broker, never from what this run observed.
  // A superseded attempt has no claim on it at all: the snapshot it built is not the one being
  // served, so the cache is refreshed from whatever *is* — which is what makes the next run see
  // the drift it still has to publish.
  const refreshed = await refreshCacheFromBroker(
    broker,
    state,
    outcome,
    completedAt,
    outcome === "superseded" ? null : attempt.plan.snapshot_id,
    log,
  );
  brokerSnapshotId = refreshed.broker_snapshot_id;

  return await deliver(finish({
    outcome,
    reason: detection.reason,
    snapshot_id: attempt.plan.snapshot_id,
    operation_id: operationId,
    page_modified_gmt: pageModifiedGmt,
    pdf_count: attempt.plan.files.length,
    saw_drift: true,
    exitCode: 0,
  }));
}

/**
 * Detection only. Read-only at the broker, not broker-free: it GETs the current pointer and that
 * snapshot's manifest and page payload, because that is what "unchanged" even means here. It
 * mutates nothing — no publication, no upload, no accepted state, no heartbeat — writes no
 * baseline, and leaves `run/` untouched; only the disposable body cache is cleared. When the
 * broker cannot be read the answer is "cannot prove unchanged", never "unchanged".
 */
export async function runCheck(
  config: PublisherConfig,
  transport: Transport,
  options: RunOptions = {},
): Promise<PublishResult> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const startedMs = now().getTime();
  const state = new StateStore(config.stateDir);
  const broker = new BrokerClient(config, transport);

  let resolved: ResolvedBaseline;
  try {
    resolved = await resolveBaseline(broker, state, log);
  } catch (err: unknown) {
    const message = (err as Error).message;
    log(`broker baseline unavailable: ${message}`);
    resolved = {
      baseline: null,
      current_snapshot_id: null,
      reason: `the broker baseline could not be read (${message}); nothing can be proven unchanged`,
    };
  }

  try {
    const detection = await detectChange(config, transport, state, resolved.baseline, resolved.reason);
    state.clearCache();
    log(detection.changed ? `changed: ${detection.reason}` : `unchanged: ${detection.reason}`);
    return {
      outcome: detection.changed ? "dry_run" : "unchanged",
      reason: detection.reason,
      snapshot_id: null,
      operation_id: null,
      page_modified_gmt: pageModifiedGmtOf(detection.pageBytes),
      pdf_count: 0,
      saw_drift: detection.changed,
      duration_ms: now().getTime() - startedMs,
      error: null,
      baseline_source: resolved.baseline?.origin ?? "none",
      broker_snapshot_id: resolved.current_snapshot_id,
      heartbeat: "skipped",
      exitCode: 0,
    };
  } catch (err: unknown) {
    state.clearCache();
    const message = (err as Error).message;
    log(`upstream check failed: ${message}`);
    return {
      outcome: "error", reason: "upstream check failed", snapshot_id: null, operation_id: null,
      page_modified_gmt: null, pdf_count: 0, saw_drift: false,
      duration_ms: now().getTime() - startedMs, error: message,
      baseline_source: resolved.baseline?.origin ?? "none",
      broker_snapshot_id: resolved.current_snapshot_id,
      heartbeat: "skipped", exitCode: 1,
    };
  }
}

export async function sendHeartbeat(
  broker: BrokerClient,
  config: PublisherConfig,
  result: PublishResult,
): Promise<boolean> {
  return broker.heartbeat({
    schema_version: 1,
    client_reported_at: new Date().toISOString(),
    status: result.outcome === "error" ? "error" : "ok",
    outcome: result.outcome,
    operation_id: result.operation_id,
    snapshot_id: result.snapshot_id,
    page_modified_gmt: result.page_modified_gmt,
    pdf_count: result.pdf_count,
    saw_drift: result.saw_drift,
    duration_ms: result.duration_ms,
    error: result.error,
    logon_model: config.logonModel,
    publisher_version: config.version,
  });
}
