import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type LayoutRoundDependencies, LayoutRound, mountedHandoffFiles, pullThenReconcile } from "../src/applyLayout.js";
import type { LocalInstance } from "../src/instanceResolver.js";
import { layeredStateOf } from "../src/layeredDrift.js";
import { nodePlan } from "../src/nodePlan.js";
import { carriedLayoutPaths } from "../src/reconcileNode.js";
import { type SetupLayout, parseLayout } from "../src/setupRepo.js";
import { FakeSyncthing, clientOf, folderOf, onPlan } from "./fakeFolderSyncthing.js";

function layoutText(apply: boolean, threshold = 50): string {
  return `
[devices.laptop]
id   = "LAPTOP-ID"
root = "/data"

[devices.keeper]
id   = "KEEPER-ID"
root = "/keep"

[folders.Documents]
priority = 80

[folders."Documents/Old"]
priority = 30

[nodes.a001]
name      = "laptop-data"
device    = "laptop"
threshold = ${threshold}
admitted  = true
apply     = ${apply}

[nodes.a002]
name      = "keeper-data"
device    = "keeper"
threshold = 0
admitted  = true
`;
}

function instanceOf(syncthing: FakeSyncthing, nodeId = "a001", source: LocalInstance["source"] = "registry"): LocalInstance {
  return { kind: "local", nodeId, name: nodeId === "a001" ? "laptop-data" : nodeId, client: clientOf(syncthing), root: "/data", os: "linux", threshold: 50, source };
}

/** A node at threshold 20, so `Documents/Old` is send-receive on it, which threshold 50 makes send-only. */
function nodeAtTwenty(): FakeSyncthing {
  const layout = parseLayout(layoutText(false, 20));
  const plan = nodePlan(layout, "a001", carriedLayoutPaths(layout, "a001", new Set(["documents", "documents-old"])));
  assert.ok(plan);
  return onPlan(plan);
}

interface Recorded {
  nodeId: string;
  folderId: string;
  text: string;
}

function roundOf(layout: () => SetupLayout | null, instances: LocalInstance[], recorded: Recorded[] = [], overrides: Partial<LayoutRoundDependencies> = {}): LayoutRound {
  return new LayoutRound({
    layout: async () => layout(),
    instances: async () => instances,
    handoffFiles: { ensure: async () => null },
    record: (nodeId, folderId, text) => recorded.push({ nodeId, folderId, text }),
    readBackDelaysMs: [],
    now: () => new Date("2026-11-05T12:00:00.000Z"),
    ...overrides,
  });
}

describe("reconciling this host's nodes on every pull", () => {
  it("reports drift while apply is off and writes nothing", async () => {
    const syncthing = nodeAtTwenty();
    const layout = parseLayout(layoutText(false));
    const recorded: Recorded[] = [];

    await roundOf(() => layout, [instanceOf(syncthing)], recorded).run();

    const state = layeredStateOf("a001");
    assert.ok(state);
    assert.equal(state.mode, "report");
    assert.equal(state.threshold, 50);
    assert.equal(state.effectiveThreshold, 50);
    assert.equal(state.pendingHandoffs, null);
    assert.deepEqual(state.drift.map((change) => `${change.folderId} ${change.field} ${change.written}`), ["documents-old type false"]);
    assert.equal(state.failed, null);
    assert.equal(state.checkedAt, "2026-11-05T12:00:00.000Z");
    assert.deepEqual(syncthing.writes(), []);
    assert.deepEqual(recorded, []);
  });

  it("brings a pulled layout change to the node within one round", async () => {
    const syncthing = nodeAtTwenty();
    let current = parseLayout(layoutText(false));
    const recorded: Recorded[] = [];
    const layoutRound = roundOf(() => current, [instanceOf(syncthing)], recorded);
    const connections = { run: async () => void (current = parseLayout(layoutText(true))) };

    await pullThenReconcile(connections, layoutRound);

    assert.equal(folderOf(syncthing, "documents-old").type, "sendonly");
    const state = layeredStateOf("a001");
    assert.equal(state?.mode, "apply");
    assert.deepEqual(state?.drift.map((change) => `${change.field} ${change.written} ${change.held}`), ["type true null"]);
    assert.deepEqual(recorded.map((entry) => `${entry.nodeId} ${entry.folderId}`), ["a001 documents-old"]);
    assert.match(recorded[0].text, /laptop-data: layered sync changed folder Documents\/Old: type send and receive to send only/);

    await layoutRound.run();
    assert.deepEqual(layeredStateOf("a001")?.drift, [], "the next round finds the node on its plan");
  });

  it("still reconciles when the connection round fails", async () => {
    const syncthing = nodeAtTwenty();
    const layoutRound = roundOf(() => parseLayout(layoutText(true)), [instanceOf(syncthing)]);

    await assert.rejects(pullThenReconcile({ run: async () => Promise.reject(new Error("profile unreadable")) }, layoutRound), /profile unreadable/);

    assert.equal(folderOf(syncthing, "documents-old").type, "sendonly");
  });

  it("never writes to an array, whose changes wait for the folder ID typed", async () => {
    const syncthing = nodeAtTwenty();

    await roundOf(() => parseLayout(layoutText(true)), [instanceOf(syncthing, "a001", "array")]).run();

    assert.deepEqual(syncthing.writes(), []);
    const state = layeredStateOf("a001");
    assert.ok(state?.drift.length);
    assert.match(state?.drift.find((change) => change.field === "type")?.held ?? "", /type the folder ID documents-old/);
    assert.ok(state?.drift.every((change) => !change.written));
  });

  it("names the node whose Syncthing does not answer, and keeps the drift it last found", async () => {
    const syncthing = nodeAtTwenty();
    const layoutRound = roundOf(() => parseLayout(layoutText(false)), [instanceOf(syncthing)]);
    await layoutRound.run();
    syncthing.answers = false;

    await layoutRound.run();

    const state = layeredStateOf("a001");
    assert.match(state?.failed ?? "", /laptop-data/);
    assert.equal(state?.drift.length, 1);
  });

  it("has no state for a node the layout does not list, nor without a layout", async () => {
    const stranger = new FakeSyncthing();
    await roundOf(() => parseLayout(layoutText(false)), [instanceOf(stranger, "b0b0")]).run();
    assert.equal(layeredStateOf("b0b0"), null);
    assert.deepEqual(stranger.writes(), []);

    await roundOf(() => null, [instanceOf(nodeAtTwenty())]).run();
    assert.equal(layeredStateOf("a001"), null);
  });

  it("shows the layout's problems with a node and plans nothing for it", async () => {
    const syncthing = nodeAtTwenty();
    const broken = parseLayout(layoutText(true).replace('name      = "laptop-data"', 'name      = "laptop data!"'));

    await roundOf(() => broken, [instanceOf(syncthing)]).run();

    const state = layeredStateOf("a001");
    assert.ok(state?.problems.length);
    assert.deepEqual(state?.drift, []);
    assert.deepEqual(syncthing.writes(), []);
  });

  it("does not plan for a node that is not admitted", async () => {
    const syncthing = nodeAtTwenty();
    const pending = parseLayout(layoutText(true).replace("threshold = 50\nadmitted  = true", "threshold = 50"));

    await roundOf(() => pending, [instanceOf(syncthing)]).run();

    assert.deepEqual(layeredStateOf("a001")?.problems, ["laptop-data is not admitted yet"]);
    assert.deepEqual(syncthing.writes(), []);
  });
});

describe("the hand-off list on a node's files this host mounts", () => {
  const scratch = mkdtempSync(join(tmpdir(), "handoff-files-"));
  after(() => rmSync(scratch, { recursive: true, force: true }));
  const mounted = join(scratch, "mounted");
  const ownRoot = join(mounted, "a001");
  const files = mountedHandoffFiles([mounted]);
  const linux = { ...instanceOf(new FakeSyncthing()), root: ownRoot };

  function folderIn(...parts: string[]): string {
    const folder = join(...parts);
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  it("creates an empty list in a folder under the node's own root", async () => {
    const folder = folderIn(ownRoot, "Documents");

    assert.equal(await files.ensure(linux, { id: "documents", path: folder }), null);

    assert.equal(readFileSync(join(folder, ".stignore-handoff"), "utf8"), "");
  });

  it("leaves a list that exists as it is", async () => {
    const folder = folderIn(ownRoot, "Kept");
    writeFileSync(join(folder, ".stignore-handoff"), "/clip.mp4\n");

    assert.equal(await files.ensure(linux, { id: "kept", path: folder }), null);

    assert.equal(readFileSync(join(folder, ".stignore-handoff"), "utf8"), "/clip.mp4\n");
  });

  it("holds a link or a directory in the list's place", async () => {
    const linked = folderIn(ownRoot, "Linked");
    symlinkSync(folderIn(scratch, "target"), join(linked, ".stignore-handoff"), "junction");
    const directory = folderIn(ownRoot, "Directory");
    mkdirSync(join(directory, ".stignore-handoff"));

    assert.match((await files.ensure(linux, { id: "linked", path: linked })) ?? "", /not a regular file/);
    assert.ok(await files.ensure(linux, { id: "directory", path: directory }));
    assert.ok(statSync(join(directory, ".stignore-handoff")).isDirectory());
  });

  it("refuses a folder under another node's root, outside the mounts, missing, or a Windows node's", async () => {
    const otherNode = folderIn(mounted, "b002", "Documents");
    const elsewhere = folderIn(scratch, "elsewhere");

    assert.equal(await files.ensure(linux, { id: "x", path: otherNode }), "the folder is not under the node's own root");
    assert.equal(await files.ensure(linux, { id: "x", path: join(ownRoot, "..", "b002", "Documents") }), "the folder is not under the node's own root");
    assert.equal(await files.ensure({ ...linux, root: elsewhere }, { id: "x", path: elsewhere }), "this host does not mount the node's files");
    assert.equal(await files.ensure(linux, { id: "x", path: join(ownRoot, "Missing") }), "the folder does not exist under the node's root");
    assert.equal(await files.ensure({ ...linux, root: null }, { id: "x", path: folderIn(ownRoot, "Documents") }), "the node has no root known to this host");
    assert.equal(await files.ensure({ ...linux, os: "windows" }, { id: "x", path: folderIn(ownRoot, "Documents") }), "the host agent creates it on a Windows node");
    assert.equal(existsSync(join(otherNode, ".stignore-handoff")), false);
  });
});
