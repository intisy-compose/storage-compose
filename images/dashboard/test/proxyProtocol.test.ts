import assert from "node:assert/strict";
import { connect } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { after, before, describe, it } from "node:test";
import { hostAllowlist } from "../src/http.js";
import { createJoinListener } from "../src/joinListener.js";
import { parseProxyV2 } from "../src/proxyProtocol.js";

const storageHost = hostAllowlist(["storage"]);
const signature = [0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a];

/** The header tailscale's serve writes (go-proxyproto, v1.102.4) for a caller on 100.75.76.90:51234. */
function ipv4Header(): Buffer {
  return Buffer.from([...signature, 0x21, 0x11, 0x00, 0x0c, 100, 75, 76, 90, 100, 64, 0, 1, 0xc8, 0x22, 0x21, 0x07]);
}

function ipv6Header(): Buffer {
  const source = [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, 0, 0, 0, 0, 0xca, 0x38, 0x4c, 0x5c];
  const destination = [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  return Buffer.from([...signature, 0x21, 0x21, 0x00, 0x24, ...source, ...destination, 0xc8, 0x22, 0x21, 0x07]);
}

describe("the PROXY protocol v2 header", () => {
  it("reads an IPv4 caller and the header's length", () => {
    assert.deepEqual(parseProxyV2(Buffer.concat([ipv4Header(), Buffer.from("POST /")])), {
      kind: "parsed",
      source: { address: "100.75.76.90", port: 51234 },
      headerLength: 28,
    });
  });

  it("reads an IPv6 caller in its short form", () => {
    assert.deepEqual(parseProxyV2(ipv6Header()), { kind: "parsed", source: { address: "fd7a:115c:a1e0::ca38:4c5c", port: 51234 }, headerLength: 52 });
  });

  it("waits for the rest of a truncated header", () => {
    assert.deepEqual(parseProxyV2(ipv4Header().subarray(0, 10)), { kind: "incomplete" });
    assert.deepEqual(parseProxyV2(ipv4Header().subarray(0, 20)), { kind: "incomplete" });
    assert.deepEqual(parseProxyV2(ipv6Header().subarray(0, 40)), { kind: "incomplete" });
  });

  it("refuses a connection that starts with HTTP instead", () => {
    assert.equal(parseProxyV2(Buffer.from("POST /api/join HTTP/1.1\r\n")).kind, "invalid");
  });

  it("refuses a wrong signature, a LOCAL command and UDP", () => {
    const wrongSignature = ipv4Header();
    wrongSignature[11] = 0x0b;
    assert.equal(parseProxyV2(wrongSignature).kind, "invalid");
    const local = ipv4Header();
    local[12] = 0x20;
    assert.equal(parseProxyV2(local).kind, "invalid");
    const udp = ipv4Header();
    udp[13] = 0x12;
    assert.equal(parseProxyV2(udp).kind, "invalid");
  });

  it("refuses an address block too short for its family", () => {
    const short = ipv6Header();
    short.writeUInt16BE(12, 14);
    assert.equal(parseProxyV2(short).kind, "invalid");
  });
});

/** Sends raw bytes and returns everything the listener answers until it closes the connection. */
function exchange(server: Server, ...writes: Buffer[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const answer = () => Buffer.concat(chunks).toString("utf8");
    socket.on("close", () => resolve(answer()));
    socket.on("error", (error: NodeJS.ErrnoException) => (error.code === "ECONNRESET" ? resolve(answer()) : reject(error)));
    socket.on("connect", async () => {
      for (const data of writes) {
        socket.write(data);
        await new Promise((wait) => setTimeout(wait, 20));
      }
    });
  });
}

function httpRequest(method: string, path: string, body = "", headers = "Content-Type: application/json\r\n"): Buffer {
  return Buffer.from(`${method} ${path} HTTP/1.1\r\nHost: storage\r\nConnection: close\r\n${headers}Content-Length:${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

describe("the join listener", () => {
  const seen: string[] = [];
  const server = createJoinListener(async (request, response, caller) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    seen.push(`${caller.address} ${Buffer.concat(chunks).toString("utf8")}`);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ caller: caller.address }));
  }, async () => ["127.0.0.1"], storageHost);

  before(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("hands a join the caller from the header, in the same packet as the request", async () => {
    const answer = await exchange(server, Buffer.concat([ipv4Header(), httpRequest("POST", "/api/join", '{"name":"pc"}')]));
    assert.match(answer, /^HTTP\/1.1 200/);
    assert.match(answer, /"caller":"100.75.76.90"/);
    assert.equal(seen.at(-1), '100.75.76.90 {"name":"pc"}');
  });

  it("reads a header that arrives in pieces before the request", async () => {
    const header = ipv6Header();
    const answer = await exchange(server, header.subarray(0, 7), header.subarray(7), httpRequest("POST", "/api/join", "{}"));
    assert.match(answer, /"caller":"fd7a:115c:a1e0::ca38:4c5c"/);
  });

  it("serves nothing but POST /api/join", async () => {
    for (const [method, path] of [["GET", "/"], ["GET", "/api/nodes"], ["POST", "/api/arrays/storage/sync"], ["GET", "/api/join"]]) {
      const answer = await exchange(server, Buffer.concat([ipv4Header(), httpRequest(method, path)]));
      assert.match(answer, /^HTTP\/1.1 404/, `${method} ${path}`);
      assert.match(answer, /serves only POST \/api\/join/);
    }
  });

  it("refuses a join a page on another site sent through the browser, and hands it on to nothing", async () => {
    const count = seen.length;
    const crossSite = await exchange(server, Buffer.concat([ipv4Header(), httpRequest("POST", "/api/join", "{}", "Content-Type: application/json\r\nOrigin: https://evil.example\r\n")]));
    assert.match(crossSite, /^HTTP\/1.1 403/);
    const plainForm = await exchange(server, Buffer.concat([ipv4Header(), httpRequest("POST", "/api/join", "{}", "Content-Type: text/plain\r\n")]));
    assert.match(plainForm, /^HTTP\/1.1 415/);
    assert.equal(seen.length, count);
  });

  it("closes a connection without a header unanswered", async () => {
    const count = seen.length;
    assert.equal(await exchange(server, httpRequest("POST", "/api/join", "{}")), "");
    assert.equal(seen.length, count);
  });

  it("closes a connection whose header has a wrong signature", async () => {
    const forged = ipv4Header();
    forged[0] = 0x0e;
    assert.equal(await exchange(server, Buffer.concat([forged, httpRequest("POST", "/api/join", "{}")])), "");
  });
});

describe("the join listener's source check", () => {
  let gatewayAddresses = ["127.0.0.1"];
  let resolutions = 0;
  let joins = 0;
  const server = createJoinListener(
    async (_request, response) => {
      joins++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    },
    async () => {
      resolutions++;
      return gatewayAddresses;
    },
    storageHost,
  );
  const validJoin = () => Buffer.concat([ipv4Header(), httpRequest("POST", "/api/join", "{}")]);

  before(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("serves a connection from the gateway's address", async () => {
    gatewayAddresses = ["172.30.0.9", "127.0.0.1"];
    assert.match(await exchange(server, validJoin()), /^HTTP\/1.1 200/);
  });

  it("closes a connection from any other source unanswered, header or not", async () => {
    gatewayAddresses = ["172.30.0.9"];
    const count = joins;
    assert.equal(await exchange(server, validJoin()), "");
    assert.equal(joins, count);
  });

  it("closes every connection while the gateway does not resolve", async () => {
    const failing = createJoinListener(async () => assert.fail("must not be called"), async () => {
      throw new Error("getaddrinfo ENOTFOUND gateway");
    });
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    try {
      assert.equal(await exchange(failing, validJoin()), "");
    } finally {
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });

  it("resolves the gateway again for each connection, so a recreated gateway is followed", async () => {
    gatewayAddresses = ["172.30.0.9"];
    assert.equal(await exchange(server, validJoin()), "");
    const before = resolutions;
    gatewayAddresses = ["127.0.0.1"];
    assert.match(await exchange(server, validJoin()), /^HTTP\/1.1 200/);
    assert.equal(resolutions, before + 1);
    gatewayAddresses = ["172.30.0.10"];
    assert.equal(await exchange(server, validJoin()), "");
  });

  it("matches an IPv4-mapped source to the gateway's IPv4 address", async () => {
    gatewayAddresses = ["::ffff:127.0.0.1"];
    assert.match(await exchange(server, validJoin()), /^HTTP\/1.1 200/);
  });
});
