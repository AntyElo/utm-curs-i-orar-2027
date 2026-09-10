/**
 * Operational self-check.
 *
 * The interesting part is the scheduled-task logon model. S4U ("run whether user is logged on or
 * not", without storing a password) gives the task a token with no network credentials and a
 * surprising privilege profile; this deployment does not use it, and `doctor` treats finding one
 * as a failure with a corrective instruction rather than a note.
 */

import { execFileSync } from "node:child_process";

import { ConfigError, loadConfig } from "./config";
import { StateStore } from "./state";
import { BrokerClient } from "./broker";
import { PAGE_API_URL } from "./upstream";
import type { PublisherConfig, Transport } from "./types";

export const SCHEDULED_TASK_NAME = "FCIM MD Publisher";

export type LogonModel = "Interactive" | "Password" | "S4U" | "InteractiveOrPassword" | "Unknown";

export interface TaskRegistration {
  installed: boolean;
  logonModel: LogonModel;
  detail: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  logon_model: LogonModel | "not-applicable";
}

const LOGON_TYPE_MAP: Record<string, LogonModel> = {
  InteractiveToken: "Interactive",
  Password: "Password",
  S4U: "S4U",
  InteractiveTokenOrPassword: "InteractiveOrPassword",
};

/** Read the registered task definition. Returns "not installed" rather than throwing. */
export function readTaskRegistration(
  run: (command: string, args: string[]) => string = defaultRunner,
): TaskRegistration {
  if (process.platform !== "win32") {
    return { installed: false, logonModel: "Unknown", detail: "Windows Task Scheduler is not available on this platform" };
  }
  let xml: string;
  try {
    xml = run("schtasks", ["/Query", "/TN", SCHEDULED_TASK_NAME, "/XML", "ONE"]);
  } catch {
    return { installed: false, logonModel: "Unknown", detail: `No scheduled task named "${SCHEDULED_TASK_NAME}"` };
  }
  const match = /<LogonType>([^<]+)<\/LogonType>/i.exec(xml);
  if (!match) {
    // A task definition with no explicit LogonType runs interactively with the stored principal.
    return { installed: true, logonModel: "Interactive", detail: "Task defines no explicit LogonType" };
  }
  const model = LOGON_TYPE_MAP[match[1].trim()] ?? "Unknown";
  return { installed: true, logonModel: model, detail: `LogonType=${match[1].trim()}` };
}

function defaultRunner(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export interface DoctorOptions {
  env?: Record<string, string | undefined>;
  transport?: Transport;
  runCommand?: (command: string, args: string[]) => string;
  /** When false, the broker is not contacted at all. */
  contactBroker?: boolean;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  let config: PublisherConfig | null = null;
  try {
    config = loadConfig({ env: options.env, requireToken: false });
    add("broker-url", true, config.brokerUrl);
  } catch (err) {
    add("broker-url", false, err instanceof ConfigError ? err.message : String(err));
  }

  const token = (options.env ?? process.env).MD_PUBLISHER_TOKEN ?? "";
  if (!token) {
    add("publisher-token", false, "MD_PUBLISHER_TOKEN is not set");
  } else if (token.length < 32) {
    // The length is a policy fact, not a secret. The value itself is never shown or logged.
    add("publisher-token", false, "MD_PUBLISHER_TOKEN is shorter than 32 characters");
  } else {
    add("publisher-token", true, "configured");
  }

  add("page-api-endpoint", true, PAGE_API_URL);

  if (config) {
    const state = new StateStore(config.stateDir);
    const writable = state.writable();
    add("state-directory", writable, writable ? config.stateDir : `${config.stateDir} is not writable`);
  }

  const registration = readTaskRegistration(options.runCommand);
  let logonModel: LogonModel | "not-applicable" = "not-applicable";
  if (process.platform !== "win32") {
    add("scheduled-task", true, "not applicable on this platform");
  } else if (!registration.installed) {
    add("scheduled-task", false, `${registration.detail}; run install-task.ps1 -LogonMode Interactive`);
  } else if (registration.logonModel === "S4U") {
    logonModel = "S4U";
    add(
      "scheduled-task",
      false,
      'Task is registered with S4U. Re-register it: .\\install-task.ps1 -LogonMode Interactive ' +
        '(or -LogonMode Password -User "<account>" if it must run before logon).',
    );
  } else {
    logonModel = registration.logonModel;
    add("scheduled-task", true, `logon model: ${registration.logonModel} (${registration.detail})`);
  }

  if (config && options.transport && options.contactBroker !== false && token) {
    try {
      const broker = new BrokerClient({ ...config, token }, options.transport);
      const status = await broker.status();
      add(
        "broker-reachable",
        status.status === 200,
        status.status === 200 ? "publication-status responded 200" : `publication-status responded ${status.status}`,
      );
    } catch (err: unknown) {
      add("broker-reachable", false, (err as Error).message);
    }
  }

  return { ok: checks.every((check) => check.ok), checks, logon_model: logonModel };
}
