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
import type { Notification } from "../src/notifyOutbox.js";
import type { HandoffFiles } from "../src/reconcileNode.js";
import { type SetupLayout, parseLayout } from "../src/setupRepo.js";
import type { NodeSpace } from "../src/spacePlan.js";
import { SyncthingClient } from "../src/syncthing.js";
import { buildExecutorImage, inPeer, runExecutor, writeNodeFile } from "./executor.js";
import { type Peer, type PeerName, type Peers, completion, ensureEmptyFile, fileExists, folderState, readFile, request, scan, startPeers, stopPeers, waitUntil, writeFile } from "./peers.js";

const root = "/var/syncthing/folders";
const nodeIds: Record<PeerName, string> = { stick: "e001", keeper: "e002", other: "e003" };
const roomy: NodeSpace = { totalBytes: 10_000_000_000, freeBytes: 9_000_000_000 };

let peers: Peers;
let scratch: string;
const pauses = memoryLayeredPauses();
const notified: Notification[] = [];

/** The scratch peers' disks are the Docker VM's, so each node's space is given here; folder sizes and completions are the real engine's. */
const spaceOf: Record<string, NodeSpace> = { e001: roomy, e002: roomy, e003: roomy };
const reads: HandoffReads = { ...syncthingHandoffReads, space: async (instance) => spaceOf[instance.nodeId] ?? null };
const spaceReads: SpaceReads = { space: reads.space, sizes: reads.sizes, completion: reads.completion };

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "layered-space-"));
  await buildExecutorImage();
  peers = await startPeers();
  for (const [folder, label] of [["archive", "Archive"], ["work", "Work"]]) {
    await putFolder(peers.stick, folder, label, folder === "archive" ? "sendonly" : "sendreceive");
    await putFolder(peers.keeper, folder, label, "sendreceive");
    await putFolder(peers.other, folder, label, "sendreceive");
  }
  await writeNodeFile(peers.stick, root, "e001", true);
});

after(async () => {
  await stopPeers();
  rmSync(scratch, { recursive: true, force: true });
});

interface Shape {
  stickThreshold: number;
  otherThreshold: number;
  keeperIsCluster: boolean;
}

const ordinary: Shape = { stickThreshold: 20, otherThreshold: 0, keeperIsCluster: false };

function layoutOf(shape: Shape): SetupLayout {
  return parseLayout(`
[devices.stick]
id   = "${peers.stick.deviceId}"
root = "${root}"

[devices.keeper]
id   = "${peers.keeper.deviceId}"
root = "${root}"
${shape.keeperIsCluster ? 'role = "archive"' : ""}

[devices.other]
id   = "${peers.other.deviceId}"
root = "${root}"

[folders.Archive]
priority = 30

[folders.Work]
priority = 80

[nodes.e001]
name      = "stick"
device    = "stick"
threshold = ${shape.stickThreshold}
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
threshold = ${shape.otherThreshold}
admitted  = true
`);
}

function instanceOf(peer: Peer): LocalInstance {
  return { kind: "local", nodeId: nodeIds[peer.name], name: peer.name, client: new SyncthingClient({ url: peer.url, apiKey: peer.apiKey }), root, os: "linux", threshold: 0, source: "registry" };
}

function stickFiles(): HandoffFiles {
  return { ensure: async (_instance, planned) => ((await ensureEmptyFile(peers.stick, `${planned.path}/${handoffIgnoreFile}`)) ? null : "the folder's directory is missing") };
}

let shapeNow: Shape = ordinary;
let round: LayoutRound | null = null;

/**
 * One layout round over the three peers, only the stick applying, then the stick's contract as it wrote it.
 * @implNote One round object for the whole file, as the dashboard keeps one, so what it notified stays known between rounds.
 */
async function layoutRound(shape: Shape = ordinary): Promise<HandoffContract> {
  shapeNow = shape;
  round ??= new LayoutRound({
    layout: async () => layoutOf(shapeNow),
    committedLayout: async () => ({ layout: layoutOf(shapeNow), pushed: true }),
    instances: async () => [peers.stick, peers.keeper, peers.other].map(instanceOf),
    handoffFiles: stickFiles(),
    handoffs: handoffPublisher(reads, () => scratch),
    space: spaceReads,
    pauses,
    notify: async (notification) => void notified.push(notification),
    record: () => {},
    readBackDelaysMs: [],
  });
  await round.run();
  const contract = await readHandoffContract(join(scratch, "e001.json"));
  assert.ok(contract, "the round wrote the stick's contract");
  return contract;
}

async function putFolder(peer: Peer, id: string, label: string, type: string): Promise<void> {
  const devices = [peers.stick, peers.keeper, peers.other].map((member) => ({ deviceID: member.deviceId }));
  await request(peer, "PUT", `/rest/config/folders/${id}`, { id, label, path: `${root}/${label}`, type, devices, fsWatcherEnabled: false, rescanIntervalS: 3600 });
  await waitUntil(async () => (await folderState(peer, id)) === "idle", `${id} idle on ${peer.name}`);
}

async function folderConfig(peer: Peer, id: string): Promise<{ type: string; paused: boolean }> {
  return request(peer, "GET", `/rest/config/folders/${id}`);
}

function threeBlocks(seedText: string): string {
  return seedText.repeat(Math.ceil(300_000 / seedText.length)).slice(0, 300_000);
}

/** A file made on a peer `minutesAgo` before now, scanned there and complete on the other two. */
async function seed(peer: Peer, name: string, content: string, minutesAgo = 20): Promise<void> {
  await writeFile(peer, "Archive", name, content);
  await inPeer(peer, 'touch -d "@$2" "$1"', `${root}/Archive/${name}`, String(Math.floor(Date.now() / 1000) - minutesAgo * 60));
  await scan(peer, "archive");
  for (const other of [peers.stick, peers.keeper, peers.other].filter((candidate) => candidate !== peer && candidate !== peers.stick)) {
    await waitUntil(async () => (await fileExists(other, "Archive", name)) && (await completion(other, "archive")).completion === 100, `${name} complete on ${other.name}`);
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("a folder held send-only turns send-receive once space allows, and pulls", async () => {
  await seed(peers.keeper, "big.bin", threeBlocks("kept on the keeper "));
  await waitUntil(async () => (await request<{ globalBytes: number }>(peers.stick, "GET", "/rest/db/status?folder=archive")).globalBytes === 300_000, "the stick knows big.bin from the keeper's index");
  spaceOf.e001 = { totalBytes: 1_000_000, freeBytes: 200_000 };

  await layoutRound();

  assert.deepEqual(layeredStateOf("e001")?.space, { state: "raised", threshold: 80, neededBytes: 0, availableBytes: 200_000 }, "Archive does not fit with 10% free, so the threshold is raised past it");
  assert.equal((await folderConfig(peers.stick, "archive")).type, "sendonly");
  await pause(3000);
  assert.equal(await fileExists(peers.stick, "Archive", "big.bin"), false, "a send-only folder pulls nothing");

  spaceOf.e001 = { totalBytes: 1_000_000, freeBytes: 900_000 };
  await layoutRound();

  assert.equal(layeredStateOf("e001")?.space?.state, "fits");
  assert.equal((await folderConfig(peers.stick, "archive")).type, "sendreceive");
  await waitUntil(async () => (await fileExists(peers.stick, "Archive", "big.bin")) && (await completion(peers.stick, "archive")).completion === 100, "big.bin pulled onto the stick");
  assert.equal((await readFile(peers.stick, "Archive", "big.bin")).length, 300_000);
});

test("a node near its limit raises and hands off through a confirmed keeper", async () => {
  await seed(peers.stick, "old.bin", threeBlocks("made on the stick "));
  spaceOf.e001 = { totalBytes: 1_000_000, freeBytes: 50_000 };

  const contract = await layoutRound();

  const space = layeredStateOf("e001")?.space;
  assert.deepEqual([space?.state, space?.threshold], ["raised", 80], "the stick holds all of Archive and the keeper holds all of it too, so the raise frees it");
  assert.equal((await folderConfig(peers.stick, "archive")).type, "sendonly", "the raise turns Archive send-only");
  assert.ok(contract.apply);
  assert.deepEqual(contract.entries.map((entry) => entry.path).sort(), ["big.bin", "old.bin"], "both settled and held by a keeper at the stick's version");
  assert.ok(contract.entries.every((entry) => ["e002", "e003"].includes(entry.keeper)));

  const result = await runExecutor(peers.stick, scratch, "e001", root);

  assert.equal(result.refused, null);
  assert.deepEqual(result.results.map((entry) => `${entry.path} ${entry.outcome}`).sort(), ["big.bin moved", "old.bin moved"]);
  for (const name of ["big.bin", "old.bin"]) {
    assert.equal(await fileExists(peers.stick, "Archive", name), false, `${name} left the stick`);
    for (const keeper of [peers.keeper, peers.other]) assert.equal((await readFile(keeper, "Archive", name)).length, 300_000, `${keeper.name} keeps ${name}`);
  }
});

test("a stopped node pulls nothing and hands off nothing", async () => {
  await seed(peers.stick, "late.bin", "would be handed off");
  spaceOf.e001 = { totalBytes: 10_000_000, freeBytes: 10_000 };

  const contract = await layoutRound();

  assert.equal(layeredStateOf("e001")?.space?.state, "stopped");
  assert.equal(layeredStateOf("e001")?.stopped, "stick does not fit even at its top priority");
  for (const id of ["archive", "work"]) assert.equal((await folderConfig(peers.stick, id)).paused, true, `${id} paused`);
  assert.deepEqual([contract.apply, contract.entries], [false, []], "the contract holds everything");
  assert.deepEqual(notified.map((entry) => entry.title), ["stick stopped"]);

  await seed(peers.keeper, "during.bin", "made on the keeper while the stick is stopped");
  await writeFile(peers.stick, "Archive", "gathered.txt", "made on the stick while it is stopped");
  const linesBefore = await readFile(peers.stick, "Archive", handoffIgnoreFile);
  const result = await runExecutor(peers.stick, scratch, "e001", root);

  assert.equal(result.refused, "the contract is not in apply mode");
  assert.equal(await fileExists(peers.stick, "Archive", "late.bin"), true, "nothing leaves a stopped node");
  assert.equal(await readFile(peers.stick, "Archive", handoffIgnoreFile), linesBefore);
  await pause(5000);
  assert.equal(await fileExists(peers.stick, "Archive", "during.bin"), false, "a paused folder pulls nothing");
  assert.equal(await fileExists(peers.keeper, "Archive", "gathered.txt"), false, "nor sends");
});

test("rejoining resumes, and what the node gathered while stopped reaches the keepers", async () => {
  spaceOf.e001 = { totalBytes: 10_000_000, freeBytes: 9_000_000 };

  await layoutRound();

  assert.equal(layeredStateOf("e001")?.stopped, null);
  for (const id of ["archive", "work"]) assert.equal((await folderConfig(peers.stick, id)).paused, false, `${id} resumed`);
  assert.equal((await folderConfig(peers.stick, "archive")).type, "sendreceive", "it fits at its threshold, so Archive pulls again");
  assert.deepEqual(notified.map((entry) => entry.title), ["stick stopped", "stick resumed"]);
  for (const keeper of [peers.keeper, peers.other]) {
    await waitUntil(async () => (await fileExists(keeper, "Archive", "gathered.txt")) && (await readFile(keeper, "Archive", "gathered.txt")) === "made on the stick while it is stopped", `gathered.txt on ${keeper.name}`);
  }
  await waitUntil(async () => fileExists(peers.stick, "Archive", "during.bin"), "during.bin on the stick");
  assert.equal(await fileExists(peers.stick, "Archive", "late.bin"), true);
  assert.equal(await fileExists(peers.stick, "Archive", "old.bin"), false, "a handed-off file stays ignored and is not pulled back");
});

test("a cluster short of space confirms no new hand-off, its folders stay as they are, and it says so", async () => {
  const shape: Shape = { stickThreshold: 50, otherThreshold: 50, keeperIsCluster: true };
  await seed(peers.stick, "waits.bin", "waits for the cluster");
  spaceOf.e002 = { totalBytes: 1_000_000_000, freeBytes: 0 };

  await layoutRound(shape);
  const contract = await layoutRound(shape);

  assert.equal(layeredStateOf("e002")?.space?.state, "full");
  assert.equal((await folderConfig(peers.stick, "archive")).type, "sendonly", "the stick still hands Archive off");
  assert.deepEqual(contract.entries, [], "no hand-off waits on the full cluster's confirmation");
  assert.ok(contract.waiting.some((entry) => entry.path === "waits.bin" && entry.reason === "keeper-full"), JSON.stringify(contract.waiting));
  for (const id of ["archive", "work"]) assert.deepEqual([(await folderConfig(peers.keeper, id)).paused, (await folderConfig(peers.keeper, id)).type], [false, "sendreceive"], `the cluster's ${id}`);
  assert.equal(notified.filter((entry) => entry.title === "keeper is short of space").length, 1);
  assert.equal(await fileExists(peers.stick, "Archive", "waits.bin"), true);

  spaceOf.e002 = roomy;
  const released = await layoutRound(shape);

  assert.ok(released.entries.some((entry) => entry.path === "waits.bin" && entry.keeper === "e002"), "with room again the cluster confirms it");
  assert.equal(notified.at(-1)?.title, "keeper has room again");
});
