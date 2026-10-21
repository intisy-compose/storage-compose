import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { StorageNode, TreeEntry } from "../src/api/types.js";
import { RequestError } from "../src/http.js";
import { parseLayout } from "../src/setupRepo.js";
import { SyncthingClient } from "../src/syncthing.js";
import { type TreeNode, type TreeSources, liveTreeNode, treeListing } from "../src/routes/tree.js";

const fixtures = new URL("../../test/fixtures/syncthing-tree/", import.meta.url);
const ownId = "OWNAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const otherId = "OTHAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";

async function fixture<Value>(name: string): Promise<Value> {
  return JSON.parse(await readFile(new URL(name, fixtures), "utf8")) as Value;
}

interface BrowseItem {
  name: string;
  modTime: string;
  size: number;
  type: string;
}

interface FakeFolder {
  id: string;
  label: string;
  path: string;
  paused?: boolean;
  shared?: boolean;
  status?: Record<string, unknown>;
  /** By prefix inside the folder, "" for its root. */
  browse: Record<string, BrowseItem[]>;
  local?: Record<string, { deleted?: boolean; ignored?: boolean } | null>;
  errors?: string[];
  need?: string[];
}

interface FakeInstance {
  folders: FakeFolder[];
  pending: Record<string, { offeredBy: Record<string, { time: string; label: string; receiveEncrypted: boolean }> }>;
  fileDelayMs: number;
}

function reply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

function directory(name: string): BrowseItem {
  return { name, modTime: "2026-10-16T06:55:40+02:00", size: 0, type: "FILE_INFO_TYPE_DIRECTORY" };
}

function file(name: string, size = 10): BrowseItem {
  return { name, modTime: "2026-10-16T06:55:40+02:00", size, type: "FILE_INFO_TYPE_FILE" };
}

function names(entries: TreeEntry[]): string[] {
  return entries.map((entry) => entry.name);
}

function stateOf(entry: TreeEntry | undefined) {
  assert.ok(entry, "entry exists");
  assert.equal(entry.nodes.length, 1);
  return { status: entry.nodes[0].status, detail: entry.nodes[0].detail };
}

describe("tree listing of one node", () => {
  let server: Server;
  let url: string;
  let instance: FakeInstance;
  let statusFixture: Record<string, unknown>;
  let fileFixture: { global: Record<string, unknown>; local: Record<string, unknown> };
  let fileRequests: string[];
  let browseRequests: string[];
  let inFlight = 0;
  let mostInFlight = 0;
  let nodeCount = 0;
  let node: TreeNode;
  const layout = parseLayout(
    ["[folders.Documents]", 'category = "synced"', '[folders."Documents/GitHub"]', 'category = "synced"', '[folders."Documents/Backup"]', 'category = "archive"', "[folders.Pictures]", 'category = "synced"', "[folders.Videos]", 'category = "archive"'].join("\n"),
  );

  function sources(overrides: Partial<TreeSources> = {}): TreeSources {
    return { node: async () => node, layout: async () => layout, needLimit: 20_000, ...overrides };
  }

  function folderOf(requestUrl: URL): FakeFolder | undefined {
    return instance.folders.find((folder) => folder.id === requestUrl.searchParams.get("folder"));
  }

  async function serveFile(requestUrl: URL, response: ServerResponse): Promise<void> {
    const folder = folderOf(requestUrl);
    const path = requestUrl.searchParams.get("file") ?? "";
    fileRequests.push(`${folder?.id}:${path}`);
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, instance.fileDelayMs));
    inFlight -= 1;
    const local = folder?.local?.[path];
    if (local === undefined) return reply(response, { ...fileFixture, availability: [{ id: otherId, fromTemporary: false }] });
    if (local === null) return reply(response, { availability: [{ id: otherId }], global: fileFixture.global });
    return reply(response, { availability: null, global: fileFixture.global, local: { ...fileFixture.local, deleted: local.deleted ?? false, ignored: local.ignored ?? false } });
  }

  before(async () => {
    statusFixture = await fixture("status-documents.json");
    fileFixture = await fixture("file-directory.json");
    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://fake");
      const folder = folderOf(requestUrl);
      switch (requestUrl.pathname) {
        case "/rest/system/status":
          return reply(response, { myID: ownId });
        case "/rest/config/folders":
          return reply(
            response,
            instance.folders.map((entry) => ({
              id: entry.id,
              label: entry.label,
              path: entry.path,
              type: "sendreceive",
              paused: entry.paused ?? false,
              devices: [{ deviceID: ownId }, ...(entry.shared === false ? [] : [{ deviceID: otherId }])],
            })),
          );
        case "/rest/config/devices":
          return reply(response, [
            { deviceID: ownId, name: "pc", addresses: ["dynamic"] },
            { deviceID: otherId, name: "laptop", addresses: ["dynamic"] },
          ]);
        case "/rest/cluster/pending/folders":
          return reply(response, instance.pending);
        case "/rest/db/status":
          if (!folder) return reply(response, "no such folder", 404);
          return reply(response, { ...statusFixture, errors: folder.errors?.length ?? 0, pullErrors: folder.errors?.length ?? 0, needFiles: folder.need?.length ?? 0, needTotalItems: folder.need?.length ?? 0, ...folder.status });
        case "/rest/db/browse":
          browseRequests.push(`${folder?.id}:${requestUrl.searchParams.get("prefix") ?? ""}:${requestUrl.searchParams.get("levels")}`);
          return reply(response, folder?.browse[requestUrl.searchParams.get("prefix") ?? ""] ?? []);
        case "/rest/db/file":
          return void serveFile(requestUrl, response);
        case "/rest/folder/errors":
          return reply(response, { errors: (folder?.errors ?? []).map((path) => ({ path, error: "denied" })), page: 1, perpage: 100 });
        case "/rest/db/need":
          return reply(response, { progress: [], queued: [], rest: (folder?.need ?? []).map((name) => ({ name })) });
        case "/rest/db/localchanged":
          return reply(response, { files: [] });
        default:
          return reply(response, "not found", 404);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(async () => {
    const documents = await fixture<BrowseItem[]>("browse-documents.json");
    instance = {
      folders: [
        { id: "documents", label: "Documents", path: "F:\\Documents", browse: { "": documents }, errors: ["Taxes\\2025\\locked.xlsx"] },
        { id: "documents-github", label: "GitHub", path: "F:\\Documents\\GitHub", browse: { "": [directory("compose"), file("README.md")] } },
      ],
      pending: {},
      fileDelayMs: 0,
    };
    fileRequests = [];
    browseRequests = [];
    inFlight = 0;
    mostInFlight = 0;
    nodeCount += 1;
    node = { nodeId: `fb${nodeCount}`, name: "pc", host: "finn", root: "F:\\", os: "windows", threshold: 50, client: new SyncthingClient({ url, apiKey: "key" }) };
  });

  it("the top directory lists folder roots with priorities and 0 at the top", async () => {
    const listing = await treeListing(node.nodeId, "", 1, sources());
    assert.equal(listing.path, "");
    assert.equal(listing.view, node.nodeId);
    assert.equal(listing.priority.effective, 0);
    assert.equal(listing.priority.source, "default");
    assert.deepEqual(names(listing.entries), ["Documents", "Pictures", "Videos"]);
    const [documents, pictures, videos] = listing.entries;
    assert.deepEqual(documents.folder, { id: "documents", label: "Documents" });
    assert.equal(documents.kind, "directory");
    assert.equal(documents.priority.effective, 80);
    assert.equal(documents.priority.overridesParent, true);
    assert.deepEqual(stateOf(documents), { status: "failed", detail: "1 item failed below" });
    assert.equal(pictures.folder, null);
    assert.deepEqual(stateOf(pictures), { status: "missing", detail: "not shared with this node" });
    assert.equal(videos.priority.effective, 30);
    assert.ok(listing.overridesBelow.some((entry) => entry.path === "Documents" && entry.priority === 80 && entry.parent === 0));
    assert.deepEqual(fileRequests, []);
  });

  it("an offered folder the node has not accepted is not here yet", async () => {
    instance.pending = { pictures: { offeredBy: { [otherId]: { time: "2026-10-21T10:00:00Z", label: "Pictures", receiveEncrypted: false } } } };
    const listing = await treeListing(node.nodeId, "", 1, sources());
    const pictures = listing.entries.find((entry) => entry.name === "Pictures");
    assert.deepEqual(pictures?.folder, { id: "pictures", label: "Pictures" });
    assert.deepEqual(stateOf(pictures), { status: "missing", detail: "offered, not accepted" });
  });

  it("a nested folder's root carries its folder and lists from the inner folder", async () => {
    const listing = await treeListing(node.nodeId, "Documents", 1, sources());
    const github = listing.entries.find((entry) => entry.name === "GitHub");
    assert.deepEqual(github?.folder, { id: "documents-github", label: "GitHub" });
    assert.equal(github?.path, "Documents/GitHub");
    assert.deepEqual(stateOf(github), { status: "in-sync", detail: null });
    assert.deepEqual(stateOf(listing.entries.find((entry) => entry.name === "Taxes")), { status: "failed", detail: "1 item failed below" });
    assert.deepEqual(stateOf(listing.entries.find((entry) => entry.name === "Recipes")), { status: "in-sync", detail: null });
    assert.ok(!fileRequests.some((request) => request.endsWith(":GitHub")));

    const inner = await treeListing(node.nodeId, "Documents/GitHub", 1, sources());
    assert.ok(browseRequests.includes("documents-github::0"));
    assert.ok(!browseRequests.some((request) => request.startsWith("documents:GitHub")));
    assert.deepEqual(names(inner.entries), ["compose", "README.md"]);
    assert.equal(inner.entries[0].path, "Documents/GitHub/compose");
    assert.equal(inner.priority.setHere, 80);
  });

  it("an entry the node lacks, ignores or holds below its threshold shows so", async () => {
    instance.folders[0].local = { Recipes: null, Taxes: { ignored: true } };
    instance.folders[0].errors = [];
    const listing = await treeListing(node.nodeId, "Documents", 1, sources({ layout: async () => parseLayout('[folders.Documents]\ncategory = "synced"\n[folders."Documents/Garden Plans"]\npriority = 20') }));
    assert.equal(stateOf(listing.entries.find((entry) => entry.name === "Recipes")).status, "missing");
    assert.equal(stateOf(listing.entries.find((entry) => entry.name === "Taxes")).status, "ignored");
    assert.deepEqual(stateOf(listing.entries.find((entry) => entry.name === "Garden Plans")), { status: "below-threshold", detail: "below threshold 50" });
    assert.deepEqual(listing.entries.find((entry) => entry.name === "Recipes")?.availability, [{ deviceId: otherId, name: "laptop" }]);
  });

  it("a listing pages at 200 with directories first", async () => {
    const files = Array.from({ length: 150 }, (_, index) => file(`file-${String(index).padStart(3, "0")}`));
    const directories = Array.from({ length: 100 }, (_, index) => directory(`dir-${String(index).padStart(3, "0")}`));
    instance.folders[0].browse[""] = [...files.slice(0, 75), ...directories.reverse(), ...files.slice(75)];
    const first = await treeListing(node.nodeId, "Documents", 1, sources());
    assert.equal(first.entries.length, 200);
    assert.equal(first.nextPage, 2);
    assert.ok(first.entries.slice(0, 101).every((entry) => entry.kind === "directory"));
    assert.equal(first.entries[0].name, "dir-000");
    assert.equal(first.entries[100].name, "GitHub");
    assert.equal(first.entries[101].name, "file-000");
    const second = await treeListing(node.nodeId, "Documents", 2, sources());
    assert.equal(second.entries.length, 51);
    assert.equal(second.nextPage, null);
    assert.equal(second.entries[50].name, "file-149");
  });

  it("db/file runs for shown entries only and at most 8 at once", async () => {
    instance.folders[0].browse[""] = Array.from({ length: 250 }, (_, index) => file(`file-${String(index).padStart(3, "0")}`));
    instance.fileDelayMs = 15;
    const listing = await treeListing(node.nodeId, "Documents", 1, sources());
    const shownFiles = listing.entries.filter((entry) => entry.folder === null);
    assert.equal(fileRequests.length, shownFiles.length);
    assert.deepEqual(new Set(fileRequests), new Set(shownFiles.map((entry) => `documents:${entry.name}`)));
    assert.ok(mostInFlight <= 8, `${mostInFlight} at once`);
    assert.ok(mostInFlight > 1, "runs in parallel");
  });

  it("a paused folder is paused and is not read", async () => {
    instance.folders[0].paused = true;
    instance.folders[0].status = { state: "paused" };
    const listing = await treeListing(node.nodeId, "", 1, sources());
    assert.equal(stateOf(listing.entries.find((entry) => entry.name === "Documents")).status, "paused");
  });

  it("a node whose Syncthing does not answer lists the layout as unknown", async () => {
    node = { ...node, client: null };
    const listing = await treeListing(node.nodeId, "", 1, sources());
    assert.deepEqual(names(listing.entries), ["Documents", "Pictures", "Videos"]);
    assert.ok(listing.entries.every((entry) => entry.nodes[0].status === "unknown"));
    assert.ok(listing.notes.some((note) => note.includes("not answering")));
  });

  it("refuses a path that climbs out of the tree", async () => {
    await assert.rejects(treeListing(node.nodeId, "Documents/../..", 1, sources()), (error: unknown) => error instanceof RequestError && error.status === 400);
  });

  it("a remote node is 409 until Task 1b.4", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tree-"));
    try {
      const remote: StorageNode = {
        id: "a1b2",
        name: "p53-data",
        kind: "drive",
        threshold: 0,
        assigned: [],
        local: false,
        online: true,
        host: "p53",
        space: null,
        sync: { state: "idle", completion: 100, lastSeen: null },
        syncthing: null,
        instance: null,
        peers: [],
        folders: [],
        dashboardUrl: "https://p53.example",
      };
      const resolver = { registryDirectory: directory, heartbeatPath: join(directory, "none.json"), otherHostNodes: async () => [remote] };
      await assert.rejects(
        treeListing("a1b2", "", 1, sources({ node: (nodeId) => liveTreeNode(nodeId, resolver) })),
        (error: unknown) => error instanceof RequestError && error.status === 409 && error.message === "act on p53's dashboard",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
