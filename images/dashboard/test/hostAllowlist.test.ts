import assert from "node:assert/strict";
import { type Server, createServer, request as httpRequest } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { after, before, describe, it } from "node:test";
import { hostAllowlist } from "../src/http.js";
import { createJoinListener } from "../src/joinListener.js";
import { type AnyRoute, type WriteNote, requestHandler } from "../src/routes.js";
import { dashboardHostsOf } from "../src/settings.js";

const pauseNote: WriteNote = { nodeId: "d7e5", nodeName: "peer", folderId: null, text: "peer: paused every device" };
const tailnetName = "storage.tail1234.ts.net";

interface Answer {
  status: number;
  body: string;
}

function rawExchange(port: number, request: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(request));
  });
}

function send(port: number, method: string, path: string, headers: Record<string, string>, body = ""): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, method, path, headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) } }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

describe("the names the dashboard answers to", () => {
  it("are loopback, the tailnet name up wrote as STORAGE_HOST and every DASHBOARD_EXTRA_HOSTS entry", () => {
    assert.deepEqual(dashboardHostsOf({ STORAGE_HOST: tailnetName, DASHBOARD_EXTRA_HOSTS: " nas.lan , Storage.Example:8442,," }), [
      "localhost",
      "127.0.0.1",
      "[::1]",
      tailnetName,
      "nas.lan",
      "Storage.Example:8442",
    ]);
  });

  it("are loopback only while the host has not joined the tailnet and nothing extra is set", () => {
    assert.deepEqual(dashboardHostsOf({}), ["localhost", "127.0.0.1", "[::1]"]);
  });
});

describe("a request for a name the dashboard does not answer to", () => {
  const ran: string[] = [];
  const routes: AnyRoute[] = [
    { method: "GET", pattern: /^\/api\/nodes$/, handle: async ({ response }) => void (ran.push("read"), response.end("{}")) },
    { method: "GET", pattern: /^\/$/, handle: async ({ response }) => void (ran.push("page"), response.end("<html>")) },
    { method: "POST", pattern: /^\/api\/nodes\/d7e5\/pause$/, write: async ({ response }) => (ran.push("pause"), response.end("{}"), pauseNote) },
  ];
  let server: Server;
  let port: number;

  before(async () => {
    const hosts = hostAllowlist(dashboardHostsOf({ STORAGE_HOST: tailnetName, DASHBOARD_EXTRA_HOSTS: "nas.lan" }));
    const handler = requestHandler(routes, { invalidate: () => {}, record: () => {} }, hosts);
    server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const json = { "Content-Type": "application/json" };

  it("answers on loopback with or without the port, on the tailnet name and on a name from DASHBOARD_EXTRA_HOSTS", async () => {
    for (const host of ["localhost:8442", "127.0.0.1:8442", "[::1]:8442", "localhost", "LocalHost:8442", tailnetName, `${tailnetName}:443`, "nas.lan:8442"]) {
      const answer = await send(port, "GET", "/api/nodes", { Host: host });
      assert.equal(answer.status, 200, host);
    }
  });

  it("refuses a rebound name with 421 for a read, the page and a same-origin write, and runs nothing", async () => {
    const before = ran.length;
    const read = await send(port, "GET", "/api/nodes", { Host: "evil.example:8442" });
    assert.equal(read.status, 421);
    assert.deepEqual(JSON.parse(read.body), { error: "this dashboard does not answer to evil.example:8442; add the name to DASHBOARD_EXTRA_HOSTS in config.env" });
    assert.equal((await send(port, "GET", "/", { Host: "evil.example:8442" })).status, 421);
    const write = await send(port, "POST", "/api/nodes/d7e5/pause", { ...json, Host: "evil.example:8442", Origin: "http://evil.example:8442", "Sec-Fetch-Site": "same-origin" }, "{}");
    assert.equal(write.status, 421);
    assert.equal(ran.length, before);
  });

  it("refuses a name that only contains an allowed one", async () => {
    for (const host of ["localhost.evil.example:8442", "evil.example@localhost:8442", "127.0.0.1.evil.example", "evil-localhost"]) {
      assert.equal((await send(port, "GET", "/api/nodes", { Host: host })).status, 421, host);
    }
  });

  it("refuses a request without a Host header", async () => {
    const before = ran.length;
    const answer = await rawExchange(port, "GET /api/nodes HTTP/1.0\r\n\r\n");
    assert.match(answer, /^HTTP\/1.1 421/);
    assert.match(answer, /a request without a Host header is refused/);
    assert.equal(ran.length, before);
  });
});

describe("the join listener's names", () => {
  const signature = [0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a];
  const proxyHeader = Buffer.from([...signature, 0x21, 0x11, 0x00, 0x0c, 100, 75, 76, 90, 100, 64, 0, 1, 0xc8, 0x22, 0x21, 0x07]);
  let joins = 0;
  const server = createJoinListener(
    async (_request, response) => {
      joins++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    },
    async () => ["127.0.0.1"],
    hostAllowlist(dashboardHostsOf({ STORAGE_HOST: tailnetName })),
  );
  const join = (host: string) =>
    Buffer.concat([proxyHeader, Buffer.from(`POST /api/join HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`)]);

  before(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("serves a join addressed to the tailnet name and refuses one addressed to another name with 421", async () => {
    const port = (server.address() as AddressInfo).port;
    const accepted = await rawExchange(port, join(tailnetName));
    assert.match(accepted, /^HTTP\/1.1 200/);
    const count = joins;
    const refused = await rawExchange(port, join("evil.example"));
    assert.match(refused, /^HTTP\/1.1 421/);
    assert.equal(joins, count);
  });
});
