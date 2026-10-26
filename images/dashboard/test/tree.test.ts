import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { StorageNode, TreeEntry, TreeListing } from "../src/api/types.js";
import { RequestError } from "../src/http.js";
import { parseLayout } from "../src/setupRepo.js";
import { SyncthingClient } from "../src/syncthing.js";
import { readDashboard } from "../src/instanceResolver.js";
import { treeResponse } from "../src/routes/tree.js";
import { type AllNodesSources, type OtherHost, allNodesListing } from "../src/treeAllNodes.js";
import { type TreeNode, type TreeSources, treeListing } from "../src/treeListing.js";
import { until } from "./until.js";

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
  errorsDelayMs: number;
  browseDelayMs: number;
  failingFile: string | null;
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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let delayedAnswers = 0;

async function delayed(milliseconds: number, answer: () => void): Promise<void> {
  delayedAnswers += 1;
  try {
    if (milliseconds) await wait(milliseconds);
    answer();
  } finally {
    delayedAnswers -= 1;
  }
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
    return { node: async () => node, layout: async () => layout, needLimit: 20_000, firstListsWaitMs: 10_000, ...overrides };
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
    if (path === instance.failingFile) return reply(response, "database is locked", 500);
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
          return void delayed(instance.browseDelayMs, () => reply(response, folder?.browse[requestUrl.searchParams.get("prefix") ?? ""] ?? []));
        case "/rest/db/file":
          return void serveFile(requestUrl, response);
        case "/rest/folder/errors":
          return void delayed(instance.errorsDelayMs, () => reply(response, { errors: (folder?.errors ?? []).map((path) => ({ path, error: "denied" })), page: 1, perpage: 100 }));
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
      errorsDelayMs: 0,
      browseDelayMs: 0,
      failingFile: null,
    };
    fileRequests = [];
    browseRequests = [];
    inFlight = 0;
    mostInFlight = 0;
    nodeCount += 1;
    node = { nodeId: `fb${nodeCount}`, name: "pc", host: "finn", root: "F:\\", os: "windows", threshold: 50, present: true, client: new SyncthingClient({ url, apiKey: "key" }) };
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

  it("a node that is not connected says so instead of not answering", async () => {
    node = { ...node, present: false, client: null };
    const listing = await treeListing(node.nodeId, "", 1, sources());
    assert.deepEqual(listing.notes, ["pc is not connected"]);
    assert.deepEqual(names(listing.entries), ["Documents", "Pictures", "Videos"]);
    assert.ok(listing.entries.every((entry) => entry.nodes[0].status === "unknown" && entry.nodes[0].detail === "not connected"));
  });

  it("refuses a path that climbs out of the tree", async () => {
    await assert.rejects(treeListing(node.nodeId, "Documents/../..", 1, sources()), (error: unknown) => error instanceof RequestError && error.status === 400);
  });

  it("a listing during a slow refresh answers from the previous lists", async () => {
    await treeListing(node.nodeId, "Documents", 1, sources());
    instance.folders[0].errors = ["Recipes\\cake\\session.lock"];
    instance.folders[0].status = { sequence: 999_001 };
    instance.errorsDelayMs = 3000;
    const started = Date.now();
    const during = await treeListing(node.nodeId, "Documents", 1, sources());
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
    assert.equal(stateOf(during.entries.find((entry) => entry.name === "Taxes")).status, "failed");
    assert.equal(stateOf(during.entries.find((entry) => entry.name === "Recipes")).status, "in-sync");
    await until(async () => {
      const listing = await treeListing(node.nodeId, "Documents", 1, sources());
      return stateOf(listing.entries.find((entry) => entry.name === "Recipes")).status === "failed";
    }, "the refreshed lists");
    const after = await treeListing(node.nodeId, "Documents", 1, sources());
    assert.equal(stateOf(after.entries.find((entry) => entry.name === "Taxes")).status, "in-sync");
    assert.equal(stateOf(after.entries.find((entry) => entry.name === "Recipes")).status, "failed");
  });

  it("a first read of the lists that takes too long shows the folder's counts with a note", async () => {
    instance.errorsDelayMs = 400;
    const listing = await treeListing(node.nodeId, "Documents", 1, sources({ firstListsWaitMs: 50 }));
    assert.deepEqual(stateOf(listing.entries.find((entry) => entry.name === "Recipes")), { status: "failed", detail: "too many failed items to place" });
    assert.ok(listing.notes.some((note) => note.includes("still being read")), listing.notes.join("; "));
    await wait(500);
  });

  it("a global change with the same local sequence re-reads the directory", async () => {
    await treeListing(node.nodeId, "Documents", 1, sources());
    const before = browseRequests.filter((request) => request === "documents::0").length;
    instance.folders[0].status = { globalTotalItems: 920_299 };
    await treeListing(node.nodeId, "Documents", 1, sources());
    await until(() => browseRequests.filter((request) => request === "documents::0").length > before, "the re-read of Documents");
    assert.equal(browseRequests.filter((request) => request === "documents::0").length, before + 1);
  });

  it("an entry whose index entry cannot be read is unknown and the page still answers", async () => {
    instance.failingFile = "Recipes";
    const listing = await treeListing(node.nodeId, "Documents", 1, sources());
    const recipes = stateOf(listing.entries.find((entry) => entry.name === "Recipes"));
    assert.equal(recipes.status, "unknown");
    assert.match(recipes.detail ?? "", /could not be read/);
    assert.equal(stateOf(listing.entries.find((entry) => entry.name === "Garden Plans")).status, "in-sync");
  });
});

interface PeerFolder {
  id: string;
  label: string;
  path: string;
  browse: Record<string, BrowseItem[]>;
  errors?: string[];
}

interface PeerInstance {
  deviceId: string;
  name: string;
  folders: PeerFolder[];
  pending: string[];
  delayMs: number;
  browseDelayMs: number;
}

const laptopId = "LAPAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";

function deviceIdOf(name: string): string {
  return `${name.slice(0, 3).toUpperCase().padEnd(7, "A")}-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH`;
}

function stateOn(entry: TreeEntry | undefined, nodeId: string) {
  assert.ok(entry, "entry exists");
  const state = entry.nodes.find((candidate) => candidate.nodeId === nodeId);
  return state && { status: state.status, detail: state.detail };
}

describe("tree listing of all nodes", () => {
  let server: Server;
  let url: string;
  let instances: Map<string, PeerInstance>;
  let statusFixture: Record<string, unknown>;
  let browseRequests: string[];
  let dashboardRequests: URL[];
  let dashboardAnswer: (requestUrl: URL) => unknown;
  let dashboardDelayMs = 0;
  let round = 0;
  const layout = parseLayout(['[folders.Documents]', 'category = "synced"', '[folders."Documents/GitHub"]', 'category = "synced"'].join("\n"));

  function documentsFolder(path: string): PeerFolder {
    return { id: "documents", label: "Documents", path, browse: { "": [directory("Taxes"), directory("Recipes"), file("notes.txt")] }, errors: ["Taxes\\2025\\locked.xlsx"] };
  }

  function addInstance(name: string, folders: PeerFolder[], pending: string[] = []): string {
    const prefix = `${name}-${round}`;
    instances.set(prefix, { deviceId: deviceIdOf(name), name, folders, pending, delayMs: 0, browseDelayMs: 0 });
    return prefix;
  }

  function treeNode(prefix: string, nodeId: string, root: string, os: TreeNode["os"]): TreeNode {
    return { nodeId: `${nodeId}-${round}`, name: instances.get(prefix)!.name, host: "finn", root, os, threshold: 0, present: true, client: new SyncthingClient({ url: `${url}/${prefix}`, apiKey: "key" }) };
  }

  function allSources(nodes: TreeNode[], overrides: Partial<AllNodesSources> = {}): AllNodesSources {
    return {
      layout: async () => layout,
      needLimit: 20_000,
      firstListsWaitMs: 10_000,
      nodeWaitMs: 10_000,
      listingBudgetMs: 10_000,
      localNodes: async () => nodes,
      otherHosts: [],
      readHost: (host, path) => readDashboard(host.dashboardUrl, host.host, path),
      hostNodes: () => [],
      ...overrides,
    };
  }

  function serveInstance(instance: PeerInstance, rest: string, requestUrl: URL, response: ServerResponse): void {
    const folder = instance.folders.find((candidate) => candidate.id === requestUrl.searchParams.get("folder"));
    const everyDevice = [...instances.values()].map((other) => ({ deviceID: other.deviceId, name: other.name }));
    switch (rest) {
      case "/rest/system/status":
        return reply(response, { myID: instance.deviceId });
      case "/rest/config/folders":
        return reply(
          response,
          instance.folders.map((entry) => ({ id: entry.id, label: entry.label, path: entry.path, type: "sendreceive", paused: false, devices: [{ deviceID: instance.deviceId }, { deviceID: laptopId }] })),
        );
      case "/rest/config/devices":
        return reply(response, [...everyDevice, { deviceID: laptopId, name: "laptop" }]);
      case "/rest/cluster/pending/folders":
        return reply(response, Object.fromEntries(instance.pending.map((id) => [id, { offeredBy: { [laptopId]: { time: "2026-10-21T10:00:00Z", label: `${id} as offered`, receiveEncrypted: false } } }])));
      case "/rest/db/status":
        if (!folder) return reply(response, "no such folder", 404);
        return reply(response, { ...statusFixture, errors: folder.errors?.length ?? 0, pullErrors: folder.errors?.length ?? 0 });
      case "/rest/db/browse":
        browseRequests.push(`${instance.name}:${folder?.id}:${requestUrl.searchParams.get("prefix") ?? ""}`);
        return void delayed(instance.browseDelayMs, () => reply(response, folder?.browse[requestUrl.searchParams.get("prefix") ?? ""] ?? []));
      case "/rest/db/file":
        return reply(response, {
          availability: [{ id: laptopId, fromTemporary: false }, ...[...instances.values()].filter((other) => other !== instance).map((other) => ({ id: other.deviceId, fromTemporary: false }))],
          local: { deleted: false, ignored: false },
        });
      case "/rest/folder/errors":
        return reply(response, { errors: (folder?.errors ?? []).map((path) => ({ path, error: "denied" })), page: 1, perpage: 100 });
      case "/rest/db/need":
        return reply(response, { progress: [], queued: [], rest: [] });
      case "/rest/db/localchanged":
        return reply(response, { files: [] });
      default:
        return reply(response, "not found", 404);
    }
  }

  before(async () => {
    statusFixture = await fixture("status-documents.json");
    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://fake");
      const [, prefix, ...rest] = requestUrl.pathname.split("/");
      if (prefix === "p53") {
        dashboardRequests.push(requestUrl);
        return void delayed(dashboardDelayMs, () => reply(response, dashboardAnswer(requestUrl) as object));
      }
      const instance = instances.get(prefix);
      if (!instance) return reply(response, "no such instance", 404);
      void delayed(instance.delayMs, () => serveInstance(instance, `/${rest.join("/")}`, requestUrl, response));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    round += 1;
    instances = new Map();
    browseRequests = [];
    dashboardRequests = [];
    dashboardAnswer = () => ({ error: "nothing" });
    dashboardDelayMs = 0;
  });

  function p53Listing(requestUrl: URL, nextPage: number | null): TreeListing {
    return {
      path: requestUrl.searchParams.get("path") ?? "",
      view: "all",
      priority: { effective: 80, setHere: 80, inherited: 0, inheritedFrom: null, source: "setup-repo", overridesParent: true },
      overridesBelow: [],
      entries: [
        {
          name: "Taxes",
          path: "Documents/Taxes",
          kind: "directory",
          size: null,
          modified: null,
          folder: null,
          priority: { effective: 80, setHere: null, inherited: 80, inheritedFrom: "Documents", source: "inherited", overridesParent: false },
          nodes: [{ nodeId: "a1b2", nodeName: "p53-data", host: "p53", status: "syncing", detail: "2 items outstanding below" }],
          availability: [],
        },
      ],
      nextPage,
      notes: [],
    };
  }

  function threeNodes(): TreeNode[] {
    const pc = addInstance("pc", [documentsFolder("F:\\Documents")]);
    const array = addInstance("private-array", [], ["documents"]);
    const peer = addInstance("peer", [{ id: "dashboard-test-x", label: "test", path: "/peer/dashboard-test-x", browse: { "": [] } }]);
    return [treeNode(pc, "fb98", "F:\\", "windows"), treeNode(array, "5784", "/pool-5784", "linux"), treeNode(peer, "d7e5", "/peer", "linux")];
  }

  it("all merges each node's state per entry", async () => {
    const nodes = threeNodes();
    const listing = await allNodesListing("Documents", 1, "all", allSources(nodes));
    assert.equal(listing.view, "all");
    assert.deepEqual(names(listing.entries), ["Recipes", "Taxes", "notes.txt"]);
    const taxes = listing.entries.find((entry) => entry.name === "Taxes");
    assert.deepEqual(stateOn(taxes, nodes[0].nodeId), { status: "failed", detail: "1 item failed below" });
    assert.deepEqual(stateOn(taxes, nodes[1].nodeId), { status: "missing", detail: "offered, not accepted" });
    assert.equal(stateOn(taxes, nodes[2].nodeId), undefined);
    assert.ok(listing.entries.every((entry) => entry.nodes.length === 2));

    const top = await allNodesListing("", 1, "all", allSources([nodes[1], nodes[0], nodes[2]]));
    assert.deepEqual(names(top.entries), ["dashboard-test-x", "Documents"]);
    const documents = top.entries.find((entry) => entry.name === "Documents");
    assert.deepEqual(documents?.folder, { id: "documents", label: "Documents" });
    assert.deepEqual(stateOn(documents, nodes[1].nodeId), { status: "missing", detail: "offered, not accepted" });
    assert.equal(stateOn(documents, nodes[2].nodeId), undefined);
    assert.ok(stateOn(top.entries.find((entry) => entry.name === "dashboard-test-x"), nodes[2].nodeId));
  });

  it("a folder offered to a node sits where another node holds it, even without a layout entry", async () => {
    const nodes = threeNodes();
    const sources = allSources(nodes, { layout: async () => null });
    const top = await allNodesListing("", 1, "all", sources);
    assert.deepEqual(stateOn(top.entries.find((entry) => entry.name === "Documents"), nodes[1].nodeId), { status: "missing", detail: "offered, not accepted" });
    assert.ok(!top.entries.some((entry) => entry.name === "Other folders"), names(top.entries).join(", "));
    const inside = await allNodesListing("Documents", 1, "all", sources);
    assert.deepEqual(stateOn(inside.entries.find((entry) => entry.name === "Taxes"), nodes[1].nodeId), { status: "missing", detail: "offered, not accepted" });
  });

  it("the cluster is asked for the listing first", async () => {
    const cluster = addInstance("storage", [documentsFolder("/pool/Documents")]);
    const pc = addInstance("pc", [documentsFolder("F:\\Documents")]);
    const nodes = [treeNode(cluster, "storage", "/pool", "linux"), treeNode(pc, "fb98", "F:\\", "windows")];
    const listing = await allNodesListing("Documents", 1, "all", allSources(nodes));
    assert.ok(browseRequests.includes("storage:documents:"), browseRequests.join(", "));
    assert.ok(!browseRequests.some((request) => request.startsWith("pc:documents:")), browseRequests.join(", "));
    assert.deepEqual(
      listing.entries.find((entry) => entry.name === "Taxes")?.nodes.map((state) => state.nodeId),
      nodes.map((node) => node.nodeId),
    );
  });

  it("another host's nodes come from its dashboard with scope local", async () => {
    const nodes = threeNodes();
    dashboardAnswer = (requestUrl) => p53Listing(requestUrl, null);
    const p53: OtherHost = { host: "p53", dashboardUrl: `${url}/p53` };
    const listing = await allNodesListing("Documents", 1, "all", allSources(nodes, { otherHosts: [p53] }));
    assert.equal(dashboardRequests.length, 1);
    const asked = dashboardRequests[0];
    assert.equal(asked.pathname, "/p53/api/tree");
    assert.deepEqual([asked.searchParams.get("node"), asked.searchParams.get("path"), asked.searchParams.get("page"), asked.searchParams.get("scope")], ["all", "Documents", "1", "local"]);
    const taxes = listing.entries.find((entry) => entry.name === "Taxes");
    assert.deepEqual(stateOn(taxes, "a1b2"), { status: "syncing", detail: "2 items outstanding below" });
    assert.equal(stateOn(taxes, nodes[0].nodeId)?.status, "failed");
    assert.equal(stateOn(listing.entries.find((entry) => entry.name === "Recipes"), "a1b2"), undefined);

    await allNodesListing("Documents", 1, "local", allSources(nodes, { otherHosts: [p53] }));
    assert.equal(dashboardRequests.length, 1, "scope=local asks no other host");
  });

  it("an unreachable host leaves its nodes unknown and says so", async () => {
    const nodes = threeNodes();
    const gone: OtherHost = { host: "gone", dashboardUrl: "http://127.0.0.1:9" };
    const listing = await allNodesListing("Documents", 1, "all", allSources(nodes, { otherHosts: [gone], hostNodes: () => [{ nodeId: "c3d4", name: "gone-data" }] }));
    assert.equal(listing.entries.length, 3);
    for (const entry of listing.entries) {
      assert.deepEqual(stateOn(entry, "c3d4"), { status: "unknown", detail: "gone's dashboard could not be reached" });
      assert.notEqual(stateOn(entry, nodes[0].nodeId)?.status, "unknown");
    }
    assert.ok(listing.notes.some((note) => note.startsWith("gone's dashboard could not be reached")), listing.notes.join("; "));
  });

  it("a device without a dashboard shows in availability only", async () => {
    const nodes = threeNodes();
    const listing = await allNodesListing("Documents", 1, "all", allSources(nodes));
    const recipes = listing.entries.find((entry) => entry.name === "Recipes");
    assert.ok(recipes?.availability.some((device) => device.deviceId === laptopId && device.name === "laptop"));
    assert.equal(new Set(recipes?.availability.map((device) => device.deviceId)).size, recipes?.availability.length);
    assert.ok(!recipes?.nodes.some((state) => state.nodeName === "laptop"));
  });

  it("a slow node shows unknown without holding up the others", async () => {
    const nodes = threeNodes();
    instances.get(`private-array-${round}`)!.delayMs = 3000;
    const started = Date.now();
    const listing = await allNodesListing("Documents", 1, "all", allSources(nodes, { nodeWaitMs: 150 }));
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
    const taxes = listing.entries.find((entry) => entry.name === "Taxes");
    assert.equal(stateOn(taxes, nodes[0].nodeId)?.status, "failed");
    assert.deepEqual(stateOn(taxes, nodes[1].nodeId), { status: "unknown", detail: "still being read" });
    assert.ok(listing.notes.includes("private-array is still being read"), listing.notes.join("; "));
    assert.ok(!listing.notes.some((note) => note.includes("not answering")), listing.notes.join("; "));
    await until(() => delayedAnswers === 0, "the slow node's answers");
  });

  it("a slow supplying read is cut at the listing budget", async () => {
    const nodes = threeNodes();
    instances.get(`pc-${round}`)!.browseDelayMs = 3000;
    const started = Date.now();
    const listing = await allNodesListing("Documents", 1, "all", allSources(nodes, { listingBudgetMs: 200 }));
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
    assert.ok(listing.notes.includes("pc is still reading Documents"), listing.notes.join("; "));
    await until(() => delayedAnswers === 0, "the slow browse");
    const later = await allNodesListing("Documents", 1, "all", allSources(nodes, { listingBudgetMs: 200 }));
    assert.deepEqual(names(later.entries), ["Recipes", "Taxes", "notes.txt"]);
  });

  it("a slow other host is not reported as unreachable", async () => {
    const nodes = threeNodes();
    dashboardDelayMs = 400;
    dashboardAnswer = (requestUrl) => p53Listing(requestUrl, null);
    const p53: OtherHost = { host: "p53", dashboardUrl: `${url}/p53` };
    const listing = await allNodesListing(
      "Documents",
      1,
      "all",
      allSources(nodes, { otherHosts: [p53], readHost: (host, path) => readDashboard(host.dashboardUrl, host.host, path, 100), hostNodes: () => [{ nodeId: "a1b2", name: "p53-data" }] }),
    );
    assert.ok(listing.notes.some((note) => note.startsWith("p53's dashboard is slow, still being read")), listing.notes.join("; "));
    assert.ok(!listing.notes.some((note) => note.includes("could not be reached")), listing.notes.join("; "));
    assert.deepEqual(stateOn(listing.entries.find((entry) => entry.name === "Taxes"), "a1b2"), { status: "unknown", detail: "p53's dashboard is slow, still being read" });
    await wait(400);
  });

  it("above one page a remote node missing from a row is unknown", async () => {
    const nodes = threeNodes();
    dashboardAnswer = (requestUrl) => p53Listing(requestUrl, 2);
    const listing = await allNodesListing("Documents", 1, "all", allSources(nodes, { otherHosts: [{ host: "p53", dashboardUrl: `${url}/p53` }] }));
    assert.equal(stateOn(listing.entries.find((entry) => entry.name === "Taxes"), "a1b2")?.status, "syncing");
    assert.deepEqual(stateOn(listing.entries.find((entry) => entry.name === "Recipes"), "a1b2"), { status: "unknown", detail: "not on this page of p53's listing" });
  });

  it("a node that is not attached says so once and shows where it took part", async () => {
    const nodes = threeNodes();
    const detached = nodes.map((node, index) => (index === 1 ? { ...node, present: false } : node));
    const unseen = await allNodesListing("Documents", 1, "all", allSources(detached));
    assert.deepEqual(unseen.notes.filter((note) => note.includes("private-array")), ["private-array is not connected"]);
    assert.ok(unseen.entries.every((entry) => stateOn(entry, nodes[1].nodeId) === undefined));

    await allNodesListing("Documents", 1, "all", allSources(nodes));
    const seen = await allNodesListing("Documents", 1, "all", allSources(detached));
    assert.deepEqual(stateOn(seen.entries.find((entry) => entry.name === "Taxes"), nodes[1].nodeId), { status: "unknown", detail: "not connected" });
    assert.equal(stateOn(seen.entries.find((entry) => entry.name === "Taxes"), nodes[2].nodeId), undefined);
  });

  it("another host's node viewed alone is forwarded", async () => {
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
        offersWaiting: 0,
        syncthing: null,
        instance: null,
        peers: [],
        folders: [],
        dashboardUrl: `${url}/p53`,
      };
      dashboardAnswer = () => ({ path: "Documents", view: "a1b2", entries: [], forwarded: true });
      const resolver = { registryDirectory: directory, heartbeatPath: join(directory, "none.json"), otherHostNodes: async () => [remote] };
      const routeSources = { resolver, listing: allSources([]), allNodes: allSources([]) };
      const answer = await treeResponse({ node: "a1b2", path: "Documents", page: 2, scope: "all" }, routeSources);
      assert.deepEqual(answer, { path: "Documents", view: "a1b2", entries: [], forwarded: true });
      assert.equal(dashboardRequests.length, 1);
      const asked = dashboardRequests[0];
      assert.deepEqual([asked.searchParams.get("node"), asked.searchParams.get("path"), asked.searchParams.get("page"), asked.searchParams.get("scope")], ["a1b2", "Documents", "2", "local"]);
      await assert.rejects(treeResponse({ node: "a1b2", path: "", page: 1, scope: "local" }, routeSources), (error: unknown) => error instanceof RequestError && error.status === 404);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
