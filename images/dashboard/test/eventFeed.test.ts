import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import type { ParityJob } from "../src/api/types.js";
import { ActivityLog, EventFeeds, type FeedInstance, ParityWatcher, failedItemsPerFolder } from "../src/eventFeed.js";
import { SyncthingClient, type SyncthingEvent } from "../src/syncthing.js";
import { until } from "./until.js";

const pcDevice = "PCAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const arrayDevice = "ARRAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const feedOptions = { waitSeconds: 1, requestTimeoutMs: 2000, retryMs: 20 };

/** A Syncthing that answers `/rest/events` like the real one: only events after `since`, or an empty list after a short wait. */
class FakeSyncthing {
  private events: SyncthingEvent[] = [];
  private startTime = "2026-10-21T08:00:00Z";
  private waiting: (() => void)[] = [];
  readonly sinceSeen: number[] = [];
  readonly server: Server;

  constructor() {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fake");
      const reply = (body: unknown) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === "/rest/system/status") return reply({ myID: pcDevice, startTime: this.startTime });
      if (url.pathname === "/rest/config/devices") return reply([{ deviceID: arrayDevice, name: "private-array", addresses: [] }]);
      if (url.pathname === "/rest/config/folders") return reply([{ id: "documents", label: "Documents", path: "/x", type: "sendreceive", paused: false, devices: [] }]);
      if (url.pathname !== "/rest/events") return reply(null);
      const since = Number(url.searchParams.get("since"));
      this.sinceSeen.push(since);
      const answer = () => this.events.filter((event) => event.id > since);
      if (answer().length) return reply(answer());
      let answered = false;
      const answerOnce = () => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        reply(answer());
      };
      const timer = setTimeout(answerOnce, 30);
      this.waiting.push(answerOnce);
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  emit(...events: { type: string; data: unknown }[]): void {
    for (const event of events) this.events.push({ id: this.events.length + 1, time: new Date(Date.now() + this.events.length).toISOString(), ...event });
    const waiting = this.waiting.splice(0);
    for (const wake of waiting) wake();
  }

  /** Starts again: new start time, IDs from 1, and the open long poll cut off. */
  restart(): void {
    this.events = [];
    this.startTime = "2026-10-21T09:00:00Z";
    this.waiting = [];
    this.server.closeAllConnections();
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}


const fakes: FakeSyncthing[] = [];
const feedSets: EventFeeds[] = [];

async function instance(nodeId: string, name: string): Promise<{ fake: FakeSyncthing; feed: FeedInstance }> {
  const fake = new FakeSyncthing();
  fakes.push(fake);
  const url = await fake.listen();
  return { fake, feed: { nodeId, name, client: new SyncthingClient({ url, apiKey: "key" }) } };
}

function feedsFor(log: ActivityLog): EventFeeds {
  const feeds = new EventFeeds(log, feedOptions);
  feedSets.push(feeds);
  return feeds;
}

function scanned(folder: string, to: string) {
  return { type: "StateChanged", data: { folder, from: "idle", to } };
}

function texts(log: ActivityLog, query = {}): string[] {
  return log.query(query).entries.map((entry) => entry.text);
}

after(async () => {
  for (const feeds of feedSets) feeds.stop();
  await Promise.all(fakes.map((fake) => fake.close()));
});

describe("event feeds", () => {
  it("events become entries in order", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    fake.emit(scanned("documents", "scanning"));
    await until(() => log.query({}).entries.length === 1, "the first batch");
    fake.emit(
      { type: "ItemFinished", data: { folder: "documents", item: "session.lock", error: "locked by another process", type: "file", action: "update" } },
      { type: "ItemFinished", data: { folder: "documents", item: "fine.txt", error: null, type: "file", action: "update" } },
    );
    await until(() => log.query({}).entries.length === 2, "the second batch");
    assert.deepEqual(texts(log), ["pc: Documents failed to sync session.lock (locked by another process)", "pc: Documents is scanning"]);
    const [failed] = log.query({}).entries;
    assert.equal(failed.source, "syncthing");
    assert.equal(failed.nodeId, "pc");
    assert.equal(failed.folderId, "documents");
    assert.equal(failed.type, "item-failed");
    assert.equal(failed.level, "warning");
  });

  it("an index update reaches the listener and stays out of Activity, and a restart is told", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    const heard: string[] = [];
    const feeds = new EventFeeds(log, feedOptions, { event: (nodeId, event) => heard.push(`${nodeId}:${event.type}`), restarted: (nodeId) => heard.push(`${nodeId}:restarted`) });
    feedSets.push(feeds);
    feeds.reconcile([feed]);
    fake.emit({ type: "LocalIndexUpdated", data: { folder: "documents", items: 1, filenames: ["a.sync-conflict-20261027-110000-TUH2R66.txt"], sequence: 9 } }, scanned("documents", "idle"));
    await until(() => heard.length === 2, "both events at the listener");
    assert.deepEqual(heard, ["pc:LocalIndexUpdated", "pc:StateChanged"]);
    await until(() => log.query({}).entries.length === 1, "the state change in Activity");
    assert.deepEqual(texts(log), ["pc: Documents is idle"]);
    fake.restart();
    fake.emit(scanned("documents", "scanning"));
    await until(() => heard.includes("pc:restarted"), "the restart at the listener");
    assert.equal(heard.filter((entry) => entry === "pc:restarted").length, 1, "the first start of a feed is no restart");
  });

  it("a restart resets since without losing new events", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    fake.emit(scanned("documents", "scanning"), scanned("documents", "idle"), scanned("documents", "syncing"));
    await until(() => log.query({}).entries.length === 3, "the events before the restart");
    fake.restart();
    fake.emit({ type: "DeviceConnected", data: { id: arrayDevice, addr: "tcp://10.0.0.2:22000" } }, { type: "FolderPaused", data: { id: "documents", label: "Documents" } });
    await until(() => log.query({}).entries.length === 5, "the events after the restart");
    assert.deepEqual(texts(log).slice(0, 2), ["pc: Documents paused", "pc: connected to private-array (tcp://10.0.0.2:22000)"]);
    assert.ok(fake.sinceSeen.includes(0) && fake.sinceSeen.lastIndexOf(0) > fake.sinceSeen.indexOf(3), "polled from 0 again after the restart");
  });

  it("filters by node and folder", async () => {
    const pc = await instance("pc", "pc");
    const array = await instance("5784", "private-array");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([pc.feed, array.feed]);
    pc.fake.emit(scanned("documents", "scanning"), scanned("music", "scanning"));
    array.fake.emit(scanned("documents", "syncing"));
    await until(() => log.query({}).entries.length === 3, "every event");
    assert.deepEqual(texts(log, { node: "pc" }).sort(), ["pc: Documents is scanning", "pc: music is scanning"]);
    assert.deepEqual(texts(log, { folder: "documents" }).sort(), ["pc: Documents is scanning", "private-array: Documents is syncing"]);
    assert.deepEqual(texts(log, { node: "5784", folder: "music" }), []);
    assert.deepEqual(texts(log, { types: ["state-changed"], source: "parity" }), []);
    assert.deepEqual(texts(log, { routine: false }), []);
  });

  it("a feed started again for the same instance does not enter its events twice", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    const feeds = feedsFor(log);
    feeds.reconcile([feed]);
    fake.emit(scanned("documents", "scanning"), scanned("documents", "idle"));
    await until(() => log.query({}).entries.length === 2, "the first events");
    feeds.reconcile([]);
    feeds.reconcile([feed]);
    fake.emit(scanned("documents", "syncing"));
    await until(() => log.query({}).entries.length >= 3, "the next event");
    const pollsAfter = (since: number) => fake.sinceSeen.filter((seen) => seen >= since).length;
    await until(() => pollsAfter(3) >= 3, "every running feed to have asked again after the next event");
    assert.deepEqual(texts(log), ["pc: Documents is syncing", "pc: Documents is idle", "pc: Documents is scanning"]);
  });

  it("failed items of one folder are capped, so device events stay", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(30);
    feedsFor(log).reconcile([feed]);
    fake.emit({ type: "DeviceConnected", data: { id: arrayDevice, addr: "tcp://10.0.0.2:22000" } });
    const failures = Array.from({ length: 25 }, (_, index) => ({ type: "ItemFinished", data: { folder: "documents", item: `file${index}`, error: "locked", type: "file", action: "update" } }));
    fake.emit(...failures);
    await until(() => texts(log).includes("pc: Documents failed to sync file24 (locked)"), "the last failure");
    const failed = texts(log, { types: ["item-failed"] });
    assert.equal(failed.length, failedItemsPerFolder);
    assert.ok(failed.includes("pc: Documents failed to sync file24 (locked)") && !failed.includes("pc: Documents failed to sync file4 (locked)"));
    assert.deepEqual(texts(log, { types: ["device-connected"] }), ["pc: connected to private-array (tcp://10.0.0.2:22000)"]);
  });

  it("the buffer keeps the newest entries", () => {
    const log = new ActivityLog(3);
    for (let index = 1; index <= 5; index++) {
      log.append("pc", { at: new Date(Date.UTC(2026, 9, 21, 8, index)).toISOString(), source: "syncthing", nodeId: "pc", folderId: null, type: "state-changed", level: "info", text: `event ${index}` });
    }
    assert.deepEqual(texts(log), ["event 5", "event 4", "event 3"]);
    assert.deepEqual(texts(log, { limit: 2 }), ["event 5", "event 4"]);
  });

  it("returns only what came after the cursor", () => {
    const log = new ActivityLog(10);
    const entry = { source: "dashboard" as const, nodeId: "pc", folderId: null, type: "dashboard-write", level: "info" as const };
    log.append("dashboard", { ...entry, at: "2026-10-21T08:00:00Z", text: "first" });
    const { cursor } = log.query({});
    log.append("dashboard", { ...entry, at: "2026-10-21T08:01:00Z", text: "second" });
    assert.deepEqual(texts(log, { after: cursor }), ["second"]);
    assert.deepEqual(texts(log, { after: "from-another-start-7" }), ["second", "first"]);
  });

  it("an instance that appears later gets a feed, and one that disappears loses it", async () => {
    const pc = await instance("pc", "pc");
    const array = await instance("5784", "private-array");
    const log = new ActivityLog(100);
    const feeds = feedsFor(log);
    feeds.reconcile([pc.feed]);
    feeds.reconcile([pc.feed, array.feed]);
    array.fake.emit(scanned("documents", "syncing"));
    await until(() => log.query({ node: "5784" }).entries.length === 1, "the late instance's event");
    feeds.reconcile([pc.feed]);
    assert.deepEqual(feeds.nodeIds(), ["pc"]);
  });

  it("scans and file changes do not push failures out of the buffer", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(2);
    feedsFor(log).reconcile([feed]);
    fake.emit({ type: "ItemFinished", data: { folder: "documents", item: "session.lock", error: "locked", type: "file", action: "update" } });
    fake.emit(scanned("documents", "scanning"), scanned("documents", "idle"), scanned("documents", "scanning"));
    await until(() => log.query({}).entries.length === 3, "the failure and the newest two scans");
    assert.deepEqual(texts(log, { types: ["item-failed"] }), ["pc: Documents failed to sync session.lock (locked)"]);
  });

  it("a failure Syncthing repeats on every pull is entered once", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    const failed = { type: "ItemFinished", data: { folder: "documents", item: "session.lock", error: "locked", type: "file", action: "update" } };
    fake.emit(failed, scanned("documents", "syncing"), failed, scanned("documents", "idle"));
    await until(() => log.query({}).entries.length === 3, "three entries");
    assert.deepEqual(texts(log, { types: ["item-failed"] }), ["pc: Documents failed to sync session.lock (locked)"]);
  });

  it("folder completion is kept only on reaching or leaving 100", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    const completion = (value: number) => ({ type: "FolderCompletion", data: { folder: "documents", device: arrayDevice, completion: value, needBytes: 0 } });
    fake.emit(completion(40), completion(70), completion(100), completion(100), completion(95));
    await until(() => log.query({}).entries.length === 2, "two completion entries");
    assert.deepEqual(texts(log), ["pc: private-array fell behind on Documents (95%)", "pc: Documents is complete on private-array"]);
  });
});

describe("parity watcher", () => {
  function sources(lines: string[], job: () => ParityJob | null) {
    return { arrays: async () => [{ id: "5784", name: "private-array" }], log: async () => lines, job: async () => job() };
  }

  it("parity log lines become job start and end entries", async () => {
    const lines = ["2026-10-21T00:44:08Z scheduler started: sync every 24 h", "2026-10-21T00:56:03Z sync started (0 deleted since the last one)", "2026-10-21T01:00:23Z sync done"];
    const log = new ActivityLog(100);
    const watcher = new ParityWatcher(log, sources(lines, () => null));
    await watcher.tick();
    await watcher.tick();
    const entries = log.query({}).entries;
    assert.deepEqual(entries.map((entry) => [entry.text, entry.type, entry.at]), [
      ["private-array: sync done", "parity-end", "2026-10-21T01:00:23.000Z"],
      ["private-array: sync started (0 deleted since the last one)", "parity-start", "2026-10-21T00:56:03.000Z"],
    ]);
    assert.ok(entries.every((entry) => entry.source === "parity" && entry.nodeId === "5784"));
  });

  it("a job the log does not mention gets one start and one end", async () => {
    const lines: string[] = [];
    let job: ParityJob | null = { kind: "scrub", progress: 10, startedAt: new Date(Date.now() - 3_600_000).toISOString() };
    const log = new ActivityLog(100);
    const watcher = new ParityWatcher(log, sources(lines, () => job));
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    job = null;
    await watcher.tick();
    await watcher.tick();
    assert.deepEqual(texts(log), ["private-array: scrub ended", "private-array: scrub running"]);
  });

  it("the previous job's logged end is not taken for the next job's end", async () => {
    const stamp = (milliseconds: number) => new Date(milliseconds).toISOString().replace(/\.\d+Z$/, "Z");
    const now = Date.now();
    const lines = [`${stamp(now - 90_000)} sync started (0 deleted since the last one)`, `${stamp(now - 60_000)} sync done`];
    let job: ParityJob | null = { kind: "scrub", progress: 0, startedAt: new Date(now - 30_000).toISOString() };
    const log = new ActivityLog(100);
    const watcher = new ParityWatcher(log, sources(lines, () => job));
    await watcher.tick();
    job = null;
    await watcher.tick();
    await watcher.tick();
    assert.deepEqual(texts(log).slice(0, 2), ["private-array: scrub ended", "private-array: scrub running"]);
  });

  it("a logged job is not entered twice from the job state", async () => {
    const lines: string[] = [];
    let job: ParityJob | null = { kind: "sync", progress: 0, startedAt: new Date().toISOString() };
    const log = new ActivityLog(100);
    const watcher = new ParityWatcher(log, sources(lines, () => job));
    await watcher.tick();
    lines.push(`${new Date().toISOString().replace(/\.\d+Z$/, "Z")} sync started (0 deleted since the last one)`);
    await watcher.tick();
    job = null;
    await watcher.tick();
    lines.push(`${new Date().toISOString().replace(/\.\d+Z$/, "Z")} sync FAILED, see the lines above`);
    await watcher.tick();
    await watcher.tick();
    const entries = log.query({}).entries;
    assert.deepEqual(entries.map((entry) => [entry.text, entry.level]), [
      ["private-array: sync FAILED, see the lines above", "error"],
      ["private-array: sync started (0 deleted since the last one)", "info"],
    ]);
  });
});
