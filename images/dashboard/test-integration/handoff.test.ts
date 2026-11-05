import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LayoutRound } from "../src/applyLayout.js";
import { type HandoffContract, type HandoffReads, handoffPublisher, readHandoffContract, syncthingHandoffReads } from "../src/handoffFeed.js";
import type { LocalInstance } from "../src/instanceResolver.js";
import { handoffIgnoreFile } from "../src/nodePlan.js";
import type { HandoffFiles } from "../src/reconcileNode.js";
import { type SetupLayout, parseLayout } from "../src/setupRepo.js";
import { SyncthingClient } from "../src/syncthing.js";
import { type Peer, type PeerName, type Peers, completion, ensureEmptyFile, fileExists, fileReport, folderState, readFile, request, scan, startPeers, stopPeers, waitUntil, writeFile } from "./peers.js";

const run = promisify(execFile);
const root = "/var/syncthing/folders";
const folder = "archive";
const executorScript = fileURLToPath(new URL("../../../../images/nodes/handoff.sh", import.meta.url));
const executorImage = "storage-nodes-tests:local";
const executorDockerfile = `FROM debian:trixie-slim
RUN apt-get update \\
    && apt-get install -y --no-install-recommends jq=1.7.1-6+deb13u4 curl=8.14.1-2+deb13u7 \\
    && rm -rf /var/lib/apt/lists/*
`;
const nodeIds: Record<PeerName, string> = { stick: "e001", keeper: "e002", other: "e003" };

let peers: Peers;
let scratch: string;

interface ExecutorResult {
  refused: string | null;
  results: { folderId: string; path: string; outcome: string; reason: string; trash?: string }[];
  purged: number;
}

function dockerBuild(dockerfile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["build", "--quiet", "-t", executorImage, "-"], { stdio: ["pipe", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk: Buffer) => { errorText += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker build: exit ${code} ${errorText}`))));
    child.stdin.end(dockerfile);
  });
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "layered-handoff-"));
  await dockerBuild(executorDockerfile);
  peers = await startPeers();
});

after(async () => {
  await stopPeers();
  rmSync(scratch, { recursive: true, force: true });
});

function layoutOf(apply: boolean): SetupLayout {
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
apply     = ${apply}

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

/** The scratch peers' roots are inside their containers, so their space is given rather than read. */
const reads: HandoffReads = { ...syncthingHandoffReads, space: async () => ({ totalBytes: 1_000_000_000_000, freeBytes: 900_000_000_000 }) };

function stickFiles(): HandoffFiles {
  return { ensure: async (_instance, planned) => ((await ensureEmptyFile(peers.stick, `${planned.path}/${handoffIgnoreFile}`)) ? null : "the folder's directory is missing") };
}

async function layoutRound(apply: boolean, instances: Peer[] = [peers.stick, peers.keeper, peers.other]): Promise<HandoffContract> {
  await new LayoutRound({
    layout: async () => layoutOf(apply),
    instances: async () => instances.map(instanceOf),
    handoffFiles: stickFiles(),
    handoffs: handoffPublisher(reads, () => scratch),
    record: () => {},
    readBackDelaysMs: [],
  }).run();
  const contract = await readHandoffContract(join(scratch, "e001.json"));
  assert.ok(contract, "the round wrote the stick's contract");
  return contract;
}

async function inPeer(peer: Peer, script: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("docker", ["exec", "-u", "1000:1000", peer.container, "sh", "-c", script, "sh", ...args]);
  return stdout;
}

async function writeNodeFile(apply: boolean): Promise<void> {
  await inPeer(peers.stick, 'mkdir -p "$1/.storage" && printf "%s\\n" "[node]" "id = \\"e001\\"" "name = \\"stick\\"" "kind = \\"drive\\"" "threshold = 50" "apply = $2" > "$1/.storage/node.toml"', root, String(apply));
}

/** A file on the stick, modified `minutesAgo` before now so the quiet period is past, sent to both keepers. */
async function seed(name: string, content: string, minutesAgo = 20): Promise<void> {
  await writeFile(peers.stick, "Archive", name, content);
  await inPeer(peers.stick, 'touch -d "@$2" "$1"', `${root}/Archive/${name}`, String(Math.floor(Date.now() / 1000) - minutesAgo * 60));
  await scan(peers.stick, folder);
  for (const keeper of [peers.keeper, peers.other]) {
    await waitUntil(async () => (await fileExists(keeper, "Archive", name)) && (await completion(keeper, folder)).completion === 100, `${name} complete on ${keeper.name}`);
  }
}

/** The executor in a container that shares the stick's volume and network, as the nodes service shares its node's, and sees no other process. */
async function runExecutor(environment: Record<string, string> = {}): Promise<ExecutorResult> {
  const variables = Object.entries({ HANDOFF_IGNORE_WAIT_SECONDS: "30", ...environment }).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  await run("docker", [
    "run", "--rm", "--network", `container:${peers.stick.container}`, "--volumes-from", peers.stick.container,
    "-u", "1000:1000", "-v", `${scratch}:/handoff`, "-v", `${executorScript}:/handoff.sh:ro`, ...variables, executorImage,
    "bash", "/handoff.sh", "e001", root, "http://127.0.0.1:8384", peers.stick.apiKey, "/handoff/e001.json", "/handoff/e001.result.json",
  ], { env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  return JSON.parse(readFileSync(join(scratch, "e001.result.json"), "utf8")) as ExecutorResult;
}

async function putFolder(peer: Peer, type: string): Promise<void> {
  const devices = [peers.stick, peers.keeper, peers.other].map((member) => ({ deviceID: member.deviceId }));
  await request(peer, "PUT", `/rest/config/folders/${folder}`, { id: folder, label: "Archive", path: `${root}/Archive`, type, devices, fsWatcherEnabled: false, rescanIntervalS: 3600 });
  await waitUntil(async () => (await folderState(peer, folder)) === "idle", `${folder} idle on ${peer.name}`);
}

async function listed(): Promise<string[]> {
  return (await readFile(peers.stick, "Archive", handoffIgnoreFile)).split("\n").filter(Boolean);
}

async function inTrash(relative: string): Promise<boolean> {
  return (await inPeer(peers.stick, 'if [ -f "$1" ]; then echo yes; else echo no; fi', `${root}/.storage/handoff-trash/${relative}`)).trim() === "yes";
}

/** About 300 KB, so the executor's hash covers three of Syncthing's blocks. */
function threeBlocks(seedText: string): string {
  return seedText.repeat(Math.ceil(300_000 / seedText.length)).slice(0, 300_000);
}

let movedTrash = "";
let movedRecord: HandoffContract["entries"][number] | undefined;

test("a file made on the stick below its threshold reaches the keeper, is confirmed, ignored, then moved to the stick's trash", async () => {
  await putFolder(peers.stick, "sendonly");
  await putFolder(peers.keeper, "sendreceive");
  await putFolder(peers.other, "sendreceive");
  await writeNodeFile(true);
  await seed("old.bin", threeBlocks("handed off "));

  const contract = await layoutRound(true);

  assert.deepEqual(contract.entries.map((entry) => `${entry.folderId} ${entry.path} ${entry.size} ${entry.numBlocks}`), [`${folder} old.bin 300000 3`]);
  movedRecord = contract.entries[0];
  assert.ok(["e002", "e003"].includes(movedRecord.keeper));
  const before = await fileReport(peers.stick, folder, "old.bin");
  assert.deepEqual([before.local.version, before.local.blocksHash], [movedRecord.version, movedRecord.blocksHash], "the record is the stick's own entry before the ignore");

  const result = await runExecutor();

  assert.equal(result.refused, null);
  assert.deepEqual(result.results.map((entry) => `${entry.path} ${entry.outcome}`), ["old.bin moved"]);
  movedTrash = result.results[0].trash ?? "";
  assert.equal(await fileExists(peers.stick, "Archive", "old.bin"), false, "gone from the stick's folder");
  assert.equal(await inTrash(movedTrash), true, "in the stick's trash");
  assert.equal((await inPeer(peers.stick, 'cat "$1"', `${root}/.storage/handoff-trash/${movedTrash}`)).length, 300_000);
  assert.deepEqual(await listed(), ["/old.bin"]);
  const after = await fileReport(peers.stick, folder, "old.bin");
  assert.equal(after.local.ignored, true, "the stick reports it ignored");
  assert.deepEqual(after.local.version, movedRecord.version, "an ignored entry keeps its version, never a deletion");
});

test("the keepers' copies are intact at the confirmed version and hash, and nothing was deleted anywhere", async () => {
  assert.ok(movedRecord);
  await scan(peers.stick, folder);
  for (const keeper of [peers.keeper, peers.other]) {
    await scan(keeper, folder);
    const report = await fileReport(keeper, folder, "old.bin");
    assert.equal(report.local.deleted, false, `${keeper.name}'s copy is not deleted`);
    assert.equal(report.global.deleted, false, `${keeper.name}'s global entry is not a deletion`);
    assert.deepEqual([report.local.version, report.local.size, report.local.blocksHash], [movedRecord.version, movedRecord.size, movedRecord.blocksHash]);
    assert.equal((await readFile(keeper, "Archive", "old.bin")).length, 300_000);
    const state = await completion(keeper, folder);
    assert.deepEqual([state.completion, state.needDeletes], [100, 0], `${keeper.name} needs no deletion`);
  }
});

test("a file changed after confirmation is not handed off", async () => {
  await seed("changing.bin", threeBlocks("first content "));
  const contract = await layoutRound(true);
  assert.ok(contract.entries.some((entry) => entry.path === "changing.bin"), "confirmed first");
  await inPeer(peers.stick, 'printf "a late change" >> "$1" && touch -d "@$2" "$1"', `${root}/Archive/changing.bin`, String(Math.floor(Date.now() / 1000) - 20 * 60));

  const result = await runExecutor();

  const outcome = result.results.find((entry) => entry.path === "changing.bin");
  assert.equal(outcome?.outcome, "refused");
  assert.match(outcome?.reason ?? "", /not the confirmed/);
  assert.equal(await fileExists(peers.stick, "Archive", "changing.bin"), true);
  assert.ok(!(await listed()).includes("/changing.bin"), "no ignore line was written for it");
  assert.equal((await readFile(peers.keeper, "Archive", "changing.bin")).length, 300_000, "the keeper keeps the confirmed copy");
});

test("a contract for an apply = false node does nothing", async () => {
  await seed("kept.bin", "stays on the stick");
  const reported = await layoutRound(false);
  assert.deepEqual([reported.apply, reported.entries], [false, []], "the dashboard gives a reporting node an empty list");

  const contract = await layoutRound(true);
  assert.ok(contract.entries.some((entry) => entry.path === "kept.bin"));
  await writeNodeFile(false);
  const linesBefore = await listed();

  const result = await runExecutor();

  assert.equal(result.refused, "the node file does not say apply = true");
  assert.deepEqual(result.results, []);
  assert.equal(await fileExists(peers.stick, "Archive", "kept.bin"), true);
  assert.deepEqual(await listed(), linesBefore);
  await writeNodeFile(true);
});

test("the trash empties after its age, and only its own files", async () => {
  await inPeer(peers.stick, 'printf "not the executor\'s" > "$1/foreign.txt" && printf "nor this" > "$1/$2"', `${root}/.storage/handoff-trash`, `${movedTrash.split("/")[0]}/foreign.bin`);
  const later = (days: number) => Math.floor(Date.now() / 1000) + days * 86400;
  const emptyContract = (at: number) => writeFileSync(join(scratch, "e001.json"), JSON.stringify({ schema: 1, nodeId: "e001", writtenAt: new Date(at * 1000).toISOString(), apply: true, cluster: false, quietMinutes: 10, entries: [], waiting: [], notes: [] }));

  emptyContract(later(6));
  const early = await runExecutor({ HANDOFF_NOW: String(later(6)) });
  assert.deepEqual([early.refused, early.purged, await inTrash(movedTrash)], [null, 0, true], "kept for 7 days");

  emptyContract(later(8));
  const late = await runExecutor({ HANDOFF_NOW: String(later(8)) });

  assert.deepEqual([late.refused, late.purged, await inTrash(movedTrash)], [null, 1, false], "then emptied");
  assert.equal(await inTrash("foreign.txt"), true, "a file it did not move there stays");
  assert.equal(await inTrash(`${movedTrash.split("/")[0]}/foreign.bin`), true, "even in its own day folder");
  assert.equal((await inPeer(peers.stick, 'cat "$1"', `${root}/.storage/handoff-trash/manifest.jsonl`)).trim(), "", "the manifest no longer lists it");
  assert.equal((await readFile(peers.keeper, "Archive", "old.bin")).length, 300_000, "the keeper's copy is untouched");
});

let pendingTrash = "";

test("a path Syncthing had not reported ignored in time stays pending and is moved on the next run", async () => {
  await seed("pending.bin", threeBlocks("pending "));
  await layoutRound(true);

  const first = await runExecutor({ HANDOFF_IGNORE_WAIT_SECONDS: "0" });

  assert.equal(first.results.find((entry) => entry.path === "pending.bin")?.outcome, "ignored-not-moved");
  assert.ok((await listed()).includes("/pending.bin"));
  await waitUntil(async () => (await fileReport(peers.stick, folder, "pending.bin")).local.ignored === true, "pending.bin ignored on the stick");
  await layoutRound(true);
  const second = await runExecutor();

  const moved = second.results.find((entry) => entry.path === "pending.bin");
  assert.equal(moved?.outcome, "moved", "retried from the pending record while ignored, the keeper still in its availability");
  pendingTrash = moved?.trash ?? "";
  assert.equal(await fileExists(peers.stick, "Archive", "pending.bin"), false);
});

test("a pending file changed before its retry gets its line removed, and its edit reaches the keepers", async () => {
  await seed("edited.bin", "the confirmed content");
  await layoutRound(true);
  await runExecutor({ HANDOFF_IGNORE_WAIT_SECONDS: "0" });
  await waitUntil(async () => (await fileReport(peers.stick, folder, "edited.bin")).local.ignored === true, "edited.bin ignored on the stick");
  await writeFile(peers.stick, "Archive", "edited.bin", "an edit made while it waited");
  await layoutRound(true);

  const result = await runExecutor();

  assert.equal(result.results.find((entry) => entry.path === "edited.bin")?.outcome, "released");
  assert.ok(!(await listed()).includes("/edited.bin"), "its line is gone");
  await waitUntil(async () => (await fileReport(peers.stick, folder, "edited.bin")).local.ignored === false, "edited.bin back in the stick's index");
  for (const keeper of [peers.keeper, peers.other]) {
    await waitUntil(async () => (await readFile(keeper, "Archive", "edited.bin")) === "an edit made while it waited", `the edit on ${keeper.name}`);
  }
});

test("with every keeper offline, nothing leaves the stick and nothing leaves the trash", async () => {
  await seed("waits.bin", "waits for a keeper");
  await run("docker", ["stop", "--timeout", "5", peers.keeper.container, peers.other.container]);

  const contract = await layoutRound(true);

  assert.deepEqual(contract.entries, []);
  assert.ok(contract.waiting.some((waiting) => waiting.path === "waits.bin" && waiting.reason === "keeper-offline"));
  const result = await runExecutor();
  assert.deepEqual(result.results.filter((entry) => entry.outcome !== "unsynced-at-handed-off-path"), []);
  assert.equal(await fileExists(peers.stick, "Archive", "waits.bin"), true);

  const at = Math.floor(Date.now() / 1000) + 8 * 86400;
  writeFileSync(join(scratch, "e001.json"), JSON.stringify({ schema: 1, nodeId: "e001", writtenAt: new Date(at * 1000).toISOString(), apply: true, cluster: false, quietMinutes: 10, entries: [], waiting: [], notes: [] }));
  const purge = await runExecutor({ HANDOFF_NOW: String(at) }) as ExecutorResult & { trash: { trash: string; reason: string }[] };
  assert.equal(purge.purged, 0);
  assert.equal(await inTrash(pendingTrash), true, "a copy no reachable keeper holds stays past its 7 days");
  assert.match(purge.trash.find((entry) => entry.trash === pendingTrash)?.reason ?? "", /no keeper holds its version/);
});
