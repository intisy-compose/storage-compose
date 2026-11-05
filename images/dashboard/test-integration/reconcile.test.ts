import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { LocalInstance } from "../src/instanceResolver.js";
import { type NodePlan, handoffIgnoreFile, handoffIgnoreLines, nodePlan } from "../src/nodePlan.js";
import { type HandoffFiles, carriedLayoutPaths, reconcileNode } from "../src/reconcileNode.js";
import { type SetupLayout, parseLayout } from "../src/setupRepo.js";
import { SyncthingClient } from "../src/syncthing.js";
import {
  type Peer, type Peers,
  ensureEmptyFile, fileExists, fileReport, folderState, readFile, request, scan, startPeers, stopPeers, waitUntil, writeFile,
} from "./peers.js";

const root = "/var/syncthing/folders";

let peers: Peers;

before(async () => {
  peers = await startPeers();
});

after(async () => {
  await stopPeers();
});

type SyncthingObject = Record<string, unknown>;

/** The stick at threshold 50, the keeper and the other peer keeping everything; `folders` is the layout's `[folders]` part. */
function layoutOf(folders: string): SetupLayout {
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

${folders}

[nodes.e001]
name      = "stick"
device    = "stick"
threshold = 50
admitted  = true

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

function stickInstance(): LocalInstance {
  return { kind: "local", nodeId: "e001", name: "stick", client: new SyncthingClient({ url: peers.stick.url, apiKey: peers.stick.apiKey }), root, os: "linux", threshold: 50, source: "registry" };
}

/** Creates the file through `docker exec`, recording the ignore lines Syncthing had at that moment. */
function peerHandoffFiles(peer: Peer, seen: string[][] = []): HandoffFiles {
  return {
    ensure: async (_instance, folder) => {
      seen.push(await ignoresOf(peer, folder.id));
      return ensureEmptyFile(peer, `${folder.path}/${handoffIgnoreFile}`);
    },
  };
}

async function putFolder(peer: Peer, id: string, relativePath: string, type: string, devices: Peer[], versioning: SyncthingObject = { type: "", params: {} }): Promise<void> {
  await request(peer, "PUT", `/rest/config/folders/${encodeURIComponent(id)}`, {
    id,
    label: relativePath,
    path: `${root}/${relativePath}`,
    type,
    devices: [peer, ...devices].map((member) => ({ deviceID: member.deviceId })),
    fsWatcherEnabled: false,
    rescanIntervalS: 3600,
    versioning,
  });
  await waitUntil(async () => (await folderState(peer, id)) === "idle", `${id} idle on ${peer.name}`);
}

async function folderConfig(peer: Peer, id: string): Promise<SyncthingObject> {
  return request<SyncthingObject>(peer, "GET", `/rest/config/folders/${encodeURIComponent(id)}`);
}

async function ignoresOf(peer: Peer, id: string): Promise<string[]> {
  return (await request<{ ignore: string[] | null }>(peer, "GET", `/rest/db/ignores?folder=${encodeURIComponent(id)}`)).ignore ?? [];
}

async function ignoreAnswer(peer: Peer, id: string): Promise<{ ignore: string[] | null; error: string | null }> {
  return request(peer, "GET", `/rest/db/ignores?folder=${encodeURIComponent(id)}`);
}

function planOf(layout: SetupLayout, configured: string[]): NodePlan {
  const plan = nodePlan(layout, "e001", carriedLayoutPaths(layout, "e001", new Set(configured)));
  assert.ok(plan);
  assert.deepEqual(plan.problems, []);
  return plan;
}

function plannedIgnores(plan: NodePlan, id: string): string[] {
  const folder = plan.folders.find((entry) => entry.id === id);
  assert.ok(folder, `${id} planned`);
  return folder.ignores;
}

function differingKeys(before: SyncthingObject, after: SyncthingObject): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort();
}

const staggeredYear = { type: "staggered", params: { maxAge: String(365 * 86400) } };

test("report mode writes nothing", async () => {
  const layout = layoutOf(`[folders.Rep]\npriority = 80\n\n[folders."Rep/Old"]\npriority = 30\n`);
  await putFolder(peers.stick, "rep", "Rep", "sendreceive", [peers.keeper]);
  await putFolder(peers.stick, "rep-old", "Rep/Old", "sendreceive", [peers.keeper]);
  const before = await request<SyncthingObject>(peers.stick, "GET", "/rest/config");
  const ignoresBefore = [await ignoresOf(peers.stick, "rep"), await ignoresOf(peers.stick, "rep-old")];
  const plan = planOf(layout, ["rep", "rep-old"]);

  const result = await reconcileNode(stickInstance(), plan, { apply: false, layout, handoffFiles: peerHandoffFiles(peers.stick), readBackDelaysMs: [] });

  console.log(`report: ${JSON.stringify(result.folders)}`);
  const fields = Object.fromEntries(result.folders.map((folder) => [folder.folderId, folder.changes.map((change) => change.field).sort()]));
  assert.deepEqual(fields, { rep: ["ignores", "sharing", "versioning"], "rep-old": ["ignores", "sharing", "type"] });
  assert.deepEqual(await request<SyncthingObject>(peers.stick, "GET", "/rest/config"), before, "the whole config is as it was");
  assert.deepEqual([await ignoresOf(peers.stick, "rep"), await ignoresOf(peers.stick, "rep-old")], ignoresBefore);
  assert.equal(await fileExists(peers.stick, "Rep", handoffIgnoreFile), false, "no hand-off list is created");
  assert.equal(await fileExists(peers.stick, "Rep/Old", handoffIgnoreFile), false);
});

test("apply changes exactly the differing fields", async () => {
  const layout = layoutOf(`[folders.App]\npriority = 80\n\n[folders."App/Old"]\npriority = 30\n`);
  await putFolder(peers.stick, "app", "App", "sendreceive", [peers.keeper]);
  await putFolder(peers.stick, "app-old", "App/Old", "sendreceive", [peers.keeper, peers.other]);
  const plan = planOf(layout, ["app", "app-old"]);
  await request(peers.stick, "POST", "/rest/db/ignores?folder=app-old", { ignore: plannedIgnores(plan, "app-old") });
  await ensureEmptyFile(peers.stick, `${root}/App/Old/${handoffIgnoreFile}`);
  const configBefore = await request<SyncthingObject>(peers.stick, "GET", "/rest/config");
  const appBefore = await folderConfig(peers.stick, "app");
  const oldBefore = await folderConfig(peers.stick, "app-old");

  const result = await reconcileNode(stickInstance(), plan, { apply: true, layout, handoffFiles: peerHandoffFiles(peers.stick), readBackDelaysMs: [] });

  console.log(`applied: ${JSON.stringify(result.folders)}`);
  const appAfter = await folderConfig(peers.stick, "app");
  const oldAfter = await folderConfig(peers.stick, "app-old");
  assert.deepEqual(differingKeys(appBefore, appAfter), ["devices", "versioning"]);
  assert.deepEqual(((appAfter.devices as SyncthingObject[]).map((entry) => entry.deviceID) as string[]).sort(), [peers.stick, peers.keeper, peers.other].map((peer) => peer.deviceId).sort());
  assert.deepEqual({ type: (appAfter.versioning as SyncthingObject).type, params: (appAfter.versioning as SyncthingObject).params }, staggeredYear);
  assert.deepEqual(differingKeys(appBefore.versioning as SyncthingObject, appAfter.versioning as SyncthingObject), ["params", "type"]);
  assert.deepEqual(differingKeys(oldBefore, oldAfter), ["type"]);
  assert.equal(oldAfter.type, "sendonly");
  assert.deepEqual(await ignoresOf(peers.stick, "app"), plannedIgnores(plan, "app"));
  assert.deepEqual(await ignoresOf(peers.stick, "app-old"), plannedIgnores(plan, "app-old"), "lines already in place are left");
  const configAfter = await request<SyncthingObject>(peers.stick, "GET", "/rest/config");
  const untouched = (config: SyncthingObject) => ({ ...config, folders: (config.folders as SyncthingObject[]).filter((folder) => folder.id !== "app" && folder.id !== "app-old") });
  assert.deepEqual(untouched(configAfter), untouched(configBefore), "nothing else in the config changed");
  assert.deepEqual(result.folders.map((folder) => [folder.folderId, folder.written.sort()]), [["app", ["ignores", "sharing", "versioning"]], ["app-old", ["type"]]]);

  const again = await reconcileNode(stickInstance(), plan, { apply: true, layout, handoffFiles: peerHandoffFiles(peers.stick), readBackDelaysMs: [] });
  assert.deepEqual(again.folders, [], "a second round finds nothing to change");
});

test("a node below its threshold becomes send-only and pulls nothing", async () => {
  const layout = layoutOf(`[folders.Low]\npriority = 30\n`);
  await putFolder(peers.keeper, "low", "Low", "sendreceive", [peers.stick]);
  await putFolder(peers.stick, "low", "Low", "sendreceive", [peers.keeper]);
  const plan = planOf(layout, ["low"]);
  assert.equal(plan.folders[0]?.type, "sendonly");

  await reconcileNode(stickInstance(), plan, { apply: true, layout, handoffFiles: peerHandoffFiles(peers.stick), readBackDelaysMs: [] });

  assert.equal((await folderConfig(peers.stick, "low")).type, "sendonly");
  await writeFile(peers.keeper, "Low", "fresh.txt", "made on the keeper");
  await scan(peers.keeper, "low");
  await waitUntil(async () => (await fileReport(peers.stick, "low", "fresh.txt")).global.size > 0, "the keeper's file in the stick's global index");
  await scan(peers.stick, "low");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(await folderState(peers.stick, "low"), "idle");
  assert.equal(await fileExists(peers.stick, "Low", "fresh.txt"), false, "the stick did not pull the keeper's file");
  await writeFile(peers.stick, "Low", "mine.txt", "made on the stick");
  await scan(peers.stick, "low");
  await waitUntil(async () => fileExists(peers.keeper, "Low", "mine.txt"), "the stick's own file on the keeper");
  assert.equal(await readFile(peers.keeper, "Low", "mine.txt"), "made on the stick", "it still sends");
});

test("the ignore order and the .stignore-handoff file are correct", async () => {
  const layout = layoutOf(`[folders.Ord]\npriority = 80\nignore   = ["/cache"]\n\n[folders."Ord/Sub"]\npriority = 90\n`);
  await putFolder(peers.keeper, "ord", "Ord", "sendreceive", [peers.stick]);
  await putFolder(peers.stick, "ord", "Ord", "sendreceive", [peers.keeper]);
  await request(peers.stick, "POST", "/rest/db/ignores?folder=ord", { ignore: ["/cache", "/node-only"] });
  const plan = planOf(layout, ["ord"]);
  const seen: string[][] = [];

  const result = await reconcileNode(stickInstance(), plan, { apply: true, layout, handoffFiles: peerHandoffFiles(peers.stick, seen), readBackDelaysMs: [] });

  assert.deepEqual(plannedIgnores(plan, "ord"), [...handoffIgnoreLines, "/Sub", "/cache"]);
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].includes(handoffIgnoreLines[0]), "no #include before the file exists");
  assert.ok(seen[0].includes(handoffIgnoreLines[1]), "the list is ignored before it is created");
  const answer = await ignoreAnswer(peers.stick, "ord");
  assert.deepEqual(answer.ignore, [...handoffIgnoreLines, "/Sub", "/cache"]);
  assert.equal(answer.error, null, "Syncthing reads the include");
  assert.equal(await readFile(peers.stick, "Ord", handoffIgnoreFile), "", "the list is empty");
  assert.ok(result.folders.find((folder) => folder.folderId === "ord")?.written.includes("ignores"));
  assert.equal(await folderState(peers.stick, "ord"), "idle");
  await writeFile(peers.stick, "Ord", "marker.txt", "after the ignores");
  await scan(peers.stick, "ord");
  await waitUntil(async () => fileExists(peers.keeper, "Ord", "marker.txt"), "the marker on the keeper");
  assert.equal(await fileExists(peers.keeper, "Ord", handoffIgnoreFile), false, "the list never reaches a keeper");
});
