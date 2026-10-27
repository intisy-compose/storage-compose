import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type StatusInput, entryStatus } from "../src/explorerStatus.js";

function input(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    answering: true,
    hasFolder: true,
    offered: false,
    folderPaused: false,
    folderState: "idle",
    local: { deleted: false, ignored: false },
    outstandingBelow: 0,
    failedBelow: 0,
    locallyChanged: false,
    sharedWithOthers: true,
    effectivePriority: 80,
    threshold: 50,
    ...overrides,
  };
}

describe("explorer status", () => {
  it("failed beats syncing", () => {
    assert.deepEqual(entryStatus(input({ failedBelow: 2, outstandingBelow: 5, folderState: "syncing" })), { status: "failed", detail: "2 items failed below" });
    assert.deepEqual(entryStatus(input({ failedBelow: "too-many" })), { status: "failed", detail: "too many failed items to place" });
    assert.deepEqual(entryStatus(input({ outstandingBelow: 3 })), { status: "syncing", detail: "3 items outstanding below" });
    assert.deepEqual(entryStatus(input({ outstandingBelow: 1 })), { status: "syncing", detail: "1 item outstanding below" });
    assert.deepEqual(entryStatus(input({ outstandingBelow: "too-many" })), { status: "syncing", detail: "too many outstanding items to place" });
  });

  it("a missing directory is grey while the folder is idle and orange while it syncs", () => {
    assert.equal(entryStatus(input({ local: null })).status, "missing");
    assert.equal(entryStatus(input({ local: { deleted: true, ignored: false } })).status, "missing");
    assert.equal(entryStatus(input({ local: null, folderState: "syncing" })).status, "syncing");
    assert.equal(entryStatus(input({ local: null, folderState: "sync-preparing" })).status, "missing");
  });

  it("a folder the node does not have is not here yet, offered or not shared", () => {
    assert.deepEqual(entryStatus(input({ hasFolder: false, offered: true, local: null })), { status: "missing", detail: "offered, not accepted" });
    assert.deepEqual(entryStatus(input({ hasFolder: false, offered: false, local: null })), { status: "missing", detail: "not shared with this node" });
  });

  it("an ignored entry is ignored", () => {
    assert.equal(entryStatus(input({ local: { deleted: false, ignored: true } })).status, "ignored");
  });

  it("a receive-only change is only here", () => {
    assert.deepEqual(entryStatus(input({ locallyChanged: true })), { status: "local-only", detail: "changed here in a receive-only folder" });
    assert.deepEqual(entryStatus(input({ sharedWithOthers: false })), { status: "local-only", detail: "shared with no other device" });
  });

  it("below the node's threshold is below threshold", () => {
    assert.deepEqual(entryStatus(input({ effectivePriority: 30, threshold: 50 })), { status: "below-threshold", detail: "below threshold 50" });
    assert.equal(entryStatus(input({ effectivePriority: 50, threshold: 50 })).status, "in-sync");
  });

  it("a paused folder is paused", () => {
    assert.equal(entryStatus(input({ folderPaused: true })).status, "paused");
    assert.equal(entryStatus(input({ folderPaused: true, outstandingBelow: 4 })).status, "paused");
  });

  it("a paused folder reads paused even where it would be only here, below threshold, ignored or not here yet", () => {
    for (const overrides of [{ sharedWithOthers: false }, { locallyChanged: true }, { effectivePriority: 10 }, { local: { deleted: false, ignored: true } }, { local: null }]) {
      assert.deepEqual(entryStatus(input({ folderPaused: true, ...overrides })), { status: "paused", detail: "Syncthing neither scans nor syncs it until it is resumed" }, JSON.stringify(overrides));
    }
    assert.equal(entryStatus(input({ folderPaused: true, hasFolder: false, local: null })).status, "missing", "a node without the folder has nothing paused");
  });

  it("an instance that does not answer is unknown", () => {
    assert.deepEqual(entryStatus(input({ answering: false, hasFolder: false, local: null, failedBelow: 3 })), { status: "unknown", detail: "the node's Syncthing is not answering" });
  });

  it("nothing else is in sync", () => {
    assert.deepEqual(entryStatus(input()), { status: "in-sync", detail: null });
  });
});
