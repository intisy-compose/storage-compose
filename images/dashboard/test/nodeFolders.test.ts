import assert from "node:assert/strict";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import type { FolderPathCheck, FolderSettings, NewFolderDefaults } from "../src/api/types.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, RemoteInstance, ResolvedInstance } from "../src/instanceResolver.js";
import type { NodeRoot } from "../src/pathGuard.js";
import { type WriteEffects, type WriteNote, requestHandler } from "../src/routes.js";
import { type FolderEdit, addFolder, browseDirectories, checkFolderPath, editFolder, folderEditText, folderIdFromLabel, newFolderDefaults, nodeFolderRoutes } from "../src/routes/nodeFolders.js";
import { folderSettings } from "../src/folderIndex.js";
import { SyncthingClient, type SyncthingFolderSettings } from "../src/syncthing.js";
import { changedFields } from "../src/syncthingConfig.js";
import { draftOf, newFolderBody, treePathOf } from "../ui/src/folderDraft.js";
import { until } from "./until.js";

const apiKey = "node-folders-test-key";
const ownId = "PCAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const laptopId = "LAPTOPA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const arrayId = "ARRAYAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const strangerId = "STRANGE-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const arraySecret = "array-folder-secret";
const configuredDevices = [
  { deviceID: ownId, name: "dashboard-test-peer", untrusted: false },
  { deviceID: laptopId, name: "laptop", untrusted: false },
  { deviceID: arrayId, name: "private-array", untrusted: true },
];

/** Syncthing's own template for a new folder, as `/rest/config/defaults/folder` answers; its values are deliberately not the dashboard's. */
const syncthingDefaults = {
  id: "",
  label: "",
  filesystemType: "basic",
  path: "~",
  type: "sendreceive",
  devices: [{ deviceID: ownId, introducedBy: "", encryptionPassword: "" }],
  rescanIntervalS: 7200,
  fsWatcherEnabled: true,
  fsWatcherDelayS: 10,
  ignorePerms: false,
  autoNormalize: true,
  minDiskFree: { value: 2, unit: "%" },
  versioning: { type: "", params: {}, cleanupIntervalS: 3600, fsPath: "", fsType: "basic" },
  order: "random",
  maxConflicts: 5,
  paused: false,
  markerName: ".stfolder",
  syncOwnership: false,
  syncXattrs: false,
};

interface Received {
  method: string;
  path: string;
  body: unknown;
}

function reply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function noteText(edit: FolderEdit): string {
  assert.ok("text" in edit.note, "the edit wrote something");
  return edit.note.text;
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : null;
}

describe("adding a folder to a node", () => {
  const received: Received[] = [];
  let folders: Record<string, unknown>[] = [];
  let directories: string[] = [];
  let openRequests = 0;
  let syncthingUrl = "";
  /** Applies the next folder PATCH and then drops its connection, as a Syncthing that restarts on the change. */
  let loseWriteAnswer = false;
  /** Once a folder PATCH was applied, drops every later request, as a Syncthing that does not come back. */
  let silentAfterWrite = false;
  /** Drops the folder PATCH without applying it, as a Syncthing that stops before the change. */
  let dropWrite = false;
  let wrote = false;
  /** Drops this many requests once a folder PATCH was applied, as a Syncthing that answers again after a restart. */
  let dropAfterWrite = 0;
  /** How the fake stores a patched path, as Syncthing may write it differently from how it was sent. */
  let storedPath = (path: string) => path;
  const fastReadBacks = [5, 10, 20];
  const syncthing = createServer(async (request, response) => {
    openRequests += 1;
    response.on("close", () => (openRequests -= 1));
    if (silentAfterWrite && wrote) return request.socket.destroy();
    if (wrote && dropAfterWrite > 0) {
      dropAfterWrite -= 1;
      return request.socket.destroy();
    }
    if (request.headers["x-api-key"] !== apiKey) return reply(response, { error: "forbidden" }, 403);
    const url = new URL(request.url ?? "/", "http://fake");
    const body = request.method === "POST" || request.method === "PATCH" ? await bodyOf(request) : null;
    received.push({ method: request.method ?? "", path: `${url.pathname}${url.search}`, body });
    if (request.method === "GET" && url.pathname === "/rest/config/defaults/folder") return reply(response, syncthingDefaults);
    if (request.method === "GET" && url.pathname === "/rest/config/folders") return reply(response, folders);
    if (request.method === "GET" && url.pathname === "/rest/config/devices") return reply(response, configuredDevices);
    if (request.method === "GET" && url.pathname === "/rest/system/status") return reply(response, { myID: ownId });
    if (request.method === "GET" && url.pathname === "/rest/svc/random/string") return reply(response, { random: "AbCdEfGhIj" });
    if (request.method === "GET" && url.pathname === "/rest/system/browse") {
      const current = url.searchParams.get("current") ?? "";
      return reply(response, directories.filter((directory) => directory.toLowerCase().startsWith(current.toLowerCase())));
    }
    const folderPath = url.pathname.match(/^\/rest\/config\/folders\/(.+)$/);
    if (request.method === "GET" && folderPath) {
      const folder = folders.find((entry) => entry.id === decodeURIComponent(folderPath[1] as string));
      return folder ? reply(response, folder) : reply(response, { error: "no such folder" }, 404);
    }
    if (request.method === "POST" && url.pathname === "/rest/config/folders") {
      folders = [...folders, body as Record<string, unknown>];
      return reply(response, null);
    }
    if (request.method === "PATCH" && folderPath) {
      if (dropWrite) return request.socket.destroy();
      const folderId = decodeURIComponent(folderPath[1] as string);
      const patched = body as Record<string, unknown>;
      const stored = typeof patched.path === "string" ? { ...patched, path: storedPath(patched.path) } : patched;
      folders = folders.map((folder) => (folder.id === folderId ? { ...folder, ...stored } : folder));
      wrote = true;
      if (loseWriteAnswer) return request.socket.destroy();
      return reply(response, null);
    }
    reply(response, { error: "not faked" }, 404);
  });

  function pc(): LocalInstance {
    return { kind: "local", nodeId: "fb98", name: "pc", client: new SyncthingClient({ url: syncthingUrl, apiKey }), root: "F:\\", os: "windows", threshold: 50 };
  }

  function peer(): LocalInstance {
    return { kind: "local", nodeId: "d7e5", name: "dashboard-test-peer", client: new SyncthingClient({ url: syncthingUrl, apiKey }), root: "/var/syncthing/data", os: "linux", threshold: 0 };
  }

  const roots: NodeRoot[] = [
    { nodeId: "fb98", name: "pc", root: "F:\\", os: "windows" },
    { nodeId: "a1b2", name: "stick", root: "F:\\.storage\\stick", os: "windows" },
    { nodeId: "d7e5", name: "dashboard-test-peer", root: "/var/syncthing/data", os: "linux" },
  ];

  before(async () => {
    syncthingUrl = await listen(syncthing);
  });

  beforeEach(async () => {
    await until(() => openRequests === 0, "the fake Syncthing to finish the last test's requests");
    received.length = 0;
    loseWriteAnswer = false;
    silentAfterWrite = false;
    dropWrite = false;
    wrote = false;
    dropAfterWrite = 0;
    storedPath = (path) => path;
    folders = [
      { ...syncthingDefaults, id: "documents", label: "Documents", path: "F:\\Documents" },
      { ...syncthingDefaults, id: "dashboard-test-e", label: "Test A", path: "/var/syncthing/data/dashboard-test-e" },
    ];
    directories = ["F:\\Documents\\", "F:\\Music\\", "C:\\Windows\\", "F:\\.storage\\", "F:\\.storage\\stick\\"];
  });

  after(() => {
    syncthing.close();
  });

  it("adding a folder outside the node root is 400", async () => {
    for (const path of ["C:\\Windows", "F:\\..\\Windows", "F:Windows", "\\\\server\\share", "F:\\.storage\\stick\\photos", "F:\\.storage"]) {
      await assert.rejects(addFolder(pc(), { id: "dashboard-test-a", path }, roots), (error: Error & { status?: number }) => error.status === 400, path);
    }
    await assert.rejects(addFolder(peer(), { id: "dashboard-test-a", path: "/var/syncthing/data/../config" }, roots), (error: Error & { status?: number }) => error.status === 400 && /outside dashboard-test-peer's root/.test(error.message));
    assert.deepEqual(received, [], "a refused path reaches no Syncthing");
  });

  it("adding a folder uses syncthing's defaults for fields the form leaves out", async () => {
    const addition = await addFolder(peer(), { id: "dashboard-test-a", path: "/var/syncthing/data/dashboard-test-a" }, roots);

    const posted = received.find((entry) => entry.method === "POST");
    assert.deepEqual(posted, {
      method: "POST",
      path: "/rest/config/folders",
      body: { ...syncthingDefaults, id: "dashboard-test-a", label: "", path: "/var/syncthing/data/dashboard-test-a" },
    });
    assert.equal(addition.added.rescanIntervalS, 7200);
    assert.equal(addition.added.maxConflicts, 5);
    assert.deepEqual(addition.added.devices, [{ deviceId: ownId, encrypted: false }]);
    assert.deepEqual(addition.note, { nodeId: "d7e5", nodeName: "dashboard-test-peer", folderId: "dashboard-test-a", text: "dashboard-test-peer: added folder dashboard-test-a at /var/syncthing/data/dashboard-test-a" });
  });

  it("the form's own fields win over the defaults, and the path is sent as checked", async () => {
    const addition = await addFolder(pc(), { id: " dashboard-test-b ", label: "Test B", path: "f:/.storage/dashboard-test/./x/../dashboard-test-b", type: "sendonly", paused: true }, roots);

    const posted = received.find((entry) => entry.method === "POST")?.body as Record<string, unknown>;
    assert.equal(posted.id, "dashboard-test-b");
    assert.equal(posted.label, "Test B");
    assert.equal(posted.path, "F:\\.storage\\dashboard-test\\dashboard-test-b");
    assert.equal(posted.type, "sendonly");
    assert.equal(posted.paused, true);
    assert.equal(posted.rescanIntervalS, 7200);
    assert.equal(addition.note.text, "pc: added folder Test B (dashboard-test-b) at F:\\.storage\\dashboard-test\\dashboard-test-b; send only; paused");
  });

  it("the node's own device is always among the folder's devices", async () => {
    const original = syncthingDefaults.devices;
    syncthingDefaults.devices = [];
    try {
      await addFolder(peer(), { id: "dashboard-test-a", path: "/var/syncthing/data/a" }, roots);
    } finally {
      syncthingDefaults.devices = original;
    }
    const posted = received.find((entry) => entry.method === "POST")?.body as { devices: { deviceID: string }[] };
    assert.deepEqual(posted.devices.map((device) => device.deviceID), [ownId]);
  });

  it("an ID or a path the node already has is 409 and nothing is added", async () => {
    await assert.rejects(addFolder(pc(), { id: "documents", path: "F:\\New" }, roots), (error: Error & { status?: number }) => error.status === 409 && error.message === "pc already has folder documents");
    await assert.rejects(addFolder(pc(), { id: "dashboard-test-a", path: "f:/documents/" }, roots), (error: Error & { status?: number }) => error.status === 409 && error.message === "pc's folder Documents already uses F:\\Documents");
    assert.equal(received.filter((entry) => entry.method === "POST").length, 0);
  });

  it("a malformed new folder is 400 before anything is read", async () => {
    for (const body of [null, [], {}, { id: "", path: "F:\\x" }, { id: "x" }, { id: "x", path: "F:\\x", type: "mirror" }, { id: "x", path: "F:\\x", paused: "yes" }, { id: "x", path: "F:\\x", rescanIntervalS: 5 }]) {
      await assert.rejects(addFolder(pc(), body, roots), (error: Error & { status?: number }) => error.status === 400, JSON.stringify(body));
    }
    assert.deepEqual(received, []);
  });

  it("a remote node's add is 409 and a node without a root is refused, both before any Syncthing call", async () => {
    const remote: RemoteInstance = { kind: "remote", nodeId: "a1b2", name: "p53-data", host: "p53", dashboardUrl: "http://127.0.0.1:1" };
    await assert.rejects(addFolder(remote, { id: "x", path: "F:\\x" }, roots), (error: Error & { status?: number }) => error.status === 409 && error.message === "act on p53's dashboard");
    await assert.rejects(addFolder({ ...pc(), root: null }, { id: "x", path: "F:\\x" }, roots), (error: Error & { status?: number }) => error.status === 409 && /pc has no root/.test(error.message));
    assert.deepEqual(received, []);
  });

  it("a new folder's defaults are placed at the directory the person is looking at", async () => {
    const projects = await newFolderDefaults(pc(), "Projects/Dashboard Test C", roots);
    assert.equal(projects.root, "F:\\");
    assert.equal(projects.settings.path, "F:\\Projects\\Dashboard Test C");
    assert.equal(projects.settings.label, "Dashboard Test C");
    assert.equal(projects.settings.id, "dashboard-test-c");
    assert.equal(projects.settings.rescanIntervalS, 7200);

    const top = await newFolderDefaults(peer(), "", roots);
    assert.equal(top.settings.path, "/var/syncthing/data");
    assert.equal(top.settings.label, "");
    assert.equal(top.settings.id, "abcde-fghij", "no directory name gives Syncthing's random ID");

    const taken = await newFolderDefaults(pc(), "Documents", roots);
    assert.equal(taken.settings.id, "abcde-fghij", "an ID the node has gives Syncthing's random ID");

    const stray: NewFolderDefaults = await newFolderDefaults(pc(), "Other folders/stray", roots);
    assert.equal(stray.settings.path, "F:\\");
    assert.equal(stray.placementProblem, null, "a group no directory stands for is no refusal");
    assert.equal(projects.placementProblem, null);
  });

  it("a directory the guard refuses says why instead of silently offering the root", async () => {
    const shortName = await newFolderDefaults(pc(), "Photos~2024", roots);
    assert.equal(shortName.settings.path, "F:\\");
    assert.equal(shortName.settings.label, "");
    assert.match(shortName.placementProblem ?? "", /^Photos~2024 cannot be a folder of pc: F:\\Photos~2024 names Photos~2024, which Windows may read as another name/);

    const nested = await newFolderDefaults(pc(), ".storage/stick/photos", roots);
    assert.match(nested.placementProblem ?? "", /inside stick's root/);
    const escaping = await newFolderDefaults(pc(), "../../Windows", roots);
    assert.equal(escaping.settings.path, "F:\\");
    assert.match(escaping.placementProblem ?? "", /outside pc's root/);
  });

  it("open after an add lands on the parent of the folder's actual path", () => {
    assert.equal(treePathOf("F:\\Projects\\Edited Name", "F:\\"), "Projects/Edited Name");
    assert.equal(treePathOf("F:\\", "F:\\"), "");
    assert.equal(treePathOf("/var/syncthing/data/dashboard-test-a", "/var/syncthing/data"), "dashboard-test-a");
    assert.equal(treePathOf("/var/syncthing/database", "/var/syncthing/data"), null);
    assert.equal(treePathOf("/srv/x", "/"), "srv/x");
  });

  it("checking a typed path gives the guard's refusal without a Syncthing call, then the node's overlaps", async () => {
    assert.deepEqual(await checkFolderPath(pc(), "C:\\Windows", roots), { path: "C:\\Windows", problem: "C:\\Windows is outside pc's root F:\\", warning: null });
    assert.deepEqual(received, []);
    assert.deepEqual(await checkFolderPath(pc(), "f:/Projects/./new", roots), { path: "F:\\Projects\\new", problem: null, warning: null });
    assert.deepEqual(await checkFolderPath(pc(), "F:\\Documents", roots), { path: "F:\\Documents", problem: "pc's folder Documents already uses F:\\Documents", warning: null });
    assert.match((await checkFolderPath(pc(), "F:\\Documents\\Letters", roots)).warning ?? "", /^inside folder Documents \(F:\\Documents\)/);
    const above = await checkFolderPath(pc(), "F:\\", roots.filter((root) => root.nodeId !== "a1b2"));
    assert.equal(above.problem, null);
    assert.match(above.warning ?? "", /^holds folder Documents/);
  });

  it("an add from under=Projects/Dashboard Test C sends and stores the label", async () => {
    const offered = await newFolderDefaults(pc(), "Projects/Dashboard Test C", roots);
    const body = newFolderBody(offered.settings, draftOf(offered.settings));
    assert.deepEqual(body, { id: "dashboard-test-c", label: "Dashboard Test C", path: "F:\\Projects\\Dashboard Test C" });

    const addition = await addFolder(pc(), body, roots);
    const posted = received.find((entry) => entry.method === "POST")?.body as Record<string, unknown>;
    assert.equal(posted.label, "Dashboard Test C");
    assert.equal(addition.added.label, "Dashboard Test C");
    assert.equal(addition.note.text, "pc: added folder Dashboard Test C (dashboard-test-c) at F:\\Projects\\Dashboard Test C");
  });

  it("a folder ID is derived from a directory's name", () => {
    assert.equal(folderIdFromLabel("Dashboard Test A"), "dashboard-test-a");
    assert.equal(folderIdFromLabel("  Fotos 2024 (alt) "), "fotos-2024-alt");
    assert.equal(folderIdFromLabel("documents.github"), "documents.github");
    assert.equal(folderIdFromLabel("???"), "");
  });

  it("browsing lists the directories below the typed path inside the node's root only", async () => {
    assert.deepEqual(await browseDirectories(pc(), "F:\\", roots), ["F:\\Documents\\", "F:\\Music\\", "F:\\.storage\\"]);
    assert.deepEqual(await browseDirectories(pc(), "F:\\Mu", roots), ["F:\\Music\\"]);
    assert.equal(received.at(-1)?.path, `/rest/system/browse?current=${encodeURIComponent("F:\\Mu")}`);
    await browseDirectories(pc(), "C:\\Win", roots);
    assert.equal(received.at(-1)?.path, `/rest/system/browse?current=${encodeURIComponent("F:\\")}`, "a path outside the root browses the root instead");
    await browseDirectories(pc(), "", roots);
    assert.equal(received.at(-1)?.path, `/rest/system/browse?current=${encodeURIComponent("F:\\")}`);
    await browseDirectories(peer(), "", roots);
    assert.equal(received.at(-1)?.path, `/rest/system/browse?current=${encodeURIComponent("/var/syncthing/data/")}`, "the root is browsed as a directory, not completed as a name");
  });

  it("editing the rescan interval sends only rescanIntervalS", async () => {
    const edit = await editFolder(peer(), "dashboard-test-e", { rescanIntervalS: 60 }, roots);
    assert.deepEqual(received.filter((entry) => entry.method === "PATCH"), [{ method: "PATCH", path: "/rest/config/folders/dashboard-test-e", body: { rescanIntervalS: 60 } }]);
    assert.equal(edit.settings.rescanIntervalS, 60);
    assert.equal(edit.settings.fsWatcherDelayS, 10, "a setting not sent keeps Syncthing's value");
    assert.deepEqual(edit.note, { nodeId: "d7e5", nodeName: "dashboard-test-peer", folderId: "dashboard-test-e", text: "dashboard-test-peer: changed folder Test A; full rescan interval 60 s" });
  });

  it("a path change outside the root is 400", async () => {
    for (const path of ["/etc", "/var/syncthing/data/../config", "relative/path"]) {
      await assert.rejects(editFolder(peer(), "dashboard-test-e", { path }, roots), (error: Error & { status?: number }) => error.status === 400, path);
    }
    for (const path of ["C:\\Windows", "F:\\.storage\\stick\\photos", "F:\\Photos~2024"]) {
      await assert.rejects(editFolder(pc(), "documents", { path }, roots), (error: Error & { status?: number }) => error.status === 400, path);
    }
    await assert.rejects(editFolder({ ...pc(), root: null }, "documents", { path: "F:\\Docs" }, roots), (error: Error & { status?: number }) => error.status === 409 && /pc has no root/.test(error.message));
    assert.deepEqual(received, [], "a refused path reaches no Syncthing");
  });

  it("a path change inside the root is sent as checked, and one another folder uses is 409", async () => {
    const moved = await editFolder(peer(), "dashboard-test-e", { path: "/var/syncthing/data/./x/../dashboard-test-moved" }, roots);
    assert.deepEqual(received.find((entry) => entry.method === "PATCH")?.body, { path: "/var/syncthing/data/dashboard-test-moved" });
    assert.equal(moved.settings.path, "/var/syncthing/data/dashboard-test-moved");
    assert.equal(noteText(moved), "dashboard-test-peer: changed folder Test A; path /var/syncthing/data/dashboard-test-moved");

    await assert.rejects(editFolder(pc(), "dashboard-test-e", { path: "f:/documents" }, roots), (error: Error & { status?: number }) => error.status === 409 && error.message === "pc's folder Documents already uses F:\\Documents");
    await editFolder(pc(), "documents", { path: "f:/documents/" }, roots);
    assert.deepEqual(received.filter((entry) => entry.method === "PATCH").at(-1)?.body, { path: "F:\\documents" }, "the folder's own path is no conflict");
  });

  it("the folder id cannot be changed", async () => {
    await assert.rejects(editFolder(peer(), "dashboard-test-e", { id: "other" }, roots), { status: 400, message: "the folder ID cannot be changed" });
    await assert.rejects(editFolder(peer(), "dashboard-test-e", { label: "x", id: "dashboard-test-e" }, roots), { status: 400, message: "the folder ID cannot be changed" });
    assert.deepEqual(received, []);
  });

  it("a malformed change is 400 before anything is read, named by the form's labels", async () => {
    const refusals: [unknown, string][] = [
      [{}, "nothing to change"],
      [[], "nothing to change"],
      [{ devices: [] }, "Sharing must say which devices to share with or stop sharing with"],
      [{ devices: {} }, "Sharing names no device"],
      [{ devices: { share: [{ deviceId: "" }] } }, "Sharing must say which devices to share with or stop sharing with"],
      [{ devices: { share: [{ deviceId: laptopId, encryptionPassword: 1 }] } }, "an encryption password must be text"],
      [{ devices: { unshare: laptopId } }, "Sharing must say which devices to share with or stop sharing with"],
      [{ devices: { share: [{ deviceId: laptopId }], unshare: [laptopId] } }, "Sharing cannot both share with and stop sharing with the same device"],
      [{ devices: { share: [{ deviceId: laptopId }], other: [] } }, "Sharing must say which devices to share with or stop sharing with"],
      [{ paused: true }, "paused is not a folder setting this edit changes"],
      [{ type: "receiveencrypted" }, "Type must be send and receive, send only, receive only"],
      [{ rescanIntervalS: -1 }, "Full rescan interval must be a whole number, 0 or more"],
      [{ fsWatcherDelayS: 0 }, "Watch delay must be a whole number of seconds, 1 or more"],
      [{ order: "biggest" }, "Pull order must be random, alphabetic, smallest first, largest first, oldest first, newest first"],
      [{ minDiskFree: { value: 101, unit: "%" } }, "Minimum free disk cannot be more than 100 %"],
      [{ minDiskFree: { value: 1, unit: "PB" } }, "Minimum free disk must be in %, kB, MB, GB, TB"],
      [{ maxConflicts: -2 }, "Conflict copies kept must be a whole number, or -1 for unlimited"],
      [{ syncXattrs: "yes" }, "Sync extended attributes must be on or off"],
      [{ path: " " }, "Path is missing"],
    ];
    for (const [change, message] of refusals) {
      await assert.rejects(editFolder(peer(), "dashboard-test-e", change, roots), { status: 400, message }, JSON.stringify(change));
    }
    assert.deepEqual(received, []);
  });

  it("a remote node's edit is 409 and a folder the node lacks is 404, neither writing anything", async () => {
    const remote: RemoteInstance = { kind: "remote", nodeId: "a1b2", name: "p53-data", host: "p53", dashboardUrl: "http://127.0.0.1:1" };
    await assert.rejects(editFolder(remote, "music", { label: "x" }, roots), { status: 409, message: "act on p53's dashboard" });
    await assert.rejects(editFolder(peer(), "nowhere", { label: "x" }, roots), { status: 404, message: "dashboard-test-peer has no folder nowhere" });
    assert.deepEqual(received.filter((entry) => entry.method === "PATCH"), []);
  });

  it("a lost answer whose change is in place reports the edit saved", async () => {
    loseWriteAnswer = true;
    const edit = await editFolder(peer(), "dashboard-test-e", { label: "Renamed", order: "alphabetic" }, roots, fastReadBacks);
    assert.deepEqual([edit.settings.label, edit.settings.order], ["Renamed", "alphabetic"]);
    assert.equal(noteText(edit), "dashboard-test-peer: changed folder Test A; label Renamed; pull order alphabetic");
  });

  it("a lost answer is read back again while the node does not answer, and a late answer with the change in place is saved", async () => {
    loseWriteAnswer = true;
    dropAfterWrite = 3;
    const edit = await editFolder(peer(), "dashboard-test-e", { label: "Renamed" }, roots, fastReadBacks);
    assert.equal(edit.settings.label, "Renamed");
    assert.equal(dropAfterWrite, 0, "the first three read-backs got no answer");
  });

  it("a read-back finds a moved path in place however Syncthing writes it", async () => {
    loseWriteAnswer = true;
    storedPath = (path) => `${path.toLowerCase()}\\`;
    const edit = await editFolder(pc(), "documents", { path: "F:\\Docs Moved" }, roots, fastReadBacks);
    assert.equal(noteText(edit), "pc: changed folder Documents; path F:\\Docs Moved");
  });

  it("a receive encrypted folder keeps its type, refused before anything is written", async () => {
    folders = [...folders, { ...syncthingDefaults, id: "dashboard-test-enc", label: "", type: "receiveencrypted", path: "/var/syncthing/data/dashboard-test-enc" }];
    await assert.rejects(editFolder(peer(), "dashboard-test-enc", { type: "sendreceive" }, roots), { status: 400, message: "dashboard-test-enc is receive encrypted, a type it keeps: it was given it by accepting an offer" });
    assert.deepEqual(received.filter((entry) => entry.method === "PATCH"), []);
    await editFolder(peer(), "dashboard-test-enc", { rescanIntervalS: 60 }, roots);
    assert.deepEqual(received.filter((entry) => entry.method === "PATCH").map((entry) => entry.body), [{ rescanIntervalS: 60 }], "its other settings still change");
  });

  it("a lost answer whose change is missing is the 503 of a node that does not answer", async () => {
    dropWrite = true;
    await assert.rejects(editFolder(peer(), "dashboard-test-e", { label: "Renamed" }, roots, fastReadBacks), { status: 503, message: "dashboard-test-peer's Syncthing is not answering" });
    assert.equal(folders.find((folder) => folder.id === "dashboard-test-e")?.label, "Test A");
  });

  it("a lost answer Syncthing does not confirm says the edit may have been saved", async () => {
    loseWriteAnswer = true;
    silentAfterWrite = true;
    await assert.rejects(editFolder(peer(), "dashboard-test-e", { label: "Renamed" }, roots, fastReadBacks), (error: Error & { status?: number; maybeSaved?: boolean }) => {
      assert.equal(error.status, 503);
      assert.equal(error.message, "dashboard-test-peer's Syncthing stopped answering during the change, so it may have been saved; check once dashboard-test-peer answers again");
      return true;
    });
  });

  it("the edit form sends only the settings that differ from what it opened with", async () => {
    const opened = folderSettings(folders.find((folder) => folder.id === "dashboard-test-e") as unknown as SyncthingFolderSettings);
    const draft: FolderSettings = { ...structuredClone(opened), rescanIntervalS: 60, minDiskFree: { unit: opened.minDiskFree.unit, value: opened.minDiskFree.value } as FolderSettings["minDiskFree"] };
    assert.deepEqual(changedFields(opened, draft), { rescanIntervalS: 60 }, "an object whose keys come in another order is no change");
  });

  function shareFixture(): void {
    folders = folders.map((folder) =>
      folder.id === "dashboard-test-e"
        ? {
            ...folder,
            devices: [
              { deviceID: ownId, introducedBy: "", encryptionPassword: "" },
              { deviceID: arrayId, introducedBy: "", encryptionPassword: arraySecret },
            ],
          }
        : folder,
    );
  }

  function patchedBodies(): unknown[] {
    return received.filter((entry) => entry.method === "PATCH").map((entry) => entry.body);
  }

  it("sharing adds the device and keeps the others", async () => {
    shareFixture();
    const edit = await editFolder(peer(), "dashboard-test-e", { devices: { share: [{ deviceId: laptopId }] } }, roots);
    assert.deepEqual(patchedBodies(), [
      {
        devices: [
          { deviceID: ownId, introducedBy: "", encryptionPassword: "" },
          { deviceID: arrayId, introducedBy: "", encryptionPassword: arraySecret },
          { deviceID: laptopId },
        ],
      },
    ]);
    assert.deepEqual(edit.settings.devices, [
      { deviceId: ownId, encrypted: false },
      { deviceId: arrayId, encrypted: true },
      { deviceId: laptopId, encrypted: false },
    ]);
    assert.deepEqual(edit.note, { nodeId: "d7e5", nodeName: "dashboard-test-peer", folderId: "dashboard-test-e", text: "dashboard-test-peer: changed folder Test A; shared with laptop" });
  });

  it("an untrusted device without a password is 400", async () => {
    shareFixture();
    folders = folders.map((folder) => (folder.id === "dashboard-test-e" ? { ...folder, devices: [{ deviceID: ownId, introducedBy: "", encryptionPassword: "" }] } : folder));
    for (const share of [{ deviceId: arrayId }, { deviceId: arrayId, encryptionPassword: "" }, { deviceId: arrayId, encryptionPassword: "  " }]) {
      await assert.rejects(editFolder(peer(), "dashboard-test-e", { devices: { share: [share] } }, roots), { status: 400, message: "private-array is untrusted, so it is shared a folder only with an encryption password" }, JSON.stringify(share));
    }
    assert.deepEqual(patchedBodies(), [], "a refused share writes nothing");

    const edit = await editFolder(peer(), "dashboard-test-e", { devices: { share: [{ deviceId: arrayId, encryptionPassword: arraySecret }] } }, roots);
    assert.deepEqual(patchedBodies(), [{ devices: [{ deviceID: ownId, introducedBy: "", encryptionPassword: "" }, { deviceID: arrayId, encryptionPassword: arraySecret }] }]);
    assert.deepEqual(edit.settings.devices.at(-1), { deviceId: arrayId, encrypted: true });
    assert.equal(noteText(edit), "dashboard-test-peer: changed folder Test A; shared with private-array, encrypted");
    assert.doesNotMatch(JSON.stringify(edit), new RegExp(arraySecret), "the password never comes back");
  });

  it("unsharing removes only that device", async () => {
    shareFixture();
    folders = folders.map((folder) => (folder.id === "dashboard-test-e" ? { ...folder, devices: [...(folder.devices as unknown[]), { deviceID: laptopId, introducedBy: "", encryptionPassword: "" }] } : folder));
    const edit = await editFolder(peer(), "dashboard-test-e", { devices: { unshare: [laptopId] } }, roots);
    assert.deepEqual(patchedBodies(), [
      {
        devices: [
          { deviceID: ownId, introducedBy: "", encryptionPassword: "" },
          { deviceID: arrayId, introducedBy: "", encryptionPassword: arraySecret },
        ],
      },
    ]);
    assert.deepEqual(edit.settings.devices.map((device) => device.deviceId), [ownId, arrayId]);
    assert.equal(noteText(edit), "dashboard-test-peer: changed folder Test A; stopped sharing with laptop");
  });

  it("sharing goes with other changed settings in one write, and a share already in place writes nothing", async () => {
    shareFixture();
    const edit = await editFolder(peer(), "dashboard-test-e", { label: "Shared", devices: { share: [{ deviceId: laptopId }], unshare: [arrayId] } }, roots);
    assert.deepEqual(patchedBodies(), [{ label: "Shared", devices: [{ deviceID: ownId, introducedBy: "", encryptionPassword: "" }, { deviceID: laptopId }] }]);
    assert.equal(noteText(edit), "dashboard-test-peer: changed folder Test A; label Shared; shared with laptop; stopped sharing with private-array");

    received.length = 0;
    const again = await editFolder(peer(), "dashboard-test-e", { devices: { share: [{ deviceId: laptopId }], unshare: [arrayId] } }, roots);
    assert.deepEqual(patchedBodies(), [], "a device already shared and one already not shared change nothing");
    assert.deepEqual(again.note, { nothingWritten: true });
    assert.deepEqual(again.settings.devices.map((device) => device.deviceId), [ownId, laptopId]);
  });

  it("a device the node does not have, or the node's own, cannot be shared or unshared", async () => {
    shareFixture();
    await assert.rejects(editFolder(peer(), "dashboard-test-e", { devices: { share: [{ deviceId: strangerId }] } }, roots), { status: 400, message: "dashboard-test-peer has no device STRANGE" });
    await assert.rejects(editFolder(peer(), "dashboard-test-e", { devices: { unshare: [ownId] } }, roots), { status: 400, message: "dashboard-test-peer is the node's own device; it keeps every folder of the node" });
    assert.deepEqual(patchedBodies(), []);
  });

  it("a lost answer to a share is read back by the device list", async () => {
    shareFixture();
    loseWriteAnswer = true;
    const edit = await editFolder(peer(), "dashboard-test-e", { devices: { share: [{ deviceId: laptopId }], unshare: [arrayId] } }, roots, fastReadBacks);
    assert.deepEqual(edit.settings.devices.map((device) => device.deviceId), [ownId, laptopId]);
    assert.equal(noteText(edit), "dashboard-test-peer: changed folder Test A; shared with laptop; stopped sharing with private-array");
  });

  it("the join's share sends only the folder's devices and keeps the others' entries", async () => {
    shareFixture();
    assert.equal(await peer().client.shareFolder("dashboard-test-e", laptopId), true);
    assert.deepEqual(patchedBodies(), [
      {
        devices: [
          { deviceID: ownId, introducedBy: "", encryptionPassword: "" },
          { deviceID: arrayId, introducedBy: "", encryptionPassword: arraySecret },
          { deviceID: laptopId },
        ],
      },
    ]);
    received.length = 0;
    assert.equal(await peer().client.shareFolder("dashboard-test-e", laptopId), true);
    assert.equal(await peer().client.shareFolder("nowhere", laptopId), false);
    assert.deepEqual(patchedBodies(), [], "a share in place and a folder the node lacks write nothing");
  });

  it("an edit's activity entry names every changed setting in words", () => {
    assert.equal(
      folderEditText("pc", "Documents", { label: "", type: "receiveonly", rescanIntervalS: 0, fsWatcherEnabled: false, fsWatcherDelayS: 5, ignorePerms: true, minDiskFree: { value: 5, unit: "GB" }, maxConflicts: -1, syncOwnership: true, syncXattrs: false }),
      "pc: changed folder Documents; label none; type receive only; full rescan interval off; watch for changes off; watch delay 5 s; ignore permissions on; minimum free disk 5 GB; conflict copies kept unlimited; sync ownership on; sync extended attributes off",
    );
  });

  it("checking a path for an edit leaves the edited folder out", async () => {
    assert.equal((await checkFolderPath(pc(), "F:\\Documents", roots, "documents")).problem, null);
    assert.equal((await checkFolderPath(pc(), "F:\\Documents\\Letters", roots, "documents")).warning, null);
    assert.match((await checkFolderPath(pc(), "F:\\Documents", roots, "dashboard-test-e")).problem ?? "", /already uses/);
  });

  function recordingEffects(): WriteEffects & { notes: WriteNote[]; invalidations: number } {
    const effects = { notes: [] as WriteNote[], invalidations: 0, invalidate: () => void (effects.invalidations += 1), record: (note: WriteNote) => void effects.notes.push(note) };
    return effects;
  }

  async function dashboardWith(effects: WriteEffects, resolve: (nodeId: string) => Promise<ResolvedInstance>): Promise<{ url: string; close: () => void }> {
    const handle = requestHandler(nodeFolderRoutes({ resolve, nodeRoots: async () => roots, readBackDelaysMs: fastReadBacks }), effects);
    const dashboard = createServer((request, response) => void handle(request, response));
    return { url: await listen(dashboard), close: () => dashboard.close() };
  }

  function post(url: string, body: unknown): Promise<Response> {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  function patch(url: string, body: unknown): Promise<Response> {
    return fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  it("a folder edit goes through the router, enters Activity once saved and says when it may have been saved", async () => {
    const effects = recordingEffects();
    const resolve = async (nodeId: string): Promise<ResolvedInstance> => (nodeId === "d7e5" ? peer() : Promise.reject(new RequestError(404, `no node ${nodeId}`)));
    const dashboard = await dashboardWith(effects, resolve);
    try {
      const folderUrl = `${dashboard.url}/api/nodes/d7e5/folders/dashboard-test-e`;
      const saved = await patch(folderUrl, { rescanIntervalS: 120 });
      assert.equal(saved.status, 200);
      assert.equal(((await saved.json()) as FolderSettings).rescanIntervalS, 120);
      assert.deepEqual(effects.notes.map((note) => note.text), ["dashboard-test-peer: changed folder Test A; full rescan interval 120 s"]);
      assert.equal(effects.invalidations, 1);

      assert.equal((await patch(folderUrl, { id: "other" })).status, 400);
      assert.equal((await patch(`${dashboard.url}/api/nodes/d7e5/folders/%E0`, { label: "x" })).status, 400);
      const check = (await (await fetch(`${dashboard.url}/api/nodes/d7e5/folder-path-check?path=${encodeURIComponent("/var/syncthing/data/dashboard-test-e")}&folder=dashboard-test-e`)).json()) as FolderPathCheck;
      assert.equal(check.problem, null);

      const shared = await patch(folderUrl, { devices: { share: [{ deviceId: arrayId, encryptionPassword: arraySecret }] } });
      assert.equal(shared.status, 200);
      const sharedText = await shared.text();
      assert.doesNotMatch(sharedText, new RegExp(arraySecret), "the page never gets the password back");
      assert.deepEqual((JSON.parse(sharedText) as FolderSettings).devices.at(-1), { deviceId: arrayId, encrypted: true });
      assert.equal(effects.notes.at(-1)?.text, "dashboard-test-peer: changed folder Test A; shared with private-array, encrypted");
      assert.doesNotMatch(JSON.stringify(effects.notes), new RegExp(arraySecret), "nor does Activity");
      const refused = await patch(folderUrl, { devices: { share: [{ deviceId: laptopId }], unshare: [laptopId] } });
      assert.equal(refused.status, 400);
      const unchanged = await patch(folderUrl, { devices: { share: [{ deviceId: arrayId, encryptionPassword: "other" }] } });
      assert.equal(unchanged.status, 200);
      assert.equal(effects.notes.length, 2, "a share already in place enters nothing");
      assert.equal(effects.invalidations, 2);

      wrote = false;
      loseWriteAnswer = true;
      silentAfterWrite = true;
      const unsure = await patch(folderUrl, { label: "Renamed" });
      assert.equal(unsure.status, 503);
      assert.equal(((await unsure.json()) as { maybeSaved?: boolean }).maybeSaved, true);
      assert.equal(effects.notes.length, 2, "a write that may not have happened enters nothing");
      assert.equal(effects.invalidations, 3, "a write that may have happened drops the shared build");
    } finally {
      dashboard.close();
    }
  });

  it("the add, its defaults and browsing go through the router, and only the add enters Activity", async () => {
    const effects = recordingEffects();
    const resolve = async (nodeId: string): Promise<ResolvedInstance> => (nodeId === "d7e5" ? peer() : Promise.reject(new RequestError(404, `no node ${nodeId}`)));
    const dashboard = await dashboardWith(effects, resolve);
    try {
      const nodePath = `${dashboard.url}/api/nodes/d7e5`;
      const defaults = (await (await fetch(`${nodePath}/folder-defaults?under=${encodeURIComponent("dashboard-test-a")}`)).json()) as NewFolderDefaults;
      assert.equal(defaults.settings.path, "/var/syncthing/data/dashboard-test-a");
      directories = ["/var/syncthing/data/x/", "/var/syncthing/config/"];
      assert.deepEqual(await (await fetch(`${nodePath}/browse?current=${encodeURIComponent("/var/syncthing/")}`)).json(), ["/var/syncthing/data/x/"]);
      const check = (await (await fetch(`${nodePath}/folder-path-check?path=${encodeURIComponent("/etc")}`)).json()) as { problem: string };
      assert.equal(check.problem, "/etc is outside dashboard-test-peer's root /var/syncthing/data");
      assert.equal(effects.invalidations, 0, "reads drop nothing");

      const outside = await post(`${nodePath}/folders`, { id: "dashboard-test-a", path: "/var/syncthing/config" });
      assert.equal(outside.status, 400);
      assert.match(((await outside.json()) as { error: string }).error, /outside dashboard-test-peer's root/);

      const added = await post(`${nodePath}/folders`, { id: "dashboard-test-a", path: "/var/syncthing/data/dashboard-test-a" });
      assert.equal(added.status, 201);
      assert.equal(((await added.json()) as FolderSettings).path, "/var/syncthing/data/dashboard-test-a");
      assert.deepEqual(effects.notes.map((note) => note.text), ["dashboard-test-peer: added folder dashboard-test-a at /var/syncthing/data/dashboard-test-a"]);
      assert.equal(effects.invalidations, 1);

      const again = await post(`${nodePath}/folders`, { id: "dashboard-test-a", path: "/var/syncthing/data/other" });
      assert.equal(again.status, 409);
      assert.equal((await post(`${dashboard.url}/api/nodes/zzzz/folders`, { id: "x", path: "/x" })).status, 404);
      assert.equal(effects.notes.length, 1, "a refused add enters nothing");
    } finally {
      dashboard.close();
    }
  });
});
