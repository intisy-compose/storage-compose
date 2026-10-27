import assert from "node:assert/strict";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { discardedCount, overrideLossText, revertLossText } from "../src/api/localChangesText.js";
import type { DiscardCounts, FailedItem, ItemsPage, LocalChangedPage, LocalChangesDone, NeedItem, RemoteNeedPage } from "../src/api/types.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, RemoteInstance, ResolvedInstance } from "../src/instanceResolver.js";
import { type WriteEffects, type WriteNote, requestHandler } from "../src/routes.js";
import { forwardBudgetsMs, itemRoutes } from "../src/routes/items.js";
import { localChangesRoutes } from "../src/routes/localChanges.js";
import { reshownForwardedError, shownSyncthingError } from "../src/shownSyncthingError.js";
import { SyncthingClient, listTimeoutMs } from "../src/syncthing.js";
import { acceptCountsRead, forgetCountsRead, startCountsRead } from "../ui/src/discardCounts.js";
import { hasNextPage, positionText, totalText } from "../ui/src/itemPages.js";
import { outOfSyncCount, outOfSyncText } from "../ui/src/outOfSync.js";
import { until } from "./until.js";

const apiKey = "items-test-key";
const ownId = "D7E5AAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA";
const peerId = "PBMD2SH-RS3UNJU-L77BP7K-X7VFKHE-73FF74D-RRCUVRY-XNUNII3-WWU53Q6";
const arrayId = "X7KCOB7-4ZJQ2RT-W352REX-D36FWRQ-YSGVXEA-6YA5PZK-PHYIU5M-32WVQQ4";
const offeredId = "NICA6WR-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA";
const leftId = "LEFTAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA";

const lockError = String.raw`open C:\Documents\Projects\.idea\session.lock: The process cannot access the file because it is being used by another process.`;

function reply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function fileInfo(name: string, extra: Record<string, unknown> = {}) {
  return { name, size: 1024, modified: "2026-10-21T10:00:00+02:00", deleted: false, modifiedBy: "PBMD2SH", type: "FILE_INFO_TYPE_FILE", sequence: 7, ...extra };
}

describe("out-of-sync items", () => {
  const asked: string[] = [];
  let openRequests = 0;
  let releaseSlowPages: () => void = () => {};
  let slowPages = new Promise<void>((resolve) => (releaseSlowPages = resolve));
  let syncthingUrl = "";
  let dashboardUrl = "";
  let peerDashboardUrl = "";
  const peerDashboardPaths: string[] = [];

  const syncthing = createServer(async (request, response) => {
    openRequests += 1;
    response.on("close", () => (openRequests -= 1));
    if (request.headers["x-api-key"] !== apiKey) return reply(response, { error: "forbidden" }, 403);
    const url = new URL(request.url ?? "/", "http://fake");
    asked.push(`${url.pathname}${url.search}`);
    const folder = url.searchParams.get("folder");
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("perpage") ?? "0");
    if (url.pathname === "/rest/config/devices") {
      return reply(response, [
        { deviceID: ownId, name: "dashboard-test-peer" },
        { deviceID: peerId, name: "pc" },
        { deviceID: arrayId, name: "private-array" },
        { deviceID: offeredId, name: "laptop" },
        { deviceID: leftId, name: "phone" },
      ]);
    }
    if (url.pathname === "/rest/config/folders") return reply(response, [{ id: "documents", label: "Documents", path: "/var/syncthing/data/documents", type: "sendreceive", paused: false, devices: [{ deviceID: ownId }, { deviceID: peerId }, { deviceID: offeredId }, { deviceID: leftId }] }]);
    if (folder !== "documents") return response.writeHead(404).end("no such folder\n");
    if (url.pathname === "/rest/db/ignores") return reply(response, { ignore: ["*.bak"], expanded: ["*.bak", "secret/included/**"], error: null });
    if (url.pathname === "/rest/db/status") return reply(response, { needTotalItems: 918_733, needFiles: 918_000, errors: 652 });
    if (url.pathname === "/rest/db/completion") {
      const device = url.searchParams.get("device");
      if (device === offeredId) return reply(response, { completion: 0, needItems: 918_733, needBytes: 1e11, remoteState: "unknown", sequence: 0 });
      if (device === leftId) return reply(response, { completion: 0, needItems: 918_733, needBytes: 1e11, remoteState: "notSharing", sequence: 0 });
      return reply(response, { completion: 12.5, needItems: 4, needBytes: 4096, remoteState: "valid", sequence: 4711 });
    }
    if (page > 1) await slowPages;
    if (url.pathname === "/rest/folder/errors") {
      const failures = [
        { path: "Projects/.idea/session.lock", error: lockError },
        { path: "Projects/pattern.txt", error: 'invalid pattern "secret/included/**" in ignore file' },
        { path: "Projects/other.txt", error: "failed to read #include ../../etc/private.stignore" },
      ];
      const errors = Array.from({ length: Math.min(perPage, 652) }, (_, index) => {
        const position = (page - 1) * perPage + index;
        return failures[position] ?? { path: `Projects/locked-${position}.bin`, error: "permission denied" };
      });
      return reply(response, { folder: "documents", page, perpage: perPage, errors });
    }
    if (url.pathname === "/rest/db/need") {
      const names = Array.from({ length: perPage }, (_, index) => `Projects/report-${(page - 1) * perPage + index}.pdf`);
      return reply(response, {
        page,
        perpage: perPage,
        progress: [fileInfo(names[0], { size: 5_000_000 })],
        queued: [fileInfo(names[1], { modifiedBy: "" })],
        rest: names.slice(2).map((name) => fileInfo(name, { deleted: name.endsWith("5.pdf") })),
      });
    }
    if (url.pathname === "/rest/db/remoteneed") return reply(response, { page, perpage: perPage, files: [fileInfo("Taxes/2025.pdf", { modifiedBy: "D7E5AAA" })] });
    reply(response, { error: "not faked" }, 404);
  });

  const peerDashboard = createServer((request, response) => {
    peerDashboardPaths.push(request.url ?? "");
    if ((request.url ?? "").includes("/errors")) return reply(response, { items: [{ path: "x.txt", error: 'invalid pattern "private/**"', apiKey: "leak" }], page: 2, perPage: 20, total: 21 });
    reply(response, { items: [{ name: "a.txt", size: 3, modified: "2026-10-21T10:00:00Z", deleted: false, modifiedBy: "p53", stage: "rest", apiKey: "leak" }], page: 2, perPage: 20, total: 21 });
  });

  function peer(): LocalInstance {
    return { kind: "local", nodeId: "d7e5", name: "dashboard-test-peer", client: new SyncthingClient({ url: syncthingUrl, apiKey }), root: "/var/syncthing/data", os: "linux", threshold: 0, source: "registry" };
  }

  function remote(): RemoteInstance {
    return { kind: "remote", nodeId: "a1b2", name: "p53-data", host: "p53", dashboardUrl: peerDashboardUrl };
  }

  async function resolve(nodeId: string): Promise<ResolvedInstance> {
    if (nodeId === "d7e5") return peer();
    if (nodeId === "a1b2") return remote();
    throw new RequestError(404, `no node ${nodeId}`);
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
    const response = await fetch(`${dashboardUrl}${path}`);
    return { status: response.status, body: (await response.json()) as T };
  }

  const dashboard = createServer((request, response) => void requestHandler(itemRoutes({ resolve }))(request, response));

  before(async () => {
    syncthingUrl = await listen(syncthing);
    dashboardUrl = await listen(dashboard);
    peerDashboardUrl = await listen(peerDashboard);
  });

  beforeEach(() => {
    asked.length = 0;
  });

  after(async () => {
    releaseSlowPages();
    await until(() => openRequests === 0, "the fake Syncthing to finish its requests");
    syncthing.close();
    dashboard.close();
    peerDashboard.close();
  });

  it("need list of a large folder answers page 1 without waiting for the rest", async () => {
    const started = Date.now();
    const { status, body } = await getJson<ItemsPage<NeedItem>>("/api/nodes/d7e5/folders/documents/need");
    assert.equal(status, 200);
    assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
    assert.equal(body.page, 1);
    assert.equal(body.perPage, 50);
    assert.equal(body.total, 918_733);
    assert.equal(body.items.length, 50);
    assert.deepEqual(body.items[0], { name: "Projects/report-0.pdf", size: 5_000_000, modified: "2026-10-21T10:00:00+02:00", deleted: false, modifiedBy: "pc", stage: "progress" });
    assert.deepEqual(body.items[1], { name: "Projects/report-1.pdf", size: 1024, modified: "2026-10-21T10:00:00+02:00", deleted: false, modifiedBy: null, stage: "queued" });
    assert.equal(body.items[2].stage, "rest");
    assert.equal(body.items[5].deleted, true);
    assert.deepEqual(
      asked.filter((path) => path.startsWith("/rest/db/need")),
      ["/rest/db/need?folder=documents&page=1&perpage=50"],
      "only the page asked for is read",
    );
  });

  it("a later page is read on its own, and a slow page leaves other reads answering", async () => {
    const later = fetch(`${dashboardUrl}/api/nodes/d7e5/folders/documents/need?page=3&perPage=20`);
    await until(() => asked.includes("/rest/db/need?folder=documents&page=3&perpage=20"), "the read of page 3");
    const first = await getJson<ItemsPage<NeedItem>>("/api/nodes/d7e5/folders/documents/need?page=1&perPage=20");
    assert.equal(first.body.items[0].name, "Projects/report-0.pdf");
    releaseSlowPages();
    const third = (await (await later).json()) as ItemsPage<NeedItem>;
    assert.equal(third.page, 3);
    assert.equal(third.items[0].name, "Projects/report-40.pdf");
    slowPages = new Promise<void>((resolve) => (releaseSlowPages = resolve));
  });

  it("perPage above 100 is clamped", async () => {
    const { status, body } = await getJson<ItemsPage<NeedItem>>("/api/nodes/d7e5/folders/documents/need?page=1&perPage=500");
    assert.equal(status, 200);
    assert.equal(body.perPage, 100);
    assert.equal(body.items.length, 100);
    assert.ok(asked.includes("/rest/db/need?folder=documents&page=1&perpage=100"), asked.join(", "));
  });

  it("a page or page size that is no whole number above 0 is refused before Syncthing is asked", async () => {
    for (const query of ["page=0", "page=x", "page=1.5", "perPage=0", "perPage=-3", "perPage=ten"]) {
      const { status } = await getJson(`/api/nodes/d7e5/folders/documents/need?${query}`);
      assert.equal(status, 400, query);
    }
    assert.deepEqual(asked, []);
  });

  it("remote need names the device", async () => {
    const { status, body } = await getJson<RemoteNeedPage>(`/api/nodes/d7e5/folders/documents/remote-need?device=${peerId}`);
    assert.equal(status, 200);
    assert.deepEqual(body.device, { deviceId: peerId, name: "pc" });
    assert.equal(body.total, 4);
    assert.deepEqual(body.items, [{ name: "Taxes/2025.pdf", size: 1024, modified: "2026-10-21T10:00:00+02:00", deleted: false, modifiedBy: "dashboard-test-peer" }]);
    assert.ok(asked.includes(`/rest/db/remoteneed?folder=documents&device=${peerId}&page=1&perpage=50`), asked.join(", "));
  });

  it("remote need of a device the folder is not shared with says so instead of listing every item", async () => {
    const { status, body } = await getJson<{ error: string }>(`/api/nodes/d7e5/folders/documents/remote-need?device=${arrayId}`);
    assert.equal(status, 409);
    assert.equal(body.error, "Documents is not shared with private-array on dashboard-test-peer");
    assert.ok(!asked.some((path) => path.startsWith("/rest/db/remoteneed")), "Syncthing would answer every item as needed");
  });

  it("remote need of a device that has not accepted the folder, or no longer shares it, says so instead of listing every item", async () => {
    const offered = await getJson<{ error: string }>(`/api/nodes/d7e5/folders/documents/remote-need?device=${offeredId}`);
    assert.equal(offered.status, 409);
    assert.equal(offered.body.error, "laptop has sent no index of Documents to dashboard-test-peer (not accepted, or nothing received yet), so what it needs is not known");
    const left = await getJson<{ error: string }>(`/api/nodes/d7e5/folders/documents/remote-need?device=${leftId}`);
    assert.equal(left.status, 409);
    assert.equal(left.body.error, "phone does not share Documents with dashboard-test-peer");
    assert.ok(!asked.some((path) => path.startsWith("/rest/db/remoteneed")), asked.join(", "));
  });

  it("remote need without a device, and a folder the node does not have, are refused", async () => {
    assert.equal((await getJson(`/api/nodes/d7e5/folders/documents/remote-need`)).status, 400);
    const missing = await getJson<{ error: string }>(`/api/nodes/d7e5/folders/nosuch/need`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "dashboard-test-peer has no folder nosuch");
  });

  it("another host's node is read from its dashboard with the page kept, field by field", async () => {
    const { status, body } = await getJson<ItemsPage<NeedItem>>("/api/nodes/a1b2/folders/documents/need?page=2&perPage=20");
    assert.equal(status, 200);
    assert.equal(peerDashboardPaths.at(-1), "/api/nodes/a1b2/folders/documents/need?page=2&perPage=20&scope=local");
    assert.deepEqual(body, { items: [{ name: "a.txt", size: 3, modified: "2026-10-21T10:00:00Z", deleted: false, modifiedBy: "p53", stage: "rest" }], page: 2, perPage: 20, total: 21 });
  });

  it("failed items page and keep syncthing's error text", async () => {
    const { status, body } = await getJson<ItemsPage<FailedItem>>("/api/nodes/d7e5/folders/documents/errors?perPage=20");
    assert.equal(status, 200);
    assert.deepEqual(asked.filter((path) => path.startsWith("/rest/folder/errors")), ["/rest/folder/errors?folder=documents&page=1&perpage=20"]);
    assert.equal(body.total, 652);
    assert.equal(body.perPage, 20);
    assert.equal(body.items.length, 20);
    assert.deepEqual(body.items[0], { path: "Projects/.idea/session.lock", error: lockError });
    assert.deepEqual(body.items[3], { path: "Projects/locked-3.bin", error: "permission denied" });
    releaseSlowPages();
    const later = await getJson<ItemsPage<FailedItem>>("/api/nodes/d7e5/folders/documents/errors?page=3&perPage=20");
    assert.equal(later.body.page, 3);
    assert.equal(later.body.items[0].path, "Projects/locked-40.bin");
    assert.ok(asked.includes("/rest/folder/errors?folder=documents&page=3&perpage=20"), asked.join(", "));
    slowPages = new Promise<void>((resolve) => (releaseSlowPages = resolve));
  });

  it("failed items show nothing quoted from an included ignore file, and a missing folder or bad page is refused", async () => {
    const { body } = await getJson<ItemsPage<FailedItem>>("/api/nodes/d7e5/folders/documents/errors?perPage=5");
    assert.equal(body.items[1].error, "invalid pattern in an included file");
    assert.equal(body.items[2].error, "Syncthing cannot read an included file");
    assert.ok(!JSON.stringify(body).includes("secret/included"));
    assert.equal((await getJson("/api/nodes/d7e5/folders/nosuch/errors")).status, 404);
    assert.equal((await getJson("/api/nodes/d7e5/folders/documents/errors?page=0")).status, 400);
    assert.ok(asked.every((path) => !path.includes("scan") && !path.includes("override")), "reading the list changes nothing");
  });

  it("another host's failed items are read from its dashboard and rebuilt field by field", async () => {
    const { status, body } = await getJson<ItemsPage<FailedItem>>("/api/nodes/a1b2/folders/documents/errors?page=2&perPage=20");
    assert.equal(status, 200);
    assert.equal(peerDashboardPaths.at(-1), "/api/nodes/a1b2/folders/documents/errors?page=2&perPage=20&scope=local");
    assert.deepEqual(body, { items: [{ path: "x.txt", error: "invalid pattern in an included file" }], page: 2, perPage: 20, total: 21 });
  });

  it("a request already forwarded by another host is not forwarded again", async () => {
    const { status } = await getJson("/api/nodes/a1b2/folders/documents/need?scope=local");
    assert.equal(status, 404);
  });
});

describe("forwarded item lists", () => {
  it("a forwarded remote need may take both of the other dashboard's sequential reads", () => {
    assert.equal(forwardBudgetsMs.remoteNeed, 2 * listTimeoutMs + 5_000);
    assert.ok(forwardBudgetsMs.need > listTimeoutMs, "the other dashboard's own timeout answers first");
    assert.ok(forwardBudgetsMs.remoteNeed > forwardBudgetsMs.need);
  });
});

describe("item list pages", () => {
  const item = { name: "a", size: 1, modified: "", deleted: false, modifiedBy: null };
  const pageOf = (count: number, total: number | null) => ({ items: Array.from({ length: count }, () => item), page: 1, perPage: 25, total });

  it("a next page follows while the count says so, or while the page is full past the count", () => {
    assert.equal(hasNextPage({ page: 1, perPage: 25 }, pageOf(25, 29)), true);
    assert.equal(hasNextPage({ page: 2, perPage: 25 }, pageOf(4, 29)), false);
    assert.equal(hasNextPage({ page: 2, perPage: 25 }, pageOf(25, 29)), true, "Syncthing repeats items being fetched past the count");
    assert.equal(hasNextPage({ page: 1, perPage: 25 }, pageOf(22, 22)), false);
    assert.equal(hasNextPage({ page: 3, perPage: 25 }, pageOf(25, null)), true);
    assert.equal(hasNextPage({ page: 3, perPage: 25 }, pageOf(3, null)), false);
  });

  it("the position names the page count only while the page lies within it", () => {
    assert.equal(positionText({ page: 1, perPage: 25, loading: false }, 918_733), "Page 1 of 36,750");
    assert.equal(positionText({ page: 3, perPage: 25, loading: false }, 29), "Page 3");
    assert.equal(positionText({ page: 1, perPage: 25, loading: true }, 29), "Reading…");
  });

  it("the total of a failed list says Syncthing could not sync them", () => {
    assert.equal(totalText({ page: 1, perPage: 25, deviceId: null, kind: "failed" }, pageOf(25, 652)), "652 items Syncthing could not sync.");
  });

  it("the total names the device, and a page past the count says why it is there", () => {
    assert.equal(totalText({ page: 1, perPage: 25, deviceId: null, kind: "need" }, pageOf(25, 29)), "29 items still to fetch.");
    assert.equal(
      totalText({ page: 3, perPage: 25, deviceId: null, kind: "need" }, { ...pageOf(4, 29), page: 3 }),
      "29 items still to fetch. This page lies past that count: Syncthing lists items it is fetching or has queued again here.",
    );
    const remote = { ...pageOf(1, 1), device: { deviceId: "PBMD2SH", name: "pc" } };
    assert.equal(totalText({ page: 1, perPage: 25, deviceId: "PBMD2SH", kind: "need" }, remote), "pc still needs 1 item of this folder.");
    assert.equal(totalText({ page: 1, perPage: 25, deviceId: null, kind: "need" }, pageOf(0, null)), "How many in all could not be read.");
  });
});

describe("local changes: list, revert and override", () => {
  const asked: string[] = [];
  const notes: WriteNote[] = [];
  let omitNeedTotal = false;
  let syncthingUrl = "";
  let dashboardUrl = "";
  const trashcan = { type: "trashcan", params: { cleanoutDays: "0" }, cleanupIntervalS: 3600, fsPath: "" };
  const off = { type: "", params: {}, cleanupIntervalS: 0, fsPath: "" };
  const folders = [
    { id: "test-ro", label: "Test RO", path: "/var/syncthing/data/test-ro", type: "receiveonly", paused: false, devices: [{ deviceID: ownId }, { deviceID: peerId }], versioning: trashcan },
    { id: "test-so", label: "Test SO", path: "/var/syncthing/data/test-so", type: "sendonly", paused: false, devices: [{ deviceID: ownId }, { deviceID: peerId }], versioning: off },
    { id: "test-sr", label: "Test SR", path: "/var/syncthing/data/test-sr", type: "sendreceive", paused: false, devices: [{ deviceID: ownId }], versioning: off },
    { id: "test-paused", label: "", path: "/var/syncthing/data/test-paused", type: "receiveonly", paused: true, devices: [{ deviceID: ownId }], versioning: off },
  ];

  const syncthing = createServer((request, response) => {
    if (request.headers["x-api-key"] !== apiKey) return reply(response, { error: "forbidden" }, 403);
    const url = new URL(request.url ?? "/", "http://fake");
    asked.push(`${request.method} ${url.pathname}${url.search}`);
    const folderId = url.searchParams.get("folder");
    if (url.pathname === "/rest/config/devices") return reply(response, [{ deviceID: ownId, name: "dashboard-test-peer" }, { deviceID: peerId, name: "pc" }]);
    if (url.pathname === "/rest/config/folders") return reply(response, folders);
    if (url.pathname.startsWith("/rest/config/folders/")) {
      const folder = folders.find((candidate) => candidate.id === decodeURIComponent(url.pathname.split("/").at(-1) ?? ""));
      return folder ? reply(response, folder) : reply(response, { error: "no such folder" }, 404);
    }
    if (url.pathname === "/rest/db/status") {
      const needTotal = omitNeedTotal ? {} : { needTotalItems: folderId === "test-so" ? 5 : 0 };
      return reply(response, { receiveOnlyTotalItems: folderId === "test-ro" ? 2 : 0, needFiles: 3, ...needTotal });
    }
    if (url.pathname === "/rest/db/localchanged") return reply(response, { page: 1, perpage: 50, files: [fileInfo("added-here.txt", { modifiedBy: "D7E5AAA" }), fileInfo("hello.txt", { deleted: true, modifiedBy: "D7E5AAA" })] });
    if (url.pathname === "/rest/db/revert" || url.pathname === "/rest/db/override") return reply(response, {});
    reply(response, { error: "not faked" }, 404);
  });

  function peer(source: LocalInstance["source"] = "registry"): LocalInstance {
    const isArray = source === "array";
    return { kind: "local", nodeId: isArray ? "5784" : "d7e5", name: isArray ? "private-array" : "dashboard-test-peer", client: new SyncthingClient({ url: syncthingUrl, apiKey }), root: "/var/syncthing/data", os: "linux", threshold: 0, source };
  }

  async function resolve(nodeId: string): Promise<ResolvedInstance> {
    if (nodeId === "d7e5") return peer();
    if (nodeId === "5784") return peer("array");
    if (nodeId === "a1b2") return { kind: "remote", nodeId, name: "p53-data", host: "p53", dashboardUrl: "http://127.0.0.1:9" };
    throw new RequestError(404, `no node ${nodeId}`);
  }

  const effects: WriteEffects = { invalidate: () => {}, record: (note) => void notes.push(note) };
  const handle = requestHandler([...itemRoutes({ resolve }), ...localChangesRoutes({ resolve })], effects);
  const dashboard = createServer((request, response) => void handle(request, response));

  async function post(path: string, body?: unknown): Promise<{ status: number; body: LocalChangesDone & { error?: string } }> {
    const response = await fetch(`${dashboardUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as LocalChangesDone & { error?: string } };
  }

  const writes = () => asked.filter((entry) => entry.startsWith("POST"));

  before(async () => {
    syncthingUrl = await listen(syncthing);
    dashboardUrl = await listen(dashboard);
  });

  beforeEach(() => {
    asked.length = 0;
    notes.length = 0;
  });

  after(() => {
    syncthing.close();
    dashboard.close();
  });

  it("the local changes of a receive only folder page with syncthing's count", async () => {
    const response = await fetch(`${dashboardUrl}/api/nodes/d7e5/folders/test-ro/local-changed?page=1&perPage=500`);
    const page = (await response.json()) as LocalChangedPage;
    assert.equal(response.status, 200);
    assert.ok(asked.includes("GET /rest/db/localchanged?folder=test-ro&page=1&perpage=100"), asked.join(", "));
    assert.equal(page.total, 2);
    assert.equal(page.perPage, 100);
    assert.deepEqual(page.items[1], { name: "hello.txt", size: 1024, modified: "2026-10-21T10:00:00+02:00", deleted: true, modifiedBy: "dashboard-test-peer" });
    assert.deepEqual(writes(), []);
  });

  it("revert is refused on a send receive folder", async () => {
    const answer = await post("/api/nodes/d7e5/folders/test-sr/revert", { confirm: "test-sr" });
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, "revert is only for a receive only folder; Test SR is send and receive on dashboard-test-peer");
    assert.equal((await post("/api/nodes/d7e5/folders/test-so/revert", { confirm: "test-so" })).status, 409);
    assert.equal((await post("/api/nodes/d7e5/folders/test-ro/override", { confirm: "test-ro" })).status, 409, "override is for send only folders");
    assert.deepEqual(writes(), []);
    assert.deepEqual(notes, []);
  });

  it("override needs the folder id typed", async () => {
    for (const body of [undefined, {}, { confirm: "" }, { confirm: "Test SO" }, { confirm: " test-so" }, { confirm: "TEST-SO" }]) {
      const answer = await post("/api/nodes/d7e5/folders/test-so/override", body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.equal(answer.body.error, "type the folder ID test-so to override the other devices' changes");
    }
    assert.equal((await post("/api/nodes/d7e5/folders/test-ro/revert", { confirm: "Test RO" })).status, 400);
    assert.deepEqual(asked, [], "a missing confirmation is refused before any request to the node");
  });

  it("override with the id typed replaces the other devices' changes and enters Activity", async () => {
    const answer = await post("/api/nodes/d7e5/folders/test-so/override", { confirm: "test-so" });
    assert.equal(answer.status, 200);
    assert.deepEqual(writes(), ["POST /rest/db/override?folder=test-so"]);
    assert.deepEqual(answer.body, {
      folderId: "test-so",
      action: "override",
      items: 5,
      text: "dashboard-test-peer: overrode 5 items other devices changed in folder Test SO with dashboard-test-peer's versions; versioning off on dashboard-test-peer",
    });
    assert.deepEqual(notes.map((note) => [note.folderId, note.text]), [["test-so", answer.body.text]]);
  });

  it("an override whose need total syncthing does not give counts an unknown number, never the files alone", async () => {
    omitNeedTotal = true;
    try {
      const answer = await post("/api/nodes/d7e5/folders/test-so/override", { confirm: "test-so" });
      assert.equal(answer.status, 200);
      assert.equal(answer.body.items, null);
      assert.match(answer.body.text, /overrode an unknown number of items other devices changed/);
    } finally {
      omitNeedTotal = false;
    }
  });

  it("the counts a revert or override form names are read from one folder status, now", async () => {
    const response = await fetch(`${dashboardUrl}/api/nodes/d7e5/folders/test-so/discard-counts`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()) as DiscardCounts, { localChanged: 0, needTotalItems: 5 });
    assert.deepEqual(asked, ["GET /rest/db/status?folder=test-so"]);
  });

  it("revert with the id typed deletes or replaces the local changes and names the versioning", async () => {
    const answer = await post("/api/nodes/d7e5/folders/test-ro/revert", { confirm: "test-ro" });
    assert.equal(answer.status, 200);
    assert.deepEqual(writes(), ["POST /rest/db/revert?folder=test-ro"]);
    assert.equal(answer.body.items, 2);
    assert.match(answer.body.text, /^dashboard-test-peer: reverted 2 items changed here in folder Test RO, deleted or replaced by the other devices' versions; versioning trash can/);
    assert.equal(notes.length, 1);
  });

  it("on an array the typed id goes through the array guard first, and a paused folder or another host's node is refused", async () => {
    const array = await post("/api/nodes/5784/folders/test-ro/revert", { confirm: "Test RO" });
    assert.equal(array.status, 400);
    assert.equal(array.body.error, "type the folder ID test-ro to revert its local changes on private-array, an array");
    assert.deepEqual(asked, []);
    assert.equal((await post("/api/nodes/a1b2/folders/test-ro/revert", { confirm: "test-ro" })).body.error, "act on p53's dashboard");
    const paused = await post("/api/nodes/d7e5/folders/test-paused/revert", { confirm: "test-paused" });
    assert.equal(paused.status, 409);
    assert.equal(paused.body.error, "test-paused is paused on dashboard-test-peer; resume it first");
    assert.equal((await post("/api/nodes/d7e5/folders/nosuch/revert", { confirm: "nosuch" })).status, 404);
    assert.deepEqual(writes(), []);
    assert.deepEqual(notes, []);
  });
});

describe("the words of a revert or override", () => {
  const staggered = { type: "staggered" as const, params: { maxAge: "31536000" }, cleanupIntervalS: 3600, fsPath: "" };
  const off = { type: "" as const, params: {}, cleanupIntervalS: 0, fsPath: "" };

  it("say how many items are lost and whether versioning keeps them", () => {
    assert.deepEqual(revertLossText("d7e5", "Test A", 2, off), [
      "2 items changed on d7e5 will be lost: a file added here is deleted, and a file changed or deleted here is replaced by the version the other devices have.",
      "Versioning is off for Test A on d7e5, so what is deleted or replaced cannot be restored.",
    ]);
    assert.match(revertLossText("d7e5", "Test A", 1, staggered)[1], /^Versioning is on for Test A on d7e5 \(staggered, versions kept up to 365 days/);
    assert.match(overrideLossText("d7e5", "Test B", null, off)[0], /^an unknown number of items that other devices changed will be lost/);
    assert.match(overrideLossText("d7e5", "Test B", 1, staggered)[1], /only if its own copy of Test B has versioning on\. Versioning on d7e5 \(staggered[^)]*\) does not keep them\.$/);
    assert.equal(overrideLossText("d7e5", "Test B", 1, off)[1], "Each device keeps the versions it replaces only if its own copy of Test B has versioning on.", "with versioning off there is no setting of this node to name");
  });

  it("the override form counts every item other devices changed, read fresh when it can be", () => {
    const polled = { localChanged: 0, needItems: 3, needTotalItems: 5 };
    assert.equal(discardedCount("override", polled, null), 5);
    assert.match(overrideLossText("d7e5", "Test B", discardedCount("override", polled, null), off)[0], /^5 items that other devices changed will be lost/);
    assert.equal(discardedCount("override", polled, { localChanged: 0, needTotalItems: 7 }), 7, "the count read as the form opened wins over the last poll");
    assert.equal(discardedCount("revert", { ...polled, localChanged: 2 }, { localChanged: 4, needTotalItems: 0 }), 4);
    assert.equal(discardedCount("override", polled, { localChanged: 0, needTotalItems: null }), null);
  });
});

describe("the copy card and the override form count alike", () => {
  it("out of sync counts every item, so directories or deletes alone still show and open their list", () => {
    const copy = { needItems: 3, needTotalItems: 5, needBytes: 60, completion: 40 };
    assert.equal(outOfSyncCount(copy), discardedCount("override", { localChanged: 0, ...copy }, null));
    assert.equal(outOfSyncText(copy), "5 items, 60 B (40% done)");
    const directoriesOnly = { needTotalItems: 2, needBytes: 0, completion: 100 };
    assert.equal(outOfSyncCount(directoriesOnly), 2);
    assert.equal(outOfSyncText(directoriesOnly), "2 items, 0 B (100% done)");
    assert.equal(outOfSyncText({ needTotalItems: 0, needBytes: 0, completion: 100 }), "nothing");
  });

  it("an answer for a form closed or reopened since is dropped and leaves a newer read waiting", () => {
    const state = { discardOpen: true, discardCounts: null, discardCountsReading: false };
    const first = startCountsRead(state);
    const second = startCountsRead(state);
    assert.equal(acceptCountsRead(state, first, { ok: true, value: { localChanged: 0, needTotalItems: 9 } }), false);
    assert.equal(state.discardCountsReading, true, "the newer read is still waiting");
    assert.equal(state.discardCounts, null);
    assert.equal(acceptCountsRead(state, second, { ok: true, value: { localChanged: 0, needTotalItems: 4 } }), true);
    assert.deepEqual([state.discardCounts, state.discardCountsReading], [{ localChanged: 0, needTotalItems: 4 }, false]);
    const third = startCountsRead(state);
    state.discardOpen = false;
    forgetCountsRead(state);
    assert.equal(acceptCountsRead(state, third, { ok: true, value: { localChanged: 0, needTotalItems: 1 } }), false, "the form was closed");
    assert.equal(state.discardCounts, null);
  });
});

describe("syncthing's error text, shown", () => {
  it("passes on nothing from an included file, with one policy for ignores and failed items", () => {
    const lock = "open x.lock: permission denied";
    assert.equal(shownSyncthingError(lock, ["*.tmp"]), lock);
    assert.equal(shownSyncthingError(lock, ["*.tmp", "#include more.stignore"]), "error hidden: this folder's ignore file has an #include", "in a folder with an include, an unrecognised shape is replaced whole");
    assert.equal(shownSyncthingError(lock, null), "error hidden: the folder's ignore file could not be read", "an unreadable .stignore counts as one with an include");
    assert.equal(shownSyncthingError('invalid pattern "*.tmp[" in ignore file', ["*.tmp["]), 'invalid pattern "*.tmp[" in ignore file', "the folder's own pattern may be shown");
    assert.equal(shownSyncthingError('invalid pattern "secret/**" in ignore file', ["*.tmp[", "#include more.stignore"]), "invalid pattern in an included file");
    assert.equal(shownSyncthingError("failed to read #include ../x", []), "Syncthing cannot read an included file");
    assert.equal(reshownForwardedError('invalid pattern "a["'), "invalid pattern in an included file");
    assert.equal(reshownForwardedError(lock), lock);
  });
});
