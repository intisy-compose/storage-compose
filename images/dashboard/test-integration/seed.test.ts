import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { nodePlan } from "../src/nodePlan.js";
import { carriedLayoutPaths } from "../src/reconcileNode.js";
import { type SetupLayout, parseLayout } from "../src/setupRepo.js";
import { type Peers, fileExists, pauseDevice, readFile, resumeDevice, scan, shareFolder, startPeers, stopPeers, waitUntil, writeFile } from "./peers.js";

const root = "/var/syncthing/folders";
const ids = { stick: "e001", keeper: "e002", other: "e003" };

let peers: Peers;
let layout: SetupLayout;

function layoutOf(): SetupLayout {
  return parseLayout(`
[devices.stick]
id = "${peers.stick.deviceId}"
root = "${root}"

[devices.keeper]
id = "${peers.keeper.deviceId}"
root = "${root}"

[devices.other]
id = "${peers.other.deviceId}"
root = "${root}"

[folders.Work]
priority = 80

[folders.Archive]
priority = 30

[nodes.e001]
name = "stick"
device = "stick"
threshold = 80
admitted = true

[nodes.e002]
name = "keeper"
device = "keeper"
threshold = 0
admitted = true

[nodes.e003]
name = "other"
device = "other"
threshold = 30
admitted = true
`);
}

function planFolders(nodeId: string): string[] {
  const plan = nodePlan(layout, nodeId, carriedLayoutPaths(layout, nodeId, new Set()));
  return (plan?.folders ?? []).filter((folder) => folder.type === "sendreceive").map((folder) => folder.id).sort();
}

before(async () => {
  peers = await startPeers();
  layout = layoutOf();
});

after(async () => {
  await stopPeers();
});

test("a stick node at 80 keeps the essential folder only, a host node at 30 keeps both, by the plan alone", () => {
  assert.deepEqual(planFolders(ids.stick), ["work"]);
  assert.deepEqual(planFolders(ids.other), ["archive", "work"]);
  assert.deepEqual(planFolders(ids.keeper), ["archive", "work"]);
});

test("the stick seeds the host node while its keeper is unreachable, then the rest arrives once the keeper is back", async () => {
  await pauseDevice(peers.other, peers.keeper);

  await shareFolder("work", [
    { peer: peers.stick, type: "sendreceive" },
    { peer: peers.other, type: "sendreceive" },
    { peer: peers.keeper, type: "sendreceive" },
  ]);
  await shareFolder("archive", [
    { peer: peers.other, type: "sendreceive" },
    { peer: peers.keeper, type: "sendreceive" },
  ]);
  await writeFile(peers.stick, "work", "essential.txt", "from the stick");
  await writeFile(peers.keeper, "archive", "old.mkv", "only the keeper has this");
  await scan(peers.stick, "work");
  await scan(peers.keeper, "archive");

  await waitUntil(() => fileExists(peers.other, "work", "essential.txt"), "the stick seeded the host node", 60_000);
  assert.equal(await readFile(peers.other, "work", "essential.txt"), "from the stick");
  assert.equal(await fileExists(peers.other, "archive", "old.mkv"), false, "nothing of Archive reached it while no keeper was reachable");

  await resumeDevice(peers.other, peers.keeper);

  await waitUntil(() => fileExists(peers.other, "archive", "old.mkv"), "the rest arrived once a keeper was reachable", 60_000);
  assert.equal(await readFile(peers.other, "archive", "old.mkv"), "only the keeper has this");
  assert.equal(await fileExists(peers.stick, "archive", "old.mkv"), false, "a stick at 80 does not carry Archive");
});
