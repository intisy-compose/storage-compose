import { request as httpRequest } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { tailnetProxy, tailscaleSocket } from "./settings.js";

export interface WhoIs {
  loginName: string | null;
  tags: string[];
  nodeName: string;
  addresses: string[];
}

/** One GET to tailscaled's LocalAPI over its unix socket. */
function localApi<T>(path: string, timeoutMs = 5000): Promise<{ status: number; body: T | null }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { socketPath: tailscaleSocket, path, method: "GET", headers: { Host: "local-tailscaled.sock" }, timeout: timeoutMs },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: T | null = null;
          try {
            body = JSON.parse(text) as T;
          } catch {
            body = null;
          }
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("tailscaled did not answer")));
    request.on("error", reject);
    request.end();
  });
}

export interface WhoIsResponse {
  Node?: { Name?: string; Tags?: string[]; Addresses?: string[] };
  UserProfile?: { LoginName?: string };
}

/** A tagged node's UserProfile is the shared "tagged-devices" login, which owns nothing. */
export function parseWhoIs(body: WhoIsResponse | null): WhoIs | null {
  if (!body?.Node) return null;
  const tags = body.Node.Tags ?? [];
  return {
    loginName: tags.length > 0 ? null : (body.UserProfile?.LoginName ?? null),
    tags,
    nodeName: (body.Node.Name ?? "").replace(/\.$/, ""),
    addresses: body.Node.Addresses ?? [],
  };
}

/** Null when the address is not a node of this tailnet. */
export async function whois(address: string): Promise<WhoIs | null> {
  const response = await localApi<WhoIsResponse>(`/localapi/v0/whois?addr=${encodeURIComponent(address)}`);
  if (response.status !== 200) return null;
  return parseWhoIs(response.body);
}

export interface StatusResponse {
  Self?: { UserID?: number; Tags?: string[] | null };
  User?: Record<string, { LoginName?: string }>;
}

/** The login that owns this node, or null for a tagged node, which an auth key with tags creates. */
export function parseOwnLogin(body: StatusResponse | null): string | null {
  const self = body?.Self;
  if (!self || (self.Tags ?? []).length > 0 || self.UserID === undefined) return null;
  return body?.User?.[String(self.UserID)]?.LoginName ?? null;
}

export async function ownLogin(): Promise<string | null> {
  return parseOwnLogin((await localApi<StatusResponse>("/localapi/v0/status")).body);
}

/** A dashboard's answer: its HTTP status and its body, parsed as JSON when it is JSON, otherwise null. */
export interface TailnetAnswer {
  status: number;
  body: unknown;
}

function parsedBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * GET from another host on the tailnet, whatever status it answers; only a transport failure (no
 * connection, no answer in time) rejects. Tailscale runs in userspace, so the request goes through
 * its HTTP proxy with CONNECT, then TLS to the host itself.
 */
export function fetchTailnet(url: string, timeoutMs = 5000): Promise<TailnetAnswer> {
  const target = new URL(url);
  if (!tailnetProxy) {
    return fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).then(async (response) => ({ status: response.status, body: parsedBody(await response.text()) }));
  }
  const proxy = new URL(tailnetProxy);
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  return new Promise((resolve, reject) => {
    const sockets: { destroy(): void }[] = [];
    let settled = false;
    const finish = (error: Error | null, value?: TailnetAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      if (error) reject(error);
      else resolve(value as TailnetAnswer);
    };
    const timer = setTimeout(() => finish(new Error(`${url}: no answer within ${timeoutMs} ms`)), timeoutMs);
    const connectRequest = httpRequest({ host: proxy.hostname, port: Number(proxy.port || 80), method: "CONNECT", path: `${target.hostname}:${port}`, agent: false });
    sockets.push(connectRequest);
    connectRequest.on("error", (error) => finish(error));
    connectRequest.on("connect", (response, socket) => {
      sockets.push(socket);
      if (response.statusCode !== 200) return finish(new Error(`${url}: the tailnet proxy answered ${response.statusCode}`));
      const stream = target.protocol === "https:" ? tlsConnect({ socket, servername: target.hostname }) : socket;
      sockets.push(stream);
      const request = httpRequest(
        { createConnection: () => stream, host: target.hostname, path: `${target.pathname}${target.search}`, method: "GET", headers: { Host: target.host } },
        (answer) => {
          const chunks: Buffer[] = [];
          answer.on("data", (chunk: Buffer) => chunks.push(chunk));
          answer.on("end", () => finish(null, { status: answer.statusCode ?? 0, body: parsedBody(Buffer.concat(chunks).toString("utf8")) }));
        },
      );
      request.on("error", (error) => finish(error));
      request.end();
    });
    connectRequest.end();
  });
}

/** GET a JSON document from another host on the tailnet; anything but a 200 with JSON rejects. */
export async function fetchTailnetJson<T>(url: string, timeoutMs = 5000): Promise<T> {
  const answer = await fetchTailnet(url, timeoutMs);
  if (answer.status !== 200) throw new Error(`${url}: HTTP ${answer.status}`);
  if (answer.body === null) throw new Error(`${url}: the answer is not JSON`);
  return answer.body as T;
}
