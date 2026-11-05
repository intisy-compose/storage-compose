import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HandoffResult, LayeredHandoff, LayeredState, StorageNode, Warning } from "../src/api/types.js";
import { LayoutRound } from "../src/applyLayout.js";
import { type HandoffContract, type HandoffPublisher, readHandoffResult } from "../src/handoffFeed.js";
import type { LocalInstance } from "../src/instanceResolver.js";
import { layeredStateOf } from "../src/layeredDrift.js";
import { parseLayout } from "../src/setupRepo.js";
import { FakeSyncthing, clientOf } from "./fakeFolderSyncthing.js";
import { layeredWarnings, setupWarnings } from "../src/layeredAttention.js";
import { warningHref } from "../ui/src/attentionPage.js";

const now = Date.parse("2026-11-06T12:00:00.000Z");

function result(overrides: Partial<HandoffResult> = {}): HandoffResult {
  return { schema: 1, nodeId: "a1b2", contractWrittenAt: "", finishedAt: "2026-11-06T11:59:00Z", refused: null, results: [], trash: [], notes: [], purged: 0, ...overrides };
}

function handoff(overrides: Partial<LayeredHandoff> = {}): LayeredHandoff {
  return { writtenAt: "2026-11-06T11:59:00Z", entries: 0, waiting: [], notes: [], space: null, result: null, ...overrides };
}

function nodeWith(layered: Partial<LayeredState>): StorageNode {
  const state: LayeredState = { mode: "apply", threshold: 50, effectiveThreshold: 50, drift: [], missing: [], unplanned: [], unknownDevices: [], nodeOnlyIgnores: [], pendingHandoffs: null, problems: [], failed: null, checkedAt: "2026-11-06T11:59:00Z", handoff: null, ...layered };
  return { id: "a1b2", name: "pc", folders: [{ id: "videos", label: "Videos" }], layered: state } as unknown as StorageNode;
}

function only(warnings: Warning[], kind: Warning["kind"]): Warning[] {
  return warnings.filter((entry) => entry.kind === kind);
}

describe("Attention for the layered sync", () => {
  it("a file waiting more than 24 hours for a keeper, by folder, and not before", () => {
    const waiting = [
      { folderId: "videos", path: "a.mp4", reason: "keeper-offline" as const, since: "2026-11-05T11:00:00.000Z" },
      { folderId: "videos", path: "b.mp4", reason: "not-confirmed" as const, since: "2026-11-05T10:00:00.000Z" },
      { folderId: "videos", path: "c.mp4", reason: "keeper-offline" as const, since: "2026-11-06T10:00:00.000Z" },
    ];
    const [entry, ...rest] = only(layeredWarnings(nodeWith({ handoff: handoff({ waiting }) }), now), "handoff-waiting");
    assert.deepEqual(rest, []);
    assert.equal(entry.text, "pc: 2 files in Videos have waited more than 24 hours for a keeper (its keeper is offline, no keeper holds this version yet); nothing of them leaves the node until one confirms");
    assert.deepEqual([entry.level, entry.folderId, entry.at], ["warning", "videos", "2026-11-05T10:00:00.000Z"]);
  });

  it("a refused hand-off by folder, and a whole refusal only while the node applies", () => {
    const refused = result({ refused: "the node file does not say apply = true", results: [{ folderId: "videos", path: "a.mp4", outcome: "refused", reason: "its size on disk is not the record's" }] });
    const warnings = only(layeredWarnings(nodeWith({ handoff: handoff({ result: refused }) }), now), "handoff-refused");
    assert.deepEqual(warnings.map((entry) => entry.text), ["pc: the hand-off executor refused the whole contract: the node file does not say apply = true", "pc: the hand-off of 1 file in Videos was refused (a.mp4: its size on disk is not the record's)"]);
    assert.equal(only(layeredWarnings(nodeWith({ mode: "report", handoff: handoff({ result: result({ refused: "the contract is not in apply mode" }) }) }), now), "handoff-refused").length, 0);
  });

  it("ignored but not moved yet is information, retried", () => {
    const pending = result({ results: [{ folderId: "videos", path: "a.mp4", outcome: "ignored-not-moved", reason: "Syncthing did not report it ignored in time" }] });
    const [entry] = only(layeredWarnings(nodeWith({ handoff: handoff({ result: pending }) }), now), "handoff-pending");
    assert.equal(entry.text, "pc: 1 file in Videos ignored but not moved yet (a.mp4: Syncthing did not report it ignored in time); each is retried, and released after 10 tries");
    assert.equal(entry.level, "info");
  });

  it("a new file at a handed-off path lives on this node only", () => {
    const stray = result({ results: [{ folderId: "videos", path: "a.mp4", outcome: "unsynced-at-handed-off-path", reason: "newer than its hand-off" }] });
    const [entry] = only(layeredWarnings(nodeWith({ handoff: handoff({ result: stray }) }), now), "handoff-unsynced");
    assert.equal(entry.text, "pc: a.mp4 in Videos is a new file at a handed-off path; it is on this node only, since the hand-off's ignore line keeps it out of sync; move or rename it to sync it");
    assert.equal(entry.folderId, "videos");
  });

  it("a copy in the trash outside its manifest is an error, one the trash keeps for want of a keeper a warning, each once", () => {
    const trash = result({
      results: [{ folderId: "videos", path: "a.mp4", outcome: "in-trash-unlisted", reason: "changed while it was moved and could not be put back", trash: "2026-11-06/videos/a.mp4" }],
      trash: [
        { trash: "2026-11-06/videos/a.mp4", folderId: "videos", path: "a.mp4", reason: "in the trash outside the manifest, never emptied: changed while it was moved and could not be put back" },
        { trash: "2026-10-01/videos/b.mp4", folderId: "videos", path: "b.mp4", reason: "its recorded keeper is not connected" },
      ],
    });
    const warnings = only(layeredWarnings(nodeWith({ handoff: handoff({ result: trash }) }), now), "handoff-trash");
    const unique = [...new Map(warnings.map((entry) => [entry.id, entry])).values()];
    assert.deepEqual(unique.map((entry) => [entry.level, entry.text]), [
      ["error", "pc: 2026-11-06/videos/a.mp4 is in the hand-off trash outside its manifest and is never emptied (in the trash outside the manifest, never emptied: changed while it was moved and could not be put back); check it by hand"],
      ["warning", "pc: the hand-off trash keeps b.mp4 of Videos past its days: its recorded keeper is not connected"],
    ]);
  });

  it("a file hashed too late is information, one too large for the agent's round a warning", () => {
    const hashing = result({
      results: [
        { folderId: "videos", path: "a.mp4", outcome: "deferred", reason: "the round's time ran out while it was hashed" },
        { folderId: "videos", path: "big.mkv", outcome: "refused", reason: "it is too large to hash within the agent's round" },
      ],
    });
    const warnings = layeredWarnings(nodeWith({ handoff: handoff({ result: hashing }) }), now);
    assert.deepEqual(only(warnings, "handoff-deferred").map((entry) => [entry.level, entry.text]), [
      ["info", "pc: a.mp4 in Videos could not be hashed within the host agent's round; it is hashed again next round"],
      ["warning", "pc: big.mkv in Videos is too large to hash within the host agent's round, so it is not handed off and stays on the node"],
    ]);
    assert.equal(only(warnings, "handoff-refused").length, 0);
  });

  it("a keeper reported twice is a warning naming the note", () => {
    const [entry] = only(layeredWarnings(nodeWith({ handoff: handoff({ notes: ["two keeper reports for node 5784; both were dropped, so it counts as offline"] }) }), now), "handoff-note");
    assert.equal(entry.text, "pc: two keeper reports for node 5784; both were dropped, so it counts as offline; two hosts may be running the same node");
    assert.equal(entry.level, "warning");
  });

  it("a stale or missing open-file snapshot is one warning, not a refusal per file", () => {
    const stale = result({ results: [{ folderId: "videos", path: "a.mp4", outcome: "ignored-not-moved", reason: "whether it is open cannot be told (the open-file snapshot is 40 s older than this run); it is retried next run" }] });
    const warnings = layeredWarnings(nodeWith({ handoff: handoff({ result: stale }) }), now);
    assert.deepEqual(only(warnings, "handoff-probe").map((entry) => entry.text), ["pc: the open-file snapshot is 40 s older than this run; no file is moved while whether it is open cannot be told"]);
    assert.equal(only(warnings, "handoff-pending").length, 0);
  });

  it("a space stop and a raise", () => {
    const stopped = layeredWarnings(nodeWith({ handoff: handoff({ space: { state: "stopped", threshold: 50, neededBytes: 900, availableBytes: 500 } }) }), now);
    assert.deepEqual(only(stopped, "space-stopped").map((entry) => entry.text), ["pc does not fit even at its top priority: it needs 900 bytes and has 500; nothing is handed off"]);
    const raised = layeredWarnings(nodeWith({ handoff: handoff({ space: { state: "raised", threshold: 80, neededBytes: 400, availableBytes: 500 } }) }), now);
    assert.deepEqual(only(raised, "space-raised").map((entry) => entry.text), ["pc is short of space: its threshold is raised from 50 to 80 until what it keeps fits with 10% free"]);
  });

  it("drift is information while the node reports, held changes name why, and a failed round is a warning", () => {
    const drift = [
      { folderId: "videos", label: "Videos", field: "type" as const, text: "send and receive to send only", written: false, held: null },
      { folderId: "videos", label: "Videos", field: "versioning" as const, text: "staggered 90 days", written: false, held: "would shorten how long versions are kept" },
    ];
    const report = layeredWarnings(nodeWith({ mode: "report", drift }), now);
    assert.deepEqual(only(report, "layout-drift").map((entry) => [entry.level, entry.text]), [["info", "pc reports 1 change its plan would make; it makes them once apply = true is committed for it"]]);
    assert.deepEqual(only(report, "layout-held").map((entry) => [entry.text, entry.folderId]), [["pc, Videos: staggered 90 days is held: would shorten how long versions are kept", "videos"]]);
    const failed = layeredWarnings(nodeWith({ failed: "pc's Syncthing is not answering" }), now);
    assert.deepEqual(only(failed, "layout-drift").map((entry) => [entry.level, entry.text]), [["warning", "pc: the layered sync round: pc's Syncthing is not answering"]]);
  });

  it("a blocking layout problem is a warning, a node not admitted yet is left to Requests", () => {
    const warnings = layeredWarnings(nodeWith({ problems: ["name 'pc' is used by another node too"] }), now);
    assert.deepEqual(only(warnings, "layout-problem").map((entry) => entry.text), ["pc: the layout leaves it unplanned: name 'pc' is used by another node too"]);
    assert.deepEqual(layeredWarnings(nodeWith({ problems: ["pc is not admitted yet"] }), now), []);
  });

  it("a hand-off folder's one needed item is no entry at all", () => {
    const node = nodeWith({ handoff: handoff() });
    (node.folders as unknown as Record<string, unknown>[])[0] = { id: "videos", label: "Videos", type: "sendonly", needItems: 1, completion: 52, errors: 0 };
    assert.deepEqual(layeredWarnings(node, now), []);
  });

  it("an unpushed or failing setup repo is a warning of the host, which opens Settings", () => {
    const [entry] = setupWarnings("storage", "this host committed 1a2b3c (feat(layout): set the priority of Videos to 40) but could not push it: offline");
    assert.equal(entry.text, "the setup repo on storage: this host committed 1a2b3c (feat(layout): set the priority of Videos to 40) but could not push it: offline");
    assert.equal(warningHref(entry), "#/settings");
    assert.deepEqual(setupWarnings("storage", null), []);
  });

  it("each hand-off entry opens its folder, a node-wide one its node", () => {
    const [waiting] = only(layeredWarnings(nodeWith({ handoff: handoff({ waiting: [{ folderId: "videos", path: "a", reason: "no-keeper", since: "2026-11-01T00:00:00Z" }] }) }), now), "handoff-waiting");
    assert.match(warningHref(waiting) ?? "", /^#\/folders/);
    const [space] = only(layeredWarnings(nodeWith({ handoff: handoff({ space: { state: "stopped", threshold: 50, neededBytes: 1, availableBytes: 0 } }) }), now), "space-stopped");
    assert.match(warningHref(space) ?? "", /^#\/nodes\/a1b2/);
  });
});

describe("the executor's result as the dashboard reads it", () => {
  it("reads schema 1 and nothing else", async () => {
    const directory = mkdtempSync(join(tmpdir(), "handoff-result-"));
    try {
      const path = join(directory, "a1b2.result.json");
      writeFileSync(path, JSON.stringify(result({ notes: undefined as unknown as string[] })));
      assert.deepEqual((await readHandoffResult(path))?.notes, []);
      writeFileSync(path, JSON.stringify({ ...result(), schema: 2 }));
      assert.equal(await readHandoffResult(path), null);
      writeFileSync(path, "{ torn");
      assert.equal(await readHandoffResult(path), null);
      assert.equal(await readHandoffResult(join(directory, "missing.json")), null);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the layout round's view of a node's hand-off", () => {
  it("keeps when it first saw a file wait across rounds, forgets it once it no longer waits, and carries the executor's result", async () => {
    const layout = parseLayout(`[devices.pc]\nid = "LAPTOP-ID"\nroot = "/data"\n[nodes.a1b2]\nname = "pc"\ndevice = "pc"\nthreshold = 50\nadmitted = true\napply = true\n`);
    const instance: LocalInstance = { kind: "local", nodeId: "a1b2", name: "pc", client: clientOf(new FakeSyncthing()), root: "/data", os: "linux", threshold: 50, source: "registry" };
    let waiting: HandoffContract["waiting"] = [{ folderId: "videos", path: "a.mp4", reason: "keeper-offline" }];
    let clock = "2026-11-05T10:00:00.000Z";
    const contract = (): HandoffContract => ({ schema: 1, nodeId: "a1b2", writtenAt: clock, apply: true, cluster: false, quietMinutes: 10, entries: [], waiting, notes: [] });
    const publisher: HandoffPublisher = {
      publish: async () => waiting.length,
      clear: async () => {},
      last: () => ({ contract: contract(), space: null }),
      result: async () => result({ purged: 2 }),
    };
    const round = new LayoutRound({ layout: async () => layout, instances: async () => [instance], handoffFiles: { ensure: async () => null }, handoffs: publisher, record: () => {}, readBackDelaysMs: [], now: () => new Date(clock) });
    await round.run();
    clock = "2026-11-06T11:00:00.000Z";
    await round.run();
    assert.equal(layeredStateOf("a1b2")?.handoff?.waiting[0].since, "2026-11-05T10:00:00.000Z");
    assert.equal(layeredStateOf("a1b2")?.handoff?.result?.purged, 2);
    waiting = [];
    await round.run();
    waiting = [{ folderId: "videos", path: "a.mp4", reason: "keeper-offline" }];
    await round.run();
    assert.equal(layeredStateOf("a1b2")?.handoff?.waiting[0].since, "2026-11-06T11:00:00.000Z");
  });
});
