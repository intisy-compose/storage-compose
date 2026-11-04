import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { knownNodeSecrets, lastReadSecretsKept, secretsClock } from "../src/nodeSecrets.js";
import { SyncthingClient, SyncthingRefusal } from "../src/syncthing.js";

/** A node's Syncthing at `url` whose `/config` holds `password`, or fails while `fails` is set. */
function clientAt(url: string, password: string, state: { fails: boolean }): SyncthingClient {
  return {
    endpoint: { url, apiKey: "key" },
    configForSecrets: async () => {
      if (state.fails) throw new Error("connection refused");
      return { gui: { password } };
    },
  } as unknown as SyncthingClient;
}

async function refusalOf(call: Promise<unknown>): Promise<SyncthingRefusal> {
  const error = await call.then(
    () => assert.fail("the request is refused"),
    (refused: unknown) => refused,
  );
  assert.ok(error instanceof SyncthingRefusal);
  return error;
}

describe("a refusal's text", () => {
  it("carries none of the node's secrets, whichever client call met it", async () => {
    const apiKey = "refusal-key";
    const syncthing = createServer((request, response) => {
      if (request.url === "/rest/config") {
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ gui: { apiKey, password: "refusal-hash" } }));
      }
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(`${apiKey} is not refusal-hash`);
    });
    await new Promise<void>((resolve) => syncthing.listen(0, "127.0.0.1", resolve));
    try {
      const client = new SyncthingClient({ url: `http://127.0.0.1:${(syncthing.address() as AddressInfo).port}`, apiKey });

      const direct = await refusalOf(client.request("PATCH", "/config/options", {}));
      const indexRead = await refusalOf(client.file("documents", "a.txt"));

      assert.equal(direct.status, 500);
      assert.equal(direct.shownBody, "[redacted] is not [redacted]");
      assert.equal(direct.message, "PATCH /config/options: HTTP 500 [redacted] is not [redacted]");
      assert.equal(indexRead.shownBody, "[redacted] is not [redacted]");
    } finally {
      syncthing.close();
    }
  });
});

describe("a node's last read secrets", () => {
  it("are kept for the newest endpoints read, beside a moved node's old one, and the one read longest ago leaves first", async (context) => {
    let now = 1_000_000;
    context.mock.method(secretsClock, "now", () => now);
    const states = Array.from({ length: lastReadSecretsKept + 1 }, () => ({ fails: false }));
    const clients = states.map((state, index) => clientAt(`http://127.0.0.1:${9000 + index}`, `hash-${index}`, state));
    for (const client of clients) await knownNodeSecrets(client);
    now += 120_000;
    for (const state of states) state.fails = true;

    assert.deepEqual(await knownNodeSecrets(clients[0]), { secrets: ["key"], complete: false }, "the endpoint read longest ago");
    assert.deepEqual(await knownNodeSecrets(clients[1]), { secrets: ["key", "hash-1"], complete: true }, "an old endpoint of the same node is still known");
    assert.deepEqual(await knownNodeSecrets(clients.at(-1)!), { secrets: ["key", `hash-${lastReadSecretsKept}`], complete: true });
  });
});
