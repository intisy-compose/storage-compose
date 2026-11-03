import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { knownNodeSecrets, secretsClock } from "../src/nodeSecrets.js";
import type { SyncthingClient } from "../src/syncthing.js";

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
