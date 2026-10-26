import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NodeFolder, StorageNode } from "../src/api/types.js";
import { normaliseCompletion } from "../ui/src/format.js";
import { shortSyncState } from "../ui/src/nodeStatus.js";

function folder(errors: number): NodeFolder {
  return { id: "documents", label: "documents", path: "F:\\Documents", type: "sendreceive", state: "syncing", completion: 50, errors } as NodeFolder;
}

function node(overrides: Partial<StorageNode>): StorageNode {
  return {
    id: "fb98", name: "pc", kind: "drive", threshold: 50, assigned: [], local: true, online: true, host: "finn", space: null,
    sync: { state: "idle", completion: 100, lastSeen: null }, offersWaiting: 0, syncthing: null, instance: null, peers: [], folders: [], dashboardUrl: null, ...overrides,
  };
}

describe("node row state", () => {
  it("failed items show while the node is syncing", () => {
    const state = shortSyncState(node({ sync: { state: "syncing", completion: 82, lastSeen: null }, folders: [folder(61), folder(3)] }));
    assert.equal(state.label, "82%, 64 failed items");
    assert.equal(state.tone, "bad");
  });

  it("failed items show alone when nothing else is going on", () => {
    assert.equal(shortSyncState(node({ folders: [folder(1)] })).label, "1 failed item");
    assert.equal(shortSyncState(node({ sync: { state: "syncing", completion: 40, lastSeen: null } })).label, "40%");
  });

  it("a completion of 1 percent is 1 percent", () => {
    assert.equal(normaliseCompletion(1), 0.01);
    assert.equal(normaliseCompletion(100), 1);
    assert.equal(normaliseCompletion(0), 0);
    assert.equal(normaliseCompletion(150), 1);
  });
});
