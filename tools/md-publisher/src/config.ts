/**
 * Publisher configuration.
 *
 * Two things are deliberately *not* configurable: the FCIM Page API endpoint and the PDF URL
 * policy. Both come from the shared canonical policy module, because a laptop that can be pointed
 * at an arbitrary "Page API" is a laptop that can be turned into an SSRF helper by whoever edits
 * its environment.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import type { PublisherConfig } from "./types";

export const PUBLISHER_VERSION = "1.0.0";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TOKEN_LENGTH = 32;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function defaultStateDir(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && localAppData.trim()) {
    return path.join(localAppData, "fcim-md-publisher");
  }
  return path.join(os.homedir(), ".fcim-md-publisher");
}

/** Broker origin only: no path, no query, no fragment, no credentials, https unless localhost. */
export function normalizeBrokerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError(`MD_PUBLISHER_BROKER_URL is not a valid URL: ${raw}`);
  }
  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new ConfigError("MD_PUBLISHER_BROKER_URL must be https (http is allowed only on loopback)");
  }
  if (parsed.username || parsed.password) {
    throw new ConfigError("MD_PUBLISHER_BROKER_URL must not embed credentials");
  }
  if (parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new ConfigError("MD_PUBLISHER_BROKER_URL must be a bare origin");
  }
  return parsed.origin;
}

interface ConfigFile {
  broker_url?: unknown;
  state_dir?: unknown;
  timeout_ms?: unknown;
  logon_model?: unknown;
}

/** Optional on-disk defaults. The token is never read from here. */
function readConfigFile(stateDir: string): ConfigFile {
  const file = path.join(stateDir, "config.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ConfigFile) : {};
  } catch {
    return {};
  }
}

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  /** When false, a missing token is tolerated so `doctor` can report it instead of throwing. */
  requireToken?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): PublisherConfig {
  const env = options.env ?? process.env;
  const stateDir = (env.MD_PUBLISHER_STATE_DIR?.trim() || defaultStateDir());
  const file = readConfigFile(stateDir);

  const brokerRaw = env.MD_PUBLISHER_BROKER_URL?.trim() ||
    (typeof file.broker_url === "string" ? file.broker_url.trim() : "");
  if (!brokerRaw) {
    throw new ConfigError("MD_PUBLISHER_BROKER_URL is not set");
  }

  const token = env.MD_PUBLISHER_TOKEN ?? "";
  if (options.requireToken !== false) {
    if (!token) throw new ConfigError("MD_PUBLISHER_TOKEN is not set");
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new ConfigError(`MD_PUBLISHER_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
    }
  }

  const timeoutRaw = env.MD_PUBLISHER_TIMEOUT_MS?.trim() ||
    (typeof file.timeout_ms === "number" ? String(file.timeout_ms) : "");
  const timeoutMs = /^[1-9]\d{2,6}$/.test(timeoutRaw) ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;

  const logonModel = env.MD_PUBLISHER_LOGON_MODEL?.trim() ||
    (typeof file.logon_model === "string" ? file.logon_model.trim() : "") || null;

  return {
    brokerUrl: normalizeBrokerUrl(brokerRaw),
    token,
    stateDir: typeof file.state_dir === "string" && !env.MD_PUBLISHER_STATE_DIR
      ? file.state_dir
      : stateDir,
    timeoutMs,
    logonModel,
    version: PUBLISHER_VERSION,
  };
}
