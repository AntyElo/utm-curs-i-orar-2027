/**
 * Regression coverage for the accepted-pointer CAS fallback (commit ac75d22).
 *
 * When the durable accepted *payload* cannot be restored — it was deleted, or its bytes no
 * longer hash to what the pointer promises — `fetchAcceptedSchedule()` correctly returns null.
 * Before ac75d22 the updater read `expectedPreviousAcceptedId` from that null record and sent
 * `expected_previous_accepted_id: null` on the CAS write, which the Worker rejects with 409
 * whenever a pointer exists. A course whose payload went missing could therefore never be
 * updated again: every tick failed closed, forever.
 *
 * The fix reads the *pointer* separately and uses its `accepted_id` as an opaque CAS
 * predecessor, without ever trusting the payload it names.
 *
 * These tests run the real path end to end. Render's production updater and broker-client talk
 * over a stubbed `globalThis.fetch` to the production Worker router, which in turn runs against
 * the R2 double that models `etagMatches` / `etagDoesNotMatch` faithfully. No CAS decision is
 * mocked: every 200/409 below is the Worker's own.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "@/lib/config";
import type { AcceptedPointer, CurrentPointer, Schedule, SnapshotManifest } from "@/lib/models";
import { parsePdf, sha256 } from "@/lib/parser";
import { checkForUpdates } from "@/lib/services/updater";
import { getCurrentSchedule, getSourceState, replaceCurrentSchedule, resetStorageCache } from "@/lib/storage";
import brokerWorker from "../worker/src/index";
import {
  acceptedPayloadKey,
  acceptedPointerKey,
  snapshotManifestKey,
  snapshotPageApiKey,
  snapshotPdfKey,
} from "../worker/src/keys";
import { createHarness, type WorkerHarness } from "./helpers/worker-doubles";

/**
 * Every local installation the production storage layer performs, in order.
 *
 * Final-state assertions alone cannot tell "the tampered accepted payload was never trusted"
 * apart from "it was installed and then overwritten by the valid candidate a moment later" —
 * both end with revision 18 on disk. Recording the real `replaceCurrentSchedule()` calls makes
 * the whole sequence observable, so a transient install is a visible extra entry. The wrapper
 * delegates to the real implementation: production storage behaviour is observed, not replaced.
 */
const { installLog } = vi.hoisted(() => ({
  installLog: [] as Array<{ course_year: number; source_pdf_hash: string; warnings: string[] }>,
}));

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    replaceCurrentSchedule: async (courseYear: number, schedule: Schedule): Promise<void> => {
      installLog.push({
        course_year: courseYear,
        source_pdf_hash: schedule.metadata.source_pdf_hash,
        warnings: [...schedule.warnings],
      });
      return actual.replaceCurrentSchedule(courseYear, schedule);
    },
  };
});

const BROKER_URL = "https://broker.fcim.internal";
const BROKER_SECRET = "gate-f-broker-secret";

/**
 * Candidate selection runs the production `discoverPdf()` against the real wall clock, and the
 * page-api fixture below describes the autumn 2026/2027 semester. Pin the clock inside the
 * fixture's own academic year so the suite cannot start failing when the host calendar rolls
 * over — the same `useFakeTimers` / `setSystemTime` pairing the other discovery-driven suites
 * use. Only `Date` is faked: these tests await real network-shaped I/O and PDF parsing, and a
 * frozen `setTimeout` would stall the broker client's own timeout plumbing.
 */
const PINNED_NOW = new Date("2026-09-09T12:00:00.000Z");

const SNAPSHOT_ACCEPTED = "2026-09-08T01-00-00-000Z-9f8e7d6c";
const SNAPSHOT_CANDIDATE = "2026-09-08T02-30-00-000Z-1a2b3c4d";

const UPLOADS = "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09";
const URL_R9 = `${UPLOADS}/anul_i_semestrul_i-9.pdf`;
const URL_R16 = `${UPLOADS}/anul_i_semestrul_i-16.pdf`;
const URL_R18 = `${UPLOADS}/anul_i_semestrul_i-18.pdf`;

const POINTER_PATH = "/accepted/course-1";

/** Carried only by the SHA-invalid payload, so any install of it is unmistakable. */
const TAMPER_MARKER = "tampered-after-pointer-write";

interface CasWrite {
  expected_previous_accepted_id: string | null;
  accepted_id: string;
}

interface FetchFaults {
  /** Return a Response to short-circuit the broker, or null to reach the real Worker. */
  intercept?: (pathname: string, method: string) => Response | null;
  /** Runs immediately before the CAS pointer PUT reaches the Worker. */
  beforeCasPut?: () => void;
}

describe("broker accepted-pointer CAS fallback (ac75d22)", () => {
  let tempDir: string;
  let harness: WorkerHarness;
  let casWrites: CasWrite[];

  let pdfBytes9: Uint8Array;
  let pdfBytes16: Uint8Array;
  let pdfBytes18: Uint8Array;
  let hash9: string;
  let hash16: string;
  let hash18: string;

  const originalBrokerUrl = config.brokerUrl;
  const originalBrokerSecret = config.brokerSecret;
  const originalDataDir = config.dataDir;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_NOW);
    installLog.length = 0;

    tempDir = await mkdtemp(path.join(tmpdir(), "fcim-fallback-test-"));
    (config as { dataDir: string }).dataDir = tempDir;
    (config as { brokerUrl: string }).brokerUrl = BROKER_URL;
    (config as { brokerSecret: string }).brokerSecret = BROKER_SECRET;
    resetStorageCache();

    harness = createHarness({ SCHEDULE_BROKER_SECRET: BROKER_SECRET });
    casWrites = [];

    pdfBytes9 = new Uint8Array(await readFile(path.join(__dirname, "fixtures", "anul_i_semestrul_i-9.pdf")));
    pdfBytes16 = new Uint8Array(await readFile(path.join(__dirname, "fixtures", "anul_i_semestrul_i-16.pdf")));
    pdfBytes18 = new Uint8Array(
      await readFile(path.join(__dirname, "..", "data", "seed", "anul_i_semestrul_i-18.pdf")),
    );
    hash9 = sha256(pdfBytes9);
    hash16 = sha256(pdfBytes16);
    hash18 = sha256(pdfBytes18);
  });

  afterEach(async () => {
    // First, so a pinned clock can never leak into another suite even if cleanup below throws.
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    (config as { dataDir: string }).dataDir = originalDataDir;
    (config as { brokerUrl: string }).brokerUrl = originalBrokerUrl;
    (config as { brokerSecret: string }).brokerSecret = originalBrokerSecret;
    resetStorageCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------------ *
   * Broker wiring: Render's fetch is answered by the production Worker. *
   * ------------------------------------------------------------------ */

  function installBrokerFetch(faults: FetchFaults = {}): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(String(input), init);
      const url = new URL(request.url);
      const method = request.method.toUpperCase();

      const injected = faults.intercept?.(url.pathname, method);
      if (injected) return injected;

      if (url.pathname === POINTER_PATH && method === "PUT") {
        const body = (await request.clone().json()) as {
          expected_previous_accepted_id: string | null;
          pointer: AcceptedPointer;
        };
        casWrites.push({
          expected_previous_accepted_id: body.expected_previous_accepted_id,
          accepted_id: body.pointer.accepted_id,
        });
        faults.beforeCasPut?.();
      }

      return brokerWorker.fetch(request, harness.env, harness.ctx);
    }) as typeof fetch;
  }

  async function makeSchedule(bytes: Uint8Array, pdfUrl: string, snapshotId: string): Promise<Schedule> {
    const { schedule } = await parsePdf(bytes, {
      source_page_url: "https://fcim.utm.md/procesul-de-studii/orar/",
      source_pdf_url: pdfUrl,
      source_kind: "live",
      source_transport: "broker",
      source_snapshot_id: snapshotId,
      downloaded_at: "2026-09-08T01:00:00.000Z",
      course_year: 1,
    });
    schedule.metadata.parser_version = config.parserVersion;
    schedule.metadata.source_transport = "broker";
    schedule.metadata.source_snapshot_id = snapshotId;
    return schedule;
  }

  function buildPointer(schedule: Schedule, payloadBytes: Uint8Array): AcceptedPointer {
    const payloadSha256 = sha256(payloadBytes);
    const parserVersion = schedule.metadata.parser_version;
    const acceptedId = `${schedule.metadata.source_pdf_hash.slice(0, 16)}-p${parserVersion.replace(/[^a-zA-Z0-9]/g, "_")}-${payloadSha256.slice(0, 16)}`;
    return {
      schema_version: 1,
      course_year: 1,
      accepted_id: acceptedId,
      payload_key: acceptedPayloadKey(1, acceptedId),
      payload_sha256: payloadSha256,
      source_snapshot_id: schedule.metadata.source_snapshot_id!,
      source_pdf_url: schedule.metadata.source_pdf_url,
      source_pdf_hash: schedule.metadata.source_pdf_hash,
      parser_version: parserVersion,
      accepted_at: "2026-09-08T01:00:05.000Z",
    };
  }

  /** Write a pointer straight into R2, bypassing the Worker's own validation. */
  function seedPointer(pointer: AcceptedPointer): void {
    harness.bucket.seed(acceptedPointerKey(1), JSON.stringify(pointer));
  }

  function seedPayload(pointer: AcceptedPointer, body: string): void {
    harness.bucket.seed(pointer.payload_key, body, {
      course_year: String(pointer.course_year),
      source_pdf_hash: pointer.source_pdf_hash,
      source_pdf_url: pointer.source_pdf_url,
      payload_sha256: pointer.payload_sha256,
      snapshot_id: pointer.source_snapshot_id,
      parser_version: pointer.parser_version,
      accepted_at: pointer.accepted_at,
    });
  }

  /** Seed the candidate snapshot (current.json + manifest + page-api + PDF) the updater will find. */
  async function seedCandidateSnapshot(): Promise<void> {
    const currentPointer: CurrentPointer = {
      schema_version: 1,
      snapshot_id: SNAPSHOT_CANDIDATE,
      updated_at: "2026-09-08T02:30:00.000Z",
      manifest_r2_key: snapshotManifestKey(SNAPSHOT_CANDIDATE),
    };

    const manifest: SnapshotManifest = {
      schema_version: 1,
      snapshot_id: SNAPSHOT_CANDIDATE,
      previous_snapshot_id: SNAPSHOT_ACCEPTED,
      created_at: "2026-09-08T02:30:00.000Z",
      source: {
        page_api_url: "https://fcim.utm.md/wp-json/wp/v2/pages?slug=orar&context=view",
        page_id: 1739,
        page_modified_gmt: null,
        retrieved_at: "2026-09-08T02:30:00.000Z",
        etag: null,
        last_modified: null,
      },
      files: [
        {
          filename: "anul_i_semestrul_i-18.pdf",
          source_url: URL_R18,
          r2_key: snapshotPdfKey(SNAPSHOT_CANDIDATE, "anul_i_semestrul_i-18.pdf"),
          content_type: "application/pdf",
          size: pdfBytes18.byteLength,
          upstream_etag: '"etag-r18"',
          upstream_last_modified: null,
        },
      ],
    };

    const pageApi = [
      {
        id: 1739,
        date_gmt: "2026-09-08T02:00:00",
        content: {
          rendered: `
            <section>
              <h2>Ciclul I, Licență - învățământ cu frecvență</h2>
              <table>
                <tr>
                  <td>Orarul semestrul de toamna 2026/2027</td>
                  <td><a href="${URL_R18}">Anul I</a></td>
                </tr>
              </table>
            </section>
          `,
        },
      },
    ];

    harness.bucket.seed("current.json", JSON.stringify(currentPointer));
    harness.bucket.seed(snapshotManifestKey(SNAPSHOT_CANDIDATE), JSON.stringify(manifest));
    harness.bucket.seed(snapshotPageApiKey(SNAPSHOT_CANDIDATE), JSON.stringify(pageApi));
    await harness.bucket.put(snapshotPdfKey(SNAPSHOT_CANDIDATE, "anul_i_semestrul_i-18.pdf"), pdfBytes18, {
      httpMetadata: { contentType: "application/pdf" },
    });
  }

  /** Local last-known-good: revision 9, the state every failure path must preserve. */
  async function installLocalR9(): Promise<Schedule> {
    const schedule = await makeSchedule(pdfBytes9, URL_R9, SNAPSHOT_ACCEPTED);
    await replaceCurrentSchedule(1, schedule);
    // Drop the fixture write: from here on the log is exactly what the updater installed.
    installLog.length = 0;
    return schedule;
  }

  /** Every hash the production storage layer was asked to install, in order. */
  function installedHashes(): string[] {
    return installLog.map((entry) => entry.source_pdf_hash);
  }

  /** The durable accepted state whose payload is unusable: revision 16. */
  async function buildBrokenAccepted(): Promise<{ pointer: AcceptedPointer; schedule: Schedule }> {
    const schedule = await makeSchedule(pdfBytes16, URL_R16, SNAPSHOT_ACCEPTED);
    const payloadBytes = new TextEncoder().encode(JSON.stringify(schedule));
    return { pointer: buildPointer(schedule, payloadBytes), schedule };
  }

  function storedPointer(): AcceptedPointer | null {
    return harness.bucket.json<AcceptedPointer>(acceptedPointerKey(1));
  }

  /* ------------------------------- Case 1 ------------------------------- */

  it("Case 1: recovers when the accepted payload is missing (404) but the pointer still exists", async () => {
    await installLocalR9();
    await seedCandidateSnapshot();

    const { pointer: pointerA } = await buildBrokenAccepted();
    // Pointer A is installed; its immutable payload is NOT — GET returns a real 404.
    seedPointer(pointerA);
    expect(harness.bucket.has(pointerA.payload_key)).toBe(false);

    installBrokerFetch();

    const result = await checkForUpdates(1);

    // The CAS write used A's accepted_id as an opaque predecessor. This is the regression:
    // pre-ac75d22 this was null, and the Worker answered 409.
    expect(casWrites).toHaveLength(1);
    expect(casWrites[0].expected_previous_accepted_id).toBe(pointerA.accepted_id);
    expect(casWrites[0].expected_previous_accepted_id).not.toBeNull();

    expect(result.outcome).toBe("updated");
    expect(result.source_pdf_hash).toBe(hash18);

    // A new immutable payload was written and the pointer now names it.
    const after = storedPointer();
    expect(after).not.toBeNull();
    expect(after!.accepted_id).not.toBe(pointerA.accepted_id);
    expect(after!.source_pdf_hash).toBe(hash18);
    expect(harness.bucket.has(after!.payload_key)).toBe(true);

    // Exactly one local install across the whole run, and it is C — A was never installed,
    // not even transiently.
    expect(installedHashes()).toEqual([hash18]);

    const local = await getCurrentSchedule(1);
    expect(local?.metadata.source_pdf_hash).toBe(hash18);

    const state = await getSourceState(1);
    expect(state.last_result).toBe("updated");
    expect(state.current_pdf_hash).toBe(hash18);
  });

  /* ------------------------------- Case 2 ------------------------------- */

  it("Case 2: recovers when the accepted payload exists but its SHA-256 does not match the pointer", async () => {
    await installLocalR9();
    await seedCandidateSnapshot();

    const { pointer: pointerA, schedule: scheduleA } = await buildBrokenAccepted();
    // The payload is present and parseable, but its bytes disagree with pointer.payload_sha256.
    const tamperedA: Schedule = {
      ...scheduleA,
      warnings: [...scheduleA.warnings, TAMPER_MARKER],
    };
    seedPointer(pointerA);
    seedPayload(pointerA, JSON.stringify(tamperedA));
    expect(sha256(new TextEncoder().encode(JSON.stringify(tamperedA)))).not.toBe(pointerA.payload_sha256);

    installBrokerFetch();

    const result = await checkForUpdates(1);

    expect(casWrites).toHaveLength(1);
    expect(casWrites[0].expected_previous_accepted_id).toBe(pointerA.accepted_id);

    expect(result.outcome).toBe("updated");

    const after = storedPointer();
    expect(after!.accepted_id).not.toBe(pointerA.accepted_id);
    expect(after!.source_pdf_hash).toBe(hash18);

    // GF-F02: the whole installation sequence, not just where it ended up. Exactly one install,
    // and it is the candidate. A transient install of the SHA-invalid payload — which the
    // candidate would then overwrite, leaving final state indistinguishable — is an extra entry
    // here and fails the test.
    expect(installedHashes()).toEqual([hash18]);
    expect(installedHashes()).not.toContain(hash16);
    for (const entry of installLog) {
      expect(entry.warnings).not.toContain(TAMPER_MARKER);
    }

    const local = await getCurrentSchedule(1);
    expect(local?.metadata.source_pdf_hash).toBe(hash18);
    expect(local?.warnings).not.toContain(TAMPER_MARKER);
  });

  /* ------------------------------- Case 3 ------------------------------- */

  it("Case 3: fails closed when the pointer changes between the fallback GET and the CAS PUT", async () => {
    const localBefore = await installLocalR9();
    await seedCandidateSnapshot();

    const { pointer: pointerA } = await buildBrokenAccepted();
    seedPointer(pointerA);

    // Pointer B: a different writer wins the race between Render's fallback GET and its PUT.
    const scheduleB = await makeSchedule(pdfBytes9, URL_R9, SNAPSHOT_ACCEPTED);
    const payloadB = new TextEncoder().encode(JSON.stringify(scheduleB));
    const pointerB = buildPointer(scheduleB, payloadB);

    let raced = false;
    installBrokerFetch({
      beforeCasPut: () => {
        if (raced) return;
        raced = true;
        seedPayload(pointerB, JSON.stringify(scheduleB));
        seedPointer(pointerB);
      },
    });

    const result = await checkForUpdates(1);

    expect(raced).toBe(true);
    expect(casWrites).toHaveLength(1);
    expect(casWrites[0].expected_previous_accepted_id).toBe(pointerA.accepted_id);

    // The Worker refused: A is no longer the predecessor.
    expect(result.outcome).toBe("error");
    expect(result.message).toContain("409");

    // B stays authoritative; the candidate never became durable state.
    const after = storedPointer();
    expect(after!.accepted_id).toBe(pointerB.accepted_id);
    expect(after!.source_pdf_hash).toBe(hash9);

    // Local last-known-good is untouched: the storage layer was never asked to install anything.
    expect(installedHashes()).toEqual([]);
    const local = await getCurrentSchedule(1);
    expect(local?.metadata.source_pdf_hash).toBe(localBefore.metadata.source_pdf_hash);
    expect(local?.metadata.source_pdf_hash).toBe(hash9);

    const state = await getSourceState(1);
    expect(state.last_result).toBe("error");
  });

  /* ------------------------------- Case 4 ------------------------------- */

  it("Case 4: a failing fallback pointer GET never degrades into an unconditional overwrite", async () => {
    const localBefore = await installLocalR9();
    await seedCandidateSnapshot();

    const { pointer: pointerA } = await buildBrokenAccepted();
    seedPointer(pointerA);

    let pointerGets = 0;
    installBrokerFetch({
      intercept: (pathname, method) => {
        if (pathname === POINTER_PATH && method === "GET") {
          pointerGets += 1;
          return new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 503 });
        }
        return null;
      },
    });

    const result = await checkForUpdates(1);

    // Both the sync read and the fallback read were attempted and both returned null.
    expect(pointerGets).toBeGreaterThanOrEqual(2);
    expect(casWrites).toHaveLength(1);
    expect(casWrites[0].expected_previous_accepted_id).toBeNull();

    // The Worker refuses a create-path write while a pointer exists: no blind overwrite.
    expect(result.outcome).toBe("error");
    expect(result.message).toContain("409");

    const after = storedPointer();
    expect(after!.accepted_id).toBe(pointerA.accepted_id);

    expect(installedHashes()).toEqual([]);
    const local = await getCurrentSchedule(1);
    expect(local?.metadata.source_pdf_hash).toBe(localBefore.metadata.source_pdf_hash);
    expect(local?.metadata.source_pdf_hash).not.toBe(hash18);
  });

  /* ------------------------------- Case 5 ------------------------------- */

  it("Case 5: creates accepted state with a null predecessor when no pointer exists at all", async () => {
    await installLocalR9();
    await seedCandidateSnapshot();

    expect(harness.bucket.has(acceptedPointerKey(1))).toBe(false);

    installBrokerFetch();

    const result = await checkForUpdates(1);

    // "No pointer" is still null — the fallback did not invent a predecessor.
    expect(casWrites).toHaveLength(1);
    expect(casWrites[0].expected_previous_accepted_id).toBeNull();

    expect(result.outcome).toBe("updated");

    const after = storedPointer();
    expect(after).not.toBeNull();
    expect(after!.source_pdf_hash).toBe(hash18);
    expect(harness.bucket.has(after!.payload_key)).toBe(true);

    expect(installedHashes()).toEqual([hash18]);
    const local = await getCurrentSchedule(1);
    expect(local?.metadata.source_pdf_hash).toBe(hash18);

    const state = await getSourceState(1);
    expect(state.last_result).toBe("updated");
  });

  /* ------------------------- Invariant I3 ordering ------------------------- */

  it("I3: the local schedule is replaced only after the durable CAS write has succeeded", async () => {
    await installLocalR9();
    await seedCandidateSnapshot();

    const { pointer: pointerA } = await buildBrokenAccepted();
    seedPointer(pointerA);

    // Observed at the instant the CAS PUT is admitted: local state must still be the old one.
    let localHashAtCasTime: string | null | undefined;
    let localHashResolved = false;

    installBrokerFetch();
    const originalFetchStub = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.pathname === POINTER_PATH && method === "PUT" && !localHashResolved) {
        localHashResolved = true;
        localHashAtCasTime = (await getCurrentSchedule(1))?.metadata.source_pdf_hash ?? null;
      }
      return originalFetchStub(input, init);
    }) as typeof fetch;

    const result = await checkForUpdates(1);

    expect(result.outcome).toBe("updated");
    expect(localHashResolved).toBe(true);
    expect(localHashAtCasTime).toBe(hash9);
    // Nothing had been installed yet when the CAS write went out; C followed, and only C.
    expect(installedHashes()).toEqual([hash18]);
    expect((await getCurrentSchedule(1))?.metadata.source_pdf_hash).toBe(hash18);
  });
});
