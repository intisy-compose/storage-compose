import assert from "node:assert/strict";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import type { FailedItem, ItemsPage, NeedItem, RemoteNeedPage } from "../src/api/types.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, RemoteInstance, ResolvedInstance } from "../src/instanceResolver.js";
import { requestHandler } from "../src/routes.js";
import { forwardBudgetsMs, itemRoutes } from "../src/routes/items.js";
import { SyncthingClient, listTimeoutMs } from "../src/syncthing.js";
import { hasNextPage, positionText, totalText } from "../ui/src/itemPages.js";
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
    assert.equal(totalText({ page: 1, perPage: 25, deviceId: null, failed: true }, pageOf(25, 652)), "652 items Syncthing could not sync.");
  });

  it("the total names the device, and a page past the count says why it is there", () => {
    assert.equal(totalText({ page: 1, perPage: 25, deviceId: null, failed: false }, pageOf(25, 29)), "29 items still to fetch.");
    assert.equal(
      totalText({ page: 3, perPage: 25, deviceId: null, failed: false }, { ...pageOf(4, 29), page: 3 }),
      "29 items still to fetch. This page lies past that count: Syncthing lists items it is fetching or has queued again here.",
    );
    const remote = { ...pageOf(1, 1), device: { deviceId: "PBMD2SH", name: "pc" } };
    assert.equal(totalText({ page: 1, perPage: 25, deviceId: "PBMD2SH", failed: false }, remote), "pc still needs 1 item of this folder.");
    assert.equal(totalText({ page: 1, perPage: 25, deviceId: null, failed: false }, pageOf(0, null)), "How many in all could not be read.");
  });
});
