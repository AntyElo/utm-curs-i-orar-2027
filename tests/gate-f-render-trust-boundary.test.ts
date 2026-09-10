/**
 * Gate F: the seam between the MD Publisher and Render.
 *
 * These tests run the real broker Worker and the real Render updater against each other. Render's
 * global `fetch` is pointed at the Worker's own routing, and candidate bytes are published the way
 * the Moldova laptop publishes them, so nothing here is a stub of the thing under test.
 *
 * Two properties are load-bearing:
 *
 *  DF-02  A publisher-observed HTTP validator must never reach Render's trusted ETag fast-path.
 *         Render may skip a download only on evidence the *broker* vouches for; a laptop that
 *         claims "ETag unchanged" while shipping different bytes must not be able to freeze the
 *         timetable Render serves.
 *
 *  GF-H01 Automatic recovery from a publisher-credential compromise is guaranteed only while the
 *         poisoned candidate has not become durable accepted state. Once it has, clearing local
 *         Render state re-synchronises the poisoned durable state instead of recovering from it.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "@/lib/config";
import { parsePdf, sha256 } from "@/lib/parser";
import { bootstrapScheduleState, checkForUpdates } from "@/lib/services/updater";
import {
  getCurrentSchedule,
  replaceCurrentSchedule,
  resetStorageCache,
  saveSourceState,
} from "@/lib/storage";
import type { AcceptedPointer } from "@/lib/models";

import worker from "../worker/src/index";
import { publishThroughApi } from "./helpers/md-publication";
import { createHarness, type WorkerHarness } from "./helpers/worker-doubles";

const BROKER_ORIGIN = "https://broker.fcim.internal";
const UPLOAD_BASE = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09";
const COURSE_1_URL = `${UPLOAD_BASE}/anul_i_semestrul_i-18.pdf`;

/** The Render-side page payload shape `discoverPdf()` understands. */
function renderPagePayload(modifiedGmt = "2026-09-08T12:57:59"): string {
  return JSON.stringify([
    {
      id: 1739,
      modified_gmt: modifiedGmt,
      content: {
        rendered: `
          <section>
            <h2>Ciclul I, Licență - învățământ cu frecvență</h2>
            <table>
              <tr>
                <td>Orarul semestrul de toamna 2026/2027</td>
                <td><a href="${COURSE_1_URL}">Anul I</a></td>
              </tr>
            </table>
          </section>
        `,
      },
    },
  ]);
}

describe("Gate F: Render trust boundary and compromise recovery", () => {
  let tempDir: string;
  let broker: WorkerHarness;
  let genuineBytes: Uint8Array;
  let poisonedBytes: Uint8Array;
  let genuineHash: string;
  let poisonedHash: string;
  let brokerRequests: string[];

  const originalBrokerUrl = config.brokerUrl;
  const originalBrokerSecret = config.brokerSecret;
  const originalDataDir = config.dataDir;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "fcim-gate-f-"));
    (config as { dataDir: string }).dataDir = tempDir;
    (config as { brokerUrl: string }).brokerUrl = BROKER_ORIGIN;
    (config as { brokerSecret: string }).brokerSecret = "test-secret";
    resetStorageCache();

    genuineBytes = new Uint8Array(
      await readFile(path.join(__dirname, "..", "data", "seed", "anul_i_semestrul_i-18.pdf")),
    );
    poisonedBytes = new Uint8Array(
      await readFile(path.join(__dirname, "fixtures", "anul_i_semestrul_i-9.pdf")),
    );
    genuineHash = sha256(genuineBytes);
    poisonedHash = sha256(poisonedBytes);

    broker = createHarness();
    brokerRequests = [];

    // Render talks to the real Worker. Anything else is an unexpected outbound call.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(BROKER_ORIGIN)) {
        throw new Error(`Render must only talk to the broker in this suite: ${url}`);
      }
      brokerRequests.push(url.slice(BROKER_ORIGIN.length));
      const request = input instanceof Request && init === undefined ? input : new Request(url, init);
      return worker.fetch(request, broker.env, broker.ctx);
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    (config as { dataDir: string }).dataDir = originalDataDir;
    (config as { brokerUrl: string }).brokerUrl = originalBrokerUrl;
    (config as { brokerSecret: string }).brokerSecret = originalBrokerSecret;
    resetStorageCache();
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Publish one candidate through the publisher API, exactly as the laptop would. */
  async function publish(bytes: Uint8Array, observedEtag?: string): Promise<string> {
    const result = await publishThroughApi(broker, {
      page: renderPagePayload(),
      bodies: { "anul_i_semestrul_i-18.pdf": bytes },
      observedEtag,
    });
    expect(result.completeBody.status).toBe("published");
    return result.snapshotId;
  }

  /** Seed Render's local state as if it had already accepted `bytes` under `etag`. */
  async function seedLocal(bytes: Uint8Array, etag: string | null): Promise<void> {
    const { schedule } = await parsePdf(bytes, {
      source_page_url: "https://fcim.utm.md/procesul-de-studii/orar/",
      source_pdf_url: COURSE_1_URL,
      source_kind: "live",
      source_transport: "broker",
      source_snapshot_id: "2026-09-08T02-08-48-000Z-7a3b4c19",
      downloaded_at: "2026-09-08T02:00:00.000Z",
      course_year: 1,
      etag,
    });
    schedule.metadata.parser_version = config.parserVersion;
    await replaceCurrentSchedule(1, schedule);
    await saveSourceState(1, {
      current_pdf_url: COURSE_1_URL,
      current_pdf_hash: schedule.metadata.source_pdf_hash,
      etag,
      last_result: "updated",
    });
  }

  function candidateDownloads(): string[] {
    return brokerRequests.filter((request) => request.includes("/pdfs/"));
  }

  /* ---------------------------------------------------------------- *
   * DF-02
   * ---------------------------------------------------------------- */

  it("downloads and applies changed candidate bytes even when the publisher-observed ETag matches Render's own", async () => {
    // Render currently holds revision 9 and remembers the ETag it saw with it.
    await seedLocal(poisonedBytes, '"frozen-etag"');

    // A compromised publisher ships different bytes while claiming Render's exact current ETag.
    await publish(genuineBytes, '"frozen-etag"');

    const result = await checkForUpdates(1);

    // The claim buys nothing: the manifest's trusted validators are null, so Render downloads.
    expect(candidateDownloads().length).toBeGreaterThan(0);
    expect(result.outcome).toBe("updated");
    expect(result.source_pdf_hash).toBe(genuineHash);
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(genuineHash);
  });

  it("publishes a manifest whose trusted validators are null and whose observation is informational", async () => {
    await publish(genuineBytes, '"frozen-etag"');

    const pointer = (await (await fetch(`${BROKER_ORIGIN}/current.json`)).json()) as { snapshot_id: string };
    const manifest = (await (
      await fetch(`${BROKER_ORIGIN}/snapshots/${pointer.snapshot_id}/manifest.json`)
    ).json()) as {
      files: { upstream_etag: unknown; upstream_last_modified: unknown; publisher_observed_etag: unknown }[];
    };

    for (const file of manifest.files) {
      expect(file.upstream_etag).toBeNull();
      expect(file.upstream_last_modified).toBeNull();
      expect(file.publisher_observed_etag).toBe('"frozen-etag"');
    }
  });

  it("downloads and hashes identical candidate bytes, then reports unchanged without reparsing", async () => {
    await seedLocal(genuineBytes, '"frozen-etag"');
    await publish(genuineBytes, '"frozen-etag"');

    const result = await checkForUpdates(1);

    // "hash unchanged" is only reachable after the bytes were downloaded and hashed, and only
    // before anything is parsed — which is exactly the ordering DF-02 requires.
    expect(candidateDownloads().length).toBeGreaterThan(0);
    expect(result.outcome).toBe("unchanged");
    expect(result.message).toMatch(/hash unchanged/i);
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(genuineHash);
  });

  /* ---------------------------------------------------------------- *
   * GF-H01: what compromise recovery does and does not guarantee
   * ---------------------------------------------------------------- */

  it("recovers automatically when a poisoned candidate was published but never accepted", async () => {
    // The attacker publishes with a stolen publisher token. Render has not run yet, so nothing
    // poisoned has become durable accepted state.
    await publish(poisonedBytes);
    const acceptedBefore = await fetch(`${BROKER_ORIGIN}/accepted/course-1`);
    expect(acceptedBefore.status).toBe(404);

    // The credential is rotated and the genuine publisher republishes. No operator surgery.
    await publish(genuineBytes);

    const result = await checkForUpdates(1);
    expect(result.outcome).toBe("updated");
    expect(result.source_pdf_hash).toBe(genuineHash);
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(genuineHash);
  });

  it("cannot recover automatically once a poisoned candidate has become durable accepted state", async () => {
    // The poisoned candidate is published and Render validates and accepts it.
    await publish(poisonedBytes);
    const accepted = await checkForUpdates(1);
    expect(accepted.outcome).toBe("updated");
    expect(accepted.source_pdf_hash).toBe(poisonedHash);

    const poisonedPointer = (await (await fetch(`${BROKER_ORIGIN}/accepted/course-1`)).json()) as AcceptedPointer;
    expect(poisonedPointer.source_pdf_hash).toBe(poisonedHash);

    // The operator rotates the credential and clears Render's local state, which is the
    // intuitive-but-insufficient response.
    await rm(tempDir, { recursive: true, force: true });
    tempDir = await mkdtemp(path.join(tmpdir(), "fcim-gate-f-"));
    (config as { dataDir: string }).dataDir = tempDir;
    resetStorageCache();
    expect(await getCurrentSchedule(1)).toBeNull();

    // Clearing local state re-synchronises the poisoned durable state rather than recovering.
    await bootstrapScheduleState();
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(poisonedHash);

    // Republishing the genuine candidate does not retract the poisoned accepted state: the
    // durable pointer still names it, and the genuine successor is validated against it.
    await publish(genuineBytes);
    const stillPoisoned = (await (await fetch(`${BROKER_ORIGIN}/accepted/course-1`)).json()) as AcceptedPointer;
    expect(stillPoisoned.accepted_id).toBe(poisonedPointer.accepted_id);

    // GF-H01 (HIGH, deferred): an operator-driven durable accepted-state rollback. Until it
    // exists, automatic recovery after a compromise is guaranteed only for candidate material
    // that never became accepted state.
    expect(poisonedPointer.source_pdf_hash).not.toBe(genuineHash);
  });
});
