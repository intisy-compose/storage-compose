import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HandoffResult, LayeredHandoff } from "../src/api/types.js";
import { LayoutRound } from "../src/applyLayout.js";
import { folderLayered } from "../src/folderLayered.js";
import type { HandoffContract, HandoffPublisher } from "../src/handoffFeed.js";
import type { LocalInstance } from "../src/instanceResolver.js";
import { parseLayout } from "../src/setupRepo.js";
import { layeredNodeText } from "../ui/src/folderDetail.js";
import { FakeSyncthing, clientOf } from "./fakeFolderSyncthing.js";

const layout = parseLayout(`[devices.pc]
id = "PC-ID"
root = "/data"
joined = true

[devices.array]
id = "ARRAY-ID"
role = "archive"
root = "/mnt/storage/pool"
joined = true

[devices.p53]
id = "P53-ID"
root = "/data"
joined = true

[folders.Documents]
priority = 80

[folders.Videos]
priority = 30

[folders.Music]
priority = 30

[folders.Pictures]
priority = 30

[nodes.a1b2]
name = "pc"
device = "pc"
threshold = 50
admitted = true
assigned = ["Music"]

[nodes.a1b2.pins]
"Pictures" = 60

[nodes.5784]
name = "private-array"
device = "array"
admitted = true

[nodes.c3d4]
name = "p53"
device = "p53"
threshold = 20
admitted = true
`);

describe("a folder on each node, from the layout", () => {
  it("says per node whether it keeps the folder and why, its pin, and what its contract here names", () => {
    const counts = (nodeId: string) => (nodeId === "a1b2" ? { entries: [{ folderId: "videos" }, { folderId: "videos" }], waiting: [{ folderId: "videos" }] } : null);
    const videos = folderLayered(layout, "videos", counts);
    assert.deepEqual(
      videos?.nodes.map((node) => [node.nodeName, node.type, node.keptBy, node.why, node.pending, node.waiting]),
      [
        ["private-array", "sendreceive", "threshold", "keeps everything: it is the cluster", null, null],
        ["pc", "sendonly", null, "sends only: priority 30 is below its threshold 50, so what it holds leaves once a keeper confirms it", 2, 1],
        ["p53", "sendreceive", "threshold", "kept both ways: priority 30 is at or above its threshold 20", null, null],
      ],
    );
    const pictures = folderLayered(layout, "pictures")?.nodes.find((node) => node.nodeId === "a1b2");
    assert.deepEqual([pictures?.keptBy, pictures?.pinned, pictures?.why], ["pin", 60, "kept both ways: pinned at 60"]);
    assert.equal(folderLayered(layout, "music")?.nodes.find((node) => node.nodeId === "a1b2")?.why, "kept both ways: assigned to it");
    assert.equal(folderLayered(layout, "holiday"), null);
    assert.equal(folderLayered(null, "videos"), null);
  });

  it("the page's line adds the pin and the hand-offs", () => {
    assert.equal(layeredNodeText({ nodeId: "a1b2", nodeName: "pc", threshold: 50, type: "sendonly", keptBy: null, pinned: 20, why: "sends only", pending: 2, waiting: 1 }), "sends only; pinned at 20; 2 to hand off now, 1 waiting for a keeper");
    assert.equal(layeredNodeText({ nodeId: "a1b2", nodeName: "pc", threshold: 50, type: "sendreceive", keptBy: "pin", pinned: 90, why: "kept both ways: pinned at 90", pending: null, waiting: null }), "kept both ways: pinned at 90");
  });
});

describe("Activity for hand-offs and space", () => {
  it("enters each new executor run's hand-offs once per folder, and each change of the space state", async () => {
    const recorded: string[] = [];
    const nodeLayout = parseLayout(`[devices.pc]\nid = "LAPTOP-ID"\nroot = "/data"\n[nodes.a1b2]\nname = "pc"\ndevice = "pc"\nthreshold = 50\nadmitted = true\napply = true\n`);
    const instance: LocalInstance = { kind: "local", nodeId: "a1b2", name: "pc", client: clientOf(new FakeSyncthing()), root: "/data", os: "linux", threshold: 50, source: "registry" };
    let finishedAt = "2026-11-06T10:00:00Z";
    let space: LayeredHandoff["space"] = { state: "fits", threshold: 50, neededBytes: 1, availableBytes: 9 };
    const result = (): HandoffResult => ({ schema: 1, nodeId: "a1b2", contractWrittenAt: "", finishedAt, refused: null, results: [{ folderId: "videos", path: "a", outcome: "moved", reason: "" }, { folderId: "videos", path: "b", outcome: "moved", reason: "" }, { folderId: "music", path: "c", outcome: "released", reason: "" }], trash: [], notes: [], purged: 0 });
    const contract: HandoffContract = { schema: 1, nodeId: "a1b2", writtenAt: "", apply: true, cluster: false, quietMinutes: 10, entries: [], waiting: [], notes: [] };
    const publisher: HandoffPublisher = {
      publish: async () => 0,
      clear: async () => {},
      last: () => ({ contract, space: space && { ...space, handoffAllowed: true } }),
      result: async () => result(),
    };
    const round = new LayoutRound({ layout: async () => nodeLayout, instances: async () => [instance], handoffFiles: { ensure: async () => null }, handoffs: publisher, record: (_nodeId, _folderId, text) => recorded.push(text), readBackDelaysMs: [] });
    await round.run();
    assert.deepEqual(recorded, [], "the run already there when the dashboard starts is not entered again");
    finishedAt = "2026-11-06T10:01:00Z";
    await round.run();
    await round.run();
    space = { state: "raised", threshold: 80, neededBytes: 1, availableBytes: 9 };
    await round.run();
    space = { state: "fits", threshold: 50, neededBytes: 1, availableBytes: 9 };
    await round.run();
    assert.deepEqual(recorded, ["pc: handed off 2 files of videos", "pc: released back into sync 1 file of music", "pc: threshold raised from 50 to 80 for space", "pc: fits at its threshold 50 again"]);
  });
});
