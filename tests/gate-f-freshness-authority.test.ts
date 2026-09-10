/**
 * Gate F: the freshness baseline is the broker's, not the laptop's.
 *
 * These are the regressions for the two ways a transport-only publisher can quietly stop
 * publishing while believing it is up to date:
 *
 *   GF-T01  a publication that loses the `current.json` CAS is recorded as if it had won, so the
 *           laptop sees FCIM matching its own memory and never republishes;
 *   GF-T02  a resumed publication re-downloads a file the broker already stores, and records the
 *           *newer* bytes it just saw as the state of the *older* snapshot it just closed.
 *
 * Both end the same way — `unchanged` forever while the broker serves something else — and both
 * are prevented by the same rule: freshness is only ever compared against, and only ever recorded
 * from, the snapshot `current.json` names.
 *
 * Every test drives the real publisher against the real broker Worker in process. No test
 * contacts FCIM.
 */

import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPublish } from "../tools/md-publisher/src/publish";
import { StateStore } from "../tools/md-publisher/src/state";
import type { PublisherConfig } from "../tools/md-publisher/src/types";
import {
  createTestTransport,
  FAKE_BROKER_ORIGIN,
  type FcimScript,
  type ScriptedResponse,
} from "./helpers/md-publisher-transport";
import { pagePayload, pdfBody, publishThroughApi, sha256Hex, UPLOAD_BASE } from "./helpers/md-publication";
import { createHarness, TEST_PUBLISHER_TOKEN, type WorkerHarness } from "./helpers/worker-doubles";

const FILE_A = "anul_i_semestrul_i-19.pdf";
const FILE_B = "anul_ii_semestrul_iii-13.pdf";
const PDF_A = `${UPLOAD_BASE}/${FILE_A}`;
const PDF_B = `${UPLOAD_BASE}/${FILE_B}`;

/** One page, one PDF: enough to exercise every rule below without extra bookkeeping. */
const ONE_PDF_PAGE = pagePayload({ filenames: [FILE_A] });
const TWO_PDF_PAGE = pagePayload({ filenames: [FILE_A, FILE_B] });

function ok(body: Uint8Array | string, headers: Record<string, string> = {}): ScriptedResponse {
  return { status: 200, body, headers };
}

/** An FCIM that serves one fixed revision of the page and of every PDF, with ETags. */
function fcimServing(
  page: string,
  bodies: Record<string, { body: Uint8Array; etag: string }>,
): FcimScript {
  return {
    page: (headers) =>
      headers["If-None-Match"] === '"page-1"'
        ? { status: 304, headers: { etag: '"page-1"' } }
        : ok(page, { etag: '"page-1"', "content-type": "application/json" }),
    pdf: (url, headers) => {
      const entry = bodies[url];
      if (!entry) return { status: 404 };
      return headers["If-None-Match"] === entry.etag
        ? { status: 304, headers: { etag: entry.etag } }
        : ok(entry.body, { etag: entry.etag, "content-type": "application/pdf" });
    },
  };
}

function storedPdf(harness: WorkerHarness, snapshotId: string, filename: string): Uint8Array | null {
  return harness.bucket.bytes(`snapshots/${snapshotId}/pdfs/${filename}`);
}

function currentSnapshotId(harness: WorkerHarness): string | null {
  return harness.bucket.json<{ snapshot_id: string }>("current.json")?.snapshot_id ?? null;
}

describe("Gate F: the broker's current snapshot is the only freshness baseline", () => {
  let stateDir: string;
  let broker: WorkerHarness;
  let config: PublisherConfig;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "md-publisher-freshness-"));
    broker = createHarness();
    config = {
      brokerUrl: FAKE_BROKER_ORIGIN,
      token: TEST_PUBLISHER_TOKEN,
      stateDir,
      timeoutMs: 5_000,
      logonModel: "Interactive",
      version: "1.0.0",
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(stateDir, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------- *
   * GF-T01: the superseded-baseline wedge
   * ---------------------------------------------------------------- */

  it("GF-T01: converges after a superseded publication instead of wedging on unchanged", async () => {
    const bodyB = pdfBody("revision-B");
    const bodyC = pdfBody("revision-C");
    const fcim = fcimServing(ONE_PDF_PAGE, { [PDF_A]: { body: bodyB, etag: '"b-etag"' } });

    // Broker current = A.
    const publicationA = await publishThroughApi(broker, {
      page: ONE_PDF_PAGE,
      body: pdfBody("revision-A"),
      observedEtag: '"a-etag"',
    });
    expect(publicationA.completeBody.status).toBe("published");
    const snapshotA = publicationA.snapshotId;
    expect(currentSnapshotId(broker)).toBe(snapshotA);

    // The publisher observes FCIM revision B and opens a publication for it. While that
    // publication is still uploading, an unrelated publication C wins the pointer.
    let snapshotC: string | null = null;
    const wedged = createTestTransport(broker, fcim, {
      interceptBroker: async (request, forward) => {
        const response = await forward();
        if (request.method === "POST" && request.path === "/publications") {
          const rival = await publishThroughApi(broker, {
            page: ONE_PDF_PAGE,
            body: bodyC,
            observedEtag: '"c-etag"',
          });
          expect(rival.completeBody.status).toBe("published");
          snapshotC = rival.snapshotId;
        }
        return response;
      },
    });

    const superseded = await runPublish(config, wedged.transport);
    expect(superseded.outcome).toBe("superseded");
    expect(superseded.exitCode).toBe(0);
    // A losing attempt is a normal outcome, and it still reports itself (GF-A04).
    expect(superseded.heartbeat).toBe("delivered");
    const beat = JSON.parse(broker.bucket.text("publisher/heartbeat.json")!) as Record<string, unknown>;
    expect(beat.outcome).toBe("superseded");
    expect(beat.status).toBe("ok");
    const snapshotB = superseded.snapshot_id!;
    expect(currentSnapshotId(broker)).toBe(snapshotC);
    expect(snapshotB).not.toBe(snapshotC);

    // The wedge, refused: the attempt that lost the race left no claim on the baseline. What is
    // cached describes the snapshot the broker is actually serving — C, holding revision C.
    const state = new StateStore(stateDir);
    const cached = state.readLastRun();
    expect(cached?.broker_snapshot_id ?? null).not.toBe(snapshotB);
    if (cached) {
      expect(cached.broker_snapshot_id).toBe(snapshotC);
      const manifestC = broker.bucket.json<{ files: { content_sha256: string }[] }>(
        `snapshots/${snapshotC!}/manifest.json`,
      )!;
      expect(cached.pdfs[0].sha256).toBe(manifestC.files[0].content_sha256);
    }

    // FCIM has not moved: it still serves revision B. The next run must therefore see drift
    // against broker current C and converge the broker toward what FCIM actually publishes.
    const converging = createTestTransport(broker, fcim);
    const converged = await runPublish(config, converging.transport);

    expect(converged.outcome).toBe("published");
    expect(converged.broker_snapshot_id).toBe(converged.snapshot_id);
    expect(currentSnapshotId(broker)).toBe(converged.snapshot_id);
    expect(storedPdf(broker, converged.snapshot_id!, FILE_A)).toEqual(bodyB);

    // Only now, with FCIM and broker current genuinely agreeing, is `unchanged` the honest answer.
    const settled = createTestTransport(broker, fcim);
    const quiet = await runPublish(config, settled.transport);
    expect(quiet.outcome).toBe("unchanged");
    expect(quiet.broker_snapshot_id).toBe(converged.snapshot_id);
    expect(currentSnapshotId(broker)).toBe(converged.snapshot_id);
  });

  it("GF-T01: never reports unchanged from a local baseline the broker does not represent", async () => {
    const bodyB = pdfBody("revision-B");
    const fcim = fcimServing(ONE_PDF_PAGE, { [PDF_A]: { body: bodyB, etag: '"b-etag"' } });

    // Broker current holds revision A.
    await publishThroughApi(broker, { page: ONE_PDF_PAGE, body: pdfBody("revision-A") });
    const snapshotA = currentSnapshotId(broker)!;

    // A laptop that believes it already published revision B: the exact state the superseded
    // wedge used to leave behind, written here directly so the claim is unambiguous.
    const state = new StateStore(stateDir);
    const bHash = await sha256Hex(bodyB);
    state.writeLastRun({
      schema_version: 2,
      broker_snapshot_id: "2026-09-08T12-00-00-000Z-deadbeef",
      page_etag: '"page-1"',
      page_last_modified: null,
      page_api_sha256: "0".repeat(64),
      page_modified_gmt: "2026-09-08T12:57:59",
      pdfs: [{ source_url: PDF_A, etag: '"b-etag"', last_modified: null, sha256: bHash }],
      outcome: "superseded",
      completed_at: new Date().toISOString(),
    });

    const { transport } = createTestTransport(broker, fcim);
    const result = await runPublish(config, transport, { log: () => {} });

    // FCIM matches the local record exactly, and it is still not "unchanged": the record
    // describes a snapshot the broker has never served.
    expect(result.outcome).toBe("published");
    expect(result.baseline_source).toBe("broker_snapshot");
    expect(result.snapshot_id).not.toBe(snapshotA);
    expect(currentSnapshotId(broker)).toBe(result.snapshot_id);
    expect(storedPdf(broker, result.snapshot_id!, FILE_A)).toEqual(bodyB);
  });

  it("rebuilds the baseline from the broker when the local state directory is deleted", async () => {
    const bodyA = pdfBody("revision-A");
    const fcim = fcimServing(ONE_PDF_PAGE, { [PDF_A]: { body: bodyA, etag: '"a-etag"' } });

    const first = createTestTransport(broker, fcim);
    const published = await runPublish(config, first.transport);
    expect(published.outcome).toBe("published");

    // A fresh clone, or the same laptop after someone cleared %LOCALAPPDATA%.
    fs.rmSync(stateDir, { recursive: true, force: true });

    const second = createTestTransport(broker, fcim);
    const result = await runPublish(config, second.transport);

    // Freshness survived the loss of every local byte: the broker's own manifest supplied it.
    expect(result.outcome).toBe("unchanged");
    expect(result.baseline_source).toBe("broker_snapshot");
    expect(result.broker_snapshot_id).toBe(published.snapshot_id);
    expect(currentSnapshotId(broker)).toBe(published.snapshot_id);
  });

  it("cannot read a pre-anchor baseline file at all", async () => {
    const bodyA = pdfBody("revision-A");
    const fcim = fcimServing(ONE_PDF_PAGE, { [PDF_A]: { body: bodyA, etag: '"a-etag"' } });

    await publishThroughApi(broker, { page: ONE_PDF_PAGE, body: bodyA, observedEtag: '"a-etag"' });

    // The shape the publisher used to write: a freshness baseline with no idea which broker
    // snapshot it describes. It is unreadable by construction rather than merely distrusted.
    const state = new StateStore(stateDir);
    fs.mkdirSync(path.dirname(state.lastRunFile), { recursive: true });
    fs.writeFileSync(
      state.lastRunFile,
      JSON.stringify({
        schema_version: 1,
        page_etag: '"page-1"',
        page_last_modified: null,
        page_api_sha256: await sha256Hex(new TextEncoder().encode(ONE_PDF_PAGE)),
        page_modified_gmt: "2026-09-08T12:57:59",
        pdfs: [{ source_url: PDF_A, etag: '"a-etag"', last_modified: null, sha256: await sha256Hex(bodyA) }],
        snapshot_id: currentSnapshotId(broker),
        outcome: "published",
        completed_at: new Date().toISOString(),
      }),
    );
    expect(state.readLastRun()).toBeNull();

    // The run still answers correctly, because it rebuilds from the broker rather than the file.
    const { transport } = createTestTransport(broker, fcim);
    const result = await runPublish(config, transport);
    expect(result.outcome).toBe("unchanged");
    expect(result.baseline_source).toBe("broker_snapshot");
    // ...and it leaves a readable, anchored record behind.
    expect(state.readLastRun()!.broker_snapshot_id).toBe(currentSnapshotId(broker));
  });

  it("publishes rather than guessing when the current snapshot records no digests", async () => {
    const bodyA = pdfBody("revision-A");
    const fcim = fcimServing(ONE_PDF_PAGE, { [PDF_A]: { body: bodyA, etag: '"a-etag"' } });

    const seeded = await publishThroughApi(broker, {
      page: ONE_PDF_PAGE,
      body: bodyA,
      observedEtag: '"a-etag"',
    });

    // A snapshot published before content digests were recorded — what a pre-Gate-F pointer looks
    // like on the morning of the cutover.
    const manifestKey = `snapshots/${seeded.snapshotId}/manifest.json`;
    const manifest = broker.bucket.json<Record<string, unknown>>(manifestKey)!;
    manifest.files = (manifest.files as Record<string, unknown>[]).map((file) => ({
      ...file,
      content_sha256: null,
    }));
    broker.bucket.seed(manifestKey, JSON.stringify(manifest));

    // FCIM matches those bytes exactly, and it is still not "unchanged": nothing in that snapshot
    // can prove it. One publication later the broker holds a snapshot that can.
    const { transport } = createTestTransport(broker, fcim);
    const result = await runPublish(config, transport);
    expect(result.outcome).toBe("published");
    expect(result.baseline_source).toBe("none");
    expect(result.reason).toMatch(/no usable manifest baseline/);

    const settled = createTestTransport(broker, fcim);
    expect((await runPublish(config, settled.transport)).outcome).toBe("unchanged");
  });

  /* ---------------------------------------------------------------- *
   * GF-T02: resume across an upstream change
   * ---------------------------------------------------------------- */

  it("GF-T02: a resumed publication never records bytes the broker did not store", async () => {
    const bodyX = pdfBody("revision-X");
    const bodyY = pdfBody("revision-Y");
    const otherBody = pdfBody("other");

    const servingX = fcimServing(TWO_PDF_PAGE, {
      [PDF_A]: { body: bodyX, etag: '"x-etag"' },
      [PDF_B]: { body: otherBody, etag: '"other-etag"' },
    });
    const servingY = fcimServing(TWO_PDF_PAGE, {
      [PDF_A]: { body: bodyY, etag: '"y-etag"' },
      [PDF_B]: { body: otherBody, etag: '"other-etag"' },
    });

    // A publication opens with X, stores X, and is interrupted before it can complete.
    const interrupted = createTestTransport(broker, servingX, {
      interceptUpload: async (request, forward) => {
        if (request.path.endsWith("/f1")) throw new Error("connection reset mid-upload");
        return forward();
      },
    });
    expect((await runPublish(config, interrupted.transport)).outcome).toBe("error");

    const state = new StateStore(stateDir);
    const resumable = state.readResumableOperation()!;
    const openSnapshot = resumable.operation.snapshot_id!;
    expect(broker.bucket.has(`snapshots/${openSnapshot}/pdfs/${FILE_A}`)).toBe(true);
    expect(state.readLastRun()).toBeNull();

    // FCIM now replaces that PDF in place, under the same URL, while the publication is open.
    const resumeTransport = createTestTransport(broker, servingY);
    const resumed = await runPublish(config, resumeTransport.transport);

    expect(resumed.outcome).toBe("published");
    expect(resumed.snapshot_id).toBe(openSnapshot);

    // The stored file is still X: the broker never accepted different bytes under that key.
    expect(storedPdf(broker, openSnapshot, FILE_A)).toEqual(bodyX);
    // And it was not re-downloaded, so no observation of Y was even made for it.
    expect(resumeTransport.log.fcim.map((call) => call.url)).not.toContain(PDF_A);

    // The cached baseline describes the snapshot as the broker actually holds it — X, not the Y
    // that FCIM was serving while the resume ran.
    const manifest = broker.bucket.json<{ files: { source_url: string; content_sha256: string }[] }>(
      `snapshots/${openSnapshot}/manifest.json`,
    )!;
    const cached = state.readLastRun()!;
    expect(cached.broker_snapshot_id).toBe(openSnapshot);
    const recordedA = cached.pdfs.find((pdf) => pdf.source_url === PDF_A)!;
    const storedA = manifest.files.find((file) => file.source_url === PDF_A)!;
    expect(recordedA.sha256).toBe(storedA.content_sha256);

    // So the very next run sees that the broker's snapshot disagrees with live FCIM, and Y gets
    // published into a snapshot of its own.
    const followUp = createTestTransport(broker, servingY);
    const converged = await runPublish(config, followUp.transport);

    expect(converged.outcome).toBe("published");
    expect(converged.snapshot_id).not.toBe(openSnapshot);
    expect(currentSnapshotId(broker)).toBe(converged.snapshot_id);
    expect(storedPdf(broker, converged.snapshot_id!, FILE_A)).toEqual(bodyY);

    // FCIM and the broker now agree, and only now does the publisher go quiet.
    const settled = createTestTransport(broker, servingY);
    expect((await runPublish(config, settled.transport)).outcome).toBe("unchanged");
  });

  it("GF-T02: an interrupted run leaves the freshness baseline exactly where it was", async () => {
    const bodyX = pdfBody("revision-X");
    const otherBody = pdfBody("other");
    const serving = (a: Uint8Array, etag: string) =>
      fcimServing(TWO_PDF_PAGE, {
        [PDF_A]: { body: a, etag },
        [PDF_B]: { body: otherBody, etag: '"other-etag"' },
      });

    const first = createTestTransport(broker, serving(bodyX, '"x-etag"'));
    const published = await runPublish(config, first.transport);
    expect(published.outcome).toBe("published");

    const state = new StateStore(stateDir);
    const before = fs.readFileSync(state.lastRunFile, "utf8");

    // A later run fails part-way through publishing a new revision.
    const failing = createTestTransport(broker, serving(pdfBody("revision-Y"), '"y-etag"'), {
      interceptUpload: async () => {
        throw new Error("connection reset mid-upload");
      },
    });
    const failed = await runPublish(config, failing.transport);
    expect(failed.outcome).toBe("error");

    // A failed run never advances the baseline, so it can never be the reason a later run
    // reports "unchanged".
    expect(fs.readFileSync(state.lastRunFile, "utf8")).toBe(before);
    expect(currentSnapshotId(broker)).toBe(published.snapshot_id);
  });

  /* ---------------------------------------------------------------- *
   * GF-A04: every completed run is visible to the broker
   * ---------------------------------------------------------------- */

  it("GF-A04: refreshes the heartbeat on an unchanged run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const fcim = fcimServing(ONE_PDF_PAGE, { [PDF_A]: { body: pdfBody("only"), etag: '"a-etag"' } });

      const first = createTestTransport(broker, fcim);
      expect((await runPublish(config, first.transport)).outcome).toBe("published");
      const afterPublish = JSON.parse(broker.bucket.text("publisher/heartbeat.json")!) as {
        received_at: string;
        outcome: string;
      };
      expect(afterPublish.outcome).toBe("published");

      vi.setSystemTime(Date.now() + 20 * 60 * 1000);
      const second = createTestTransport(broker, fcim);
      const unchanged = await runPublish(config, second.transport);
      expect(unchanged.outcome).toBe("unchanged");
      expect(unchanged.heartbeat).toBe("delivered");

      // A quiet run is still a run: `received_at` moves, so a stale heartbeat means a stalled
      // laptop rather than a calm upstream.
      const afterUnchanged = JSON.parse(broker.bucket.text("publisher/heartbeat.json")!) as {
        received_at: string;
        outcome: string;
        status: string;
        saw_drift: boolean;
      };
      expect(afterUnchanged.outcome).toBe("unchanged");
      expect(afterUnchanged.status).toBe("ok");
      expect(afterUnchanged.saw_drift).toBe(false);
      expect(Date.parse(afterUnchanged.received_at)).toBeGreaterThan(Date.parse(afterPublish.received_at));
    } finally {
      vi.useRealTimers();
    }
  });

  it("GF-A04: reports a refused redirect and a broker outage as failed runs, not as quiet ones", async () => {
    const redirecting = createTestTransport(broker, {
      page: () => ({ status: 302, headers: { location: "https://evil.example/page" } }),
      pdf: () => ({ status: 200, body: pdfBody() }),
    });
    const refused = await runPublish(config, redirecting.transport);
    expect(refused.outcome).toBe("error");
    expect(refused.heartbeat).toBe("delivered");
    expect(JSON.parse(broker.bucket.text("publisher/heartbeat.json")!).error).toMatch(/redirect/i);

    // And when the broker itself cannot answer, the run still fails rather than going quiet —
    // it simply has nowhere to report it.
    const brokerDown = createTestTransport(
      broker,
      fcimServing(ONE_PDF_PAGE, { [PDF_A]: { body: pdfBody("only"), etag: '"a-etag"' } }),
      {
        interceptBroker: async () => {
          throw new Error("socket hang up");
        },
      },
    );
    const lines: string[] = [];
    const unreachable = await runPublish(config, brokerDown.transport, { log: (line) => lines.push(line) });
    expect(unreachable.outcome).toBe("error");
    expect(unreachable.reason).toBe("upstream check failed");
    expect(unreachable.error).toMatch(/socket hang up/);
    expect(unreachable.heartbeat).toBe("failed");
    expect(lines.join("\n")).toMatch(/heartbeat not delivered/);
  });

  it("GF-A04: a lost heartbeat never turns a completed publication into a failure", async () => {
    const bodyA = pdfBody("only");
    const { transport } = createTestTransport(
      broker,
      fcimServing(ONE_PDF_PAGE, { [PDF_A]: { body: bodyA, etag: '"a-etag"' } }),
      {
        interceptBroker: async (request, forward) => {
          if (request.path === "/publisher/heartbeat") throw new Error("timeout writing heartbeat");
          return forward();
        },
      },
    );

    const lines: string[] = [];
    const result = await runPublish(config, transport, { log: (line) => lines.push(line) });

    expect(result.outcome).toBe("published");
    expect(result.exitCode).toBe(0);
    expect(result.heartbeat).toBe("failed");
    expect(lines.join("\n")).toMatch(/heartbeat not delivered; the run stands as published/);

    // The publication itself is intact and complete.
    expect(currentSnapshotId(broker)).toBe(result.snapshot_id);
    expect(storedPdf(broker, result.snapshot_id!, FILE_A)).toEqual(bodyA);
    // And the next run still knows it is up to date.
    const second = createTestTransport(
      broker,
      fcimServing(ONE_PDF_PAGE, { [PDF_A]: { body: bodyA, etag: '"a-etag"' } }),
    );
    expect((await runPublish(config, second.transport)).outcome).toBe("unchanged");
  });
});
