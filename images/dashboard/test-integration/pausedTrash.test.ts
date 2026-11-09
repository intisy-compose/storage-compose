import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { LayoutRound, type SpaceReads } from "../src/applyLayout.js";
import { type HandoffContract, type HandoffReads, handoffPublisher, readHandoffContract, syncthingHandoffReads } from "../src/handoffFeed.js";
import type { LocalInstance } from "../src/instanceResolver.js";
import { layeredStateOf } from "../src/layeredDrift.js";
import { memoryLayeredPauses } from "../src/layeredPauses.js";
import { handoffIgnoreFile } from "../src/nodePlan.js";
import { fileNotifiedState } from "../src/notifiedState.js";
import type { HandoffFiles } from "../src/reconcileNode.js";
import { type SetupLayout, parseLayout } from "../src/setupRepo.js";
import type { NodeSpace } from "../src/spacePlan.js";
import { SyncthingClient } from "../src/syncthing.js";
import { type ExecutorResult, buildExecutorImage, inPeer, runExecutor, writeNodeFile } from "./executor.js";
import { type Peer, type PeerName, type Peers, completion, ensureEmptyFile, fileExists, fileReport, folderState, pauseDevice, readFile, request, resumeDevice, scan, startPeers, stopPeers, waitUntil, writeFile } from "./peers.js";

const root = "/var/syncthing/folders";
const manifest = `${root}/.storage/handoff-trash/manifest.jsonl`;
const nodeIds: Record<PeerName, string> = { stick: "e001", keeper: "e002", other: "e003" };
const roomy: NodeSpace = { totalBytes: 10_000_000_000, freeBytes: 9_000_000_000 };

let peers: Peers;
let scratch: string;
const spaceOf: Record<string, NodeSpace> = { e001: roomy, e002: roomy, e003: roomy };
const reads: HandoffReads = { ...syncthingHandoffReads, space: async (instance) => spaceOf[instance.nodeId] ?? null };
const spaceReads: SpaceReads = { space: reads.space, sizes: reads.sizes, completion: reads.completion };

function layoutOf(): SetupLayout {
  return parseLayout(`
[devices.stick]
id   = "${peers.stick.deviceId}"
root = "${root}"

[devices.keeper]
id   = "${peers.keeper.deviceId}"
root = "${root}"

[devices.other]
id   = "${peers.other.deviceId}"
root = "${root}"

[folders.Archive]
priority = 30

[nodes.e001]
name      = "stick"
device    = "stick"
threshold = 50
admitted  = true
apply     = true

[nodes.e002]
name      = "keeper"
device    = "keeper"
threshold = 0
admitted  = true

[nodes.e003]
name      = "other"
device    = "other"
threshold = 0
admitted  = true
`);
}

function instanceOf(peer: Peer): LocalInstance {
  return { kind: "local", nodeId: nodeIds[peer.name], name: peer.name, client: new SyncthingClient({ url: peer.url, apiKey: peer.apiKey }), root, os: "linux", threshold: 0, source: "registry" };
}

const stickFiles: HandoffFiles = { ensure: async (_instance, planned) => ((await ensureEmptyFile(peers.stick, `${planned.path}/${handoffIgnoreFile}`)) ? null : "the folder's directory is missing") };

let round: LayoutRound;

async function layoutRound(): Promise<HandoffContract> {
  await round.run();
  const contract = await readHandoffContract(join(scratch, "e001.json"));
  assert.ok(contract, "the round wrote the stick's contract");
  return contract;
}

async function putFolder(peer: Peer, type: string): Promise<void> {
  const devices = [peers.stick, peers.keeper, peers.other].map((member) => ({ deviceID: member.deviceId }));
  await request(peer, "PUT", "/rest/config/folders/archive", { id: "archive", label: "Archive", path: `${root}/Archive`, type, devices, fsWatcherEnabled: false, rescanIntervalS: 3600 });
  await waitUntil(async () => (await folderState(peer, "archive")) === "idle", `archive idle on ${peer.name}`);
}

function paused(peer: Peer): Promise<boolean> {
  return request<{ paused: boolean }>(peer, "GET", "/rest/config/folders/archive").then((folder) => folder.paused);
}

function trashCopy(): Promise<string> {
  return inPeer(peers.stick, 'grep -c "" "$1" || true', manifest).then((lines) => lines.trim());
}

function execute(): Promise<ExecutorResult> {
  return runExecutor(peers.stick, scratch, "e001", root);
}

/** The 7 days, passed by the manifest's own clock, so evidence read a moment ago stays fresh. */
function ageManifestPastTheTrashDays(): Promise<string> {
  return inPeer(peers.stick, 'sed -i -E "s/\\"movedAt\\":[0-9]+/\\"movedAt\\":1/" "$1"', manifest);
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "layered-paused-trash-"));
  await buildExecutorImage();
  peers = await startPeers();
  await putFolder(peers.stick, "sendonly");
  await putFolder(peers.keeper, "sendreceive");
  await putFolder(peers.other, "sendreceive");
  await writeNodeFile(peers.stick, root, "e001", true);
  round = new LayoutRound({
    layout: async () => layoutOf(),
    committedLayout: async () => ({ layout: layoutOf(), pushed: true }),
    instances: async () => [peers.stick, peers.keeper, peers.other].map(instanceOf),
    handoffFiles: stickFiles,
    handoffs: handoffPublisher(reads, () => scratch),
    space: spaceReads,
    pauses: memoryLayeredPauses(),
    notify: async () => undefined,
    notified: fileNotifiedState(join(scratch, "notified.json")),
    record: () => {},
    readBackDelaysMs: [],
  });
});

after(async () => {
  await stopPeers();
  rmSync(scratch, { recursive: true, force: true });
});

test("a stopped node's paused folder empties its due trash on the keeper's own index, and only then", { timeout: 300_000 }, async () => {
  await writeFile(peers.stick, "Archive", "old.bin", "handed off before the stop");
  await inPeer(peers.stick, 'touch -d "@$2" "$1"', `${root}/Archive/old.bin`, String(Math.floor(Date.now() / 1000) - 1200));
  await scan(peers.stick, "archive");
  for (const keeper of [peers.keeper, peers.other]) {
    await waitUntil(async () => (await fileExists(keeper, "Archive", "old.bin")) && (await completion(keeper, "archive")).completion === 100, `old.bin complete on ${keeper.name}`);
  }
  const handing = await layoutRound();
  assert.deepEqual(handing.entries.map((entry) => entry.path), ["old.bin"]);
  const moved = await execute();
  assert.deepEqual(moved.results.map((entry) => entry.outcome), ["moved"]);
  assert.equal(await trashCopy(), "1", "the manifest has the copy");

  spaceOf.e001 = { totalBytes: 10_000_000, freeBytes: 10_000 };
  const stopped = await layoutRound();
  assert.equal(layeredStateOf("e001")?.space?.state, "stopped");
  assert.equal(await paused(peers.stick), true, "the folder is paused, so the stick's own index answers nothing");
  assert.deepEqual([stopped.apply, stopped.trashOnly, stopped.entries, stopped.trashEvidence], [false, true, [], undefined], "nothing has asked for evidence yet");

  await ageManifestPastTheTrashDays();
  const asked = await execute();
  assert.equal(asked.refused, null);
  assert.equal(asked.purged, 0, "the first run has no evidence, so the copy stays");
  assert.deepEqual((asked as ExecutorResult & { awaitingKeeperEvidence: unknown[] }).awaitingKeeperEvidence, [{ folderId: "archive", path: "old.bin", keeperDevice: handing.entries[0].keeperDevice }]);

  const carried = await layoutRound();
  assert.deepEqual([carried.apply, carried.trashOnly, carried.entries], [false, true, []], "the stopped node's contract is still only trash");
  assert.equal(carried.trashEvidence?.length, 1, JSON.stringify(carried));
  const keeperPeer = handing.entries[0].keeper === "e002" ? peers.keeper : peers.other;
  const keeperIndex = await fileReport(keeperPeer, "archive", "old.bin");
  assert.deepEqual(carried.trashEvidence?.[0].version, keeperIndex.local.version, "read from the keeper's own index");

  await pauseDevice(peers.stick, keeperPeer);
  const disconnected = await execute();
  assert.equal(disconnected.purged, 0, "evidence or not, a keeper not connected to this node keeps the copy");
  await resumeDevice(peers.stick, keeperPeer);

  await request(keeperPeer, "PATCH", "/rest/config/folders/archive", { paused: true });
  const keeperPaused = await layoutRound();
  assert.equal(keeperPaused.trashEvidence, undefined, "a keeper whose folder is paused answers nothing either");
  await request(keeperPeer, "PATCH", "/rest/config/folders/archive", { paused: false });
  await waitUntil(async () => (await folderState(keeperPeer, "archive")) === "idle", "the keeper's folder idle again");

  const fresh = await layoutRound();
  assert.equal(fresh.trashEvidence?.length, 1, "with the keeper back, the evidence is read again");
  const emptied = await execute();
  assert.equal(emptied.refused, null);
  assert.equal(emptied.purged, 1, JSON.stringify(emptied));
  assert.equal((await readFile(keeperPeer, "Archive", "old.bin")).length, "handed off before the stop".length, "the keeper's copy is untouched");
  assert.equal(await paused(peers.stick), true, "the folder stayed paused throughout");
});
