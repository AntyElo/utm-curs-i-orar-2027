/**
 * Strict parser for `current.json`.
 *
 * `current.json` is the one mutable object in the bucket and the only thing that decides which
 * snapshot Render is allowed to read, so it is parsed as JSON and validated field by field —
 * never pattern-matched. A document that does not satisfy every rule below yields no fields at
 * all: there is no partial recovery, because a partially-trusted pointer is exactly how a spoofed
 * `snapshot_id` would get through.
 *
 * Both accepted formats are deliberately flat: the strict eight-field split-publication pointer
 * and the exact four-field pointer emitted by the original monolithic broker. Rejecting every
 * nested value removes the whole class of
 * "real field at the top, decoy field one level down" documents, and it is also what makes the
 * duplicate-key check below sound: once every value has been validated, no value can contain a
 * quote character, so a second occurrence of a key name in the raw text is a duplicate key.
 */

import { snapshotManifestKey } from "./keys";
import type { CurrentPointer, LegacyCurrentPointer, ParsedCurrentPointer } from "./types";

/** A pointer is a few hundred bytes; anything larger is not our document. */
export const MAX_CURRENT_POINTER_BYTES = 4096;

/** Collision-safe snapshot identifier: ISO instant with separators replaced, plus random suffix. */
export const SNAPSHOT_ID_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;

const ISO_INSTANT_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** WordPress `modified_gmt` is a naive GMT timestamp without a zone designator. */
export const WP_GMT_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/**
 * Keep a WordPress `modified_gmt` only in the exact shape the pointer contract allows.
 * Anything else becomes `null` rather than being written into a document our own parser
 * would then reject.
 */
export function normalizePageModifiedGmt(value: unknown): string | null {
  return typeof value === "string" && WP_GMT_REGEX.test(value) ? value : null;
}

const STRICT_REQUIRED_KEYS = [
  "schema_version",
  "snapshot_id",
  "updated_at",
  "published_at",
  "manifest_r2_key",
  "page_modified_gmt",
  "page_id",
  "pdf_count",
] as const;

const LEGACY_REQUIRED_KEYS = [
  "schema_version",
  "snapshot_id",
  "updated_at",
  "manifest_r2_key",
] as const;

export type ParseCurrentPointerResult =
  | { ok: true; pointer: ParsedCurrentPointer; format: "strict" | "legacy" }
  | { ok: false; error: string };

function fail(error: string): ParseCurrentPointerResult {
  return { ok: false, error };
}

/**
 * Count unescaped `"key":` occurrences. Safe to run only after every value has been validated,
 * at which point no value contains a quote and therefore no occurrence can come from a value.
 */
function countKeyOccurrences(text: string, key: string): number {
  const needle = `"${key}"`;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    from = idx + needle.length;
    if (idx > 0 && text[idx - 1] === "\\") continue;
    let after = from;
    while (after < text.length && (text[after] === " " || text[after] === "\t" || text[after] === "\n" || text[after] === "\r")) {
      after++;
    }
    if (text[after] === ":") count++;
  }
  return count;
}

/**
 * Parse and fully validate the raw body of `current.json`, accepting no shape other than the
 * strict split-publication schema or the exact legacy four-field schema.
 */
export function parseCurrentPointer(text: string): ParseCurrentPointerResult {
  if (typeof text !== "string" || text.length === 0) {
    return fail("current.json is empty");
  }
  if (text.length > MAX_CURRENT_POINTER_BYTES) {
    return fail(`current.json exceeds ${MAX_CURRENT_POINTER_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return fail(`current.json is not valid JSON: ${(err as Error).message}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("current.json must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  const keys = Object.keys(obj);
  const requiredKeys =
    keys.length === STRICT_REQUIRED_KEYS.length && STRICT_REQUIRED_KEYS.every((key) => Object.hasOwn(obj, key))
      ? STRICT_REQUIRED_KEYS
      : keys.length === LEGACY_REQUIRED_KEYS.length && LEGACY_REQUIRED_KEYS.every((key) => Object.hasOwn(obj, key))
        ? LEGACY_REQUIRED_KEYS
        : null;
  if (!requiredKeys) {
    return fail(
      `current.json must have exactly ${STRICT_REQUIRED_KEYS.length} fields (strict) or exactly ${LEGACY_REQUIRED_KEYS.length} fields (legacy)`,
    );
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(obj, key)) {
      return fail(`current.json is missing required field ${key}`);
    }
  }

  // No nesting: a pointer carries scalars only, so no decoy field can hide one level down.
  for (const key of keys) {
    const value = obj[key];
    if (value !== null && typeof value !== "string" && typeof value !== "number") {
      return fail(`current.json field ${key} must be a string, number or null`);
    }
  }

  if (obj.schema_version !== 1) {
    return fail(`current.json schema_version must be 1, got ${JSON.stringify(obj.schema_version)}`);
  }

  const snapshotId = obj.snapshot_id;
  if (typeof snapshotId !== "string" || !SNAPSHOT_ID_REGEX.test(snapshotId)) {
    return fail("current.json snapshot_id is not a valid snapshot identifier");
  }

  const updatedAt = obj.updated_at;
  if (typeof updatedAt !== "string" || !ISO_INSTANT_REGEX.test(updatedAt)) {
    return fail("current.json updated_at must be an ISO-8601 UTC instant");
  }

  const manifestKey = obj.manifest_r2_key;
  if (typeof manifestKey !== "string" || manifestKey !== snapshotManifestKey(snapshotId)) {
    return fail("current.json manifest_r2_key does not address this snapshot's manifest");
  }

  for (const key of requiredKeys) {
    if (countKeyOccurrences(text, key) !== 1) {
      return fail(`current.json declares field ${key} more than once`);
    }
  }

  if (requiredKeys === LEGACY_REQUIRED_KEYS) {
    const pointer: LegacyCurrentPointer = {
      schema_version: 1,
      snapshot_id: snapshotId,
      updated_at: updatedAt,
      published_at: updatedAt,
      manifest_r2_key: manifestKey,
    };
    return { ok: true, pointer, format: "legacy" };
  }

  const publishedAt = obj.published_at;
  if (typeof publishedAt !== "string" || !ISO_INSTANT_REGEX.test(publishedAt)) {
    return fail("current.json published_at must be an ISO-8601 UTC instant");
  }

  const pageModifiedGmt = obj.page_modified_gmt;
  if (pageModifiedGmt !== null && (typeof pageModifiedGmt !== "string" || !WP_GMT_REGEX.test(pageModifiedGmt))) {
    return fail("current.json page_modified_gmt must be a WordPress GMT timestamp or null");
  }

  const pageId = obj.page_id;
  if (pageId !== null && (typeof pageId !== "number" || !Number.isSafeInteger(pageId) || pageId <= 0)) {
    return fail("current.json page_id must be a positive integer or null");
  }

  const pdfCount = obj.pdf_count;
  if (typeof pdfCount !== "number" || !Number.isSafeInteger(pdfCount) || pdfCount < 0) {
    return fail("current.json pdf_count must be a non-negative integer");
  }

  return {
    ok: true,
    format: "strict",
    pointer: {
      schema_version: 1,
      snapshot_id: snapshotId,
      updated_at: updatedAt,
      published_at: publishedAt,
      manifest_r2_key: manifestKey,
      page_modified_gmt: pageModifiedGmt,
      page_id: pageId,
      pdf_count: pdfCount,
    },
  };
}

/** Build the pointer document for a snapshot that has just been proven complete. */
export function buildCurrentPointer(input: {
  snapshotId: string;
  publishedAt: string;
  pageModifiedGmt: string | null;
  pageId: number | null;
  pdfCount: number;
}): CurrentPointer {
  return {
    schema_version: 1,
    snapshot_id: input.snapshotId,
    updated_at: input.publishedAt,
    published_at: input.publishedAt,
    manifest_r2_key: snapshotManifestKey(input.snapshotId),
    page_modified_gmt: input.pageModifiedGmt,
    page_id: input.pageId,
    pdf_count: input.pdfCount,
  };
}
