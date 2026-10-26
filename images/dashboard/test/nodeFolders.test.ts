import assert from "node:assert/strict";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import type { FolderSettings, NewFolderDefaults } from "../src/api/types.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, RemoteInstance, ResolvedInstance } from "../src/instanceResolver.js";
import type { NodeRoot } from "../src/pathGuard.js";
import { type WriteEffects, type WriteNote, requestHandler } from "../src/routes.js";
import { addFolder, browseDirectories, checkFolderPath, folderIdFromLabel, newFolderDefaults, nodeFolderRoutes } from "../src/routes/nodeFolders.js";
import { SyncthingClient } from "../src/syncthing.js";
import { until } from "./until.js";

const apiKey = "node-folders-test-key";
const ownId = "PCAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";

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
  const syncthing = createServer(async (request, response) => {
    openRequests += 1;
    response.on("close", () => (openRequests -= 1));
    if (request.headers["x-api-key"] !== apiKey) return reply(response, { error: "forbidden" }, 403);
    const url = new URL(request.url ?? "/", "http://fake");
    const body = request.method === "POST" ? await bodyOf(request) : null;
    received.push({ method: request.method ?? "", path: `${url.pathname}${url.search}`, body });
    if (request.method === "GET" && url.pathname === "/rest/config/defaults/folder") return reply(response, syncthingDefaults);
    if (request.method === "GET" && url.pathname === "/rest/config/folders") return reply(response, folders);
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
    folders = [{ ...syncthingDefaults, id: "documents", label: "Documents", path: "F:\\Documents" }];
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
    const projects = await newFolderDefaults(pc(), "Projects/Dashboard Test C");
    assert.equal(projects.root, "F:\\");
    assert.equal(projects.settings.path, "F:\\Projects\\Dashboard Test C");
    assert.equal(projects.settings.label, "Dashboard Test C");
    assert.equal(projects.settings.id, "dashboard-test-c");
    assert.equal(projects.settings.rescanIntervalS, 7200);

    const top = await newFolderDefaults(peer(), "");
    assert.equal(top.settings.path, "/var/syncthing/data");
    assert.equal(top.settings.label, "");
    assert.equal(top.settings.id, "abcde-fghij", "no directory name gives Syncthing's random ID");

    const taken = await newFolderDefaults(pc(), "Documents");
    assert.equal(taken.settings.id, "abcde-fghij", "an ID the node has gives Syncthing's random ID");

    for (const under of ["Other folders/stray", "../../Windows"]) {
      const placed: NewFolderDefaults = await newFolderDefaults(pc(), under);
      assert.equal(placed.settings.path, "F:\\", under);
    }
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

  function recordingEffects(): WriteEffects & { notes: WriteNote[]; invalidations: number } {
    const effects = { notes: [] as WriteNote[], invalidations: 0, invalidate: () => void (effects.invalidations += 1), record: (note: WriteNote) => void effects.notes.push(note) };
    return effects;
  }

  async function dashboardWith(effects: WriteEffects, resolve: (nodeId: string) => Promise<ResolvedInstance>): Promise<{ url: string; close: () => void }> {
    const handle = requestHandler(nodeFolderRoutes({ resolve, nodeRoots: async () => roots }), effects);
    const dashboard = createServer((request, response) => void handle(request, response));
    return { url: await listen(dashboard), close: () => dashboard.close() };
  }

  function post(url: string, body: unknown): Promise<Response> {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

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
