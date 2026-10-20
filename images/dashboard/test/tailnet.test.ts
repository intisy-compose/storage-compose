import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { after, before, describe, it } from "node:test";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

describe("reading another host's dashboard through the tailnet proxy", () => {
  const target = createServer((request, response) => {
    response.writeHead(request.url === "/api/nodes?scope=local" ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ host: { name: "p53" }, path: request.url, hostHeader: request.headers.host }));
  });
  const tunnels: string[] = [];
  const proxy = createServer();
  proxy.on("connect", (request, client) => {
    tunnels.push(request.url ?? "");
    const [host, port] = (request.url ?? "").split(":");
    const upstream = connect(Number(port), host === "dashboard.test" ? "127.0.0.1" : host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  });
  let targetPort = 0;
  let fetchTailnetJson: <T>(url: string, timeoutMs?: number) => Promise<T>;

  before(async () => {
    targetPort = await listen(target);
    process.env.TAILNET_PROXY = `http://127.0.0.1:${await listen(proxy)}`;
    ({ fetchTailnetJson } = await import("../src/tailnet.js"));
  });

  after(() => {
    target.closeAllConnections();
    proxy.closeAllConnections();
    target.close();
    proxy.close();
  });

  it("tunnels to the host by name and reads its answer", async () => {
    const answer = await fetchTailnetJson<{ host: { name: string }; hostHeader: string }>(`http://dashboard.test:${targetPort}/api/nodes?scope=local`);
    assert.equal(answer.host.name, "p53");
    assert.equal(answer.hostHeader, `dashboard.test:${targetPort}`);
    assert.deepEqual(tunnels, [`dashboard.test:${targetPort}`]);
  });

  it("fails on an answer other than 200", async () => {
    await assert.rejects(fetchTailnetJson(`http://dashboard.test:${targetPort}/nothing`), /HTTP 404/);
  });

  it("fails when the proxy cannot reach the host", async () => {
    await assert.rejects(fetchTailnetJson("http://127.0.0.1:1/api/nodes", 3000), /proxy answered 502/);
  });
});
