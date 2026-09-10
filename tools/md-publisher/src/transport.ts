/**
 * The publisher's only two ways of touching the network.
 *
 * `get` and `json` are ordinary bounded fetches. `upload` deliberately is not: it uses the Node
 * HTTP client directly so the request carries an exact `Content-Length` while the body is piped
 * from disk. That combination is what lets the broker enforce a real byte count without the
 * laptop ever holding a 25 MB PDF in memory.
 *
 * Everything is injected as a `Transport`, so tests drive the publisher end to end without a
 * single socket being opened.
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";

import type { HttpResponseLike, JsonRequest, JsonResponse, Transport } from "./types";

const USER_AGENT = "fcim-md-publisher/1.0 (+transport-only)";

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

async function get(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpResponseLike> {
  const response = await fetch(url, {
    method: "GET",
    headers: { "User-Agent": USER_AGENT, ...headers },
    // Redirects are resolved by the caller against the FCIM policy, never followed implicitly.
    redirect: "manual",
    signal: timeoutSignal(timeoutMs),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: response.body as ReadableStream<Uint8Array> | null,
    cancel: async () => {
      await response.body?.cancel().catch(() => {});
    },
  };
}

async function json(request: JsonRequest): Promise<JsonResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: { "User-Agent": USER_AGENT, ...request.headers },
    body: request.body ? Buffer.from(request.body) : undefined,
    redirect: "manual",
    signal: timeoutSignal(request.timeoutMs),
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

function upload(input: {
  url: string;
  headers: Record<string, string>;
  filePath: string;
  size: number;
  timeoutMs: number;
}): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(input.url);
    const client = target.protocol === "http:" ? http : https;
    const request = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: "PUT",
        headers: {
          "User-Agent": USER_AGENT,
          ...input.headers,
          "Content-Length": String(input.size),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === "string") headers.set(name, value);
            else if (Array.isArray(value)) headers.set(name, value.join(", "));
          }
          resolve({
            status: response.statusCode ?? 0,
            headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.setTimeout(input.timeoutMs, () => {
      request.destroy(new Error(`Upload to ${target.pathname} timed out after ${input.timeoutMs} ms`));
    });
    request.on("error", reject);

    const body = fs.createReadStream(input.filePath);
    body.on("error", (err) => {
      request.destroy(err);
      reject(err);
    });
    body.pipe(request);
  });
}

export const nodeTransport: Transport = { get, json, upload };
