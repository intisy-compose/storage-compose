import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type LayoutRoundDependencies, LayoutRound, type SpaceReads, mountedHandoffFiles, pullThenReconcile } from "../src/applyLayout.js";
import { type HandoffPublisher, handoffPublisher, readHandoffContract } from "../src/handoffFeed.js";
import type { LocalInstance } from "../src/instanceResolver.js";
import { layeredStateOf } from "../src/layeredDrift.js";
import { type NodePlan, nodePlan } from "../src/nodePlan.js";
import { carriedLayoutPaths } from "../src/reconcileNode.js";
import { type SetupLayout, parseLayout } from "../src/setupRepo.js";
import type { FolderSize } from "../src/spacePlan.js";
import { memoryLayeredPauses } from "../src/layeredPauses.js";
import type { Notification } from "../src/notifyOutbox.js";
import { fileNotifiedState } from "../src/notifiedState.js";
import type { RelayedReport } from "../src/keeperRelay.js";
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
  folderId: string | null;
  text: string;
}

function roundOf(layout: () => SetupLayout | null, instances: LocalInstance[], recorded: Recorded[] = [], overrides: Partial<LayoutRoundDependencies> = {}): LayoutRound {
  return new LayoutRound({
    layout: async () => layout(),
    committedLayout: async () => {
      const current = layout();
      return current ? { layout: current, pushed: true } : null;
    },
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

  it("a node applies only from a committed, pushed apply = true: one only in the working tree or not pushed reports and writes nothing", async () => {
    for (const committed of [{ layout: parseLayout(layoutText(false)), pushed: true }, { layout: parseLayout(layoutText(true)), pushed: false }, null]) {
      const syncthing = nodeAtTwenty();
      const recorded: Recorded[] = [];
      await roundOf(() => parseLayout(layoutText(true)), [instanceOf(syncthing)], recorded, { committedLayout: async () => committed }).run();
      assert.equal(layeredStateOf("a001")?.mode, "report", JSON.stringify(committed?.pushed));
      assert.deepEqual(syncthing.writes(), []);
      assert.deepEqual(recorded, []);
    }
  });

  it("a failed read of this host's nodes is caught, writes nothing and keeps the last states", async () => {
    const syncthing = nodeAtTwenty();
    await roundOf(() => parseLayout(layoutText(false)), [instanceOf(syncthing)]).run();
    const before = layeredStateOf("a001");
    const calls: string[] = [];
    await roundOf(() => parseLayout(layoutText(true)), [], [], {
      instances: () => Promise.reject(new Error("the registry cannot be read")),
      nodeFiles: { follow: async () => calls.push("follow") > 0, withdraw: async () => calls.push("withdraw") > 0 },
    }).run();
    assert.deepEqual(calls, []);
    assert.equal(layeredStateOf("a001"), before);
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

/** A node at threshold 50, where `Documents/Old` is send-only, as a raise to 80 or a held type-up leaves it. */
function nodeAtFifty(): FakeSyncthing {
  const layout = parseLayout(layoutText(false, 50));
  const plan = nodePlan(layout, "a001", carriedLayoutPaths(layout, "a001", new Set(["documents", "documents-old"])));
  assert.ok(plan);
  return onPlan(plan);
}

/** Both folders 100 bytes in the network; the node holds Documents whole and nothing of Old. */
function spaceOf(totalBytes: number, freeBytes: number, missing: string[] = []): SpaceReads {
  const sizes: Record<string, FolderSize> = { documents: { globalBytes: 100, localBytes: 100 }, "documents-old": { globalBytes: 100, localBytes: 0 } };
  return {
    space: async () => ({ totalBytes, freeBytes }),
    sizes: async (_instance, folderId) => {
      if (missing.includes(folderId) || !sizes[folderId]) throw new Error(`no status for ${folderId}`);
      return sizes[folderId];
    },
  };
}

describe("the space of each node of this host, every round", () => {
  it("is decided in report mode too, and a raise plans at its threshold: the folder it drops turns send-only", async () => {
    for (const apply of [false, true]) {
      const syncthing = nodeAtTwenty();
      await roundOf(() => parseLayout(layoutText(apply, 20)), [instanceOf(syncthing)], [], { space: spaceOf(300, 100) }).run();

      const state = layeredStateOf("a001");
      assert.deepEqual(state?.space, { state: "raised", threshold: 80, neededBytes: 100, availableBytes: 200 });
      assert.equal(state?.effectiveThreshold, 80);
      assert.deepEqual(state?.drift.map((change) => `${change.folderId} ${change.field} ${change.written}`), [`documents-old type ${apply}`]);
      assert.equal(folderOf(syncthing, "documents-old").type, apply ? "sendonly" : "sendreceive");
    }
  });

  it("turns a folder held send-only send-receive once what the node keeps fits with 10% free, the folder counted", async () => {
    const syncthing = nodeAtFifty();
    const recorded: Recorded[] = [];

    await roundOf(() => parseLayout(layoutText(true, 20)), [instanceOf(syncthing)], recorded, { space: spaceOf(1000, 800) }).run();

    assert.equal(layeredStateOf("a001")?.space?.state, "fits");
    assert.equal(folderOf(syncthing, "documents-old").type, "sendreceive");
    assert.ok(recorded.some((entry) => /Documents\/Old: type send only to send and receive/.test(entry.text)));
  });

  it("holds the type-up while the node's disk or a kept folder's size cannot be read, or what it keeps would not fit", async () => {
    const cases: [string, Partial<LayoutRoundDependencies>, string | null, RegExp][] = [
      ["no space reads", {}, null, /space can be read/],
      ["the disk unread", { space: { ...spaceOf(1000, 800), space: async () => null } }, null, /space can be read/],
      ["a size unread", { space: spaceOf(1000, 800, ["documents-old"]) }, "unknown", /every folder the node keeps has a size/],
      ["only at 80", { space: spaceOf(300, 100) }, "raised", /./],
    ];
    for (const [name, overrides, state, held] of cases) {
      const syncthing = nodeAtFifty();
      await roundOf(() => parseLayout(layoutText(true, 20)), [instanceOf(syncthing)], [], overrides).run();
      assert.equal(layeredStateOf("a001")?.space?.state ?? null, state, name);
      assert.equal(folderOf(syncthing, "documents-old").type, "sendonly", name);
      const type = layeredStateOf("a001")?.drift.find((change) => change.field === "type");
      if (state !== "raised") assert.match(type?.held ?? "", held, name);
      else assert.equal(type, undefined, "a raise to 80 plans Old send-only, as it is");
    }
  });

  it("lets a node that holds everything raise once a keeper of this host holds all of what the raise drops", async () => {
    const completions: Record<string, number> = {};
    const holdingAll: SpaceReads = {
      space: async (instance) => (instance.nodeId === "a002" ? { totalBytes: 10_000, freeBytes: 9_000 } : { totalBytes: 1000, freeBytes: 50 }),
      sizes: async () => ({ globalBytes: 100, localBytes: 100, needBytes: 0 }),
      completion: async (instance, folderId) => (instance.nodeId === "a002" ? (completions[folderId] ?? 0) : 0),
    };
    const run = async () => {
      const syncthing = nodeAtTwenty();
      await roundOf(() => parseLayout(layoutText(true, 20)), [instanceOf(syncthing), instanceOf(new FakeSyncthing(), "a002")], [], { space: holdingAll, pauses: memoryLayeredPauses() }).run();
      return syncthing;
    };

    await run();
    assert.equal(layeredStateOf("a001")?.space?.state, "stopped", "nothing a keeper holds, so a raise frees nothing sure to leave");

    completions["documents-old"] = 100;
    const syncthing = await run();
    assert.deepEqual(layeredStateOf("a001")?.space, { state: "raised", threshold: 80, neededBytes: 100, availableBytes: 250 });
    assert.equal(folderOf(syncthing, "documents-old").type, "sendonly", "the raise turns Old send-only, so it can hand off");
    assert.ok(syncthing.folders.every((folder) => folder.paused === false));
  });
});

function disabled(text: string): string {
  return text.replace(/(apply {5}= (true|false))/, "$1\nenabled   = false");
}

describe("the cluster short of space", () => {
  const clusterText = layoutText(true).replace('root = "/keep"', 'root = "/keep"\nrole = "archive"');

  function clusterInstance(): { syncthing: FakeSyncthing; instance: LocalInstance } {
    const layout = parseLayout(clusterText);
    const plan = nodePlan(layout, "a002", carriedLayoutPaths(layout, "a002", new Set(["documents", "documents-old"])));
    assert.ok(plan?.cluster);
    const syncthing = onPlan(plan);
    return { syncthing, instance: { ...instanceOf(syncthing, "a002"), name: "keeper-data" } };
  }

  it("is full, never paused or raised, and notified once when it turns full and once when it has room again", async () => {
    const { syncthing, instance } = clusterInstance();
    const notified: Notification[] = [];
    let space = spaceOf(210, 10);
    const round = roundOf(() => parseLayout(clusterText), [instance], [], { space: { space: (at) => space.space(at), sizes: (at, id) => space.sizes(at, id) }, pauses: memoryLayeredPauses(), notify: async (entry) => void notified.push(entry) });

    await round.run();
    await round.run();

    assert.deepEqual(layeredStateOf("a002")?.space, { state: "full", threshold: 0, neededBytes: 200, availableBytes: 110 });
    assert.equal(layeredStateOf("a002")?.stopped, null);
    assert.ok(syncthing.folders.every((folder) => folder.paused === false && folder.type === "sendreceive"));
    assert.deepEqual(notified.map((entry) => `${entry.priority} ${entry.title}`), ["4 keeper-data is short of space"]);

    space = spaceOf(10_000, 9_000);
    await round.run();
    assert.deepEqual(notified.map((entry) => entry.title), ["keeper-data is short of space", "keeper-data has room again"]);
  });
});

describe("stopping a node and rejoining", () => {
  it("a node that does not fit even at its top priority is paused, notified once, and resumed once it fits", async () => {
    const syncthing = nodeAtTwenty();
    const pauses = memoryLayeredPauses();
    const notified: Notification[] = [];
    const notify = async (notification: Notification) => void notified.push(notification);
    let space = spaceOf(110, 10);
    const round = roundOf(() => parseLayout(layoutText(true, 20)), [instanceOf(syncthing)], [], { space: { space: (instance) => space.space(instance), sizes: (instance, id) => space.sizes(instance, id) }, pauses, notify });

    await round.run();

    assert.equal(layeredStateOf("a001")?.space?.state, "stopped");
    assert.equal(layeredStateOf("a001")?.stopped, "laptop-data does not fit even at its top priority");
    assert.deepEqual(syncthing.folders.map((folder) => `${folder.id} ${folder.type} ${folder.paused}`), ["documents sendreceive true", "documents-old sendreceive true"], "paused, every type as it was");
    assert.deepEqual(notified.map((entry) => `${entry.priority} ${entry.title}`), ["4 laptop-data stopped"]);
    assert.match(notified[0].message, /2 folders paused, so it pulls nothing and hands nothing off/);

    await round.run();
    assert.equal(notified.length, 1, "a stop is notified once");

    space = spaceOf(1000, 800);
    await round.run();

    assert.deepEqual(syncthing.folders.map((folder) => `${folder.id} ${folder.paused}`), ["documents false", "documents-old false"]);
    assert.equal(layeredStateOf("a001")?.stopped, null);
    assert.deepEqual(notified.map((entry) => entry.title), ["laptop-data stopped", "laptop-data resumed"]);
    assert.deepEqual(pauses.marks, {});
  });

  it("a node the layout disables is paused although apply holds its node file, and enabled = true committed again resumes it", async () => {
    const syncthing = nodeAtTwenty();
    const pauses = memoryLayeredPauses();
    let working = disabled(layoutText(true, 20));
    let committed = working;
    const round = roundOf(() => parseLayout(working), [instanceOf(syncthing)], [], { committedLayout: async () => ({ layout: parseLayout(committed), pushed: true }), space: spaceOf(1000, 800), pauses });

    await round.run();
    assert.equal(layeredStateOf("a001")?.mode, "apply");
    assert.equal(layeredStateOf("a001")?.stopped, "laptop-data is not enabled");
    assert.ok(syncthing.folders.every((folder) => folder.paused === true));

    working = layoutText(true, 20);
    await round.run();
    assert.ok(syncthing.folders.every((folder) => folder.paused === true), "enabled only in the working tree resumes nothing");

    committed = working;
    await round.run();
    assert.ok(syncthing.folders.every((folder) => folder.paused === false));
    assert.equal(layeredStateOf("a001")?.stopped, null);
  });

  it("a node that only reports is shown stopped and paused by nothing", async () => {
    const syncthing = nodeAtTwenty();
    await roundOf(() => parseLayout(disabled(layoutText(false, 20))), [instanceOf(syncthing)], [], { space: spaceOf(1000, 800), pauses: memoryLayeredPauses() }).run();

    assert.equal(layeredStateOf("a001")?.stopped, "laptop-data is not enabled");
    assert.ok(layeredStateOf("a001")?.drift.some((change) => change.field === "paused" && !change.written));
    assert.deepEqual(syncthing.writes(), []);
  });
});

/** Every contract the round asked for, as `<node> publish|clear <apply>`. */
function recordingPublisher(seen: string[], pending: number | null = 3): HandoffPublisher {
  return {
    publish: async (context) => {
      seen.push(`${context.nodeId} publish ${context.layout.nodes.find((node) => node.id === context.nodeId)?.apply} ${context.instances.map((instance) => instance.nodeId).join(",")}`);
      return pending;
    },
    clear: async (nodeId, _instance, apply) => void seen.push(`${nodeId} clear ${apply}`),
  };
}

describe("the hand-off contract of each node, every round", () => {
  it("is published after the node is reconciled, with every instance of this host to read keepers from", async () => {
    const seen: string[] = [];
    const keeper = instanceOf(new FakeSyncthing(), "a002");

    await roundOf(() => parseLayout(layoutText(true)), [instanceOf(nodeAtTwenty()), keeper], [], { handoffs: recordingPublisher(seen) }).run();

    assert.deepEqual(seen.filter((entry) => entry.startsWith("a001")), ["a001 publish true a001,a002"]);
    assert.equal(layeredStateOf("a001")?.pendingHandoffs, 3);
  });

  it("is published in report mode too, which the publisher writes as an empty list", async () => {
    const seen: string[] = [];

    await roundOf(() => parseLayout(layoutText(false)), [instanceOf(nodeAtTwenty())], [], { handoffs: recordingPublisher(seen, null) }).run();

    assert.deepEqual(seen, ["a001 publish false a001"]);
    assert.equal(layeredStateOf("a001")?.pendingHandoffs, null);
  });

  it("is cleared for a node that is not admitted, blocked by the layout, not listed, or whose Syncthing does not answer", async () => {
    const pending = parseLayout(layoutText(true).replace("threshold = 50\nadmitted  = true", "threshold = 50"));
    const broken = parseLayout(layoutText(true).replace('name      = "laptop-data"', 'name      = "laptop data!"'));
    const silent = nodeAtTwenty();
    silent.answers = false;
    for (const [layout, instance] of [[pending, instanceOf(nodeAtTwenty())], [broken, instanceOf(nodeAtTwenty())], [parseLayout(layoutText(true)), instanceOf(new FakeSyncthing(), "b0b0")], [parseLayout(layoutText(true)), instanceOf(silent)]] as const) {
      const seen: string[] = [];
      await roundOf(() => layout, [instance], [], { handoffs: recordingPublisher(seen) }).run();
      assert.equal(seen.length, 1, seen.join(" "));
      assert.match(seen[0], / clear /);
    }
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

/** Space reads that can be switched between rounds. */
function switchable(initial: SpaceReads): { reads: SpaceReads; set(next: SpaceReads): void } {
  let current = initial;
  return {
    reads: { space: (instance) => current.space(instance), sizes: (instance, id) => current.sizes(instance, id), completion: (instance, id) => current.completion?.(instance, id) ?? Promise.resolve(0) },
    set: (next) => void (current = next),
  };
}

describe("a stop holds until a decision lets the node pull", () => {
  it("two stopped rounds keep the pause and notify once; an unreadable round after a stop keeps it too", async () => {
    const syncthing = nodeAtTwenty();
    const pauses = memoryLayeredPauses();
    const notified: Notification[] = [];
    const space = switchable(spaceOf(110, 10));
    const round = roundOf(() => parseLayout(layoutText(true, 20)), [instanceOf(syncthing)], [], { space: space.reads, pauses, notify: async (entry) => void notified.push(entry) });

    await round.run();
    await round.run();
    assert.ok(syncthing.folders.every((folder) => folder.paused === true));
    assert.deepEqual(notified.map((entry) => entry.title), ["laptop-data stopped"]);

    for (const unreadable of [{ ...spaceOf(1000, 900), space: async () => null }, { ...spaceOf(1000, 900), space: async () => Promise.reject(new Error("statfs failed")) }]) {
      space.set(unreadable);
      await round.run();
      assert.ok(syncthing.folders.every((folder) => folder.paused === true), "nothing is resumed on a decision not made");
      assert.equal(layeredStateOf("a001")?.space, null);
      assert.deepEqual(layeredStateOf("a001")?.pausedByStop, ["documents", "documents-old"]);
      assert.ok(layeredStateOf("a001")?.drift.every((change) => change.field !== "paused" || /space can be read/.test(change.held ?? "")));
    }
    assert.deepEqual(notified.map((entry) => entry.title), ["laptop-data stopped"]);
  });

  it("a paused folder whose status errors or reads empty is sized from its pause record, and without one the node stays paused", async () => {
    const pausedStatus = { globalBytes: 0, localBytes: 0, needBytes: 0, state: "", stateChanged: "0001-01-01T00:00:00Z", remoteSequence: null };
    const roomy = (failing: "errors" | "empty"): SpaceReads => ({
      space: async () => ({ totalBytes: 1000, freeBytes: 900 }),
      sizes: async () => (failing === "errors" ? Promise.reject(new Error("folder is paused")) : pausedStatus),
    });
    for (const failing of ["errors", "empty"] as const) {
      const recorded = nodeAtTwenty();
      for (const folder of recorded.folders) folder.paused = true;
      const size = { globalBytes: 100, localBytes: 100, needBytes: 0 };
      const withSizes = memoryLayeredPauses({ a001: { documents: { at: "t", size }, "documents-old": { at: "t", size } } });
      await roundOf(() => parseLayout(layoutText(true, 20)), [instanceOf(recorded)], [], { space: roomy(failing), pauses: withSizes }).run();
      assert.equal(layeredStateOf("a001")?.space?.state, "fits", failing);
      assert.ok(recorded.folders.every((folder) => folder.paused === false), `${failing}: resumed on the recorded sizes`);

      const unsized = nodeAtTwenty();
      for (const folder of unsized.folders) folder.paused = true;
      const withoutSizes = memoryLayeredPauses({ a001: { documents: { at: "t", size: null }, "documents-old": { at: "t", size: null } } });
      await roundOf(() => parseLayout(layoutText(true, 20)), [instanceOf(unsized)], [], { space: roomy(failing), pauses: withoutSizes }).run();
      assert.equal(layeredStateOf("a001")?.space?.state, "unknown", failing);
      assert.ok(unsized.folders.every((folder) => folder.paused === true), `${failing}: no size, no resume`);
    }
  });

  it("a folder is unknown until it is indexed: past its first scan, not paused, with a remote index when it is shared", async () => {
    const statusOf = (overrides: Record<string, unknown>) => ({ globalBytes: 0, localBytes: 0, needBytes: 0, state: "idle", stateChanged: "2026-11-05T11:00:00Z", remoteSequence: { "KEEPER-ID": 3 }, ...overrides });
    const cases: [Record<string, unknown>, string][] = [
      [{}, "fits"],
      [{ remoteSequence: {} }, "unknown"],
      [{ remoteSequence: null, state: "" }, "unknown"],
      [{ stateChanged: "0001-01-01T00:00:00Z" }, "unknown"],
      [{ state: "error" }, "unknown"],
    ];
    for (const [overrides, state] of cases) {
      await roundOf(() => parseLayout(layoutText(false, 20)), [instanceOf(nodeAtTwenty())], [], { space: { space: async () => ({ totalBytes: 1000, freeBytes: 900 }), sizes: async () => statusOf(overrides) } }).run();
      assert.equal(layeredStateOf("a001")?.space?.state, state, JSON.stringify(overrides));
    }
  });
});

describe("keepers of another host, through their dashboard", () => {
  const short: SpaceReads = {
    space: async () => ({ totalBytes: 1000, freeBytes: 50 }),
    sizes: async () => ({ globalBytes: 100, localBytes: 100, needBytes: 0 }),
    completion: async () => 0,
  };
  const report = (overrides: object = {}): RelayedReport => ({ nodeId: "a002", online: true, state: "ok", observedAt: "2026-11-05T12:00:00.000Z", ageSeconds: 3, effectiveThreshold: 0, folders: { "documents-old": { completion: 100, files: {} } }, decision: { state: "fits", threshold: 0 }, ...overrides } as RelayedReport);
  const state = async (relayed: RelayedReport[]) => {
    const syncthing = nodeAtTwenty();
    await roundOf(() => parseLayout(layoutText(true, 20)), [instanceOf(syncthing)], [], { space: short, pauses: memoryLayeredPauses(), relayed: async () => relayed }).run();
    return layeredStateOf("a001")?.space?.state;
  };

  it("counts for what a raise frees while its report is fresh, healthy and whole", async () => {
    assert.equal(await state([report()]), "raised");
  });

  it("counts for nothing when its report is stale, it is not ok, or its own decision would drop the folder", async () => {
    assert.equal(await state([report({ ageSeconds: 300 })]), "stopped", "a stale report counts for nothing");
    assert.equal(await state([report({ observedAt: "2026-11-05T11:50:00.000Z" })]), "stopped");
    assert.equal(await state([report({ state: "frozen" })]), "stopped");
    assert.equal(await state([report({ decision: null })]), "stopped", "no decision of its own");
    assert.equal(await state([report({ decision: { state: "raised", threshold: 80 } })]), "stopped", "it drops Old itself");
    assert.equal(await state([report({ folders: { "documents-old": { completion: 99, files: {} } } })]), "stopped");
    assert.equal(await state([report({ nodeId: "dead" })]), "stopped", "a node the layout does not list");
  });
});

describe("a joined device's round and this host's last decisions", () => {
  it("counts a local keeper only while this host's decision about it is fresh", async () => {
    let now = new Date("2026-11-05T12:00:00.000Z");
    const layout = parseLayout(layoutText(true, 20));
    const keeperSyncthing = onPlan(nodePlan(layout, "a002", carriedLayoutPaths(layout, "a002", new Set(["documents", "documents-old"]))) as NodePlan);
    const keeper = instanceOf(keeperSyncthing, "a002");
    const reads: SpaceReads = {
      space: async (instance) => (instance.source === "joined" ? { totalBytes: 1000, freeBytes: 50 } : { totalBytes: 10_000, freeBytes: 9_000 }),
      sizes: async () => ({ globalBytes: 100, localBytes: 100, needBytes: 0 }),
      completion: async (instance) => (instance.source === "joined" ? 0 : 100),
    };
    const round = roundOf(() => layout, [keeper], [], { space: reads, pauses: memoryLayeredPauses(), now: () => now });
    await round.run();
    const joined = (): LocalInstance => ({ ...instanceOf(nodeAtTwenty()), source: "joined" });

    assert.equal((await round.joinedRound(joined())).state?.space?.state, "raised", "the keeper's decision is a minute old at most");

    now = new Date(now.getTime() + 121_000);
    assert.equal((await round.joinedRound(joined())).state?.space?.state, "stopped", "a decision past the report limit counts for nothing");
  });
});

describe("keepers by their own decision", () => {
  it("two nodes that both keep a folder and are both short of space never drop it on the word of the other", async () => {
    const both = layoutText(true, 20).replace("threshold = 0\nadmitted  = true", "threshold = 20\nadmitted  = true\napply     = true");
    const layout = parseLayout(both);
    const syncthings = ["a001", "a002"].map((nodeId) => onPlan(nodePlan(layout, nodeId, carriedLayoutPaths(layout, nodeId, new Set(["documents", "documents-old"]))) as NodePlan));
    const short: SpaceReads = {
      space: async () => ({ totalBytes: 1000, freeBytes: 50 }),
      sizes: async () => ({ globalBytes: 100, localBytes: 100, needBytes: 0 }),
      completion: async () => 100,
    };

    await roundOf(() => layout, [instanceOf(syncthings[0], "a001"), instanceOf(syncthings[1], "a002")], [], { space: short, pauses: memoryLayeredPauses() }).run();

    const states = ["a001", "a002"].map((nodeId) => layeredStateOf(nodeId)?.space?.state);
    assert.deepEqual(states, ["stopped", "stopped"], "neither counts the other, which only fits by dropping the folder");
    for (const syncthing of syncthings) assert.equal(folderOf(syncthing, "documents-old").type, "sendreceive", "neither turned it send-only");
  });
});

describe("the hand-off trash", () => {
  it("counts as freeing on its own, so a node in the middle of a hand-off stays raised, and lets nothing pull on it", async () => {
    const syncthing = nodeAtFifty();
    let finishedAt = "2026-11-05T11:58:00.000Z";
    const result = (trashBytes: number) => ({ schema: 1, nodeId: "a001", contractWrittenAt: "", finishedAt, refused: null, results: [], trash: [], notes: [], purged: 0, trashBytes });
    let trash = 100;
    const publisher: HandoffPublisher = { publish: async () => 0, clear: async () => {}, last: () => null, result: async () => result(trash) };
    const space: SpaceReads = {
      space: async () => ({ totalBytes: 1000, freeBytes: 50 }),
      sizes: async (_instance, id) => (id === "documents" ? { globalBytes: 100, localBytes: 100, needBytes: 0 } : { globalBytes: 100, localBytes: 0, needBytes: 100 }),
    };
    const round = roundOf(() => parseLayout(layoutText(true, 20)), [instanceOf(syncthing)], [], { space, handoffs: publisher, pauses: memoryLayeredPauses() });

    await round.run();
    assert.deepEqual(layeredStateOf("a001")?.space, { state: "raised", threshold: 80, neededBytes: 100, availableBytes: 250 }, "Old has left into the trash, which frees 100 by itself");
    assert.equal(folderOf(syncthing, "documents-old").type, "sendonly", "no type-up on bytes still in the trash");

    finishedAt = "2026-11-05T11:54:59.000Z";
    await round.run();
    assert.equal(layeredStateOf("a001")?.space?.state, "stopped", "a result older than the contract's age limit says nothing of the trash now");
    finishedAt = "2026-11-05T12:01:01.000Z";
    await round.run();
    assert.equal(layeredStateOf("a001")?.space?.state, "stopped", "nor one written more than a minute ahead of this host's clock");

    finishedAt = "2026-11-05T11:58:00.000Z";
    trash = 0;
    await round.run();
    assert.equal(layeredStateOf("a001")?.space?.state, "stopped", "without it the same node would stop");
  });
});

describe("resuming on a recorded size", () => {
  /** Both folders paused by a stop with 100 bytes recorded each, on a node whose paused folders report nothing. */
  function pausedNode(size: { globalBytes: number; localBytes: number; needBytes: number } | null) {
    const syncthing = nodeAtTwenty();
    for (const folder of syncthing.folders) folder.paused = true;
    const pauses = memoryLayeredPauses({ a001: { documents: { at: "2026-11-05T11:30:00.000Z", size }, "documents-old": { at: "2026-11-05T11:00:00.000Z", size } } });
    return { syncthing, pauses };
  }
  const reads = (freeBytes: number): SpaceReads => ({ space: async () => ({ totalBytes: 1000, freeBytes }), sizes: async () => Promise.reject(new Error("folder is paused")) });

  it("needs a 25% margin on the recorded global size, and says the record's age while it waits", async () => {
    const size = { globalBytes: 100, localBytes: 0, needBytes: 100 };
    const tight = pausedNode(size);
    await roundOf(() => parseLayout(layoutText(true, 20)), [instanceOf(tight.syncthing)], [], { space: reads(300), pauses: tight.pauses }).run();
    assert.equal(layeredStateOf("a001")?.space?.state, "fits", "200 needed of 300 free leaves the 100 of 10% plus nothing more");
    assert.ok(tight.syncthing.folders.every((folder) => folder.paused === true), "250 with the margin does not fit");
    const held = layeredStateOf("a001")?.drift.find((change) => change.field === "paused")?.held ?? "";
    assert.match(held, /on sizes recorded 60 minutes ago with a 25% margin/);

    const roomy = pausedNode(size);
    await roundOf(() => parseLayout(layoutText(true, 20)), [instanceOf(roomy.syncthing)], [], { space: reads(400), pauses: roomy.pauses }).run();
    assert.ok(roomy.syncthing.folders.every((folder) => folder.paused === false), "with the margin it fits, so it resumes; the next round decides on live sizes");
  });

  it("never resumes a pause recorded without a size by itself, saying the typed resume does", async () => {
    const unsized = pausedNode(null);
    await roundOf(() => parseLayout(layoutText(true, 20)), [instanceOf(unsized.syncthing)], [], { space: reads(900), pauses: unsized.pauses }).run();
    assert.ok(unsized.syncthing.folders.every((folder) => folder.paused === true));
    assert.match(layeredStateOf("a001")?.drift.find((change) => change.field === "paused")?.held ?? "", /paused with no size recorded: only the typed resume on the node page resumes it/);
  });

  it("names the trash bytes a paused folder cannot empty", async () => {
    const node = pausedNode(null);
    const publisher: HandoffPublisher = { publish: async () => 0, clear: async () => {}, last: () => null, result: async () => ({ schema: 1, nodeId: "a001", contractWrittenAt: "", finishedAt: "2026-11-05T11:59:00.000Z", refused: null, results: [], trash: [], notes: [], purged: 0, trashBytes: 42 }) };
    await roundOf(() => parseLayout(layoutText(true, 20)), [instanceOf(node.syncthing)], [], { space: reads(900), pauses: node.pauses, handoffs: publisher }).run();
    assert.match(layeredStateOf("a001")?.drift.find((change) => change.field === "paused")?.held ?? "", /a paused folder cannot empty its trash, so 42 bytes wait in it and the typed resume on the node page may be needed$/);
    assert.equal(layeredStateOf("a001")?.trashBytes, 42);
  });
});

describe("a stop held on an array", () => {
  it("says it cannot pause without the folder ID typed, in its state and in one notification", async () => {
    const syncthing = nodeAtTwenty();
    const notified: Notification[] = [];
    const round = roundOf(() => parseLayout(disabled(layoutText(true, 20))), [instanceOf(syncthing, "a001", "array")], [], { space: spaceOf(1000, 900), pauses: memoryLayeredPauses(), notify: async (entry) => void notified.push(entry) });

    await round.run();
    await round.run();

    assert.deepEqual(syncthing.writes(), []);
    assert.equal(layeredStateOf("a001")?.pauseHeld, "it cannot be paused without the folder ID typed");
    assert.deepEqual(notified.map((entry) => entry.title), ["laptop-data cannot be paused"]);
    assert.match(notified[0].message, /nothing was paused/);
  });
});

describe("the cluster's notification across a restart", () => {
  it("is sent once although a new round object reads the same record", async () => {
    const directory = mkdtempSync(join(tmpdir(), "notified-round-"));
    try {
      const clusterText = layoutText(true).replace('root = "/keep"', 'root = "/keep"\nrole = "archive"');
      const layout = parseLayout(clusterText);
      const plan = nodePlan(layout, "a002", carriedLayoutPaths(layout, "a002", new Set(["documents", "documents-old"]))) as NodePlan;
      const notified: Notification[] = [];
      for (let restart = 0; restart < 2; restart++) {
        const instance = { ...instanceOf(onPlan(plan), "a002"), name: "keeper-data" };
        await roundOf(() => layout, [instance], [], { space: spaceOf(210, 10), notified: fileNotifiedState(join(directory, "notified.json")), notify: async (entry) => void notified.push(entry) }).run();
      }
      assert.deepEqual(notified.map((entry) => entry.title), ["keeper-data is short of space"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the contract of a node that is not enabled", () => {
  it("never applies: trash-only while it acts, also when its round fails; a reporting one once the layout blocks it or does not admit it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "held-contract-"));
    try {
      const silent = nodeAtTwenty();
      silent.answers = false;
      const base = disabled(layoutText(true, 20));
      const cases: [string, string, FakeSyncthing, boolean][] = [
        ["its round fails", base, silent, true],
        ["it plans", base, nodeAtTwenty(), true],
        ["the layout blocks it", base.replace('name      = "laptop-data"', 'name      = "laptop data!"'), nodeAtTwenty(), false],
        ["it is not admitted", base.replace("threshold = 20\nadmitted  = true", "threshold = 20"), nodeAtTwenty(), false],
      ];
      for (const [name, text, syncthing, acting] of cases) {
        rmSync(join(directory, "a001.json"), { force: true });
        await roundOf(() => parseLayout(text), [instanceOf(syncthing)], [], { handoffs: handoffPublisher(undefined, () => directory), space: spaceOf(1000, 900), pauses: memoryLayeredPauses() }).run();
        const contract = await readHandoffContract(join(directory, "a001.json"));
        assert.deepEqual([contract?.apply, contract?.trashOnly, contract?.entries], [false, acting ? true : undefined, []], name);
        if (acting) assert.match(contract?.notes.join(" ") ?? "", /hand-offs are held: laptop-data is not enabled/, name);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
