import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type LocalInstance, callSyncthing } from "../src/instanceResolver.js";
import { knownNodeSecrets, secretsClock } from "../src/nodeSecrets.js";
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
  it("are kept for its current endpoint only, so a node that moved keeps no list of the old one", async (context) => {
    let now = 1_000_000;
    context.mock.method(secretsClock, "now", () => now);
    const old = { fails: false };
    const moved = { fails: false };
    const oldClient = clientAt("http://127.0.0.1:8384", "old-hash", old);
    assert.deepEqual(await knownNodeSecrets("n1", oldClient), { secrets: ["key", "old-hash"], complete: true });
    assert.deepEqual(await knownNodeSecrets("n1", clientAt("http://127.0.0.1:8385", "new-hash", moved)), { secrets: ["key", "new-hash"], complete: true });
    now += 120_000;
    old.fails = true;

    assert.deepEqual(await knownNodeSecrets("n1", oldClient), { secrets: ["key"], complete: false });
  });
});
