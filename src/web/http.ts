import type { IncomingMessage, ServerResponse } from "node:http";

/** Minimal request and response helpers, so the app runs on Vercel and on plain Node without a framework. */

export interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  cookies: Map<string, string>;
  /** Origin the app is served from, e.g. https://undercut.vercel.app. */
  baseUrl: string;
  rawBody(): Promise<Buffer>;
  form(): Promise<URLSearchParams>;
}

const MAX_BODY = 2 * 1024 * 1024;

export function toRequest(req: IncomingMessage, publicUrl?: string): Request {
  const url = new URL(req.url ?? "/", "http://local");
  // vercel.json rewrites every path to one function and passes the original path along.
  const rewritten = url.searchParams.get("__path");
  url.searchParams.delete("__path");
  const path = rewritten !== null ? `/${rewritten.replace(/^\/+/, "")}` : url.pathname;
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost");
  let body: Promise<Buffer> | null = null;
  const rawBody = () =>
    (body ??= new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, "Request too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    }));
  return {
    method: (req.method ?? "GET").toUpperCase(),
    path: path.replace(/\/+$/, "") || "/",
    query: url.searchParams,
    headers: req.headers,
    cookies: parseCookies(req.headers.cookie),
    baseUrl: publicUrl?.replace(/\/+$/, "") || `${proto}://${host}`,
    rawBody,
    form: async () => new URLSearchParams((await rawBody()).toString("utf8")),
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try {
      out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
    } catch {
      // Ignore a malformed cookie rather than failing the request.
    }
  }
  return out;
}

export interface Reply {
  status: number;
  headers: Record<string, string | string[]>;
  body: string | Buffer;
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
};

export const html = (body: string, status = 200, headers: Record<string, string | string[]> = {}): Reply => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers },
  body,
});

export const json = (data: unknown, status = 200): Reply => ({
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(data),
});

export const text = (body: string, status = 200, contentType = "text/plain; charset=utf-8", extra: Record<string, string> = {}): Reply => ({
  status,
  headers: { "content-type": contentType, "cache-control": "no-store", ...extra },
  body,
});

export const redirect = (location: string, headers: Record<string, string | string[]> = {}): Reply => ({
  status: 303,
  headers: { location, "cache-control": "no-store", ...headers },
  body: "",
});

export function cookie(name: string, value: string, options: { maxAge?: number; path?: string; secure?: boolean } = {}): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? "/"}`,
    "HttpOnly",
    "SameSite=Lax",
    options.secure === false ? "" : "Secure",
    options.maxAge !== undefined ? `Max-Age=${options.maxAge}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function send(res: ServerResponse, reply: Reply): void {
  res.statusCode = reply.status;
  for (const [k, v] of Object.entries(reply.headers)) res.setHeader(k, v);
  res.end(reply.body);
}

export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
