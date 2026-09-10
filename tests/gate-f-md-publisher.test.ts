/**
 * Gate F: the MD Publisher.
 *
 * The laptop is transport-only, so the behaviours that matter are the ones that decide *whether*
 * it acts and how it recovers when it cannot finish: conservative change detection, an attempt
 * identity it is willing to throw away, and a hard refusal to fetch anything the FCIM policy does
 * not allow — including a URL handed to it by the broker.
 *
 * Every test drives the real publisher against the real broker Worker over an in-process
 * transport. No test contacts FCIM; the upstream is scripted per case.
 */

import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CANONICAL_PAGE_API_URL } from "../worker-shared/fcim-policy";
import { runCheck, runPublish } from "../tools/md-publisher/src/publish";
import { runDoctor, readTaskRegistration } from "../tools/md-publisher/src/doctor";
import { ConfigError, loadConfig, normalizeBrokerUrl } from "../tools/md-publisher/src/config";
import { StateStore } from "../tools/md-publisher/src/state";
import { main } from "../tools/md-publisher/src/cli";
import type { PublisherConfig } from "../tools/md-publisher/src/types";
import {
  createTestTransport,
  FAKE_BROKER_ORIGIN,
  type FcimScript,
  type ScriptedResponse,
} from "./helpers/md-publisher-transport";
import { pagePayload, pdfBody, publishThroughApi, UPLOAD_BASE } from "./helpers/md-publication";
import { createHarness, TEST_PUBLISHER_TOKEN, type WorkerHarness } from "./helpers/worker-doubles";

const PDF_A = `${UPLOAD_BASE}/anul_i_semestrul_i-19.pdf`;
const PDF_B = `${UPLOAD_BASE}/anul_ii_semestrul_iii-13.pdf`;
const PAGE = pagePayload();

function ok(body: Uint8Array | string, headers: Record<string, string> = {}): ScriptedResponse {
  return { status: 200, body, headers };
}

/** A cooperative FCIM: the page and both PDFs, with validators, answering 304 when asked. */
function defaultScript(overrides: Partial<FcimScript> = {}): FcimScript {
  return {
    page: (headers) =>
      headers["If-None-Match"] === '"page-1"'
        ? { status: 304, headers: { etag: '"page-1"' } }
        : ok(PAGE, { etag: '"page-1"', "content-type": "application/json" }),
    pdf: (url, headers) =>
      headers["If-None-Match"] === `"${url.slice(-8)}"`
        ? { status: 304 }
        : ok(pdfBody(url), { etag: `"${url.slice(-8)}"`, "content-type": "application/pdf" }),
    ...overrides,
  };
}

describe("Gate F: MD Publisher", () => {
  let stateDir: string;
  let broker: WorkerHarness;
  let config: PublisherConfig;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "md-publisher-"));
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
   * The happy path and change detection
   * ---------------------------------------------------------------- */

  it("publishes a full candidate and caches a baseline anchored to the broker's snapshot", async () => {
    const { transport, log } = createTestTransport(broker, defaultScript());

    const result = await runPublish(config, transport);

    expect(result.outcome).toBe("published");
    expect(result.exitCode).toBe(0);
    expect(result.pdf_count).toBe(2);
    expect(result.page_modified_gmt).toBe("2026-09-08T12:57:59");
    expect(result.heartbeat).toBe("delivered");

    // The broker actually published: current.json points at the snapshot the publisher opened.
    expect(broker.bucket.json<{ snapshot_id: string }>("current.json")?.snapshot_id).toBe(result.snapshot_id);

    // Local state is left clean and resumable-from-nothing.
    const state = new StateStore(stateDir);
    expect(state.readResumableOperation()).toBeNull();

    // The cached baseline names the snapshot the broker is serving and repeats its digests, so it
    // can be recognised as stale the moment current.json moves on.
    const last = state.readLastRun()!;
    expect(last.broker_snapshot_id).toBe(result.snapshot_id);
    expect(result.broker_snapshot_id).toBe(result.snapshot_id);
    expect(last.pdfs.map((pdf) => pdf.source_url).sort()).toEqual([PDF_A, PDF_B].sort());
    const manifest = broker.bucket.json<{ files: { source_url: string; content_sha256: string }[] }>(
      `snapshots/${result.snapshot_id}/manifest.json`,
    )!;
    for (const file of manifest.files) {
      expect(last.pdfs.find((pdf) => pdf.source_url === file.source_url)!.sha256).toBe(file.content_sha256);
    }

    // A heartbeat was sent, and it never carries the credential.
    const heartbeat = broker.bucket.text("publisher/heartbeat.json")!;
    expect(JSON.parse(heartbeat).outcome).toBe("published");
    expect(heartbeat).not.toContain(TEST_PUBLISHER_TOKEN);
    expect(log.broker.filter((call) => call.path === "/publications")).toHaveLength(1);
  });

  it("reports unchanged, and publishes nothing, when the page and every PDF revalidate", async () => {
    const first = createTestTransport(broker, defaultScript());
    const published = await runPublish(config, first.transport);
    expect(published.outcome).toBe("published");
    const pointer = broker.bucket.text("current.json");

    const second = createTestTransport(broker, defaultScript());
    const result = await runPublish(config, second.transport);

    expect(result.outcome).toBe("unchanged");
    expect(result.exitCode).toBe(0);
    expect(result.saw_drift).toBe(false);
    // The cheap path: the cache was anchored to broker current, so one small pointer read was
    // enough to establish what "unchanged" would even mean.
    expect(result.baseline_source).toBe("local_cache");
    expect(result.broker_snapshot_id).toBe(published.snapshot_id);
    expect(second.log.broker.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /current.json",
      "PUT /publisher/heartbeat",
    ]);
    // Nothing was published, and the heartbeat records a live run rather than a silent one.
    expect(broker.bucket.text("current.json")).toBe(pointer);
    expect(JSON.parse(broker.bucket.text("publisher/heartbeat.json")!).outcome).toBe("unchanged");
  });

  it("publishes when the Page API is unchanged but a PDF was replaced in place", async () => {
    const first = createTestTransport(broker, defaultScript());
    const firstResult = await runPublish(config, first.transport);
    expect(firstResult.outcome).toBe("published");

    // The page still answers 304 with the same validator; one PDF answers 200 to its conditional
    // request, which is exactly the change Gate F exists to catch.
    const replaced = new TextEncoder().encode("%PDF-1.4 replaced in place");
    const second = createTestTransport(broker, {
      // Conditional: 304. Unconditional (the re-fetch needed to open a publication): the body.
      page: (headers) =>
        headers["If-None-Match"]
          ? { status: 304, headers: { etag: '"page-1"' } }
          : ok(PAGE, { etag: '"page-1"', "content-type": "application/json" }),
      pdf: (url, headers) =>
        url === PDF_A
          ? ok(replaced, { etag: '"pdf-a-2"', "content-type": "application/pdf" })
          : headers["If-None-Match"]
            ? { status: 304 }
            : ok(pdfBody(url), { "content-type": "application/pdf" }),
    });

    const result = await runPublish(config, second.transport);

    expect(result.outcome).toBe("published");
    expect(result.snapshot_id).not.toBe(firstResult.snapshot_id);
    expect(result.reason).toMatch(/answered 200 to a conditional request/);
    expect(broker.bucket.json<{ snapshot_id: string }>("current.json")?.snapshot_id).toBe(result.snapshot_id);
  });

  it("compares bytes when the upstream offers no usable validator", async () => {
    const noValidators: FcimScript = {
      page: () => ok(PAGE, { "content-type": "application/json" }),
      pdf: (url) => ok(pdfBody(url), { "content-type": "application/pdf" }),
    };

    const first = createTestTransport(broker, noValidators);
    expect((await runPublish(config, first.transport)).outcome).toBe("published");

    // Second run: nothing has a validator, so a conditional request cannot decide anything. The
    // publisher downloads and compares hashes rather than republishing on every tick.
    const second = createTestTransport(broker, noValidators);
    const unchanged = await runPublish(config, second.transport);
    expect(unchanged.outcome).toBe("unchanged");

    // Third run: the bytes really did change.
    const third = createTestTransport(broker, {
      page: () => ok(PAGE, { "content-type": "application/json" }),
      pdf: (url) =>
        url === PDF_A
          ? ok(new TextEncoder().encode("%PDF-1.4 genuinely new"), { "content-type": "application/pdf" })
          : ok(pdfBody(url), { "content-type": "application/pdf" }),
    });
    const changed = await runPublish(config, third.transport);
    expect(changed.outcome).toBe("published");
    expect(changed.reason).toMatch(/content hash changed/);
  });

  it("publishes when the broker has no current snapshot at all", async () => {
    const { transport } = createTestTransport(broker, defaultScript());
    const result = await runPublish(config, transport);
    expect(result.outcome).toBe("published");
    expect(result.reason).toBe("the broker has no current snapshot");
    expect(result.baseline_source).toBe("none");
  });

  /* ---------------------------------------------------------------- *
   * Upstream failures are never "unchanged"
   * ---------------------------------------------------------------- */

  it("treats an FCIM 403 as an error, not as unchanged", async () => {
    const { transport, log } = createTestTransport(broker, {
      page: () => ({ status: 403, body: "denied" }),
      pdf: () => ({ status: 403 }),
    });

    const result = await runPublish(config, transport);
    expect(result.outcome).toBe("error");
    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/HTTP 403/);

    // GF-A04: a laptop that cannot reach FCIM must not look like a laptop with nothing to do.
    // It opened no publication, but the failed run is visible to whoever reads the broker.
    expect(result.heartbeat).toBe("delivered");
    expect(log.broker.filter((call) => call.method !== "GET")).toEqual([
      { method: "PUT", path: "/publisher/heartbeat" },
    ]);
    expect(broker.bucket.keys()).toEqual(["publisher/heartbeat.json"]);
    const heartbeat = JSON.parse(broker.bucket.text("publisher/heartbeat.json")!) as Record<string, unknown>;
    expect(heartbeat.status).toBe("error");
    expect(heartbeat.outcome).toBe("error");
    expect(heartbeat.error).toMatch(/HTTP 403/);
  });

  it("treats an FCIM timeout as an error", async () => {
    const { transport } = createTestTransport(broker, {
      page: () => ({ status: 0, fail: new Error("The operation was aborted due to timeout") }),
      pdf: () => ({ status: 0, fail: new Error("timeout") }),
    });

    const result = await runPublish(config, transport);
    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/timeout/i);
    expect(broker.bucket.keys()).toEqual(["publisher/heartbeat.json"]);
    expect(JSON.parse(broker.bucket.text("publisher/heartbeat.json")!).status).toBe("error");
  });

  it("refuses a Page API redirect instead of following it", async () => {
    const { transport } = createTestTransport(broker, {
      page: () => ({ status: 302, headers: { location: "https://evil.example/page" } }),
      pdf: () => ({ status: 200, body: pdfBody() }),
    });

    const result = await runPublish(config, transport);
    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/redirect/i);
  });

  /* ---------------------------------------------------------------- *
   * The laptop must not become an SSRF helper
   * ---------------------------------------------------------------- */

  it("refuses a plan URL that leaves the official FCIM policy", async () => {
    const { transport, log } = createTestTransport(broker, defaultScript(), {
      interceptBroker: async (request, forward) => {
        const response = await forward();
        if (request.path !== "/publications") return response;
        // A compromised or confused broker hands back an off-policy source URL.
        const plan = JSON.parse(response.text) as { files: { source_url: string }[] };
        plan.files[0].source_url = "https://evil.example/wp-content/uploads/sites/24/2026/09/x.pdf";
        return { ...response, text: JSON.stringify(plan) };
      },
    });

    const result = await runPublish(config, transport);
    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/outside the official FCIM policy/);
    expect(log.fcim.map((call) => call.url)).not.toContain(
      "https://evil.example/wp-content/uploads/sites/24/2026/09/x.pdf",
    );
  });

  it("refuses a PDF redirect that leaves the approved origin", async () => {
    const { transport } = createTestTransport(broker, {
      page: () => ok(PAGE, { "content-type": "application/json" }),
      pdf: () => ({ status: 302, headers: { location: "https://evil.example/x.pdf" } }),
    });

    const result = await runPublish(config, transport);
    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/approved FCIM origin policy/);
  });

  /* ---------------------------------------------------------------- *
   * Broker failures
   * ---------------------------------------------------------------- */

  it("fails without publishing when the broker times out opening a publication", async () => {
    const { transport } = createTestTransport(broker, defaultScript(), {
      interceptBroker: async (request, forward) => {
        if (request.path === "/publications" && request.method === "POST") {
          throw new Error("socket hang up");
        }
        return forward();
      },
    });

    const result = await runPublish(config, transport);
    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/socket hang up/);
    expect(broker.bucket.has("current.json")).toBe(false);
  });

  it("fails without publishing when the broker answers 500", async () => {
    const { transport } = createTestTransport(broker, defaultScript(), {
      interceptBroker: async (request, forward) => {
        if (request.path === "/publications" && request.method === "POST") {
          return { status: 500, headers: new Headers(), text: JSON.stringify({ code: "internal", error: "boom" }) };
        }
        return forward();
      },
    });

    const result = await runPublish(config, transport);
    expect(result.outcome).toBe("error");
    expect(result.error).toMatch(/broker 500/);
    expect(broker.bucket.has("current.json")).toBe(false);
  });

  /* ---------------------------------------------------------------- *
   * Operation identity and recovery
   * ---------------------------------------------------------------- */

  it("resumes the same publication after a local interruption", async () => {
    let failUpload = true;
    const first = createTestTransport(broker, defaultScript(), {
      interceptUpload: async (request, forward) => {
        if (failUpload && request.path.endsWith("/f1")) throw new Error("connection reset mid-upload");
        return forward();
      },
    });

    const interrupted = await runPublish(config, first.transport);
    expect(interrupted.outcome).toBe("error");

    // The attempt survived on disk exactly as it was opened.
    const state = new StateStore(stateDir);
    const resumable = state.readResumableOperation()!;
    expect(resumable).not.toBeNull();

    failUpload = false;
    const second = createTestTransport(broker, defaultScript());
    const resumed = await runPublish(config, second.transport);

    expect(resumed.outcome).toBe("published");
    expect(resumed.operation_id).toBe(resumable.operation.operation_id);
    expect(resumed.snapshot_id).toBe(resumable.operation.snapshot_id);
    // Only the missing file needed uploading the second time.
    expect(second.log.broker.filter((call) => call.path.includes("/files/"))).toHaveLength(1);
  });

  it("recovers a file whose upload succeeded but whose response never arrived", async () => {
    const first = createTestTransport(broker, defaultScript(), {
      interceptUpload: async (request, forward) => {
        const response = await forward(); // the broker really did store it
        if (request.path.endsWith("/f0")) throw new Error("timeout waiting for response");
        return response;
      },
    });
    expect((await runPublish(config, first.transport)).outcome).toBe("error");

    const second = createTestTransport(broker, defaultScript());
    const result = await runPublish(config, second.transport);
    expect(result.outcome).toBe("published");
  });

  it("discards a run directory that fails the resume test and starts a clean attempt", async () => {
    const first = createTestTransport(broker, defaultScript(), {
      interceptUpload: async () => {
        throw new Error("connection reset mid-upload");
      },
    });
    expect((await runPublish(config, first.transport)).outcome).toBe("error");

    const state = new StateStore(stateDir);
    const abandoned = state.readResumableOperation()!.operation;

    // The saved page payload no longer matches its recorded hash: the attempt is unusable.
    fs.writeFileSync(state.pageFile, "corrupted");
    expect(state.readResumableOperation()).toBeNull();

    const second = createTestTransport(broker, defaultScript());
    const result = await runPublish(config, second.transport);
    expect(result.outcome).toBe("published");
    expect(result.operation_id).not.toBe(abandoned.operation_id);
    expect(result.snapshot_id).not.toBe(abandoned.snapshot_id);
  });

  it("mints a new identity and retries exactly once after operation_payload_mismatch", async () => {
    let injected = false;
    const attempts: string[] = [];
    const { transport } = createTestTransport(broker, defaultScript(), {
      interceptBroker: async (request, forward) => {
        if (request.method === "POST" && request.path === "/publications") {
          attempts.push(request.path);
          if (!injected) {
            injected = true;
            return {
              status: 409,
              headers: new Headers(),
              text: JSON.stringify({ code: "operation_payload_mismatch", error: "reused id" }),
            };
          }
        }
        return forward();
      },
    });

    const result = await runPublish(config, transport);
    expect(result.outcome).toBe("published");
    expect(attempts).toHaveLength(2);
  });

  it("mints a new identity and retries exactly once after operation_expired", async () => {
    let injected = false;
    let opens = 0;
    const { transport } = createTestTransport(broker, defaultScript(), {
      interceptBroker: async (request, forward) => {
        if (request.method === "POST" && request.path === "/publications") {
          opens++;
          if (!injected) {
            injected = true;
            return {
              status: 410,
              headers: new Headers(),
              text: JSON.stringify({ code: "operation_expired", error: "gone" }),
            };
          }
        }
        return forward();
      },
    });

    expect((await runPublish(config, transport)).outcome).toBe("published");
    expect(opens).toBe(2);
  });

  it("never retries operation_state_corrupt, and reports it in the heartbeat", async () => {
    let opens = 0;
    const { transport } = createTestTransport(broker, defaultScript(), {
      interceptBroker: async (request, forward) => {
        if (request.method === "POST" && request.path === "/publications") {
          opens++;
          return {
            status: 409,
            headers: new Headers(),
            text: JSON.stringify({ code: "operation_state_corrupt", error: "storage disagrees" }),
          };
        }
        return forward();
      },
    });

    const result = await runPublish(config, transport);
    expect(result.outcome).toBe("error");
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe("operation_state_corrupt");
    expect(opens).toBe(1);

    const heartbeat = JSON.parse(broker.bucket.text("publisher/heartbeat.json")!) as { status: string; error: string };
    expect(heartbeat.status).toBe("error");
    expect(heartbeat.error).toMatch(/operation_state_corrupt/);
  });

  it("treats a superseded publication as a normal, successful outcome", async () => {
    const { transport } = createTestTransport(broker, defaultScript(), {
      interceptBroker: async (request, forward) => {
        const response = await forward();
        if (request.method === "POST" && request.path === "/publications") {
          // Another publisher wins the pointer while this run is still uploading.
          await publishThroughApi(broker, { page: PAGE, body: pdfBody("rival") });
        }
        return response;
      },
    });

    const result = await runPublish(config, transport);
    expect(result.outcome).toBe("superseded");
    expect(result.exitCode).toBe(0);
  });

  /* ---------------------------------------------------------------- *
   * Dry run and check
   * ---------------------------------------------------------------- */

  it("mutates nothing at all in a dry run, at the broker or on disk", async () => {
    const { transport, log } = createTestTransport(broker, defaultScript());

    const result = await runPublish(config, transport, { dryRun: true });

    expect(result.outcome).toBe("dry_run");
    expect(result.exitCode).toBe(0);
    // It may read the authoritative baseline — a dry run that guessed would be answering a
    // different question than `publish` does — but it opens nothing, uploads nothing, completes
    // nothing and writes no heartbeat.
    expect(log.broker.filter((call) => call.method !== "GET")).toEqual([]);
    expect(result.heartbeat).toBe("skipped");
    expect(broker.bucket.keys()).toEqual([]);
    // Nothing is left behind for a later run to mistake for a resumable attempt.
    const state = new StateStore(stateDir);
    expect(state.readResumableOperation()).toBeNull();
    expect(state.readLastRun()).toBeNull();
  });

  it("leaves a resumable attempt intact through a dry run, and finishes it afterwards", async () => {
    // GF-N01: `--dry-run` is an observation, so it may not consume pending work. A dry run that
    // wiped `run/` would strand a publication the broker already has open and force the next real
    // run to mint a second identity for the same bytes.
    let failUpload = true;
    const first = createTestTransport(broker, defaultScript(), {
      interceptUpload: async (request, forward) => {
        if (failUpload && request.path.endsWith("/f1")) throw new Error("connection reset mid-upload");
        return forward();
      },
    });
    expect((await runPublish(config, first.transport)).outcome).toBe("error");

    const state = new StateStore(stateDir);
    const opened = state.readResumableOperation()!;
    expect(opened).not.toBeNull();
    const bucketBefore = broker.bucket.keys();

    const dry = createTestTransport(broker, defaultScript());
    const dryResult = await runPublish(config, dry.transport, { dryRun: true });

    expect(dryResult.outcome).toBe("dry_run");
    expect(dryResult.exitCode).toBe(0);
    // Nothing was opened, uploaded, completed or heartbeated, and the broker's objects are
    // byte-for-byte what the interrupted attempt left.
    expect(dry.log.broker.filter((call) => call.method !== "GET")).toEqual([]);
    expect(dryResult.heartbeat).toBe("skipped");
    expect(broker.bucket.keys()).toEqual(bucketBefore);
    // A resumed run answers from the bytes already on disk, so it does not re-ask FCIM either.
    expect(dry.log.fcim).toEqual([]);

    // The attempt is still there, unchanged, and the dry run said whose it was.
    const after = state.readResumableOperation()!;
    expect(after).not.toBeNull();
    expect(after.operation.operation_id).toBe(opened.operation.operation_id);
    expect(after.operation.snapshot_id).toBe(opened.operation.snapshot_id);
    expect(Buffer.from(after.pageBytes)).toEqual(Buffer.from(opened.pageBytes));
    expect(dryResult.operation_id).toBe(opened.operation.operation_id);

    // ...and the real run that follows finishes that same publication rather than opening another.
    failUpload = false;
    const second = createTestTransport(broker, defaultScript());
    const resumed = await runPublish(config, second.transport);

    expect(resumed.outcome).toBe("published");
    expect(resumed.operation_id).toBe(opened.operation.operation_id);
    expect(resumed.snapshot_id).toBe(opened.operation.snapshot_id);
    expect(second.log.broker.filter((call) => call.path === "/publications")).toHaveLength(1);
    expect(broker.bucket.json<{ snapshot_id: string }>("current.json")?.snapshot_id).toBe(
      opened.operation.snapshot_id,
    );
  });

  it("reports drift from `check` without mutating anything", async () => {
    const { transport, log } = createTestTransport(broker, defaultScript());
    const result = await runCheck(config, transport);

    expect(result.outcome).toBe("dry_run");
    expect(result.exitCode).toBe(0);
    expect(log.broker.filter((call) => call.method !== "GET")).toEqual([]);
    expect(broker.bucket.keys()).toEqual([]);
    expect(new StateStore(stateDir).readLastRun()).toBeNull();
  });

  /* ---------------------------------------------------------------- *
   * Configuration, CLI surface and diagnostics
   * ---------------------------------------------------------------- */

  it("has no force affordance anywhere in the CLI", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const { transport } = createTestTransport(broker, defaultScript());
    const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line), env: {}, transport };

    expect(await main(["publish", "--force"], io)).toBe(2);
    expect(err.join("\n")).toMatch(/Unknown option: --force/);
    // The usage text does not advertise it either: there is no forced publication to ask for.
    const usage = out.concat(err).filter((line) => !line.startsWith("Unknown option")).join("\n");
    expect(usage).not.toContain("--force");
    expect(broker.bucket.keys()).toEqual([]);
  });

  it("prints usage and refuses --dry-run outside publish", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const { transport } = createTestTransport(broker, defaultScript());
    const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line), env: {}, transport };

    expect(await main([], io)).toBe(2);
    expect(out.join("\n")).toMatch(/md-publisher publish/);
    expect(await main(["check", "--dry-run"], io)).toBe(2);
  });

  it("refuses to run without configuration rather than guessing", async () => {
    const err: string[] = [];
    const { transport } = createTestTransport(broker, defaultScript());
    const io = { out: () => {}, err: (line: string) => err.push(line), env: { MD_PUBLISHER_STATE_DIR: stateDir }, transport };

    expect(await main(["publish"], io)).toBe(2);
    expect(err.join("\n")).toMatch(/MD_PUBLISHER_BROKER_URL is not set/);
  });

  it("rejects a broker URL that is not a bare https origin", () => {
    expect(normalizeBrokerUrl("https://broker.example")).toBe("https://broker.example");
    expect(normalizeBrokerUrl("https://broker.example/")).toBe("https://broker.example");
    expect(() => normalizeBrokerUrl("http://broker.example")).toThrow(ConfigError);
    expect(() => normalizeBrokerUrl("https://user:pw@broker.example")).toThrow(ConfigError);
    expect(() => normalizeBrokerUrl("https://broker.example/path")).toThrow(ConfigError);
    expect(() => normalizeBrokerUrl("https://broker.example?x=1")).toThrow(ConfigError);
    // Loopback stays usable for a local smoke test.
    expect(normalizeBrokerUrl("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("requires a publisher credential of at least the deployed minimum length", () => {
    const env = { MD_PUBLISHER_BROKER_URL: FAKE_BROKER_ORIGIN, MD_PUBLISHER_STATE_DIR: stateDir };
    expect(() => loadConfig({ env: { ...env } })).toThrow(/MD_PUBLISHER_TOKEN is not set/);
    expect(() => loadConfig({ env: { ...env, MD_PUBLISHER_TOKEN: "short" } })).toThrow(/at least 32/);
    expect(loadConfig({ env: { ...env, MD_PUBLISHER_TOKEN: TEST_PUBLISHER_TOKEN } }).token).toBe(TEST_PUBLISHER_TOKEN);
  });

  it("does not let the Page API endpoint be configured", () => {
    const env = {
      MD_PUBLISHER_BROKER_URL: FAKE_BROKER_ORIGIN,
      MD_PUBLISHER_TOKEN: TEST_PUBLISHER_TOKEN,
      MD_PUBLISHER_STATE_DIR: stateDir,
      MD_PUBLISHER_PAGE_API_URL: "https://evil.example/wp-json",
    };
    const loaded = loadConfig({ env });
    expect(Object.values(loaded)).not.toContain("https://evil.example/wp-json");
  });

  it("reports a healthy deployment from doctor", async () => {
    const { transport } = createTestTransport(broker, defaultScript());
    const report = await runDoctor({
      env: {
        MD_PUBLISHER_BROKER_URL: FAKE_BROKER_ORIGIN,
        MD_PUBLISHER_TOKEN: TEST_PUBLISHER_TOKEN,
        MD_PUBLISHER_STATE_DIR: stateDir,
      },
      transport,
      runCommand: () => "<Principal><LogonType>InteractiveToken</LogonType></Principal>",
    });

    expect(report.checks.find((check) => check.name === "publisher-token")?.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "page-api-endpoint")?.detail).toBe(CANONICAL_PAGE_API_URL);
    expect(report.checks.find((check) => check.name === "broker-reachable")?.ok).toBe(true);
    // The credential value itself never appears in a report.
    expect(JSON.stringify(report)).not.toContain(TEST_PUBLISHER_TOKEN);
  });

  it("fails doctor with a corrective instruction when the task is registered with S4U", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const registration = readTaskRegistration(() => "<Principal><LogonType>S4U</LogonType></Principal>");
    expect(registration.logonModel).toBe("S4U");

    const report = await runDoctor({
      env: {
        MD_PUBLISHER_BROKER_URL: FAKE_BROKER_ORIGIN,
        MD_PUBLISHER_TOKEN: TEST_PUBLISHER_TOKEN,
        MD_PUBLISHER_STATE_DIR: stateDir,
      },
      contactBroker: false,
      runCommand: () => "<Principal><LogonType>S4U</LogonType></Principal>",
    });

    const task = report.checks.find((check) => check.name === "scheduled-task")!;
    expect(task.ok).toBe(false);
    expect(task.detail).toMatch(/install-task\.ps1 -LogonMode Interactive/);
    expect(report.ok).toBe(false);
    expect(report.logon_model).toBe("S4U");
  });

  it("reports each supported logon model, and a missing task, on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    expect(readTaskRegistration(() => "<LogonType>InteractiveToken</LogonType>").logonModel).toBe("Interactive");
    expect(readTaskRegistration(() => "<LogonType>Password</LogonType>").logonModel).toBe("Password");
    const missing = readTaskRegistration(() => {
      throw new Error("ERROR: The system cannot find the file specified.");
    });
    expect(missing.installed).toBe(false);
    expect(missing.detail).toMatch(/No scheduled task named/);
  });
});
