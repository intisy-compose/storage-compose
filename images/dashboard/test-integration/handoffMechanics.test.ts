import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  type FileReport, type FolderMember, type Peer, type Peers,
  appendLine, completion, fileExists, fileReport, folderState, pauseDevice, readFile, removeFile,
  resumeDevice, scan, setIgnores, shareFolder, startPeers, stopPeers, waitUntil, writeFile,
} from "./peers.js";

const handoffIgnores = ".stignore-handoff";

/** @implNote `.stignore` pulls the hand-off list in, and ignores the list itself, which would otherwise sync to every keeper as an ordinary file. */
const stignoreLines = [`#include ${handoffIgnores}`, `/${handoffIgnores}`];

let peers: Peers;

before(async () => {
  peers = await startPeers();
});

after(async () => {
  await stopPeers();
});

function report(label: string, value: unknown): void {
  console.log(`${label}: ${JSON.stringify(value)}`);
}

async function arrived(peer: Peer, folder: string, file: string): Promise<void> {
  await waitUntil(async () => (await fileExists(peer, folder, file)) && (await completion(peer, folder)).needItems === 0
    && (await folderState(peer, folder)) === "idle", `${file} in ${folder} on ${peer.name}`);
}

/** Sends a marker from the stick and waits until every receiver has it and is idle, so every earlier index update has been applied. */
async function settle(folder: string, receivers: Peer[], marker: string): Promise<void> {
  await writeFile(peers.stick, folder, marker, marker);
  await scan(peers.stick, folder);
  for (const receiver of receivers) await arrived(receiver, folder, marker);
}

/** A folder send-only on the stick and send-receive on the keeper and the other peer, with the hand-off ignore list in place. */
async function handoffFolder(folder: string): Promise<void> {
  await shareFolder(folder, [
    { peer: peers.stick, type: "sendonly" },
    { peer: peers.keeper, type: "sendreceive" },
    { peer: peers.other, type: "sendreceive" },
  ]);
  await writeFile(peers.stick, folder, handoffIgnores, "");
  await setIgnores(peers.stick, folder, stignoreLines);
}

async function handOver(folder: string, file: string, content: string): Promise<void> {
  await writeFile(peers.stick, folder, file, content);
  await scan(peers.stick, folder);
  await arrived(peers.keeper, folder, file);
  await arrived(peers.other, folder, file);
}

async function ignoreOnStick(folder: string, file: string): Promise<FileReport> {
  await appendLine(peers.stick, folder, handoffIgnores, `/${file}`);
  await scan(peers.stick, folder);
  return fileReport(peers.stick, folder, file);
}

test("a send-only folder uploads a file made offline", async () => {
  const folder = "offline-made";
  await shareFolder(folder, [{ peer: peers.stick, type: "sendonly" }, { peer: peers.keeper, type: "sendreceive" }]);
  await pauseDevice(peers.stick, peers.keeper);
  await writeFile(peers.stick, folder, "notes.txt", "written offline");
  await scan(peers.stick, folder);
  assert.equal(await fileExists(peers.keeper, folder, "notes.txt"), false);
  await resumeDevice(peers.stick, peers.keeper);
  await arrived(peers.keeper, folder, "notes.txt");
  assert.equal(await readFile(peers.keeper, folder, "notes.txt"), "written offline");
});

test("a path in .stignore-handoff is ignored in the local index after a rescan", async () => {
  const folder = "ignore";
  await handoffFolder(folder);
  await handOver(folder, "doc.txt", "kept elsewhere");
  report("stick local entry before the ignore", (await fileReport(peers.stick, folder, "doc.txt")).local);
  const ignored = await ignoreOnStick(folder, "doc.txt");
  report("stick db/file after the ignore", ignored);
  assert.equal(ignored.local.ignored, true);
  assert.equal(await fileExists(peers.stick, folder, "doc.txt"), true);
  assert.equal(await fileExists(peers.keeper, folder, handoffIgnores), false, "the ignore list never syncs");
});

test("removing the ignored file leaves every peer's copy and records no deletion", async () => {
  const folder = "remove";
  await handoffFolder(folder);
  await handOver(folder, "doc.txt", "kept elsewhere");
  const keptBefore = (await fileReport(peers.keeper, folder, "doc.txt")).global;
  await ignoreOnStick(folder, "doc.txt");
  await removeFile(peers.stick, folder, "doc.txt");
  await scan(peers.stick, folder);
  await settle(folder, [peers.keeper, peers.other], "after-remove.txt");
  for (const keeper of [peers.keeper, peers.other]) {
    assert.equal(await readFile(keeper, folder, "doc.txt"), "kept elsewhere", `${keeper.name} keeps its copy`);
    const kept = await fileReport(keeper, folder, "doc.txt");
    assert.equal(kept.global.deleted, false, `${keeper.name} sees no deletion`);
    assert.deepEqual(kept.global.version, keptBefore.version, `${keeper.name} sees the same version`);
  }
  const onStick = await fileReport(peers.stick, folder, "doc.txt");
  report("stick db/file after the removal", onStick);
  assert.equal(onStick.local.deleted, false, "the stick records no deletion");
});

test("the keeper's db/file shows the handing node's version, size and block hash", async () => {
  const folder = "confirm";
  await handoffFolder(folder);
  await handOver(folder, "photo.bin", "x".repeat(300_000));
  const handing = await fileReport(peers.stick, folder, "photo.bin");
  const kept = await fileReport(peers.keeper, folder, "photo.bin");
  const keeperCompletion = await completion(peers.keeper, folder);
  report("stick db/file", handing);
  report("keeper db/file", kept);
  report("keeper completion of its own folder", keeperCompletion);
  report("stick's view of the keeper's completion", await completion(peers.stick, folder, peers.keeper));
  assert.ok(kept.local.blocksHash, "the keeper reports a block hash");
  assert.deepEqual(kept.local.version, handing.local.version);
  assert.equal(kept.local.size, handing.local.size);
  assert.equal(kept.local.size, 300_000);
  assert.equal(kept.local.blocksHash, handing.local.blocksHash);
  assert.equal(keeperCompletion.completion, 100);
});

test("a receive-only keeper keeps a send-only node's deletion only with ignoreDelete", async () => {
  const outcomes: Record<string, boolean> = {};
  for (const ignoreDelete of [false, true]) {
    const folder = ignoreDelete ? "receive-only-ignore-delete" : "receive-only";
    const members: FolderMember[] = [{ peer: peers.stick, type: "sendonly" }, { peer: peers.keeper, type: "receiveonly", ignoreDelete }];
    await shareFolder(folder, members);
    await writeFile(peers.stick, folder, "clip.bin", "frames");
    await scan(peers.stick, folder);
    await arrived(peers.keeper, folder, "clip.bin");
    await removeFile(peers.stick, folder, "clip.bin");
    await scan(peers.stick, folder);
    await settle(folder, [peers.keeper], "after-delete.txt");
    outcomes[folder] = await fileExists(peers.keeper, folder, "clip.bin");
  }
  report("kept on the receive-only keeper", outcomes);
  assert.deepEqual(outcomes, { "receive-only": false, "receive-only-ignore-delete": true });
});

test("dropping the ignore entry after the file is gone does not pull it into a send-only folder", async () => {
  const folder = "prune";
  await handoffFolder(folder);
  await handOver(folder, "doc.txt", "kept elsewhere");
  await ignoreOnStick(folder, "doc.txt");
  await removeFile(peers.stick, folder, "doc.txt");
  await scan(peers.stick, folder);
  await writeFile(peers.stick, folder, handoffIgnores, "");
  await scan(peers.stick, folder);
  await settle(folder, [peers.keeper, peers.other], "after-prune.txt");
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  await scan(peers.stick, folder);
  const onStick = await fileReport(peers.stick, folder, "doc.txt");
  const stickCompletion = await completion(peers.stick, folder);
  report("stick db/file after the prune", onStick);
  report("stick completion after the prune", stickCompletion);
  assert.equal(await fileExists(peers.stick, folder, "doc.txt"), false);
  for (const keeper of [peers.keeper, peers.other]) {
    const kept = await fileReport(keeper, folder, "doc.txt");
    report(`${keeper.name} db/file after the prune`, kept);
    assert.equal(kept.global.deleted, false, `${keeper.name} sees no deletion`);
    assert.equal(await readFile(keeper, folder, "doc.txt"), "kept elsewhere", `${keeper.name} keeps its copy`);
  }
  assert.deepEqual(onStick.local.version, [], "the stick's deletion carries no version, so it never wins");
  assert.equal(stickCompletion.needItems, 1, "the pruned path stays out of sync on the stick");
});
