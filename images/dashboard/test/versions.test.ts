import assert from "node:assert/strict";
import { type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { restoreConsequences } from "../src/api/versioningText.js";
import type { FileVersion, RestoredVersions, Versioning, VersionsPage } from "../src/api/types.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, ResolvedInstance } from "../src/instanceResolver.js";
import { type WriteEffects, type WriteNote, requestHandler } from "../src/routes.js";
import { versionRoutes } from "../src/routes/versions.js";
import { SyncthingClient } from "../src/syncthing.js";

const apiKey = "versions-test-key";
const ownId = "D7E5AAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA";

function reply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function version(versionTime: string, size = 10): FileVersion {
  return { versionTime, modTime: "2026-10-20T08:00:00+02:00", size };
}

const staggered: Versioning = { type: "staggered", params: { maxAge: "31536000" }, cleanupIntervalS: 3600, fsPath: "" };
const off: Versioning = { type: "", params: {}, cleanupIntervalS: 3600, fsPath: "" };
const external: Versioning = { type: "external", params: { command: "/bin/true" }, cleanupIntervalS: 0, fsPath: "" };

const storedVersions: Record<string, FileVersion[]> = {
  "hello.txt": [version("2026-10-25T10:00:00+02:00", 5), version("2026-10-27T09:00:00+01:00", 7)],
  "notes/a.txt": [version("2026-10-01T10:00:00+02:00")],
  "notes/deep/b.txt": [version("2026-10-26T10:00:00+01:00")],
  "photos/c.jpg": [version("2026-09-01T10:00:00+02:00")],
  "zeta.md": [version("2026-10-26T12:00:00+01:00")],
};

describe("file versions: browse and restore", () => {
  const asked: string[] = [];
  const restoreBodies: unknown[] = [];
  const notes: WriteNote[] = [];
  let loseRestoreAnswer = false;
  let syncthingUrl = "";
  let dashboardUrl = "";
  let peerDashboardUrl = "";
  const peerDashboardPaths: string[] = [];
  const folders = [
    { id: "test-a", label: "Test A", path: "/var/syncthing/data/test-a", type: "sendreceive", paused: false, devices: [{ deviceID: ownId }], versioning: staggered },
    { id: "test-off", label: "Test Off", path: "/var/syncthing/data/test-off", type: "sendreceive", paused: false, devices: [{ deviceID: ownId }], versioning: off },
    { id: "test-ext", label: "", path: "/var/syncthing/data/test-ext", type: "sendreceive", paused: false, devices: [{ deviceID: ownId }], versioning: external },
    { id: "test-paused", label: "", path: "/var/syncthing/data/test-paused", type: "receiveonly", paused: true, devices: [{ deviceID: ownId }], versioning: staggered },
    { id: "test-declared", label: "", path: "/var/syncthing/data/test-declared", type: "sendreceive", paused: false, devices: [{ deviceID: ownId }], versioning: staggered },
    { id: "test-big", label: "", path: "/var/syncthing/data/test-big", type: "sendreceive", paused: false, devices: [{ deviceID: ownId }], versioning: staggered },
  ];

  const syncthing = createServer((request, response) => {
    if (request.headers["x-api-key"] !== apiKey) return reply(response, { error: "forbidden" }, 403);
    const url = new URL(request.url ?? "/", "http://fake");
    asked.push(`${request.method} ${url.pathname}${url.search}`);
    const folderId = url.searchParams.get("folder");
    if (url.pathname === "/rest/config/folders") return reply(response, folders);
    if (url.pathname.startsWith("/rest/config/folders/")) {
      const folder = folders.find((candidate) => candidate.id === decodeURIComponent(url.pathname.split("/").at(-1) ?? ""));
      return folder ? reply(response, folder) : reply(response, { error: "no such folder" }, 404);
    }
    if (url.pathname === "/rest/folder/versions" && request.method === "GET") {
      if (folderId === "test-off") return response.writeHead(500).end("no versioner configured\n");
      if (folderId === "test-declared") {
        response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "10000" });
        response.write("{");
        return;
      }
      if (folderId === "test-big") return reply(response, Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`file-${index}.bin`, [version("2026-10-26T10:00:00+01:00")]])));
      return reply(response, storedVersions);
    }
    if (url.pathname === "/rest/folder/versions" && request.method === "POST") {
      let text = "";
      request.on("data", (chunk) => (text += chunk));
      request.on("end", () => {
        restoreBodies.push(JSON.parse(text));
        if (loseRestoreAnswer) return void request.socket.destroy();
        reply(response, { "gone.txt": "version not found", "leaky.txt": "cannot restore: #include ../../config/config.xml" });
      });
      return;
    }
    reply(response, { error: "not faked" }, 404);
  });

  const peerDashboard = createServer((request, response) => {
    peerDashboardPaths.push(request.url ?? "");
    reply(response, { enabled: true, versioning: staggered, folderType: "sendreceive", prefix: "", directories: [{ path: "x", files: 2, apiKey: "leak" }], files: { "y.txt": [{ ...version("2026-10-26T10:00:00+01:00"), apiKey: "leak" }] }, page: 1, perPage: 50, total: 2, readAt: "2026-10-27T10:00:00Z" });
  });

  function peer(source: LocalInstance["source"] = "registry", os: LocalInstance["os"] = "linux"): LocalInstance {
    const isArray = source === "array";
    return { kind: "local", nodeId: isArray ? "5784" : "d7e5", name: isArray ? "private-array" : "dashboard-test-peer", client: new SyncthingClient({ url: syncthingUrl, apiKey }), root: "/var/syncthing/data", os, threshold: 0, source };
  }

  async function resolve(nodeId: string): Promise<ResolvedInstance> {
    if (nodeId === "d7e5") return peer();
    if (nodeId === "5784") return peer("array");
    if (nodeId === "w001") return { ...peer(), nodeId, name: "windows-node", os: "windows" };
    if (nodeId === "a1b2") return { kind: "remote", nodeId, name: "p53-data", host: "p53", dashboardUrl: peerDashboardUrl };
    throw new RequestError(404, `no node ${nodeId}`);
  }

  const effects: WriteEffects = { invalidate: () => {}, record: (note) => void notes.push(note) };
  const handle = requestHandler(versionRoutes({ resolve, maxListBytes: 4_000 }), effects);
  const dashboard = createServer((request, response) => void handle(request, response));

  async function get(path: string): Promise<{ status: number; body: VersionsPage & { error?: string } }> {
    const response = await fetch(`${dashboardUrl}${path}`);
    return { status: response.status, body: (await response.json()) as VersionsPage & { error?: string } };
  }

  async function restore(path: string, body: unknown): Promise<{ status: number; body: RestoredVersions & { error?: string } }> {
    const response = await fetch(`${dashboardUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as RestoredVersions & { error?: string } };
  }

  const versionReads = () => asked.filter((entry) => entry.startsWith("GET /rest/folder/versions"));
  const writes = () => asked.filter((entry) => entry.startsWith("POST"));

  before(async () => {
    await Promise.all([
      new Promise<void>((resolve) => syncthing.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => dashboard.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => peerDashboard.listen(0, "127.0.0.1", resolve)),
    ]);
    syncthingUrl = `http://127.0.0.1:${(syncthing.address() as AddressInfo).port}`;
    dashboardUrl = `http://127.0.0.1:${(dashboard.address() as AddressInfo).port}`;
    peerDashboardUrl = `http://127.0.0.1:${(peerDashboard.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    asked.length = 0;
    restoreBodies.length = 0;
    notes.length = 0;
  });

  after(() => {
    syncthing.close();
    dashboard.close();
    peerDashboard.close();
  });

  it("versioning off is enabled false, not 500", async () => {
    const answer = await get("/api/nodes/d7e5/folders/test-off/versions");
    assert.equal(answer.status, 200);
    assert.equal(answer.body.enabled, false);
    assert.deepEqual(answer.body.files, {});
    assert.deepEqual(answer.body.directories, []);
    assert.equal(answer.body.versioning.type, "");
    assert.deepEqual(versionReads(), [], "a folder without versioning is never listed, so its Syncthing walks nothing");
  });

  it("lists one level of the tree, directories first, newest version first", async () => {
    const answer = await get("/api/nodes/d7e5/folders/test-a/versions?reread=true");
    assert.equal(answer.status, 200);
    assert.equal(answer.body.enabled, true);
    assert.equal(answer.body.folderType, "sendreceive");
    assert.deepEqual(answer.body.directories, [{ path: "notes", files: 2 }, { path: "photos", files: 1 }]);
    assert.deepEqual(Object.keys(answer.body.files), ["hello.txt", "zeta.md"]);
    assert.deepEqual(answer.body.files["hello.txt"].map((entry) => entry.versionTime), ["2026-10-27T09:00:00+01:00", "2026-10-25T10:00:00+02:00"]);
    assert.equal(answer.body.total, 4);
    const notesLevel = await get("/api/nodes/d7e5/folders/test-a/versions?prefix=notes");
    assert.deepEqual(notesLevel.body.directories, [{ path: "notes/deep", files: 1 }]);
    assert.deepEqual(Object.keys(notesLevel.body.files), ["notes/a.txt"]);
    assert.equal(versionReads().length, 1, "browsing the tree reads Syncthing's list once");
  });

  it("the date filter keeps only versions within it, and directories count only what is left", async () => {
    const from = encodeURIComponent("2026-10-26T00:00:00+01:00");
    const answer = await get(`/api/nodes/d7e5/folders/test-a/versions?from=${from}`);
    assert.deepEqual(answer.body.directories, [{ path: "notes", files: 1 }]);
    assert.deepEqual(Object.keys(answer.body.files), ["hello.txt", "zeta.md"]);
    assert.deepEqual(answer.body.files["hello.txt"].map((entry) => entry.versionTime), ["2026-10-27T09:00:00+01:00"]);
    const to = encodeURIComponent("2026-10-26T11:00:00+01:00");
    const window = await get(`/api/nodes/d7e5/folders/test-a/versions?from=${from}&to=${to}`);
    assert.deepEqual(Object.keys(window.body.files), []);
    assert.equal((await get("/api/nodes/d7e5/folders/test-a/versions?from=yesterday")).status, 400);
  });

  it("pages a level, at most 100 entries a page", async () => {
    const first = await get("/api/nodes/d7e5/folders/test-a/versions?page=1&perPage=3");
    assert.deepEqual(first.body.directories.map((entry) => entry.path), ["notes", "photos"]);
    assert.deepEqual(Object.keys(first.body.files), ["hello.txt"]);
    const second = await get("/api/nodes/d7e5/folders/test-a/versions?page=2&perPage=3");
    assert.deepEqual(second.body.directories, []);
    assert.deepEqual(Object.keys(second.body.files), ["zeta.md"]);
    assert.equal((await get("/api/nodes/d7e5/folders/test-a/versions?perPage=500")).body.perPage, 100);
  });

  it("a versions list larger than the limit is refused naming the setting, and kept from no other request", async () => {
    const answer = await get("/api/nodes/d7e5/folders/test-big/versions");
    assert.equal(answer.status, 409);
    assert.match(answer.body.error ?? "", /^test-big on dashboard-test-peer keeps more versions than the dashboard reads at once: Syncthing's list passed 0\.004 MB \(VERSIONS_LIST_MAX_MB\)/);
    const small = await get("/api/nodes/d7e5/folders/test-a/versions?reread=true");
    assert.equal(small.status, 200);
  });

  it("a versions answer that declares a length over the limit is refused without reading it", async () => {
    const started = Date.now();
    const answer = await get("/api/nodes/d7e5/folders/test-declared/versions");
    assert.equal(answer.status, 409);
    assert.match(answer.body.error ?? "", /keeps more versions than the dashboard reads at once/);
    assert.ok(Date.now() - started < 5_000, "refused from the declared length, not after waiting on the body");
  });

  it("external versioning is refused, and another host's node is read from its dashboard", async () => {
    const answer = await get("/api/nodes/d7e5/folders/test-ext/versions");
    assert.equal(answer.status, 409);
    assert.match(answer.body.error ?? "", /external command/);
    assert.deepEqual(versionReads(), []);
    const forwarded = await get("/api/nodes/a1b2/folders/test-a/versions?prefix=x&page=1&perPage=50");
    assert.equal(forwarded.status, 200);
    assert.match(peerDashboardPaths.at(-1) ?? "", /^\/api\/nodes\/a1b2\/folders\/test-a\/versions\?prefix=x&page=1&perPage=50&scope=local$/);
    assert.deepEqual(forwarded.body.directories, [{ path: "x", files: 2 }]);
    assert.deepEqual(forwarded.body.files["y.txt"], [version("2026-10-26T10:00:00+01:00")]);
    assert.equal(JSON.stringify(forwarded.body).includes("leak"), false);
  });

  it("restore passes path to version time and returns per file errors", async () => {
    const files = { "hello.txt": "2026-10-25T10:00:00+02:00", "gone.txt": "2026-10-01T10:00:00+02:00" };
    const answer = await restore("/api/nodes/d7e5/folders/test-a/versions/restore", { files });
    assert.equal(answer.status, 200);
    assert.deepEqual(writes(), ["POST /rest/folder/versions?folder=test-a"]);
    assert.deepEqual(restoreBodies, [files]);
    assert.deepEqual(answer.body.restored, ["hello.txt"]);
    assert.deepEqual(answer.body.errors, { "gone.txt": "version not found", "leaky.txt": "error hidden: it mentions an include" }, "a per file error is shown through the redaction");
    assert.match(answer.body.text, /^dashboard-test-peer: restored 1 file of folder Test A from its versions: hello\.txt \(version of 2026-10-25T10:00:00\+02:00\); 2 not restored/);
    assert.deepEqual(notes.map((note) => [note.folderId, note.text]), [["test-a", answer.body.text]]);
  });

  it("a restore whose answer is lost may have been saved, and the versions are read again", async () => {
    await get("/api/nodes/d7e5/folders/test-a/versions");
    const before = versionReads().length;
    loseRestoreAnswer = true;
    try {
      const response = await fetch(`${dashboardUrl}/api/nodes/d7e5/folders/test-a/versions/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: { "hello.txt": "2026-10-25T10:00:00+02:00" } }) });
      const body = (await response.json()) as { error?: string; maybeSaved?: boolean };
      assert.equal(response.status, 503);
      assert.equal(body.maybeSaved, true);
      assert.match(body.error ?? "", /may have been saved/);
    } finally {
      loseRestoreAnswer = false;
    }
    assert.deepEqual(restoreBodies, [{ "hello.txt": "2026-10-25T10:00:00+02:00" }]);
    assert.deepEqual(notes, []);
    await get("/api/nodes/d7e5/folders/test-a/versions");
    assert.equal(versionReads().length, before + 1, "the list read before the restore is dropped");
  });

  it("a file named like an object property is restored, not taken for a failure", async () => {
    const answer = await restore("/api/nodes/d7e5/folders/test-a/versions/restore", { files: { toString: "2026-10-25T10:00:00+02:00", constructor: "2026-10-25T10:00:00+02:00" } });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.restored, ["toString", "constructor"]);
  });

  it("a restore of nothing but failures enters nothing in Activity", async () => {
    const answer = await restore("/api/nodes/d7e5/folders/test-a/versions/restore", { files: { "gone.txt": "2026-10-01T10:00:00+02:00" } });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.restored, []);
    assert.deepEqual(notes, []);
  });

  it("restore paths outside the folder, and bodies that are no restore, are refused before any request", async () => {
    for (const path of ["/etc/passwd", "\\x", "C:/x", "../x", "a/../../x", "a\\..\\x", "", "a\u0000b"]) {
      const answer = await restore("/api/nodes/d7e5/folders/test-a/versions/restore", { files: { [path]: "2026-10-25T10:00:00+02:00" } });
      assert.equal(answer.status, 400, JSON.stringify(path));
    }
    for (const body of [{}, { files: {} }, { files: [] }, { files: { "a.txt": 5 } }, { files: { "a.txt": "last week" } }, { files: { "a.txt": "2026-10-25" } }, { files: { "a.txt": "Oct 25 2026 10:00" } }, { files: { "a.txt": "2026-10-25T10:00:00" } }, { files: { "a.txt": "2026-10-25T10:00:00Z" }, folder: "other" }, { files: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`f${index}`, "2026-10-25T10:00:00+02:00"])) }]) {
      assert.equal((await restore("/api/nodes/d7e5/folders/test-a/versions/restore", body)).status, 400, JSON.stringify(body).slice(0, 80));
    }
    const windows = await restore("/api/nodes/w001/folders/test-a/versions/restore", { files: { "photos/PROGRA~1/x.txt": "2026-10-25T10:00:00+02:00" } });
    assert.equal(windows.status, 400);
    assert.match(windows.body.error ?? "", /Windows may read as another name/);
    assert.deepEqual(asked, []);
  });

  it("on an array the folder id is typed first; versioning off, external, a paused folder and another host's node are refused", async () => {
    const files = { "hello.txt": "2026-10-25T10:00:00+02:00" };
    const array = await restore("/api/nodes/5784/folders/test-a/versions/restore", { files, confirm: "Test A" });
    assert.equal(array.status, 400);
    assert.equal(array.body.error, "type the folder ID test-a to restore versions on private-array, an array");
    assert.deepEqual(asked, []);
    assert.equal((await restore("/api/nodes/a1b2/folders/test-a/versions/restore", { files })).body.error, "act on p53's dashboard");
    const offFolder = await restore("/api/nodes/d7e5/folders/test-off/versions/restore", { files });
    assert.equal(offFolder.status, 409);
    assert.equal(offFolder.body.error, "versioning is off for Test Off on dashboard-test-peer, so it keeps no versions to restore");
    assert.equal((await restore("/api/nodes/d7e5/folders/test-ext/versions/restore", { files })).status, 409);
    const paused = await restore("/api/nodes/d7e5/folders/test-paused/versions/restore", { files });
    assert.equal(paused.status, 409);
    assert.equal(paused.body.error, "test-paused is paused on dashboard-test-peer; resume it first");
    assert.equal((await restore("/api/nodes/d7e5/folders/nosuch/versions/restore", { files })).status, 404);
    assert.deepEqual(writes(), []);
    const typed = await restore("/api/nodes/5784/folders/test-a/versions/restore", { files, confirm: "test-a" });
    assert.equal(typed.status, 200);
    assert.deepEqual(writes(), ["POST /rest/folder/versions?folder=test-a"]);
  });

  it("a restore reads the versions again afterwards", async () => {
    await get("/api/nodes/d7e5/folders/test-a/versions");
    const before = versionReads().length;
    await restore("/api/nodes/d7e5/folders/test-a/versions/restore", { files: { "hello.txt": "2026-10-25T10:00:00+02:00" } });
    await get("/api/nodes/d7e5/folders/test-a/versions");
    assert.equal(versionReads().length, before + 1);
  });
});

describe("the words of a restore", () => {
  it("says the current file is kept as a version, as this folder's versioning keeps it, and where the change goes", () => {
    const lines = restoreConsequences("pc", "Test A", staggered, "sendreceive");
    assert.match(lines[0], /^Versioning is on for Test A on pc \(staggered, versions kept up to 365 days, cleanup every 3600 s, in \.stversions inside the folder\), so Syncthing first moves each current file into the versions/);
    assert.match(lines[1], /every device Test A is shared with/);
    const trash = restoreConsequences("pc", "Test A", { type: "trashcan", params: { cleanoutDays: "0" }, cleanupIntervalS: 3600, fsPath: "" }, "receiveonly");
    assert.match(trash[0], /keeps only the last version of a file/);
    assert.match(trash[1], /receive only.*which a revert would undo/);
  });
});
