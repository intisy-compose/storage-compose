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

/** The host names a request may be addressed to, lowercased and without a port. */
export type HostAllowlist = ReadonlySet<string>;

const plainAuthority = /^[^\s/\\?#@]+$/;

/** A Host header's name, lowercased and without its port; null for anything but a plain `name[:port]`. */
function hostNameOf(authority: string): string | null {
  if (!plainAuthority.test(authority)) return null;
  try {
    return new URL(`http://${authority}`).hostname;
  } catch {
    return null;
  }
}

export function hostAllowlist(names: readonly string[]): HostAllowlist {
  return new Set(names.map(hostNameOf).filter((name): name is string => name !== null));
}

/**
 * Refuses a request addressed to a name the dashboard does not answer to, reads included.
 * @implNote A page on another site can rebind its own name to 127.0.0.1 and then reach the loopback site
 * with that name in Host and a matching Origin, which the cross-site check takes for same-origin; only the
 * name tells the two apart. The port is not compared: the attacker picks the name, never the port.
 */
export function hostRefusal(request: IncomingMessage, allowlist: HostAllowlist): RequestError | null {
  const host = header(request, "host");
  if (!host) return new RequestError(421, "a request without a Host header is refused");
  const name = hostNameOf(host);
  if (name !== null && allowlist.has(name)) return null;
  return new RequestError(421, `this dashboard does not answer to ${host}; add the name to DASHBOARD_EXTRA_HOSTS in config.env`);
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
