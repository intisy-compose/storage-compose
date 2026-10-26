import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NodeFolder, Peer, StorageNode } from "../src/api/types.js";
import { normaliseCompletion } from "../ui/src/format.js";
import { isNotConnected, shortSyncState } from "../ui/src/nodeStatus.js";

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

function pausedPeer(paused: boolean): Peer {
  return { deviceId: "D7E5AAA", name: "peer", paused, connected: false } as Peer;
}

describe("a paused node", () => {
  it("reads paused on its row and status line when every device is paused", () => {
    assert.deepEqual(shortSyncState(node({ peers: [pausedPeer(true), pausedPeer(true)], sync: { state: "waiting", completion: 0, lastSeen: null } })), { symbol: "‖", label: "paused", tone: "warn" });
  });

  it("is not paused while one device still syncs, without devices, or on another host", () => {
    assert.equal(shortSyncState(node({ peers: [pausedPeer(true), pausedPeer(false)] })).label, "in sync");
    assert.equal(shortSyncState(node({ peers: [] })).label, "in sync");
    assert.equal(shortSyncState(node({ local: false, peers: [pausedPeer(true)] })).label, "in sync");
  });

  it("an offline node still reads offline", () => {
    assert.notEqual(shortSyncState(node({ online: false, peers: [pausedPeer(true)], sync: { state: "offline", completion: 0, lastSeen: null } })).label, "paused");
  });
});

describe("a node that is not connected", () => {
  it("is a node of this host that is not attached, the way the Nodes page reads it", () => {
    assert.equal(isNotConnected(node({ online: false })), true);
    assert.equal(isNotConnected(node({ online: true })), false);
  });

  it("is never another host's node, whose reachability is that host's to judge", () => {
    assert.equal(isNotConnected(node({ local: false, online: false })), false);
  });
});
