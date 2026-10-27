import assert from "node:assert/strict";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { FolderDetailResponse, FolderSettings, FolderSummary } from "../src/api/types.js";
import { type FolderIndexSources, folderDetail, foldersResponse } from "../src/folderIndex.js";
import { requestHandler } from "../src/routes.js";
import { folderRoutesFrom, peerFolderReads } from "../src/routes/folders.js";
import type { SetupLayout } from "../src/setupRepo.js";
import { SyncthingClient } from "../src/syncthing.js";

const pcId = "PCAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const arrayId = "ARRAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const encryptionSecret = "hunter2-encryption";

interface FakeFolder {
  id: string;
  path: string;
  devices: string[];
}

interface FakeInstance {
  ownId: string;
  apiKey: string;
  folders: FakeFolder[];
  pending: Record<string, { offeredBy: Record<string, { time: string; label: string; receiveEncrypted: boolean; remoteEncrypted: boolean }> }>;
  pendingFails?: boolean;
  foldersRefused?: boolean;
}

function reply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function fullConfig(folder: FakeFolder) {
  return {
    id: folder.id,
    label: folder.id,
    filesystemType: "basic",
    path: folder.path,
    type: "sendreceive",
    devices: folder.devices.map((deviceID) => ({ deviceID, introducedBy: "", encryptionPassword: deviceID === arrayId ? encryptionSecret : "" })),
    rescanIntervalS: 3600,
    fsWatcherEnabled: true,
    fsWatcherDelayS: 10,
    ignorePerms: false,
    minDiskFree: { value: 1, unit: "%" },
    versioning: { type: "staggered", params: { maxAge: "2592000" }, cleanupIntervalS: 3600, fsPath: "", fsType: "basic" },
    order: "random",
    maxConflicts: 10,
    paused: false,
    syncOwnership: false,
    syncXattrs: false,
  };
}

function fakeSyncthing(instance: FakeInstance): Server {
  return createServer((request, response) => {
    if (request.headers["x-api-key"] !== instance.apiKey) return reply(response, { error: "forbidden" }, 403);
    const url = new URL(request.url ?? "/", "http://fake");
    const configMatch = url.pathname.match(/^\/rest\/config\/folders\/(.+)$/);
    if (configMatch) {
      const folder = instance.folders.find((entry) => entry.id === decodeURIComponent(configMatch[1]));
      return folder ? reply(response, fullConfig(folder)) : reply(response, { error: "no such folder" }, 404);
    }
    switch (url.pathname) {
      case "/rest/system/status":
        return reply(response, { myID: instance.ownId });
      case "/rest/config/folders":
        if (instance.foldersRefused) return reply(response, { error: "forbidden" }, 403);
        return reply(response, instance.folders.map((folder) => ({ ...fullConfig(folder), devices: folder.devices.map((deviceID) => ({ deviceID })) })));
      case "/rest/config/devices":
        return reply(response, [
          { deviceID: pcId, name: "pc", addresses: ["dynamic"] },
          { deviceID: arrayId, name: "private-array", addresses: ["dynamic"] },
        ]);
      case "/rest/stats/folder":
        return reply(response, { documents: { lastScan: "2026-10-21T08:00:00Z", lastFile: { at: "2026-10-21T07:00:00Z", filename: "a.txt", deleted: false } } });
      case "/rest/db/status":
        return reply(response, { state: "idle", globalBytes: 2000, globalFiles: 918_000, globalDirectories: 700, needBytes: 0, needFiles: 0, pullErrors: url.searchParams.get("folder") === "documents" ? 1 : 0 });
      case "/rest/cluster/pending/folders":
        return instance.pendingFails ? reply(response, { error: "pending folders broke" }, 500) : reply(response, instance.pending);
      default:
        return reply(response, { error: "not found" }, 404);
    }
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const pc: FakeInstance = {
  ownId: pcId,
  apiKey: "pc-api-key",
  folders: [
    { id: "documents", path: "F:\\Documents", devices: [pcId, arrayId] },
    { id: "music", path: "F:\\Music", devices: [pcId, arrayId] },
  ],
  pending: {},
};

const privateArray: FakeInstance = {
  ownId: arrayId,
  apiKey: "array-api-key",
  folders: [{ id: "music", path: "/mnt/storage/pool-5784/music", devices: [arrayId, pcId] }],
  pending: {
    documents: { offeredBy: { [pcId]: { time: "2026-10-21T05:53:20Z", label: "documents", receiveEncrypted: false, remoteEncrypted: false } } },
    pictures: { offeredBy: { [pcId]: { time: "2026-10-21T05:53:21Z", label: "Pictures", receiveEncrypted: false, remoteEncrypted: false } } },
  },
};

const remoteMusic: FolderSummary = {
  id: "music",
  label: "music",
  priority: null,
  prioritySource: "none",
  copies: [
    {
      id: "music",
      label: "music",
      path: "/srv/music",
      type: "receiveonly",
      state: "idle",
      completion: 100,
      errors: 0,
      needItems: 0,
      needBytes: 0,
      globalBytes: 2000,
      globalFiles: 10,
      globalDirectories: 1,
      lastScan: null,
      lastFile: null,
      localChanged: 0,
      sharedWith: [],
      nodeId: "a1b2",
      nodeName: "p53-data",
      host: "p53",
      local: true,
      paused: false,
    },
  ],
  offers: [],
};

describe("folder index", () => {
  const servers: Server[] = [];
  let sources: FolderIndexSources;
  let layout: SetupLayout | null = null;

  before(async () => {
    const clients: SyncthingClient[] = [];
    for (const instance of [pc, privateArray]) {
      const server = fakeSyncthing(instance);
      servers.push(server);
      clients.push(new SyncthingClient({ url: `http://127.0.0.1:${await listen(server)}`, apiKey: instance.apiKey }));
    }
    sources = {
      localInstances: async () => [
        { nodeId: "fb98", nodeName: "pc", host: "finn", client: clients[0], root: "F:\\", os: "windows" },
        { nodeId: "5784", nodeName: "private-array", host: "finn", client: clients[1], root: "/mnt/storage/pool-5784", os: "linux" },
      ],
      peerFolders: async () => [remoteMusic],
      peerFolderDetails: async () => [],
      layout: async () => layout,
    };
  });

  after(async () => {
    for (const server of servers) await close(server);
  });

  function byId(folders: FolderSummary[], id: string): FolderSummary {
    const found = folders.find((folder) => folder.id === id);
    assert(found, `no folder ${id}`);
    return found;
  }

  it("folders are grouped by id across nodes", async () => {
    const { folders } = await foldersResponse("all", sources);
    const music = byId(folders, "music");
    assert.deepEqual(music.copies.map((copy) => [copy.nodeId, copy.local]).sort(), [["5784", true], ["a1b2", false], ["fb98", true]]);
    const documents = byId(folders, "documents");
    assert.equal(documents.copies.length, 1);
    const copy = documents.copies[0];
    assert.equal(copy.nodeName, "pc");
    assert.equal(copy.path, "F:\\Documents");
    assert.equal(copy.errors, 1);
    assert.equal(copy.globalFiles + copy.globalDirectories, 918_700);
    assert.deepEqual(copy.sharedWith, [{ deviceId: arrayId, name: "private-array" }]);
    assert.equal(copy.lastFile?.filename, "a.txt");
  });

  it("a local scope leaves the peers out", async () => {
    const { folders } = await foldersResponse("local", sources);
    assert.equal(byId(folders, "music").copies.length, 2);
  });

  it("a pending offer shows under its folder and as its own entry when no node has the folder", async () => {
    const { folders } = await foldersResponse("all", sources);
    assert.deepEqual(byId(folders, "documents").offers, [
      { nodeId: "5784", nodeName: "private-array", folderId: "documents", label: "documents", offeredBy: pcId, offeredByName: "pc", time: "2026-10-21T05:53:20Z", receiveEncrypted: false },
    ]);
    const pictures = byId(folders, "pictures");
    assert.equal(pictures.label, "Pictures");
    assert.deepEqual(pictures.copies, []);
    assert.equal(pictures.offers.length, 1);
  });

  it("priority comes from the layout when it has the folder", async () => {
    layout = { devices: [], folders: [{ relativePath: "Documents", id: "documents", priority: 80 }], bands: [] };
    const { folders } = await foldersResponse("all", sources);
    layout = null;
    assert.deepEqual([byId(folders, "documents").priority, byId(folders, "documents").prioritySource], [80, "setup-repo"]);
    assert.deepEqual([byId(folders, "music").priority, byId(folders, "music").prioritySource], [null, "none"]);
  });

  it("settings never contain an api key or password", async () => {
    const detail = await folderDetail("music", "all", sources);
    assert.deepEqual(Object.keys(detail.settings).sort(), ["5784", "fb98"]);
    assert.equal(detail.settings.fb98.versioning.type, "staggered");
    assert.deepEqual(detail.settings.fb98.devices, [
      { deviceId: pcId, encrypted: false },
      { deviceId: arrayId, encrypted: true },
    ]);
    assert.deepEqual(detail.settings.fb98.minDiskFree, { value: 1, unit: "%" });
    const text = JSON.stringify(detail);
    for (const secret of [encryptionSecret, pc.apiKey, privateArray.apiKey]) assert(!text.includes(secret), `the detail holds ${secret}`);
    assert(!/"[A-Za-z]*(apiKey|apikey|password|Password)"/.test(text), "the detail has an api key or password field");
  });

  it("pending folders that cannot be read keep the copies and name the node", async () => {
    privateArray.pendingFails = true;
    const answer = await foldersResponse("local", sources).finally(() => (privateArray.pendingFails = false));
    assert.deepEqual(byId(answer.folders, "music").copies.map((copy) => copy.nodeId).sort(), ["5784", "fb98"]);
    assert.deepEqual(byId(answer.folders, "documents").offers, []);
    assert.equal(answer.offersUnreadable.length, 1);
    assert.equal(answer.offersUnreadable[0].nodeId, "5784");
    assert.match(answer.offersUnreadable[0].error, /HTTP 500/);
  });

  it("a node that refuses its folder list is named and the other nodes' folders still list", async () => {
    privateArray.foldersRefused = true;
    const answer = await foldersResponse("local", sources).finally(() => (privateArray.foldersRefused = false));
    assert.deepEqual(byId(answer.folders, "music").copies.map((copy) => copy.nodeId), ["fb98"]);
    assert.deepEqual(byId(answer.folders, "documents").copies.map((copy) => copy.nodeId), ["fb98"]);
    assert.deepEqual(answer.unreadable.map((entry) => [entry.nodeId, entry.nodeName]), [["5784", "private-array"]]);
    assert.match(answer.unreadable[0].error, /HTTP 403/);
  });

  it("a peer's settings for its own copy are merged into the folder detail", async () => {
    const peerSettings: FolderSettings = { ...(await folderDetail("music", "local", sources)).settings.fb98, path: "/srv/music", type: "receiveonly" };
    const peerDetail: FolderDetailResponse = { summary: remoteMusic, settings: { a1b2: peerSettings }, treePath: "Music" };
    const detail = await folderDetail("music", "all", { ...sources, peerFolderDetails: async () => [peerDetail] });
    assert.deepEqual(Object.keys(detail.settings).sort(), ["5784", "a1b2", "fb98"]);
    assert.equal(detail.settings.a1b2.path, "/srv/music");
    assert.equal(detail.settings.fb98.path, "F:\\Music", "a peer's settings never replace a local node's");
    assert.deepEqual(detail.summary.copies.map((copy) => [copy.nodeId, copy.local]).sort(), [["5784", true], ["a1b2", false], ["fb98", true]]);
  });

  it("a peer answering 2xx with something other than JSON adds nothing", async () => {
    const htmlPeer = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<html>sign in</html>");
    });
    const goodPeer = createServer((request, response) => {
      const detail: FolderDetailResponse = { summary: remoteMusic, settings: {}, treePath: "Music" };
      reply(response, new URL(request.url ?? "/", "http://peer").pathname === "/api/folders" ? { folders: [remoteMusic], unreadable: [], offersUnreadable: [] } : detail);
    });
    try {
      const reads = peerFolderReads([`http://127.0.0.1:${await listen(htmlPeer)}`, `http://127.0.0.1:${await listen(goodPeer)}`]);
      assert.deepEqual((await reads.peerFolders()).map((folder) => folder.id), ["music"]);
      assert.deepEqual((await reads.peerFolderDetails("music")).map((detail) => detail.summary.id), ["music"]);
    } finally {
      await Promise.all([close(htmlPeer), close(goodPeer)]);
    }
  });

  it("/api/folders/%E0 answers 400", async () => {
    const handle = requestHandler(folderRoutesFrom(sources));
    const dashboard = createServer((request, response) => void handle(request, response));
    try {
      const answer = await fetch(`http://127.0.0.1:${await listen(dashboard)}/api/folders/%E0`);
      assert.equal(answer.status, 400);
      assert.deepEqual(await answer.json(), { error: "%E0 is not a valid folder ID" });
    } finally {
      await close(dashboard);
    }
  });

  it("the detail says where the folder's root lies in the explorer's tree", async () => {
    assert.equal((await folderDetail("documents", "all", sources)).treePath, "Documents");
    assert.equal((await folderDetail("music", "all", sources)).treePath, "Music", "the first node with a copy places it");
    assert.equal((await folderDetail("pictures", "all", sources)).treePath, "Other folders/Pictures", "an offer no node keeps sits under Other folders");
    layout = { devices: [], folders: [{ relativePath: "Media/Pictures", id: "pictures", priority: 50 }], bands: [] };
    const placed = await folderDetail("pictures", "all", sources).finally(() => (layout = null));
    assert.equal(placed.treePath, "Media/Pictures", "or where the layout puts it");
    const peerOnly = await folderDetail("music", "all", { ...sources, localInstances: async () => [], peerFolderDetails: async () => [{ summary: remoteMusic, settings: {}, treePath: "Audio/Music" }] });
    assert.equal(peerOnly.treePath, "Audio/Music", "a folder kept only on another host is placed as that host's dashboard placed it");
  });

  it("a folder no node has and nobody offers is 404", async () => {
    await assert.rejects(folderDetail("nowhere", "all", sources), { status: 404, message: "no folder nowhere" });
  });
});
