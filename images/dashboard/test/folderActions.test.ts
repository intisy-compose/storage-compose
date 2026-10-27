import assert from "node:assert/strict";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import type { FolderRescan, FolderSettings, RemovedFolder } from "../src/api/types.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, RemoteInstance, ResolvedInstance } from "../src/instanceResolver.js";
import { type WriteEffects, type WriteNote, requestHandler } from "../src/routes.js";
import { folderActionRoutes, pauseFolder, removeFolder, rescanAll, rescanFolder, rescanSubProblem } from "../src/routes/folderActions.js";
import { SyncthingClient } from "../src/syncthing.js";
import { copyCondition, nodeFolderState } from "../ui/src/folderCondition.js";
import type { FolderCopy } from "../src/api/types.js";
import { until } from "./until.js";

const apiKey = "folder-actions-test-key";
const fastReadBacks = [5, 10, 20];

interface Received {
  method: string;
  path: string;
  body: unknown;
}

interface FakeFolder {
  id: string;
  label: string;
  path: string;
  type: string;
  paused: boolean;
  rescanIntervalS: number;
  devices: { deviceID: string; encryptionPassword?: string }[];
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

describe("pause, resume, rescan and remove a folder", () => {
  const received: Received[] = [];
  let openRequests = 0;
  let syncthingUrl = "";
  let folders: FakeFolder[] = [];
  let loseWriteAnswer = false;

  const syncthing = createServer(async (request, response) => {
    openRequests += 1;
    response.on("close", () => (openRequests -= 1));
    if (request.headers["x-api-key"] !== apiKey) return reply(response, { error: "forbidden" }, 403);
    const url = new URL(request.url ?? "/", "http://fake");
    const body = request.method === "GET" ? null : await bodyOf(request);
    received.push({ method: request.method ?? "", path: `${url.pathname}${url.search}`, body });
    const folderMatch = url.pathname.match(/^\/rest\/config\/folders\/([^/]+)$/);
    const folder = folderMatch ? folders.find((candidate) => candidate.id === decodeURIComponent(folderMatch[1] as string)) : undefined;
    if (request.method === "GET" && url.pathname === "/rest/config/folders") return reply(response, folders);
    if (folderMatch && !folder) return reply(response, { error: "no such folder" }, 404);
    if (request.method === "GET" && folder) return reply(response, folder);
    if (request.method === "PATCH" && folder) {
      Object.assign(folder, body);
      if (loseWriteAnswer) return request.socket.destroy();
      return reply(response, {});
    }
    if (request.method === "DELETE" && folder) {
      folders = folders.filter((candidate) => candidate !== folder);
      if (loseWriteAnswer) return request.socket.destroy();
      return reply(response, {});
    }
    if (request.method === "POST" && url.pathname === "/rest/db/scan") return reply(response, {});
    reply(response, { error: "not faked" }, 404);
  });

  function peer(): LocalInstance {
    return { kind: "local", nodeId: "d7e5", name: "dashboard-test-peer", client: new SyncthingClient({ url: syncthingUrl, apiKey }), root: "/var/syncthing/data", os: "linux", threshold: 0 };
  }

  const remote: RemoteInstance = { kind: "remote", nodeId: "a1b2", name: "p53-data", host: "p53", dashboardUrl: "http://127.0.0.1:1" };

  function writes(): Received[] {
    return received.filter((entry) => entry.method !== "GET");
  }

  function noteText(note: WriteNote | { nothingWritten: true }): string {
    assert.ok("text" in note, "the action wrote something");
    return note.text;
  }

  before(async () => {
    syncthingUrl = await listen(syncthing);
  });

  beforeEach(async () => {
    await until(() => openRequests === 0, "the fake Syncthing to finish the last test's requests");
    received.length = 0;
    loseWriteAnswer = false;
    folders = [
      { id: "dashboard-test-c", label: "Test C", path: "/var/syncthing/data/dashboard-test-c", type: "sendreceive", paused: false, rescanIntervalS: 3600, devices: [{ deviceID: "PEER", encryptionPassword: "secret-share-password" }] },
      { id: "dashboard-test-p", label: "", path: "/var/syncthing/data/dashboard-test-p", type: "sendreceive", paused: true, rescanIntervalS: 3600, devices: [] },
    ];
  });

  after(() => {
    syncthing.close();
  });

  it("pause sends only paused", async () => {
    const paused = await pauseFolder(peer(), "dashboard-test-c", true, fastReadBacks);
    assert.deepEqual(writes(), [{ method: "PATCH", path: "/rest/config/folders/dashboard-test-c", body: { paused: true } }]);
    assert.equal(paused.settings.paused, true);
    assert.equal(noteText(paused.note), "dashboard-test-peer: paused folder Test C");
    assert.doesNotMatch(JSON.stringify(paused.settings), /secret-share-password/);

    const resumed = await pauseFolder(peer(), "dashboard-test-c", false, fastReadBacks);
    assert.deepEqual(writes().at(-1)?.body, { paused: false });
    assert.equal(resumed.settings.paused, false);
    assert.equal(noteText(resumed.note), "dashboard-test-peer: resumed folder Test C");
  });

  it("a folder already paused, or already running, is not written", async () => {
    assert.deepEqual((await pauseFolder(peer(), "dashboard-test-p", true, fastReadBacks)).note, { nothingWritten: true });
    assert.deepEqual((await pauseFolder(peer(), "dashboard-test-c", false, fastReadBacks)).note, { nothingWritten: true });
    assert.deepEqual(writes(), []);
  });

  it("a pause whose answer is lost is read back and counts once it is in place", async () => {
    loseWriteAnswer = true;
    const paused = await pauseFolder(peer(), "dashboard-test-c", true, fastReadBacks);
    assert.equal(paused.settings.paused, true);
    assert.equal(noteText(paused.note), "dashboard-test-peer: paused folder Test C");
  });

  it("rescan of a subfolder passes sub", async () => {
    const done = await rescanFolder(peer(), "dashboard-test-c", { sub: " photos/2024/ " });
    assert.deepEqual(writes(), [{ method: "POST", path: "/rest/db/scan?folder=dashboard-test-c&sub=photos%2F2024", body: null }]);
    assert.deepEqual(done.rescan, { folderId: "dashboard-test-c", sub: "photos/2024" });
    assert.equal(done.note.text, "dashboard-test-peer: rescanned photos/2024 of folder Test C");

    const whole = await rescanFolder(peer(), "dashboard-test-c", {});
    assert.equal(writes().at(-1)?.path, "/rest/db/scan?folder=dashboard-test-c");
    assert.deepEqual(whole.rescan, { folderId: "dashboard-test-c", sub: null });
    assert.equal(whole.note.text, "dashboard-test-peer: rescanned folder Test C");
    await rescanFolder(peer(), "dashboard-test-c", { sub: "  " });
    assert.equal(writes().at(-1)?.path, "/rest/db/scan?folder=dashboard-test-c", "an empty subfolder is the whole folder");
  });

  it("a subfolder outside the folder, and a rescan of a paused folder, are refused before any scan", async () => {
    for (const sub of ["/etc", "\\x", "C:/x", "c:x", "../x", "a/../../x", "a\\..\\x", "..", "a\u0000b", "a\nb"]) {
      await assert.rejects(rescanFolder(peer(), "dashboard-test-c", { sub }), { status: 400 }, JSON.stringify(sub));
    }
    for (const body of [null, [], { sub: 1 }, { folder: "x" }]) {
      await assert.rejects(rescanFolder(peer(), "dashboard-test-c", body), { status: 400 }, JSON.stringify(body));
    }
    assert.equal(rescanSubProblem("a..b/c"), null, "a name holding two dots is no climb");
    await assert.rejects(rescanFolder(peer(), "dashboard-test-p", {}), { status: 409, message: "dashboard-test-p is paused, so Syncthing does not scan it; resume it first" });
    assert.deepEqual(writes(), []);
  });

  it("rescan every folder sends a scan without a folder", async () => {
    const done = await rescanAll(peer());
    assert.deepEqual(writes(), [{ method: "POST", path: "/rest/db/scan", body: null }]);
    assert.deepEqual(done.rescan, { folderId: null, sub: null });
    assert.equal(done.note.text, "dashboard-test-peer: rescanned every folder that is not paused");
    assert.equal(done.note.folderId, null);
  });

  it("remove needs the folder id typed", async () => {
    for (const body of [{}, null, { confirm: "" }, { confirm: "Test C" }, { confirm: "dashboard-test-C" }, { confirm: " dashboard-test-c" }]) {
      await assert.rejects(removeFolder(peer(), "dashboard-test-c", body, fastReadBacks), { status: 400, message: "type dashboard-test-c to confirm" }, JSON.stringify(body));
    }
    assert.deepEqual(writes(), []);
    const removal = await removeFolder(peer(), "dashboard-test-c", { confirm: "dashboard-test-c" }, fastReadBacks);
    assert.deepEqual(writes(), [{ method: "DELETE", path: "/rest/config/folders/dashboard-test-c", body: null }]);
    const text = "dashboard-test-peer: removed folder Test C (dashboard-test-c) from Syncthing; the files stay on disk at /var/syncthing/data/dashboard-test-c";
    assert.deepEqual(removal.removed, { folderId: "dashboard-test-c", label: "Test C", path: "/var/syncthing/data/dashboard-test-c", text });
    assert.equal(removal.note.text, text);
    assert.equal(removal.note.folderId, "dashboard-test-c");
    assert.ok(!folders.some((folder) => folder.id === "dashboard-test-c"));
  });

  it("a removal whose answer is lost counts once the folder is gone", async () => {
    loseWriteAnswer = true;
    const removal = await removeFolder(peer(), "dashboard-test-p", { confirm: "dashboard-test-p" }, fastReadBacks);
    assert.equal(removal.note.text, "dashboard-test-peer: removed folder dashboard-test-p from Syncthing; the files stay on disk at /var/syncthing/data/dashboard-test-p");
  });

  it("a remote node and an unknown folder are refused, none writing", async () => {
    await assert.rejects(pauseFolder(remote, "dashboard-test-c", true), { status: 409, message: "act on p53's dashboard" });
    await assert.rejects(rescanFolder(remote, "dashboard-test-c", {}), { status: 409 });
    await assert.rejects(rescanAll(remote), { status: 409 });
    await assert.rejects(removeFolder(remote, "dashboard-test-c", { confirm: "dashboard-test-c" }), { status: 409 });
    await assert.rejects(pauseFolder(peer(), "nope", true), { status: 404, message: "dashboard-test-peer has no folder nope" });
    await assert.rejects(rescanFolder(peer(), "nope", {}), { status: 404 });
    await assert.rejects(removeFolder(peer(), "nope", { confirm: "nope" }), { status: 404 });
    assert.deepEqual(writes(), []);
  });

  it("each action goes through the router as a node write and enters Activity once", async () => {
    const notes: WriteNote[] = [];
    const effects: WriteEffects = { invalidate: () => {}, record: (note) => void notes.push(note) };
    const resolve = async (nodeId: string): Promise<ResolvedInstance> => (nodeId === "d7e5" ? peer() : Promise.reject(new RequestError(404, `no node ${nodeId}`)));
    const handle = requestHandler(folderActionRoutes({ resolve, readBackDelaysMs: fastReadBacks }), effects);
    const dashboard = createServer((request, response) => void handle(request, response));
    const base = `${await listen(dashboard)}/api/nodes/d7e5`;
    const send = (path: string, method: string, body?: unknown) => fetch(`${base}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      const paused = await send("folders/dashboard-test-c/pause", "POST");
      assert.equal(paused.status, 200);
      assert.equal(((await paused.json()) as FolderSettings).paused, true);
      assert.equal((await send("folders/dashboard-test-c/pause", "POST")).status, 200, "pausing again answers the folder");
      assert.equal((await send("folders/dashboard-test-c/resume", "POST")).status, 200);
      const rescan = await send("folders/dashboard-test-c/rescan", "POST", { sub: "photos" });
      assert.deepEqual((await rescan.json()) as FolderRescan, { folderId: "dashboard-test-c", sub: "photos" });
      assert.equal((await send("folders/dashboard-test-c/rescan", "POST")).status, 200, "a rescan without a body is the whole folder");
      assert.equal((await send("rescan-all", "POST")).status, 200);
      assert.equal((await send("folders/dashboard-test-c", "DELETE", { confirm: "Test C" })).status, 400);
      const removed = await send("folders/dashboard-test-c", "DELETE", { confirm: "dashboard-test-c" });
      assert.equal(removed.status, 200);
      assert.match(((await removed.json()) as RemovedFolder).text, /the files stay on disk at \/var\/syncthing\/data\/dashboard-test-c$/);
      assert.deepEqual(
        notes.map((note) => note.text),
        [
          "dashboard-test-peer: paused folder Test C",
          "dashboard-test-peer: resumed folder Test C",
          "dashboard-test-peer: rescanned photos of folder Test C",
          "dashboard-test-peer: rescanned folder Test C",
          "dashboard-test-peer: rescanned every folder that is not paused",
          "dashboard-test-peer: removed folder Test C (dashboard-test-c) from Syncthing; the files stay on disk at /var/syncthing/data/dashboard-test-c",
        ],
      );
    } finally {
      dashboard.close();
    }
  });
});

describe("a paused folder reads plainly as paused", () => {
  it("on the Nodes page and in the folder detail, never as 0 % of anything", () => {
    assert.deepEqual(nodeFolderState({ state: "paused", completion: 0 }), { text: "paused", tone: "warn" });
    assert.deepEqual(nodeFolderState({ state: "idle", completion: 100 }), { text: "up to date", tone: "ok" });
    assert.deepEqual(nodeFolderState({ state: "syncing", completion: 40 }), { text: "syncing, 40%", tone: "accent" });
    assert.equal(nodeFolderState({ state: "error", completion: 100 }).tone, "bad");
    const copy = { state: "paused", completion: 0, errors: 0 } as FolderCopy;
    assert.equal(copyCondition(copy).label, "paused");
  });
});
