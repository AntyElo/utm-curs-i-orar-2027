/**
 * Local run state.
 *
 * None of this is required for correctness — the broker refuses anything unsafe regardless of
 * what the laptop believes, and freshness is decided against the snapshot `current.json` names,
 * never against this directory. State exists so an interrupted run can resume the *same*
 * publication instead of opening a second one, and so a genuinely unchanged upstream can be a
 * cheap no-op instead of three broker reads.
 *
 * `state/last-run.json` is therefore a cache, and it carries the id of the broker snapshot it
 * describes so that a reader can tell whether it still means anything (see `baseline.ts`). A
 * record from an older schema is simply not readable: an unanchored baseline that looked
 * authoritative is precisely the failure this shape exists to prevent.
 *
 * Resume is deliberately strict: an attempt is resumable only when the operation record, the
 * saved page payload and that payload's hash all agree. Anything less is discarded and a fresh
 * operation id is minted, because a half-remembered attempt is exactly how two different page
 * payloads would end up sharing one identity.
 */

import fs from "node:fs";
import path from "node:path";

import { sha256File, sha256Hex } from "./hash";
import type { LastRunState, OperationState, RecordedPdf } from "./types";

export class StateStore {
  readonly root: string;

  constructor(stateDir: string) {
    this.root = stateDir;
  }

  get runDir(): string {
    return path.join(this.root, "run");
  }

  get tmpDir(): string {
    return path.join(this.runDir, "tmp");
  }

  /**
   * Bodies downloaded while deciding whether anything changed.
   *
   * Deliberately outside `run/`: opening a publication wipes the run directory, and a body that
   * was already fetched during change detection should be uploaded rather than fetched twice.
   */
  get cacheDir(): string {
    return path.join(this.root, "cache");
  }

  get operationFile(): string {
    return path.join(this.runDir, "operation.json");
  }

  get pageFile(): string {
    return path.join(this.runDir, "page.json");
  }

  get lastRunFile(): string {
    return path.join(this.root, "state", "last-run.json");
  }

  ensureDirs(): void {
    fs.mkdirSync(this.tmpDir, { recursive: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(path.dirname(this.lastRunFile), { recursive: true });
  }

  writable(): boolean {
    try {
      this.ensureDirs();
      const probe = path.join(this.runDir, ".write-probe");
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  readLastRun(): LastRunState | null {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.lastRunFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const state = parsed as LastRunState;
      if (state.schema_version !== 2 || typeof state.page_api_sha256 !== "string") return null;
      // A cache that does not say which broker snapshot it describes cannot be anchored to one,
      // so it is unusable by construction rather than merely suspect.
      if (typeof state.broker_snapshot_id !== "string" || !state.broker_snapshot_id) return null;
      if (!Array.isArray(state.pdfs)) return null;
      const pdfs: RecordedPdf[] = [];
      for (const pdf of state.pdfs) {
        if (!pdf || typeof pdf !== "object") return null;
        if (typeof pdf.source_url !== "string" || typeof pdf.sha256 !== "string") return null;
        pdfs.push({
          source_url: pdf.source_url,
          etag: typeof pdf.etag === "string" ? pdf.etag : null,
          last_modified: typeof pdf.last_modified === "string" ? pdf.last_modified : null,
          sha256: pdf.sha256,
        });
      }
      return { ...state, pdfs };
    } catch {
      return null;
    }
  }

  writeLastRun(state: LastRunState): void {
    this.ensureDirs();
    writeFileAtomic(this.lastRunFile, JSON.stringify(state, null, 2));
  }

  /**
   * Drop the cached baseline.
   *
   * Always safe: the next run rebuilds it from the broker's own current snapshot. Used whenever
   * the cache cannot be proven to describe what the broker is serving.
   */
  clearLastRun(): void {
    fs.rmSync(this.lastRunFile, { force: true });
  }

  /**
   * Recover the in-flight attempt, if and only if every part of it still agrees.
   *
   * `sha256(page.json)` must equal the hash recorded in `operation.json`; otherwise the saved
   * bytes are not the bytes that attempt was opened with, and resuming would send an operation id
   * bound to a different payload — which the broker refuses anyway, with a wasted round trip.
   */
  readResumableOperation(): { operation: OperationState; pageBytes: Uint8Array } | null {
    let operation: OperationState;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.operationFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      operation = parsed as OperationState;
    } catch {
      return null;
    }
    if (
      operation.schema_version !== 1 ||
      typeof operation.operation_id !== "string" ||
      typeof operation.page_api_sha256 !== "string"
    ) {
      return null;
    }

    let pageBytes: Buffer;
    try {
      pageBytes = fs.readFileSync(this.pageFile);
    } catch {
      return null;
    }

    if (sha256Hex(pageBytes) !== operation.page_api_sha256) return null;
    return { operation, pageBytes: new Uint8Array(pageBytes) };
  }

  startOperation(operation: OperationState, pageBytes: Uint8Array): void {
    this.discardRun();
    this.ensureDirs();
    fs.writeFileSync(this.pageFile, pageBytes);
    writeFileAtomic(this.operationFile, JSON.stringify(operation, null, 2));
  }

  updateOperation(operation: OperationState): void {
    writeFileAtomic(this.operationFile, JSON.stringify(operation, null, 2));
  }

  /** Remove everything about the current attempt, including any temporary PDF bodies. */
  discardRun(): void {
    fs.rmSync(this.runDir, { recursive: true, force: true });
  }

  /** Stable per-URL path for a body fetched during change detection. */
  cachePathFor(token: string): string {
    this.ensureDirs();
    return path.join(this.cacheDir, `${sha256Hex(Buffer.from(token, "utf8")).slice(0, 32)}.pdf`);
  }

  /** Per-file path for a body fetched while a publication is open. */
  runTempPathFor(fileId: string): string {
    this.ensureDirs();
    return path.join(this.tmpDir, `${fileId}.pdf`);
  }

  clearCache(): void {
    fs.rmSync(this.cacheDir, { recursive: true, force: true });
  }

  removeTemp(filePath: string): void {
    fs.rmSync(filePath, { force: true });
  }

  async hashTemp(filePath: string): Promise<string> {
    return sha256File(filePath);
  }
}

/** Write via a sibling temp file so an interrupted write never leaves a half-parsed document. */
function writeFileAtomic(target: string, contents: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, contents);
  fs.renameSync(temp, target);
}
