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

interface WhoIsResponse {
  Node?: { Name?: string; Tags?: string[]; Addresses?: string[] };
  UserProfile?: { LoginName?: string };
}

/** Null when the address is not a node of this tailnet. */
export async function whois(address: string): Promise<WhoIs | null> {
  const response = await localApi<WhoIsResponse>(`/localapi/v0/whois?addr=${encodeURIComponent(address)}`);
  if (response.status !== 200 || !response.body?.Node) return null;
  const tags = response.body.Node.Tags ?? [];
  return {
    loginName: tags.length > 0 ? null : (response.body.UserProfile?.LoginName ?? null),
    tags,
    nodeName: (response.body.Node.Name ?? "").replace(/\.$/, ""),
    addresses: response.body.Node.Addresses ?? [],
  };
}

interface StatusResponse {
  Self?: { UserID?: number; Tags?: string[] };
  User?: Record<string, { LoginName?: string }>;
}

/** The login that owns this dashboard's node, or null for a tagged node. */
export async function ownLogin(): Promise<string | null> {
  const response = await localApi<StatusResponse>("/localapi/v0/status");
  const self = response.body?.Self;
  if (!self || (self.Tags ?? []).length > 0 || self.UserID === undefined) return null;
  return response.body?.User?.[String(self.UserID)]?.LoginName ?? null;
}

/**
 * GET a JSON document from another host on the tailnet. Tailscale runs in userspace, so the request
 * goes through its HTTP proxy with CONNECT, then TLS to the host itself.
 */
export function fetchTailnetJson<T>(url: string, timeoutMs = 5000): Promise<T> {
  const target = new URL(url);
  if (!tailnetProxy) {
    return fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).then(async (response) => {
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return (await response.json()) as T;
    });
  }
  const proxy = new URL(tailnetProxy);
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  return new Promise((resolve, reject) => {
    const sockets: { destroy(): void }[] = [];
    let settled = false;
    const finish = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      if (error) reject(error);
      else resolve(value as T);
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
          answer.on("end", () => {
            if (answer.statusCode !== 200) return finish(new Error(`${url}: HTTP ${answer.statusCode}`));
            try {
              finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
            } catch (error) {
              finish(error as Error);
            }
          });
        },
      );
      request.on("error", (error) => finish(error));
      request.end();
    });
    connectRequest.end();
  });
}
