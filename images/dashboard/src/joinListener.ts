import { type IncomingMessage, type ServerResponse, createServer as createHttpServer } from "node:http";
import { type Server, type Socket, createServer as createNetServer } from "node:net";
import { type ProxySource, parseProxyV2 } from "./proxyProtocol.js";

export type CallerHandler = (request: IncomingMessage, response: ServerResponse, caller: ProxySource) => Promise<void>;

const headerTimeoutMs = 5000;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function isJoinRequest(request: IncomingMessage): boolean {
  return request.method === "POST" && new URL(request.url ?? "/", "http://join").pathname === "/api/join";
}

/**
 * The tailnet-only join port: tailscale terminates TLS and opens each connection with a PROXY protocol
 * v2 header naming the caller, which is the only way to learn its tailnet address (a plain TCP forward
 * hands on a loopback port that whois does not know). A connection without a valid header is closed
 * unanswered, and only POST /api/join is served.
 */
export function createJoinListener(handleJoin: CallerHandler): Server {
  const callers = new WeakMap<Socket, ProxySource>();
  const http = createHttpServer((request, response) => {
    const caller = callers.get(request.socket as Socket);
    if (!caller) return void request.socket.destroy();
    if (!isJoinRequest(request)) return sendJson(response, 404, { error: "this port serves only POST /api/join" });
    handleJoin(request, response, caller).catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  return createNetServer((socket) => {
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), headerTimeoutMs);
    const readHeader = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const parsed = parseProxyV2(received);
      if (parsed.kind === "incomplete") return;
      clearTimeout(timer);
      socket.off("data", readHeader);
      if (parsed.kind === "invalid") return void socket.destroy();
      socket.pause();
      callers.set(socket, parsed.source);
      const rest = received.subarray(parsed.headerLength);
      if (rest.length > 0) socket.unshift(rest);
      http.emit("connection", socket);
      socket.resume();
    };
    socket.on("data", readHeader);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => clearTimeout(timer));
  });
}
