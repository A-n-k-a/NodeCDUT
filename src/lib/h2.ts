import http2 from "node:http2";
import { TextDecoder } from "node:util";
import { Agent, setGlobalDispatcher } from "undici";

const IS_SERVERLESS =
  !!process.env.VERCEL ||
  !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
  !!process.env.TENCENTCLOUD_RUNENV ||
  !!process.env.EFUNCTION;

if (IS_SERVERLESS) {
  setGlobalDispatcher(
    new Agent({
      connect: { timeout: 30_000 },
      bodyTimeout: 45_000,
      headersTimeout: 15_000,
    })
  );
}

const {
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_STATUS,
  HTTP2_HEADER_CONTENT_LENGTH,
  HTTP2_HEADER_COOKIE,
} = http2.constants;

export interface H2Response {
  status: number;
  ok: boolean;
  headers: Headers;
  url: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface H2RequestInit {
  method?: string;
  headers?: Record<string, string> | Headers;
  body?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface PoolEntry {
  client: http2.ClientHttp2Session;
  refCount: number;
}

const clientPool = new Map<string, PoolEntry>();

function acquireClient(origin: string): http2.ClientHttp2Session {
  const existing = clientPool.get(origin);
  if (
    existing &&
    !existing.client.closed &&
    !existing.client.destroyed &&
    !existing.client.connecting
  ) {
    existing.refCount++;
    return existing.client;
  }
  if (existing) {
    existing.client.destroy();
    clientPool.delete(origin);
  }
  const client = http2.connect(origin, {
    settings: { enablePush: false },
  });
  client.on("error", () => {
    client.destroy();
    clientPool.delete(origin);
  });
  client.on("close", () => {
    clientPool.delete(origin);
  });
  clientPool.set(origin, { client, refCount: 1 });
  return client;
}

function releaseClient(origin: string): void {
  const entry = clientPool.get(origin);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0 && entry.client.closed) {
    clientPool.delete(origin);
  }
}

function headersToRecord(
  headers: Record<string, string> | Headers | undefined
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

export function h2Fetch(
  url: string,
  init: H2RequestInit = {}
): Promise<H2Response> {
  if (IS_SERVERLESS) {
    return nodeFetchFallback(url, init);
  }
  return doH2Fetch(url, init).catch((err) => {
    if (isH2Unsupported(err)) {
      return nodeFetchFallback(url, init);
    }
    throw err;
  });
}

function isH2Unsupported(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = (err.message || "").toLowerCase();
  return (
    msg.includes("unsupported protocol") ||
    msg.includes("econnreset") ||
    msg.includes("alpn") ||
    msg.includes("nghttp2") ||
    msg.includes("err_http2") ||
    msg.includes("protocol error") ||
    msg.includes("socket hang up") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("ehostunreach") ||
    msg.includes("epipe") ||
    err.name === "AbortError"
  );
}

async function nodeFetchFallback(
  url: string,
  init: H2RequestInit
): Promise<H2Response> {
  const headers = headersToRecord(init.headers);
  if (!headers["accept"]) {
    headers["accept"] = "text/html,application/xhtml+xml,*/*;q=0.8";
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? 15000
  );
  let signal: AbortSignal | undefined = init.signal;
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort());
  }
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body:
        init.body instanceof Buffer
          ? new Uint8Array(init.body)
          : init.body !== undefined
            ? init.body
            : undefined,
      signal: controller.signal,
      redirect: "manual",
    });
    return toH2Response(res, url);
  } finally {
    clearTimeout(timer);
  }
}

async function toH2Response(
  res: Response,
  url: string
): Promise<H2Response> {
  const buf = Buffer.from(await res.arrayBuffer());
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    if (key === "set-cookie") return;
    headers.set(key, value);
  });
  for (const sc of res.headers.getSetCookie()) {
    headers.append("set-cookie", sc);
  }
  return {
    status: res.status,
    ok: res.ok,
    headers,
    url,
    text: async () => new TextDecoder().decode(buf),
    json: async () => JSON.parse(new TextDecoder().decode(buf)),
    arrayBuffer: async () => buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength
    ) as ArrayBuffer,
  };
}

function doH2Fetch(url: string, init: H2RequestInit): Promise<H2Response> {
  const u = new URL(url);
  const origin = u.origin;
  const client = acquireClient(origin);

  return new Promise<H2Response>((resolve, reject) => {
    const headerRecord = headersToRecord(init.headers);
    const reqHeaders: http2.OutgoingHttpHeaders = {
      [HTTP2_HEADER_METHOD]: init.method ?? "GET",
      [HTTP2_HEADER_PATH]: u.pathname + u.search,
      ...headerRecord,
    };

    if (init.body !== undefined) {
      const bodyBuf = Buffer.isBuffer(init.body)
        ? init.body
        : Buffer.from(String(init.body));
      if (!reqHeaders[HTTP2_HEADER_CONTENT_LENGTH]) {
        reqHeaders[HTTP2_HEADER_CONTENT_LENGTH] = String(bodyBuf.length);
      }
      const stream = client.request(reqHeaders, { waitForTrailers: true });
      setupStream(stream, u, init, bodyBuf, resolve, reject, origin);
      stream.write(bodyBuf);
      stream.end();
    } else {
      const stream = client.request(reqHeaders);
      setupStream(stream, u, init, undefined, resolve, reject, origin);
      stream.end();
    }
  });
}

function setupStream(
  stream: http2.ClientHttp2Stream,
  u: URL,
  init: H2RequestInit,
  _body: Buffer | undefined,
  resolve: (r: H2Response) => void,
  reject: (e: Error) => void,
  origin: string
): void {
  const chunks: Buffer[] = [];
  let status = 0;
  const respHeaders = new Headers();

  const timeout = setTimeout(() => {
    stream.destroy(new Error("H2 request timeout"));
  }, init.timeoutMs ?? 15000);

  if (init.signal) {
    if (init.signal.aborted) {
      stream.destroy(new Error("aborted"));
    } else {
      init.signal.addEventListener(
        "abort",
        () => stream.destroy(new Error("aborted")),
        { once: true }
      );
    }
  }

  stream.on("response", (h) => {
    status = Number(h[HTTP2_HEADER_STATUS] ?? 0);
    for (const [key, value] of Object.entries(h)) {
      if (key.startsWith(":")) continue;
      if (Array.isArray(value)) {
        for (const v of value) respHeaders.append(key, String(v));
      } else if (value !== undefined) {
        if (key === "set-cookie") {
          respHeaders.append(key, String(value));
        } else {
          respHeaders.set(key, String(value));
        }
      }
    }
  });

  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => {
    clearTimeout(timeout);
    const buf = Buffer.concat(chunks);
    const finalUrl = u.toString();
    resolve({
      status,
      ok: status >= 200 && status < 300,
      headers: respHeaders,
      url: finalUrl,
      text: async () => buf.toString("utf8"),
      json: async () => JSON.parse(buf.toString("utf8")),
      arrayBuffer: async () =>
        buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength
        ) as ArrayBuffer,
    });
    releaseClient(origin);
  });
  stream.on("error", (err) => {
    clearTimeout(timeout);
    releaseClient(origin);
    reject(err);
  });
}

export function getH2PoolSize(): number {
  return clientPool.size;
}
