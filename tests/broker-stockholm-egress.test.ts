/** Gate E.7 coverage for the private Stockholm HTTP Service Binding transport. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stockholmEgressWorker from "../worker-egress/src/index";
import {
  CANONICAL_PAGE_API_URL,
  FCIM_EGRESS_ERROR_HEADER,
  FCIM_EGRESS_INTERNAL_ORIGIN,
  FCIM_EGRESS_SERVICE_HEADER,
  FCIM_EGRESS_SERVICE_VALUE,
  FCIM_PLACEMENT_HEADER,
  FCIM_UPSTREAM_CF_RAY_HEADER,
} from "../worker-shared/fcim-policy";
import { isRetryableUpstreamFailure } from "../worker/src/http";
import worker from "../worker/src/index";
import { pendingDescriptorKey, snapshotManifestKey, snapshotPageApiKey } from "../worker/src/keys";
import { fetchPageApi, PageApiError } from "../worker/src/page-api";
import { fetchOfficialPdf, PdfFetchError } from "../worker/src/pdf-fetch";
import { runDiscovery, runPdfIngest } from "../worker/src/publisher";
import type {
  CurrentPointer,
  IngestPdfJob,
  PendingDescriptor,
  ServiceBinding,
  SnapshotManifest,
} from "../worker/src/types";
import { createHarness, drainQueue } from "./helpers/worker-doubles";

const PAGE_API_URL = CANONICAL_PAGE_API_URL;
const PDF_URL =
  "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/orar-anul-i-curent.pdf";
const REDIRECTED_PDF_URL =
  "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/orar-anul-i-actualizat.pdf";

function upstreamFetch(
  implementation: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    implementation(String(input), init),
  );
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}

function internalRequest(
  path: "/page-api" | "/pdf",
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return stockholmEgressWorker.fetch(
    new Request(`${FCIM_EGRESS_INTERNAL_ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ schema_version: 1, ...body }),
    }),
  );
}

function pagePayload(pdfUrls: string[]): string {
  return JSON.stringify([
    {
      id: 1739,
      modified_gmt: "2026-09-09T01:20:00",
      content: {
        rendered: pdfUrls.map((url) => `<a href="${url}">orar</a>`).join("\n"),
      },
    },
  ]);
}

function serviceHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set(FCIM_EGRESS_SERVICE_HEADER, FCIM_EGRESS_SERVICE_VALUE);
  return headers;
}

class StaticServiceBinding implements ServiceBinding {
  readonly requests: Request[] = [];

  constructor(private readonly respond: (request: Request) => Response | Promise<Response>) {}

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    this.requests.push(request.clone());
    return this.respond(request);
  }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Stockholm backend fetch-handler boundary", () => {
  it("exports a default fetch handler for HTTP Service Binding semantics", () => {
    expect(stockholmEgressWorker).toEqual(expect.objectContaining({ fetch: expect.any(Function) }));
    expect(Object.keys(stockholmEgressWorker)).toEqual(["fetch"]);
  });

  it("has no generic proxy route", async () => {
    const upstream = upstreamFetch(() => new Response("must not be called"));
    const response = await stockholmEgressWorker.fetch(
      new Request(`${FCIM_EGRESS_INTERNAL_ORIGIN}/proxy`, { method: "POST" }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get(FCIM_EGRESS_ERROR_HEADER)).toBe("invalid-contract");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("bounds the internal request body while reading it", async () => {
    const upstream = upstreamFetch(() => new Response("must not be called"));
    const response = await stockholmEgressWorker.fetch(
      new Request(`${FCIM_EGRESS_INTERNAL_ORIGIN}/page-api`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: " ".repeat(8 * 1024 + 1),
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get(FCIM_EGRESS_ERROR_HEADER)).toBe("invalid-contract");
    expect(await response.json()).toEqual({ error: "internal contract is too large" });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("Stockholm backend Page API operation", () => {
  it("uses the exact endpoint without accepting a caller-supplied URL", async () => {
    const upstream = upstreamFetch(() =>
      new Response("[]", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: '"page-v1"',
          "CF-Ray": "page-ray-ARN",
          "Set-Cookie": "not-forwarded=1",
          "X-Untrusted": "not-forwarded",
        },
      }),
    );

    const response = await internalRequest("/page-api", {}, { "cf-placement": "remote-ARN" });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][0]).toBe(PAGE_API_URL);
    expect(upstream.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "manual" });
    const requestHeaders = new Headers(upstream.mock.calls[0][1]?.headers);
    expect(requestHeaders.get("Accept")).toBe("application/json");
    expect(requestHeaders.get("User-Agent")).toBeNull();
    expect(response.headers.get(FCIM_UPSTREAM_CF_RAY_HEADER)).toBe("page-ray-ARN");
    expect(response.headers.get(FCIM_PLACEMENT_HEADER)).toBe("remote-ARN");
    expect(response.headers.get("ETag")).toBe('"page-v1"');
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("X-Untrusted")).toBeNull();
  });

  it("rejects a caller-supplied Page API target", async () => {
    const upstream = upstreamFetch(() => new Response("must not be called"));
    const response = await internalRequest("/page-api", { target_url: PAGE_API_URL });

    expect(response.status).toBe(400);
    expect(response.headers.get(FCIM_EGRESS_ERROR_HEADER)).toBe("invalid-contract");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a redirect deterministically", async () => {
    upstreamFetch(() => new Response(null, { status: 302, headers: { Location: PAGE_API_URL } }));
    const response = await internalRequest("/page-api", {});

    expect(response.status).toBe(400);
    expect(response.headers.get(FCIM_EGRESS_ERROR_HEADER)).toBe("page-api-redirect");
  });

  for (const status of [403, 429, 500]) {
    it(`propagates upstream HTTP ${status}`, async () => {
      upstreamFetch(() => new Response(null, { status, headers: { "CF-Ray": `ray-${status}-ARN` } }));
      const response = await internalRequest("/page-api", {});

      expect(response.status).toBe(status);
      expect(response.headers.get(FCIM_EGRESS_ERROR_HEADER)).toBeNull();
      expect(response.headers.get(FCIM_UPSTREAM_CF_RAY_HEADER)).toBe(`ray-${status}-ARN`);
    });
  }
});

describe("Stockholm backend PDF operation", () => {
  it("allows a dynamic official PDF URL", async () => {
    upstreamFetch(() =>
      new Response(new TextEncoder().encode("%PDF-live"), {
        status: 200,
        headers: { "Content-Type": "application/pdf", "Content-Length": "9" },
      }),
    );

    const response = await internalRequest("/pdf", { target_url: PDF_URL });

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("%PDF-live");
  });

  for (const [name, target] of [
    ["foreign host", "https://evil.example/wp-content/uploads/sites/24/2026/09/a.pdf"],
    ["lookalike host", "https://fcim.utm.md.evil.example/wp-content/uploads/sites/24/2026/09/a.pdf"],
    ["credentials", "https://user:pass@fcim.utm.md/wp-content/uploads/sites/24/2026/09/a.pdf"],
    ["port", "https://fcim.utm.md:444/wp-content/uploads/sites/24/2026/09/a.pdf"],
    ["query", `${PDF_URL}?download=1`],
    ["fragment", `${PDF_URL}#page=1`],
    ["raw traversal", "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/../a.pdf"],
    ["encoded traversal", "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/%2e%2e/a.pdf"],
    ["unsafe filename", "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/.hidden.pdf"],
    ["non-PDF path", "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/a.txt"],
  ] as const) {
    it(`independently rejects a PDF ${name}`, async () => {
      const upstream = upstreamFetch(() => new Response("must not be called"));
      const response = await internalRequest("/pdf", { target_url: target });

      expect(response.status).toBe(400);
      expect(response.headers.get(FCIM_EGRESS_ERROR_HEADER)).toBe("invalid-url");
      expect(upstream).not.toHaveBeenCalled();
    });
  }

  it("accepts only an independently validated official redirect", async () => {
    const upstream = upstreamFetch((url) => {
      if (url === PDF_URL) {
        return new Response(null, { status: 302, headers: { Location: REDIRECTED_PDF_URL } });
      }
      return new Response(new TextEncoder().encode("%PDF-redirected"), { status: 200 });
    });

    const response = await internalRequest("/pdf", { target_url: PDF_URL });

    expect(response.status).toBe(200);
    expect(upstream.mock.calls.map((call) => call[0])).toEqual([PDF_URL, REDIRECTED_PDF_URL]);
  });

  it("rejects a foreign redirect as a deterministic security error", async () => {
    upstreamFetch(() =>
      new Response(null, { status: 302, headers: { Location: "https://evil.example/file.pdf" } }),
    );
    const response = await internalRequest("/pdf", { target_url: PDF_URL });

    expect(response.status).toBe(400);
    expect(response.headers.get(FCIM_EGRESS_ERROR_HEADER)).toBe("invalid-redirect");
  });

  it("bounds redirect loops", async () => {
    const upstream = upstreamFetch(() =>
      new Response(null, { status: 302, headers: { Location: PDF_URL } }),
    );
    const response = await internalRequest("/pdf", { target_url: PDF_URL });

    expect(response.status).toBe(400);
    expect(response.headers.get(FCIM_EGRESS_ERROR_HEADER)).toBe("invalid-redirect");
    expect(upstream).toHaveBeenCalledTimes(6);
  });

  it("returns before the complete PDF arrives and leaves its body unbuffered", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await gate;
        controller.enqueue(new TextEncoder().encode("%PDF-streamed"));
        controller.close();
      },
    });
    upstreamFetch(() => new Response(source, { status: 200 }));

    const response = await Promise.race([
      internalRequest("/pdf", { target_url: PDF_URL }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("backend buffered the PDF")), 250),
      ),
    ]);
    expect(response.body).not.toBeNull();

    release();
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("%PDF-streamed");
  });
});

describe("main Worker HTTP Service Binding integration", () => {
  it("runDiscovery uses FCIM_EGRESS.fetch and never global FCIM fetch", async () => {
    const directFetch = upstreamFetch(() => {
      throw new Error("main Worker attempted direct FCIM fetch");
    });
    const binding = new StaticServiceBinding(
      () =>
        new Response(pagePayload([PDF_URL]), {
          status: 200,
          headers: serviceHeaders({ "Content-Type": "application/json" }),
        }),
    );
    const h = createHarness({ FCIM_EGRESS: binding });

    const result = await runDiscovery(h.env);

    expect(result.outcome).toBe("scheduled");
    expect(binding.requests).toHaveLength(1);
    expect(binding.requests[0].url).toBe(`${FCIM_EGRESS_INTERNAL_ORIGIN}/page-api`);
    expect(binding.requests[0].method).toBe("POST");
    expect(await binding.requests[0].json()).toEqual({ schema_version: 1 });
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("runPdfIngest uses FCIM_EGRESS.fetch and never global FCIM fetch", async () => {
    const pageBinding = new StaticServiceBinding(
      () =>
        new Response(pagePayload([PDF_URL]), {
          status: 200,
          headers: serviceHeaders({ "Content-Type": "application/json" }),
        }),
    );
    const h = createHarness({ FCIM_EGRESS: pageBinding });
    const discovery = await runDiscovery(h.env);
    const job = h.queue.ofKind("ingest_pdf")[0] as IngestPdfJob;
    expect(discovery.outcome).toBe("scheduled");

    const directFetch = upstreamFetch(() => {
      throw new Error("Queue consumer attempted direct FCIM fetch");
    });
    const pdfBinding = new StaticServiceBinding(
      () =>
        new Response(new TextEncoder().encode("%PDF-service"), {
          status: 200,
          headers: serviceHeaders({
            "Content-Type": "application/pdf",
            "Content-Length": "12",
          }),
        }),
    );
    h.env.FCIM_EGRESS = pdfBinding;

    const result = await runPdfIngest(h.env, job);

    expect(result.outcome).toBe("ingested");
    expect(pdfBinding.requests).toHaveLength(1);
    expect(pdfBinding.requests[0].url).toBe(`${FCIM_EGRESS_INTERNAL_ORIGIN}/pdf`);
    expect(await pdfBinding.requests[0].json()).toEqual({ schema_version: 1, target_url: PDF_URL });
    expect(directFetch).not.toHaveBeenCalled();
  });

  for (const status of [403, 429, 500]) {
    it(`keeps backend HTTP ${status} retryable for 300 seconds without pointer advancement`, async () => {
      const h = createHarness();
      upstreamFetch(() => new Response(null, { status }));
      await h.queue.send({ schema_version: 1, kind: "discover", force: false });

      const result = await drainQueue(h, worker.queue, { maxDeliveries: 1 });

      expect(result.retried).toBe(1);
      expect(result.retryDelays).toEqual([300]);
      expect(h.bucket.has("current.json")).toBe(false);
    });
  }

  it("keeps invalid URLs deterministic and outside the Service Binding", async () => {
    const h = createHarness();
    const error = await fetchOfficialPdf(h.env, "https://evil.example/file.pdf").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PdfFetchError);
    expect(isRetryableUpstreamFailure(error)).toBe(false);
    expect(h.egress.requests).toHaveLength(0);
  });

  it("runs discovery, streamed PDF ingest, finalize, and strict CAS through the backend", async () => {
    const secondPdf =
      "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/orar-anul-ii-curent.pdf";
    const h = createHarness({ FCIM_PAGE_API_URL: PAGE_API_URL });
    upstreamFetch((url) => {
      if (url === PAGE_API_URL) {
        return new Response(pagePayload([PDF_URL, secondPdf]), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: '"page-current"' },
        });
      }
      const bytes = new TextEncoder().encode(`%PDF-${url.endsWith("ii-curent.pdf") ? "II" : "I"}`);
      return new Response(bytes, {
        status: 200,
        headers: { "Content-Type": "application/pdf", "Content-Length": String(bytes.byteLength) },
      });
    });

    const trigger = await worker.fetch(
      new Request("https://broker.local/publish?force=1", {
        method: "POST",
        headers: { Authorization: "Bearer test-secret" },
      }),
      h.env,
      h.ctx,
    );
    expect(trigger.status).toBe(202);
    expect((await drainQueue(h, worker.queue)).retried).toBe(0);

    const pointer = h.bucket.json<CurrentPointer>("current.json")!;
    const descriptor = h.bucket.json<PendingDescriptor>(pendingDescriptorKey(pointer.snapshot_id))!;
    const manifest = h.bucket.json<SnapshotManifest>(snapshotManifestKey(pointer.snapshot_id))!;
    expect(pointer).toMatchObject({ schema_version: 1, pdf_count: 2 });
    expect(h.bucket.has(snapshotPageApiKey(pointer.snapshot_id))).toBe(true);
    expect(descriptor.files).toHaveLength(2);
    expect(manifest.files).toHaveLength(2);
    expect(h.egress.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/page-api",
      "/pdf",
      "/pdf",
    ]);
  });
});

describe("main transport error normalization", () => {
  it("rejects a backend Page API redirect without retrying it", async () => {
    const h = createHarness();
    upstreamFetch(() => new Response(null, { status: 302, headers: { Location: PAGE_API_URL } }));

    const error = await fetchPageApi(h.env, PAGE_API_URL).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PageApiError);
    expect((error as Error).message).toMatch(/redirect/i);
    expect(isRetryableUpstreamFailure(error)).toBe(false);
  });
});
