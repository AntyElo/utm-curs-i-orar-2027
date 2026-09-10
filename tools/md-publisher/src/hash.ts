/**
 * Hashing helpers. Streaming where the input can be large, so a 25 MB PDF never has to be
 * resident in memory just to be identified.
 */

import crypto from "node:crypto";
import fs from "node:fs";

export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function newOperationId(): string {
  return crypto.randomUUID();
}
