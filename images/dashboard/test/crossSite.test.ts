import assert from "node:assert/strict";
import { type Server, createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { hostAllowlist } from "../src/http.js";
import { type AnyRoute, type WriteNote, hostWritePattern, requestHandler } from "../src/routes.js";

const pauseNote: WriteNote = { nodeId: "d7e5", nodeName: "peer", folderId: null, text: "peer: paused every device" };

interface Answer {
  status: number;
  body: string;
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

describe("a write from another site", () => {
  const ran: string[] = [];
  const notes: string[] = [];
  const routes: AnyRoute[] = [
    { method: "GET", pattern: /^\/api\/nodes$/, handle: async ({ response }) => void response.end("{}") },
    { method: "POST", pattern: /^\/api\/nodes\/d7e5\/pause$/, write: async ({ response }) => (ran.push("pause"), response.end("{}"), pauseNote) },
    { method: "POST", pattern: hostWritePattern(/^\/api\/arrays\/beef\/sync$/), handle: async ({ response }) => void (ran.push("sync"), response.end("{}")) },
  ];
  let server: Server;
  let port: number;

  before(async () => {
    const hosts = hostAllowlist(["localhost", "127.0.0.1", "storage.tail1234.ts.net"]);
    const handler = requestHandler(routes, { invalidate: () => {}, record: (note) => void notes.push(note.text) }, hosts);
    server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const json = { "Content-Type": "application/json" };

  for (const path of ["/api/nodes/d7e5/pause", "/api/arrays/beef/sync"]) {
    it(`refuses ${path} with another site's Origin, and runs nothing`, async () => {
      const before = ran.length;
      const answer = await send(port, "POST", path, { ...json, Host: "localhost:8442", Origin: "https://evil.example" });
      assert.equal(answer.status, 403);
      assert.deepEqual(JSON.parse(answer.body), { error: "a write from another site is refused" });
      assert.equal(ran.length, before);
    });

    it(`refuses ${path} marked Sec-Fetch-Site cross-site or same-site`, async () => {
      const before = ran.length;
      for (const site of ["cross-site", "same-site", "none"]) {
        const answer = await send(port, "POST", path, { ...json, Host: "localhost:8442", "Sec-Fetch-Site": site });
        assert.equal(answer.status, 403, site);
      }
      assert.equal(ran.length, before);
    });

    it(`refuses ${path} sent as text/plain or without a content type, as a plain form sends it`, async () => {
      const before = ran.length;
      for (const headers of [{ "Content-Type": "text/plain" } as Record<string, string>, { "Content-Type": "application/x-www-form-urlencoded" }, {}]) {
        const answer = await send(port, "POST", path, { ...headers, Host: "localhost:8442" }, "{}");
        assert.equal(answer.status, 415, JSON.stringify(headers));
        assert.deepEqual(JSON.parse(answer.body), { error: "a write must be sent as application/json" });
      }
      assert.equal(ran.length, before);
    });
  }

  it("accepts a same-origin JSON write on the tailnet name, on localhost and on 127.0.0.1", async () => {
    const origins: [string, string][] = [
      ["storage.tail1234.ts.net", "https://storage.tail1234.ts.net"],
      ["localhost:8442", "http://localhost:8442"],
      ["127.0.0.1:8442", "http://127.0.0.1:8442"],
      ["Storage.Tail1234.ts.net", "https://storage.tail1234.ts.net"],
    ];
    ran.length = 0;
    for (const [host, origin] of origins) {
      const answer = await send(port, "POST", "/api/nodes/d7e5/pause", { "Content-Type": "application/json; charset=utf-8", Host: host, Origin: origin, "Sec-Fetch-Site": "same-origin" });
      assert.equal(answer.status, 200, origin);
    }
    assert.equal(ran.length, origins.length);
  });

  it("accepts a JSON write that carries no browser headers, as the join scripts and curl send it", async () => {
    const answer = await send(port, "POST", "/api/arrays/beef/sync", { ...json, Host: "localhost:8442" });
    assert.equal(answer.status, 200);
  });

  it("refuses an Origin on another port of the same host, and an opaque one", async () => {
    for (const origin of ["http://localhost:8443", "http://localhost", "null"]) {
      const answer = await send(port, "POST", "/api/nodes/d7e5/pause", { ...json, Host: "localhost:8442", Origin: origin });
      assert.equal(answer.status, 403, origin);
    }
  });

  it("leaves a read from another site alone, which changes nothing", async () => {
    const answer = await send(port, "GET", "/api/nodes", { Host: "localhost:8442", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
    assert.equal(answer.status, 200);
  });
});
