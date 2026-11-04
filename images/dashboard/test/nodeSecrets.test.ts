import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type LocalInstance, callSyncthing } from "../src/instanceResolver.js";
import { knownNodeSecrets, lastReadSecretsKept, secretsClock } from "../src/nodeSecrets.js";
import { type SyncthingClient, SyncthingRefusal } from "../src/syncthing.js";

/** A node's Syncthing at `url` whose `/config` holds `password`, or fails while `fails` is set. */
function clientAt(url: string, password: string, state: { fails: boolean }): SyncthingClient {
  return {
    endpoint: { url, apiKey: "key" },
    request: async () => {
      if (state.fails) throw new Error("connection refused");
      return { gui: { password } };
    },
  } as unknown as SyncthingClient;
}

describe("a refusal's text", () => {
  it("carries none of the node's secrets", async () => {
    const client = {
      endpoint: { url: "http://127.0.0.1:9384", apiKey: "refusal-key" },
      request: async (_method: string, path: string) => {
        if (path === "/config") return { gui: { password: "refusal-hash" } };
        throw new SyncthingRefusal("PATCH /config/options", 400, "refusal-key is not refusal-hash");
      },
    } as unknown as SyncthingClient;
    const instance: LocalInstance = { kind: "local", nodeId: "rf01", name: "refusing", client, root: "/data", os: "linux", threshold: 0, source: "registry" };

    const refusal = await callSyncthing(instance, (syncthing) => syncthing.request("PATCH", "/config/options", {})).then(
      () => assert.fail("the request is refused"),
      (error: unknown) => error,
    );

    assert.ok(refusal instanceof SyncthingRefusal);
    assert.equal(refusal.status, 400);
    assert.equal(refusal.shownBody, "[redacted] is not [redacted]");
    assert.equal(refusal.message, "PATCH /config/options: HTTP 400 [redacted] is not [redacted]");
  });
});

describe("a node's last read secrets", () => {
  it("are kept for the newest endpoints read, beside a moved node's old one, and the one read longest ago leaves first", async (context) => {
    let now = 1_000_000;
    context.mock.method(secretsClock, "now", () => now);
    const states = Array.from({ length: lastReadSecretsKept + 1 }, () => ({ fails: false }));
    const clients = states.map((state, index) => clientAt(`http://127.0.0.1:${9000 + index}`, `hash-${index}`, state));
    for (const client of clients) await knownNodeSecrets("n1", client);
    now += 120_000;
    for (const state of states) state.fails = true;

    assert.deepEqual(await knownNodeSecrets("n1", clients[0]), { secrets: ["key"], complete: false }, "the endpoint read longest ago");
    assert.deepEqual(await knownNodeSecrets("n1", clients[1]), { secrets: ["key", "hash-1"], complete: true }, "an old endpoint of the same node is still known");
    assert.deepEqual(await knownNodeSecrets("n1", clients.at(-1)!), { secrets: ["key", `hash-${lastReadSecretsKept}`], complete: true });
  });
});
