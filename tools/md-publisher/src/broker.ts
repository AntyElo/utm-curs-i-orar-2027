/**
 * Broker client.
 *
 * Every refusal is surfaced as a `BrokerError` carrying the broker's own machine-readable code,
 * because the publisher's recovery rules are defined by identity — `operation_payload_mismatch`
 * is retried with a new identity, `operation_state_corrupt` is never retried at all — and
 * matching on human-readable text would make those rules quietly stop working.
 */

import {
  BrokerError,
  type CurrentPointerView,
  type ManifestFileView,
  type ManifestView,
  type PlanFile,
  type PublicationPlan,
  type PublisherConfig,
  type Transport,
} from "./types";

const JSON_CONTENT_TYPE = "application/json";

/**
 * The broker's own snapshot identifier shape.
 *
 * Re-checked here rather than trusted, because a snapshot id read out of `current.json` is used
 * to compose the two read paths below. The publisher never lets a value it received compose a
 * request path without proving its shape first — the same rule that keeps it from being usable
 * as an SSRF helper on the FCIM side.
 */
const SNAPSHOT_ID_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parse `current.json` into the two things the publisher is allowed to act on. */
function parseCurrent(text: string): CurrentPointerView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BrokerError(200, "current_unreadable", "Broker current pointer is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BrokerError(200, "current_unreadable", "Broker current pointer is not an object");
  }
  const pointer = parsed as Record<string, unknown>;
  const snapshotId = pointer.snapshot_id;
  if (typeof snapshotId !== "string" || !SNAPSHOT_ID_REGEX.test(snapshotId)) {
    throw new BrokerError(200, "current_unreadable", "Broker current pointer has no usable snapshot id");
  }
  return {
    snapshot_id: snapshotId,
    published_at: stringOrNull(pointer.published_at) ?? stringOrNull(pointer.updated_at),
    page_modified_gmt: stringOrNull(pointer.page_modified_gmt),
  };
}

/** Parse an immutable snapshot manifest into the freshness facts it carries. */
function parseManifest(text: string, snapshotId: string): ManifestView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BrokerError(200, "manifest_unreadable", `Manifest for ${snapshotId} is not JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BrokerError(200, "manifest_unreadable", `Manifest for ${snapshotId} is not an object`);
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.snapshot_id !== snapshotId) {
    throw new BrokerError(200, "manifest_unreadable", `Manifest does not describe snapshot ${snapshotId}`);
  }
  if (!Array.isArray(manifest.files)) {
    throw new BrokerError(200, "manifest_unreadable", `Manifest for ${snapshotId} lists no files`);
  }
  const source = (manifest.source ?? {}) as Record<string, unknown>;
  const files: ManifestFileView[] = manifest.files.map((entry) => {
    const file = (entry ?? {}) as Record<string, unknown>;
    const sourceUrl = file.source_url;
    if (typeof sourceUrl !== "string") {
      throw new BrokerError(200, "manifest_unreadable", `Manifest file entry for ${snapshotId} has no source URL`);
    }
    const hash = typeof file.content_sha256 === "string" ? file.content_sha256.toLowerCase() : null;
    return {
      source_url: sourceUrl,
      content_sha256: hash && SHA256_HEX_REGEX.test(hash) ? hash : null,
      publisher_observed_etag: stringOrNull(file.publisher_observed_etag),
      publisher_observed_last_modified: stringOrNull(file.publisher_observed_last_modified),
    };
  });
  return {
    snapshot_id: snapshotId,
    page_modified_gmt: stringOrNull(source.page_modified_gmt),
    files,
  };
}

interface BrokerFailure {
  code?: unknown;
  error?: unknown;
}

function parseFailure(status: number, text: string): BrokerError {
  let code = "unknown";
  let message = text.slice(0, 400);
  try {
    const parsed = JSON.parse(text) as BrokerFailure;
    if (typeof parsed.code === "string") code = parsed.code;
    if (typeof parsed.error === "string") message = parsed.error;
  } catch {
    // A non-JSON failure body is still a failure; keep the truncated text.
  }
  return new BrokerError(status, code, `broker ${status} ${code}: ${message}`);
}

function parsePlan(text: string): PublicationPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BrokerError(200, "invalid_plan", "Broker returned a plan that is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BrokerError(200, "invalid_plan", "Broker plan is not an object");
  }
  const plan = parsed as Record<string, unknown>;
  if (typeof plan.snapshot_id !== "string" || typeof plan.operation_id !== "string") {
    throw new BrokerError(200, "invalid_plan", "Broker plan has no snapshot or operation identity");
  }
  if (!Array.isArray(plan.files) || plan.files.length === 0) {
    throw new BrokerError(200, "invalid_plan", "Broker plan lists no files");
  }
  const files: PlanFile[] = plan.files.map((entry) => {
    const file = entry as Record<string, unknown>;
    if (
      typeof file.file_id !== "string" ||
      typeof file.filename !== "string" ||
      typeof file.source_url !== "string" ||
      typeof file.upload_path !== "string"
    ) {
      throw new BrokerError(200, "invalid_plan", "Broker plan file entry is incomplete");
    }
    return {
      file_id: file.file_id,
      filename: file.filename,
      source_url: file.source_url,
      upload_path: file.upload_path,
      status: file.status === "stored" ? "stored" : "needed",
    };
  });

  return {
    status: plan.status === "resumed" ? "resumed" : "created",
    snapshot_id: plan.snapshot_id,
    operation_id: plan.operation_id,
    page_api_sha256: typeof plan.page_api_sha256 === "string" ? plan.page_api_sha256 : "",
    created_at: typeof plan.created_at === "string" ? plan.created_at : "",
    expires_at: typeof plan.expires_at === "string" ? plan.expires_at : "",
    files,
  };
}

export class BrokerClient {
  constructor(
    private readonly config: PublisherConfig,
    private readonly transport: Transport,
  ) {}

  private url(path: string): string {
    return `${this.config.brokerUrl}${path}`;
  }

  /**
   * The publisher credential.
   *
   * Omitted entirely when there is none, so `check` — which needs no credential — reads the
   * broker's public pointer and manifest routes without sending an empty bearer token.
   */
  private authHeaders(): Record<string, string> {
    return this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {};
  }

  async openPublication(
    operationId: string,
    pageBytes: Uint8Array,
    pageSha256: string,
  ): Promise<PublicationPlan> {
    const response = await this.transport.json({
      method: "POST",
      url: this.url("/publications"),
      headers: {
        ...this.authHeaders(),
        "Content-Type": JSON_CONTENT_TYPE,
        "Content-Length": String(pageBytes.byteLength),
        "X-Publication-Operation-Id": operationId,
        "X-Page-Sha256": pageSha256,
      },
      body: pageBytes,
      timeoutMs: this.config.timeoutMs,
    });

    if (response.status !== 200 && response.status !== 201) {
      throw parseFailure(response.status, response.text);
    }
    return parsePlan(response.text);
  }

  /**
   * Read `current.json`: the one authoritative statement of what the broker is serving.
   *
   * `null` means the broker genuinely has no snapshot yet, which is a publishable state. An
   * unreadable pointer throws instead, because "the broker will not tell me what it is serving"
   * can never be turned into "nothing changed".
   */
  async readCurrentPointer(): Promise<CurrentPointerView | null> {
    const response = await this.transport.json({
      method: "GET",
      url: this.url("/current.json"),
      headers: this.authHeaders(),
      timeoutMs: this.config.timeoutMs,
    });
    if (response.status === 404) return null;
    if (response.status !== 200) throw parseFailure(response.status, response.text);
    return parseCurrent(response.text);
  }

  /** Read one immutable snapshot manifest. `null` only when the object is genuinely absent. */
  async readManifest(snapshotId: string): Promise<ManifestView | null> {
    if (!SNAPSHOT_ID_REGEX.test(snapshotId)) {
      throw new BrokerError(0, "invalid_snapshot_id", `Refusing to read a malformed snapshot id: ${snapshotId}`);
    }
    const response = await this.transport.json({
      method: "GET",
      url: this.url(`/snapshots/${snapshotId}/manifest.json`),
      headers: this.authHeaders(),
      timeoutMs: this.config.timeoutMs,
    });
    if (response.status === 404) return null;
    if (response.status !== 200) throw parseFailure(response.status, response.text);
    return parseManifest(response.text, snapshotId);
  }

  /** Read the exact Page API bytes a snapshot archived. `null` only when genuinely absent. */
  async readSnapshotPageApi(snapshotId: string): Promise<Uint8Array | null> {
    if (!SNAPSHOT_ID_REGEX.test(snapshotId)) {
      throw new BrokerError(0, "invalid_snapshot_id", `Refusing to read a malformed snapshot id: ${snapshotId}`);
    }
    const response = await this.transport.json({
      method: "GET",
      url: this.url(`/snapshots/${snapshotId}/page-api.json`),
      headers: this.authHeaders(),
      timeoutMs: this.config.timeoutMs,
    });
    if (response.status === 404) return null;
    if (response.status !== 200) throw parseFailure(response.status, response.text);
    return new TextEncoder().encode(response.text);
  }

  async getPublication(snapshotId: string): Promise<PublicationPlan> {
    const response = await this.transport.json({
      method: "GET",
      url: this.url(`/publications/${snapshotId}`),
      headers: this.authHeaders(),
      timeoutMs: this.config.timeoutMs,
    });
    if (response.status !== 200) throw parseFailure(response.status, response.text);
    return parsePlan(response.text);
  }

  /**
   * Upload one PDF body.
   *
   * The path is the one the broker's own plan supplied; the publisher never composes a storage
   * path of its own. The declared digest is validated server-side, so a corrupted transfer
   * cannot become a stored object.
   */
  async uploadFile(input: {
    uploadPath: string;
    filePath: string;
    size: number;
    sha256: string;
    observedEtag: string | null;
    observedLastModified: string | null;
  }): Promise<{ status: "stored" | "already_stored" }> {
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      "Content-Type": "application/pdf",
      "X-Content-Sha256": input.sha256,
    };
    if (input.observedEtag) headers["X-Publisher-Observed-Etag"] = input.observedEtag;
    if (input.observedLastModified) {
      headers["X-Publisher-Observed-Last-Modified"] = input.observedLastModified;
    }

    const response = await this.transport.upload({
      url: this.url(input.uploadPath),
      headers,
      filePath: input.filePath,
      size: input.size,
      timeoutMs: this.config.timeoutMs,
    });

    if (response.status !== 200 && response.status !== 201) {
      throw parseFailure(response.status, response.text);
    }
    try {
      const parsed = JSON.parse(response.text) as { status?: unknown };
      return { status: parsed.status === "already_stored" ? "already_stored" : "stored" };
    } catch {
      return { status: "stored" };
    }
  }

  async complete(snapshotId: string): Promise<{ status: string }> {
    const response = await this.transport.json({
      method: "POST",
      url: this.url(`/publications/${snapshotId}/complete`),
      headers: { ...this.authHeaders(), "Content-Length": "0" },
      timeoutMs: this.config.timeoutMs,
    });
    if (response.status !== 200) throw parseFailure(response.status, response.text);
    try {
      const parsed = JSON.parse(response.text) as { status?: unknown };
      return { status: typeof parsed.status === "string" ? parsed.status : "published" };
    } catch {
      return { status: "published" };
    }
  }

  /** Best-effort liveness. A failing heartbeat never changes the outcome of a run. */
  async heartbeat(payload: Record<string, unknown>): Promise<boolean> {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    try {
      const response = await this.transport.json({
        method: "PUT",
        url: this.url("/publisher/heartbeat"),
        headers: {
          ...this.authHeaders(),
          "Content-Type": JSON_CONTENT_TYPE,
          "Content-Length": String(body.byteLength),
        },
        body,
        timeoutMs: this.config.timeoutMs,
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async status(): Promise<{ status: number; body: unknown }> {
    const response = await this.transport.json({
      method: "GET",
      url: this.url("/publication-status"),
      headers: this.authHeaders(),
      timeoutMs: this.config.timeoutMs,
    });
    let body: unknown = response.text;
    try {
      body = JSON.parse(response.text);
    } catch {
      // Keep the raw text; `status` prints whatever the broker actually said.
    }
    return { status: response.status, body };
  }
}
