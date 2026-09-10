/**
 * A `Transport` that wires the real MD Publisher to the real broker Worker and to a scripted
 * FCIM, without opening a socket.
 *
 * Broker requests go through the Worker's own routing and its R2 double, so a publisher test
 * exercises the same authorization, validation and CAS behaviour production would. FCIM is
 * scripted per test: no automated test may ever contact the real site.
 */

import fs from "node:fs";

import worker from "../../worker/src/index";
import { CANONICAL_PAGE_API_URL } from "../../worker-shared/fcim-policy";
import type {
  HttpResponseLike,
  JsonRequest,
  JsonResponse,
  Transport,
} from "../../tools/md-publisher/src/types";
import type { WorkerHarness } from "./worker-doubles";

export const FAKE_BROKER_ORIGIN = "https://broker.test";

export interface ScriptedResponse {
  status: number;
  body?: Uint8Array | string | null;
  headers?: Record<string, string>;
  /** Throw instead of answering, to model a timeout or a reset connection. */
  fail?: Error;
}

export interface FcimScript {
  page: (headers: Record<string, string>, call: number) => ScriptedResponse;
  pdf: (url: string, headers: Record<string, string>, call: number) => ScriptedResponse;
}

export interface TransportLog {
  fcim: { url: string; headers: Record<string, string> }[];
  broker: { method: string; path: string }[];
}

function streamOf(body: Uint8Array | string | null | undefined): ReadableStream<Uint8Array> | null {
  if (body === null || body === undefined) return null;
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export interface TransportOptions {
  /** Wrap every broker call, e.g. to inject a failure or a race. */
  interceptBroker?: (
    request: { method: string; path: string },
    forward: () => Promise<JsonResponse>,
  ) => Promise<JsonResponse>;
  /** Wrap every upload, e.g. to model a timeout after the broker already stored the body. */
  interceptUpload?: (
    request: { path: string },
    forward: () => Promise<JsonResponse>,
  ) => Promise<JsonResponse>;
}

export function createTestTransport(
  harness: WorkerHarness,
  script: FcimScript,
  options: TransportOptions = {},
): { transport: Transport; log: TransportLog } {
  const log: TransportLog = { fcim: [], broker: [] };
  let pageCalls = 0;
  const pdfCalls = new Map<string, number>();

  async function toJsonResponse(response: Response): Promise<JsonResponse> {
    return { status: response.status, headers: response.headers, text: await response.text() };
  }

  const transport: Transport = {
    async get(url, headers): Promise<HttpResponseLike> {
      log.fcim.push({ url, headers: { ...headers } });
      const scripted =
        url === CANONICAL_PAGE_API_URL
          ? script.page(headers, pageCalls++)
          : script.pdf(url, headers, (pdfCalls.set(url, (pdfCalls.get(url) ?? 0) + 1), pdfCalls.get(url)! - 1));
      if (scripted.fail) throw scripted.fail;
      return {
        status: scripted.status,
        headers: new Headers(scripted.headers ?? {}),
        body: streamOf(scripted.body),
        cancel: async () => {},
      };
    },

    async json(request: JsonRequest): Promise<JsonResponse> {
      const path = request.url.slice(FAKE_BROKER_ORIGIN.length);
      log.broker.push({ method: request.method, path });
      const forward = async () => {
        const httpRequest = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body ? Buffer.from(request.body) : undefined,
        });
        return toJsonResponse(await worker.fetch(httpRequest, harness.env, harness.ctx));
      };
      return options.interceptBroker
        ? options.interceptBroker({ method: request.method, path }, forward)
        : forward();
    },

    async upload(input): Promise<JsonResponse> {
      const path = input.url.slice(FAKE_BROKER_ORIGIN.length);
      log.broker.push({ method: "PUT", path });
      const forward = async () => {
        const body = fs.readFileSync(input.filePath);
        const httpRequest = new Request(input.url, {
          method: "PUT",
          headers: { ...input.headers, "Content-Length": String(input.size) },
          body,
        });
        return toJsonResponse(await worker.fetch(httpRequest, harness.env, harness.ctx));
      };
      return options.interceptUpload ? options.interceptUpload({ path }, forward) : forward();
    },
  };

  return { transport, log };
}
