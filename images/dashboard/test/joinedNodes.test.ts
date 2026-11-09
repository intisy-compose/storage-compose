import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type JoinedRound, LayoutRound, mountedHandoffFiles, nodeHandoffFiles } from "../src/applyLayout.js";
import { handoffPublisher, syncthingHandoffReads } from "../src/handoffFeed.js";
import type { JoinedDevice, JoinRecords } from "../src/join.js";
import { type JoinedNodeReport, answerJoinedNode, forgetHeardNodes, joinedClaimFor, joinedDeviceIdOf, joinedNodeInfos } from "../src/joinedNodes.js";
import type { RequestError } from "../src/http.js";
import type { JoinedOp } from "../src/joinedClient.js";
import { fileLayeredPauses } from "../src/layeredPauses.js";
import { parseLayout, type SetupLayout } from "../src/setupRepo.js";
import type { WhoIs } from "../src/tailnet.js";

const stickId = "STICKXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX";
const otherId = "OTHERXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX";

function layoutText(options: { apply?: boolean; admitted?: boolean; device?: string; threshold?: number } = {}): string {
  return `
[devices.stick]
id = "${stickId}"
root = "/media/stick"
joined = true

[devices.other]
id = "${otherId}"
root = "/srv/other"
joined = true

[folders.Essential]
priority = 80

[folders.Archive]
priority = 30

[nodes.b001]
name = "stick"
device = "${options.device ?? "stick"}"
threshold = ${options.threshold ?? 50}
admitted = ${options.admitted ?? true}
apply = ${options.apply ?? false}

[nodes.c002]
name = "other"
device = "other"
threshold = 0
admitted = true
`;
}

const record: JoinedDevice = { name: "stick", syncthingDeviceId: stickId, os: "linux", nodes: [], joinedAt: "2026-11-01", tailnetName: "stick-host", setup: null };
const records: JoinRecords = { all: async () => ({ stick: record }), put: async () => undefined };
const caller: WhoIs = { nodeName: "stick-host", loginName: "finn", tags: [], addresses: ["100.64.0.5"] } as unknown as WhoIs;
const now = new Date("2026-11-08T12:00:00Z");

function folderReport(id: string, path: string, type = "sendreceive") {
  return { id, path, type, paused: false, devices: [stickId], versioning: { type: "" }, ignores: [] as string[] | null, status: { globalBytes: 100, localBytes: 100, needBytes: 0, state: "idle", stateChanged: "2026-11-08T11:00:00Z", remoteSequence: { X: 1 } } };
}

function report(overrides: Partial<JoinedNodeReport> = {}): JoinedNodeReport {
  return { schema: 1, name: "stick", kind: "drive", threshold: 50, root: "/media/stick", os: "linux", deviceId: stickId, knownDevices: [stickId, otherId], folders: [folderReport("essential", "/media/stick/Essential")], files: [], space: { totalBytes: 1000, freeBytes: 900 }, result: null, listingProblems: [], ...overrides };
}

function round(layout: SetupLayout | null, committedApply = true): LayoutRound {
  const directory = mkdtempSync(join(tmpdir(), "joined-round-"));
  return new LayoutRound({
    layout: async () => layout,
    instances: async () => [],
    committedLayout: async () => (layout ? { layout: { ...layout, nodes: layout.nodes.map((node) => ({ ...node, apply: committedApply && node.apply })) }, pushed: true } : null),
    handoffFiles: nodeHandoffFiles(mountedHandoffFiles([]), mountedHandoffFiles([])),
    handoffs: handoffPublisher({ files: async () => [], entry: async () => null, fileReport: async () => null, completion: async () => 0, sizes: async () => ({ globalBytes: 0, localBytes: 0 }), space: async () => null, keeperState: async () => "ok" }, () => directory),
    pauses: fileLayeredPauses(join(directory, "paused.json")),
    space: syncthingHandoffReads,
    record: () => undefined,
    now: () => now,
  });
}

function dependencies(layout: SetupLayout | null, options: { round?: LayoutRound; admit?: (addresses: string[]) => Promise<WhoIs> } = {}) {
  return { admit: options.admit ?? (async () => caller), records, layout: async () => layout, round: options.round ?? round(layout), resultDirectory: mkdtempSync(join(tmpdir(), "joined-result-")), now: () => now };
}

function opsOf(ops: JoinedOp[], folderId: string): JoinedOp[] {
  return ops.filter((op) => "folderId" in op && op.folderId === folderId);
}

describe("a joined device's report", () => {
  it("refuses a report that does not read", async () => {
    const layout = parseLayout(layoutText());
    await assert.rejects(answerJoinedNode(dependencies(layout), ["100.64.0.5"], "b001", { schema: 9 }), /schema/);
    await assert.rejects(answerJoinedNode(dependencies(layout), ["100.64.0.5"], "b001", { ...report(), files: [{ folderId: "x", path: "y" }] }), /unreadable file/);
  });

  it("is told about no node of another device: a caller that is not on the tailnet, or another device's node, gets 404", async () => {
    const layout = parseLayout(layoutText({ device: "other" }));
    await assert.rejects(answerJoinedNode(dependencies(layout), ["100.64.0.5"], "b001", report()), /no node b001 of the calling device/);
    await assert.rejects(answerJoinedNode(dependencies(parseLayout(layoutText()), { admit: async () => { throw new Error("refused"); } }), ["1.2.3.4"], "b001", report()), /no node b001/);
    await assert.rejects(answerJoinedNode(dependencies(parseLayout(layoutText())), ["100.64.0.5"], "b001", report({ deviceId: otherId })), /no node b001/);
  });

  it("gets a report-mode plan and writes nothing while the node does not apply", async () => {
    const answer = await answerJoinedNode(dependencies(parseLayout(layoutText({ apply: false }))), ["100.64.0.5"], "b001", report());

    assert.equal(answer.apply, false);
    assert.deepEqual(answer.ops, []);
    assert.equal(answer.nodeFile.action, "withdraw");
    assert.equal(answer.contract?.apply, false);
  });

  it("withdraws apply on any doubt: unpushed or uncommitted", async () => {
    const layout = parseLayout(layoutText({ apply: true }));
    const answer = await answerJoinedNode(dependencies(layout, { round: round(layout, false) }), ["100.64.0.5"], "b001", report());

    assert.equal(answer.apply, false);
    assert.deepEqual(answer.ops, []);
    assert.equal(answer.nodeFile.action, "withdraw");
  });

  it("applies through the same reconciler: ops in the reconciler's order, and the node file follows", async () => {
    const answer = await answerJoinedNode(dependencies(parseLayout(layoutText({ apply: true }))), ["100.64.0.5"], "b001", report());

    assert.equal(answer.apply, true);
    assert.equal(answer.nodeFile.action, "follow");
    const ops = opsOf(answer.ops, "essential");
    assert.deepEqual(ops.map((op) => op.op), ["ignores", "ensureList", "ignores", "versioning", "devices"]);
    const [first, , second] = ops as Extract<JoinedOp, { op: "ignores" }>[];
    assert.ok(first.lines.includes("/.stignore-handoff"));
    assert.ok(!first.lines.includes("#include .stignore-handoff"));
    assert.ok(second.lines.includes("#include .stignore-handoff"));
  });

  it("adds the planned folder and the layout devices the device lacks, and never a closed one", async () => {
    const layout = parseLayout(layoutText({ apply: true }).replace('name = "other"', 'name = "other"\naccess = "closed"'));
    const answer = await answerJoinedNode(dependencies(layout), ["100.64.0.5"], "b001", report({ folders: [], knownDevices: [stickId] }));

    assert.deepEqual(answer.ops.filter((op) => op.op === "addDevice").map((op) => (op as { deviceId: string }).deviceId), []);
    const added = answer.ops.filter((op) => op.op === "addFolder") as Extract<JoinedOp, { op: "addFolder" }>[];
    assert.deepEqual(added.map((op) => op.id), ["essential"]);
    assert.equal(added[0].type, "sendonly", "without a size no space rule lets it pull yet");
    assert.ok(added[0].ignores.includes("#include .stignore-handoff"));
    assert.equal(added[0].path, "/media/stick/Essential");
    assert.deepEqual(added[0].devices, [stickId]);
  });

  it("holds a type-up the space rule does not allow", async () => {
    const answer = await answerJoinedNode(dependencies(parseLayout(layoutText({ apply: true }))), ["100.64.0.5"], "b001", report({ folders: [folderReport("essential", "/media/stick/Essential", "sendonly")], space: { totalBytes: 1000, freeBytes: 0 } }));

    assert.deepEqual(answer.ops.filter((op) => op.op === "type"), []);
    assert.equal(answer.drift.find((change) => change.field === "type")?.written, false);
  });

  it("carries a contract whose apply follows the gate, and the file the node reported as its own", async () => {
    const layout = parseLayout(layoutText({ apply: true, threshold: 90 }));
    const answer = await answerJoinedNode(dependencies(layout), ["100.64.0.5"], "b001", report({ folders: [folderReport("archive", "/media/stick/Archive", "sendonly")], files: [] }));

    assert.equal(answer.contract?.apply, true);
    assert.equal(answer.contract?.nodeId, "b001");
    assert.deepEqual(answer.contract?.entries, []);
  });
});

describe("what a report could not read", () => {
  const applying = () => dependencies(parseLayout(layoutText({ apply: true })));
  const unknownIgnores = () => report({ folders: [{ ...folderReport("essential", "/media/stick/Essential"), ignores: null }] });

  it("plans no overwrite of a .stignore it could not read, so the device's own lines stay", async () => {
    const answer = await answerJoinedNode(applying(), ["100.64.0.5"], "b001", unknownIgnores());

    assert.deepEqual(answer.ops, [], "nothing at all is written while one folder's list is unknown");
  });

  it("refuses a folder report without its versioning, which would read as no versioning and be replaced", async () => {
    const { versioning: _left, ...withoutVersioning } = folderReport("essential", "/media/stick/Essential");
    await assert.rejects(answerJoinedNode(applying(), ["100.64.0.5"], "b001", report({ folders: [withoutVersioning as never] })), /unreadable folder/);
  });

  it("carries a listing the device could not make, as a problem of the node", async () => {
    const answer = await answerJoinedNode(applying(), ["100.64.0.5"], "b001", report({ listingProblems: ["archive: the listing is too large"] }));

    assert.ok(answer.problems.includes("archive: the listing is too large"));
  });
});

describe("whose node it is", () => {
  it("is nobody's when the layout lists it with no device, or with one it does not have", async () => {
    for (const device of ["", "gone"]) {
      await assert.rejects(answerJoinedNode(dependencies(parseLayout(layoutText({ device }))), ["100.64.0.5"], "b001", report()), /no node b001/, `device "${device}"`);
    }
  });

  const devicesWith = (...names: JoinedDevice[]): JoinRecords => ({ all: async () => Object.fromEntries(names.map((device) => [device.name, device])), put: async () => undefined });
  const otherRecord: JoinedDevice = { ...record, name: "other", syncthingDeviceId: otherId, tailnetName: "other-host" };
  const otherCaller = { ...caller, nodeName: "other-host" } as WhoIs;

  it("every device has its own claim on an unlisted id, so a squatter cannot keep the real owner out, and neither sees the other", async () => {
    forgetHeardNodes();
    const layout = parseLayout(layoutText());
    const both = devicesWith(record, otherRecord);
    const first = await answerJoinedNode({ ...dependencies(layout), records: both }, ["100.64.0.5"], "aaa1", report());
    assert.equal(first.contract, null, "an unlisted node has no contract and no round");

    const second = await answerJoinedNode({ ...dependencies(layout), records: both, admit: async () => otherCaller }, ["100.64.0.6"], "aaa1", report({ deviceId: otherId, name: "other" }));
    assert.deepEqual([second.apply, second.ops, second.contract, second.drift], [false, [], null, []]);

    const claims = joinedNodeInfos(now).filter((info) => info.nodeId === "aaa1").map((info) => [info.claimedBy?.deviceId, info.claimedBy?.deviceName]);
    assert.deepEqual(claims.sort(), [[otherId, "other"], [stickId, "stick"]].sort());
    assert.equal(joinedDeviceIdOf("aaa1", otherId), otherId);
    assert.equal(joinedDeviceIdOf("aaa1"), null, "two devices claim it, so no one is taken for its device unnamed");
    assert.throws(() => joinedClaimFor("aaa1", undefined, now), /more than one device claims/);
    assert.equal(joinedClaimFor("aaa1", stickId, now)?.claimedBy?.deviceName, "stick");
    forgetHeardNodes();
  });

  it("keeps no result of a node the layout does not list", async () => {
    const dependenciesOfRun = dependencies(parseLayout(layoutText()));
    const result = { schema: 1, nodeId: "aaa2", contractWrittenAt: "", finishedAt: "2026-11-08T12:00:00Z", refused: null, results: [], trash: [], notes: [], purged: 0 };
    await answerJoinedNode(dependenciesOfRun, ["100.64.0.5"], "aaa2", report({ result: result as never }));

    assert.equal(existsSync(join(dependenciesOfRun.resultDirectory, "aaa2.result.json")), false);
  });

  it("caps a device's unlisted claims, for that device alone, and never a listed node", async () => {
    forgetHeardNodes();
    const layout = parseLayout(layoutText());
    const both = devicesWith(record, otherRecord);
    for (let index = 0; index < 16; index++) await answerJoinedNode({ ...dependencies(layout), records: both }, ["100.64.0.5"], (0xa000 + index).toString(16), report());
    await assert.rejects(answerJoinedNode({ ...dependencies(layout), records: both }, ["100.64.0.5"], "aabb", report()), (error: RequestError) => error.status === 429);
    assert.equal((await answerJoinedNode({ ...dependencies(layout), records: both }, ["100.64.0.5"], "b001", report())).admitted, true, "a listed node is heard whatever the claims");
    assert.equal((await answerJoinedNode({ ...dependencies(layout), records: both, admit: async () => otherCaller }, ["100.64.0.6"], "aabb", report({ deviceId: otherId, name: "other" }))).admitted, false, "another device is not held back");
    assert.equal(joinedDeviceIdOf("a000", stickId), stickId, "what was heard stays");
    forgetHeardNodes();
  });
});

describe("a node the layout does not know yet", () => {
  it("stays pending: it is heard for Requests and gets an empty plan and no contract moves", async () => {
    const layout = parseLayout(layoutText()).nodes.length ? parseLayout(layoutText().replace('[nodes.b001]', '[nodes.dead]')) : null;
    const answer = await answerJoinedNode(dependencies(layout), ["100.64.0.5"], "b001", report());

    assert.equal(answer.apply, false);
    assert.deepEqual(answer.ops, []);
    assert.equal(answer.admitted, false);
    assert.equal(answer.contract, null);
    assert.ok(joinedNodeInfos(now).some((info) => info.nodeId === "b001" && info.name === "stick" && info.source === "joined"));
    assert.equal(joinedDeviceIdOf("b001", stickId), stickId);
    assert.equal(joinedDeviceIdOf("b001"), stickId, "one claim, unnamed is that one");
  });

  it("is no longer listed once it has stopped reporting", () => {
    assert.ok(!joinedNodeInfos(new Date(now.getTime() + 16 * 60_000)).some((info) => info.nodeId === "b001"));
  });
});

export type { JoinedRound };
