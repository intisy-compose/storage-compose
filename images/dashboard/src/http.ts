import type { IncomingMessage, ServerResponse } from "node:http";

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

export async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new RequestError(400, "the request body is not JSON");
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/** A browser marked the request as coming from another site, by `Sec-Fetch-Site` or by an `Origin` whose host is not the one asked. */
function isCrossSite(request: IncomingMessage): boolean {
  const fetchSite = header(request, "sec-fetch-site");
  if (fetchSite !== undefined && fetchSite !== "same-origin") return true;
  const origin = header(request, "origin");
  if (origin === undefined) return false;
  const host = header(request, "host")?.toLowerCase();
  return !host || originHost(origin) !== host;
}

function isJson(request: IncomingMessage): boolean {
  return header(request, "content-type")?.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * Refuses a write another site could have sent from a page the human partner has open.
 * @implNote A plain form POST carries no JSON content type, and a cross-site `fetch` with one needs a CORS preflight that nothing here answers, so requiring JSON closes what the Origin and Sec-Fetch-Site checks leave to older browsers.
 */
export function crossSiteRefusal(request: IncomingMessage): RequestError | null {
  if (request.method === "GET" || request.method === "HEAD") return null;
  if (isCrossSite(request)) return new RequestError(403, "a write from another site is refused");
  if (!isJson(request)) return new RequestError(415, "a write must be sent as application/json");
  return null;
}

export function refuseCrossSiteWrite(request: IncomingMessage): void {
  const refusal = crossSiteRefusal(request);
  if (refusal) throw refusal;
}
