import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type LayoutRoundDependencies, LayoutRound, type SpaceReads, mountedHandoffFiles, pullThenReconcile } from "../src/applyLayout.js";
import type { HandoffPublisher } from "../src/handoffFeed.js";
import type { LocalInstance } from "../src/instanceResolver.js";
import { layeredStateOf } from "../src/layeredDrift.js";
import { nodePlan } from "../src/nodePlan.js";
import { carriedLayoutPaths } from "../src/reconcileNode.js";
import { type SetupLayout, parseLayout } from "../src/setupRepo.js";
import type { FolderSize } from "../src/spacePlan.js";
import { memoryLayeredPauses } from "../src/layeredPauses.js";
import type { Notification } from "../src/notifyOutbox.js";
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
