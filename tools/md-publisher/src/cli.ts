/**
 * MD Publisher command line.
 *
 * There is no `--force`. The normal scheduled command is `publish`, and a run that finds nothing
 * to do is a success, not something to override. Forcing publication would let a laptop create
 * candidate snapshots for its own reasons, which is exactly the authority it must not have.
 */

import { ConfigError, loadConfig } from "./config";
import { BrokerClient } from "./broker";
import { runDoctor } from "./doctor";
import { runCheck, runPublish } from "./publish";
import { nodeTransport } from "./transport";
import type { Transport } from "./types";

const USAGE = `fcim-md-publisher — transport-only timetable publisher

Usage:
  md-publisher publish [--dry-run] [--json]   fetch FCIM and publish a candidate to the broker
                                              (--dry-run decides and reports; read-only, and it
                                              leaves any resumable attempt in place)
  md-publisher check [--json]                 report drift against the broker's current snapshot
                                              (read-only broker GETs; no mutation, no heartbeat)
  md-publisher status [--json]                print the broker's bounded operational state
  md-publisher doctor [--json]                check configuration, state and the scheduled task

Environment:
  MD_PUBLISHER_BROKER_URL   broker origin (required)
  MD_PUBLISHER_TOKEN        publisher credential (required)
  MD_PUBLISHER_STATE_DIR    local state root (default: %LOCALAPPDATA%\\fcim-md-publisher)
  MD_PUBLISHER_TIMEOUT_MS   per-request timeout (default: 30000)
  MD_PUBLISHER_LOGON_MODEL  reported in the heartbeat; set by install-task.ps1

The FCIM Page API endpoint is fixed by policy and is deliberately not configurable.
`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  transport: Transport;
}

function defaultIo(): CliIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    transport: nodeTransport,
  };
}

export async function main(argv: readonly string[], io: CliIo = defaultIo()): Promise<number> {
  const args = [...argv];
  const command = args.shift();
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");

  const unknown = args.filter((arg) => arg !== "--json" && arg !== "--dry-run");
  if (unknown.length > 0) {
    io.err(`Unknown option: ${unknown[0]}`);
    io.err(USAGE);
    return 2;
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return command ? 0 : 2;
  }

  if (command !== "publish" && dryRun) {
    io.err("--dry-run is only valid for `publish`");
    return 2;
  }

  try {
    switch (command) {
      case "publish": {
        const config = loadConfig({ env: io.env });
        const result = await runPublish(config, io.transport, { dryRun, log: io.out });
        io.out(json ? JSON.stringify(result) : `${result.outcome}: ${result.reason || result.error || ""}`.trim());
        return result.exitCode;
      }

      case "check": {
        const config = loadConfig({ env: io.env, requireToken: false });
        const result = await runCheck(config, io.transport, { log: io.out });
        io.out(json ? JSON.stringify(result) : `${result.outcome}: ${result.reason || result.error || ""}`.trim());
        return result.exitCode;
      }

      case "status": {
        const config = loadConfig({ env: io.env });
        const broker = new BrokerClient(config, io.transport);
        const status = await broker.status();
        io.out(JSON.stringify(status.body, null, json ? 0 : 2));
        return status.status === 200 ? 0 : 1;
      }

      case "doctor": {
        const report = await runDoctor({ env: io.env, transport: io.transport });
        if (json) {
          io.out(JSON.stringify(report));
        } else {
          for (const check of report.checks) {
            io.out(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
          }
          io.out(`logon model: ${report.logon_model}`);
        }
        return report.ok ? 0 : 1;
      }

      default:
        io.err(`Unknown command: ${command}`);
        io.err(USAGE);
        return 2;
    }
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      io.err(`configuration error: ${err.message}`);
      return 2;
    }
    io.err(`fatal: ${(err as Error).message}`);
    return 1;
  }
}
