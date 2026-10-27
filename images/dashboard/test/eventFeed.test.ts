import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { secretsClock } from "../src/nodeSecrets.js";
import { deflateRawSync, gzipSync } from "node:zlib";
import { type DebugFacilities, type NodeErrors, type NodeLog, type ParityJob, changeActivityTypes, listTimeoutMs } from "../src/api/types.js";
import { versionsReadLongestSeconds, versionsSlotWaitMs } from "../src/api/versioningText.js";
import { RequestError } from "../src/http.js";
import { type LocalInstance, type RemoteInstance, type ResolvedInstance, forwardedListTimeoutMs } from "../src/instanceResolver.js";
import { type WriteEffects, type WriteNote, errorAnswer, requestHandler } from "../src/routes.js";
import { shownUnscopedText } from "../src/shownSyncthingError.js";
import { logLevelOf, nodeLogRoutes } from "../src/routes/activity.js";
import { zipEntries } from "../src/supportBundle.js";
import { keptLogLines } from "../src/api/logLines.js";
import { ActivityLog, EventFeeds, type FeedInstance, ParityWatcher, failedItemsPerFolder } from "../src/eventFeed.js";
import { ConflictIndexes } from "../src/conflicts.js";
import { type BrowseEntry, type FolderStatus, SyncthingClient, type SyncthingEvent, type SyncthingFolderConfig, SyncthingRefusal } from "../src/syncthing.js";
import { until } from "./until.js";

const pcDevice = "PCAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const arrayDevice = "ARRAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const feedOptions = { waitSeconds: 1, requestTimeoutMs: 2000, retryMs: 20, bufferSize: 3, changesPerPoll: 4, changesPauseMs: 0 };

/**
 * A Syncthing that answers `/rest/events` and `/rest/events/disk` like the real one: only events after `since`, the newest `limit` of them,
 * or an empty list after a short wait; the two subscriptions number their events apart.
 */
class FakeSyncthing {
  private events: SyncthingEvent[] = [];
  private diskEvents: SyncthingEvent[] = [];
  private startTime = "2026-10-21T08:00:00Z";
  private waiting: (() => void)[] = [];
  readonly sinceSeen: number[] = [];
  readonly typesSeen: string[] = [];
  readonly diskQueries: { since: number; limit: number | null }[] = [];
  /** What `/rest/config` answers, or a 500 while `configFails`. */
  config: unknown = null;
  configFails = false;
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
      if (url.pathname === "/rest/config") {
        if (!this.configFails) return reply(this.config);
        response.writeHead(500);
        return response.end("config unreadable");
      }
      const isDisk = url.pathname === "/rest/events/disk";
      if (url.pathname !== "/rest/events" && !isDisk) return reply(null);
      const since = Number(url.searchParams.get("since"));
      const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : null;
      if (isDisk) this.diskQueries.push({ since, limit });
      else {
        this.sinceSeen.push(since);
        this.typesSeen.push(url.searchParams.get("events") ?? "");
      }
      const answer = () => {
        const after = (isDisk ? this.diskEvents : this.events).filter((event) => event.id > since);
        return limit ? after.slice(-limit) : after;
      };
      if (answer().length) return reply(answer());
      let answered = false;
      const answerOnce = () => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        this.waiting = this.waiting.filter((wake) => wake !== answerOnce);
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

  emitDisk(...events: { type: string; data: unknown }[]): void {
    for (const event of events) this.diskEvents.push({ id: this.diskEvents.length + 1, time: new Date(Date.now() + this.diskEvents.length).toISOString(), ...event });
    const waiting = this.waiting.splice(0);
    for (const wake of waiting) wake();
  }

  /** Cuts the open long poll off, as a network failure would, without a restart; waits for one to be open, so a poll always fails. */
  async dropOpenPoll(): Promise<void> {
    await until(() => this.waiting.length > 0, "a long poll to cut off");
    this.waiting = [];
    this.server.closeAllConnections();
  }

  /** Starts again: new start time, IDs from 1, and the open long poll cut off. */
  restart(): void {
    this.events = [];
    this.diskEvents = [];
    this.startTime = "2026-10-21T09:00:00Z";
    this.waiting = [];
    this.server.closeAllConnections();
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}


const eventFeedApiKey = "event-feed-api-key-0123456789";
const guiPasswordHash = "$2a$10$abcdefghijklmnopqrstuvO1234567890abcdefghijklmnopqrst";
const secretsUnreadText = "error hidden: the node's secrets could not be read";
const fakes: FakeSyncthing[] = [];
const feedSets: EventFeeds[] = [];

async function instance(nodeId: string, name: string): Promise<{ fake: FakeSyncthing; feed: FeedInstance }> {
  const fake = new FakeSyncthing();
  fakes.push(fake);
  const url = await fake.listen();
  return { fake, feed: { nodeId, name, client: new SyncthingClient({ url, apiKey: eventFeedApiKey }) } };
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
    const feeds = new EventFeeds(log, feedOptions, { event: (nodeId, event) => heard.push(`${nodeId}:${event.type}`), mayHaveMissed: (nodeId) => heard.push(`${nodeId}:restarted`) });
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

  it("a poll that fills syncthing's buffer, and one that failed and answers again, may have missed events", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    const missed: string[] = [];
    const feeds = new EventFeeds(log, feedOptions, { event: () => {}, mayHaveMissed: (nodeId) => missed.push(nodeId) });
    feedSets.push(feeds);
    feeds.reconcile([feed]);
    fake.emit(scanned("documents", "scanning"), scanned("documents", "idle"));
    await until(() => log.query({}).entries.length === 2, "two events");
    assert.deepEqual(missed, [], "fewer than the buffer holds");
    fake.emit(scanned("documents", "scanning"), scanned("documents", "idle"), scanned("documents", "syncing"));
    await until(() => missed.length === 1, "a full buffer told");
    await fake.dropOpenPoll();
    fake.emit(scanned("documents", "idle"));
    await until(() => missed.length === 2, "the failed poll told once it answers again");
  });

  it("a failed poll whose recovered batch moved the sequence does not start a running conflict sweep again", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const directory = await mkdtemp(join(tmpdir(), "feed-conflicts-"));
    let sequence = 40;
    const roots: string[] = [];
    let release = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const reader = {
      browse: async (_folderId: string, prefix: string): Promise<BrowseEntry[]> => {
        if (prefix === "") roots.push(prefix);
        await hold;
        return [];
      },
      file: async () => null,
      folderStatus: async (): Promise<FolderStatus> => ({ state: "idle", globalBytes: 0, needBytes: 0, sequence }),
      folders: async (): Promise<SyncthingFolderConfig[]> => [{ id: "documents", label: "Documents", path: "/x", type: "sendreceive", paused: false, devices: [] }],
    };
    const indexes = new ConflictIndexes({ directory, recheckMs: 0, browsePauseMs: 0, report: () => {} });
    const feeds = new EventFeeds(new ActivityLog(100), feedOptions, {
      event: (nodeId, event) => indexes.takeEvent(nodeId, event),
      mayHaveMissed: (nodeId, isRestart) => indexes.mayHaveMissedUpdates(nodeId, isRestart),
    });
    feedSets.push(feeds);
    try {
      await indexes.reconcile([{ nodeId: "pc", client: reader }]);
      await until(() => roots.length === 1, "the sweep to read the root");
      feeds.reconcile([feed]);
      fake.emit(scanned("documents", "idle"));
      await until(() => fake.sinceSeen.some((since) => since >= 1), "the feed to take the first event");
      await fake.dropOpenPoll();
      sequence = 41;
      fake.emit({ type: "LocalIndexUpdated", data: { folder: "documents", items: 1, filenames: ["a.txt"], sequence: 41 } });
      await until(() => fake.sinceSeen.some((since) => since >= 2), "the recovered poll");
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await indexes.idle();
      assert.deepEqual(roots, [""], "the batch brought the index to the folder's sequence, so the sweep went on");
      assert.equal(indexes.list("pc", "documents")?.complete, true);
    } finally {
      indexes.stop();
      await rm(directory, { recursive: true, force: true });
    }
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

  it("an event text carrying the node's api key reaches Activity with it replaced", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    fake.emit(
      { type: "ItemFinished", data: { folder: "documents", item: "a.txt", error: `rejected X-API-Key ${eventFeedApiKey}`, type: "file", action: "update" } },
      { type: "Failure", data: `request with ${eventFeedApiKey} failed` },
    );
    await until(() => log.query({}).entries.length === 2, "two entries");
    assert.ok(!JSON.stringify(log.query({})).includes(eventFeedApiKey));
    assert.deepEqual(texts(log), ["pc: failure: request with [redacted] failed", "pc: Documents failed to sync a.txt (rejected X-API-Key [redacted])"]);
  });

  it("an event error text past the length cut has a secret straddling the cut replaced whole", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    const straddling = `${"e".repeat(1990)}${eventFeedApiKey} and more`;
    fake.emit({ type: "ItemFinished", data: { folder: "documents", item: "a.txt", error: straddling, type: "file", action: "update" } }, { type: "Failure", data: straddling });
    await until(() => log.query({}).entries.length === 2, "two entries");
    for (const shown of texts(log)) {
      assert.ok(!shown.includes(eventFeedApiKey.slice(0, 10)), shown.slice(-40));
      assert.ok(shown.includes(`${"e".repeat(1990)}[redac`), shown.slice(-40));
    }
  });

  it("an event error carrying the GUI password hash is hidden while the node's configuration was never read", async () => {
    const { fake, feed } = await instance("pc", "pc");
    fake.configFails = true;
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    fake.emit(
      { type: "ItemFinished", data: { folder: "documents", item: "a.txt", error: `login with ${guiPasswordHash} refused`, type: "file", action: "update" } },
      { type: "Failure", data: `hash ${guiPasswordHash}` },
    );
    await until(() => log.query({}).entries.length === 2, "two entries");
    assert.ok(!JSON.stringify(log.query({})).includes(guiPasswordHash));
    assert.deepEqual(texts(log), [`pc: failure: ${secretsUnreadText}`, `pc: Documents failed to sync a.txt (${secretsUnreadText})`]);
  });

  it("an event error carrying the GUI password hash has it replaced by the secrets last read once the configuration cannot be read", async () => {
    const { fake, feed } = await instance("pc", "pc");
    fake.config = { gui: { apiKey: eventFeedApiKey, user: "finn", password: guiPasswordHash } };
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    fake.emit({ type: "ConfigSaved", data: {} });
    await until(() => log.query({}).entries.length === 1, "the entry read with the configuration");
    fake.configFails = true;
    const realNow = secretsClock.now;
    try {
      secretsClock.now = () => realNow() + 61_000;
      fake.emit({ type: "ItemFinished", data: { folder: "documents", item: "a.txt", error: `login with ${guiPasswordHash} refused`, type: "file", action: "update" } });
      await until(() => log.query({}).entries.length === 2, "the entry read after the configuration failed");
    } finally {
      secretsClock.now = realNow;
    }
    assert.ok(!JSON.stringify(log.query({})).includes(guiPasswordHash));
    assert.equal(texts(log)[0], "pc: Documents failed to sync a.txt (login with [redacted] refused)");
  });

  it("an event error that names an include or quotes a pattern reaches Activity hidden, any other as Syncthing wrote it", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    const leak = 'invalid pattern "apikey-from-config.xml" in ignore file';
    fake.emit(
      { type: "FolderErrors", data: { folder: "documents", errors: [{ path: "a.txt", error: "failed to load #include ../../config/config.xml" }] } },
      { type: "ItemFinished", data: { folder: "documents", item: "b.txt", error: leak, type: "file", action: "update" } },
      { type: "ItemFinished", data: { folder: "documents", item: "c.txt", error: "permission denied", type: "file", action: "update" } },
      { type: "StateChanged", data: { folder: "documents", from: "scanning", to: "error", error: "loading ignores: Include of secret.txt" } },
      { type: "DeviceDisconnected", data: { id: arrayDevice, error: leak } },
      { type: "Failure", data: leak },
    );
    await until(() => log.query({}).entries.length === 6, "six entries");
    const all = texts(log).join("\n");
    assert.ok(!all.includes("apikey-from-config") && !all.includes("config.xml") && !all.includes("secret.txt"), all);
    assert.deepEqual(texts(log, { types: ["folder-errors"] }), ["pc: Documents failed to sync 1 item, first a.txt (error hidden: it mentions an include)"]);
    assert.deepEqual(texts(log, { types: ["item-failed"] }), [
      "pc: Documents failed to sync c.txt (permission denied)",
      "pc: Documents failed to sync b.txt (error hidden: it quotes an ignore pattern; the folder's ignore patterns show it)",
    ]);
    assert.deepEqual(texts(log, { types: ["state-changed"] }), ["pc: Documents stopped: error hidden: it mentions an include"]);
    assert.deepEqual(texts(log, { types: ["device-disconnected", "failure"] }), [
      "pc: failure: error hidden: it quotes an ignore pattern; the folder's ignore patterns show it",
      "pc: lost private-array (error hidden: it quotes an ignore pattern; the folder's ignore patterns show it)",
    ]);
  });
});

describe("file changes", () => {
  const pcShort = pcDevice.slice(0, 7);
  const arrayShort = arrayDevice.slice(0, 7);
  const diskChange = (type: "LocalChangeDetected" | "RemoteChangeDetected", path: string, modifiedBy: string, folder = "documents", action = "modified", item = "file") => ({
    type,
    data: { action, folder, folderID: folder, label: folder === "documents" ? "Documents" : folder, modifiedBy, path, type: item },
  });
  const changes = (log: ActivityLog, query = {}) => log.query({ types: [...changeActivityTypes], ...query }).entries;

  it("disk events become change entries with path and device", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    fake.emitDisk(diskChange("LocalChangeDetected", "notes/today.txt", pcShort), diskChange("RemoteChangeDetected", "old", arrayShort, "documents", "deleted", "dir"));
    await until(() => changes(log).length === 2, "both changes");
    const [remote, local] = changes(log);
    assert.equal(local.type, "local-change");
    assert.equal(local.nodeId, "pc");
    assert.equal(local.folderId, "documents");
    assert.equal(local.source, "syncthing");
    assert.deepEqual(local.change, { path: "notes/today.txt", action: "modified", item: "file", device: "pc" });
    assert.equal(local.text, "pc: notes/today.txt modified here in Documents");
    assert.equal(remote.type, "remote-change");
    assert.deepEqual(remote.change, { path: "old", action: "deleted", item: "dir", device: "private-array" });
    assert.equal(remote.text, "pc: old deleted in Documents by private-array");
  });

  it("changes are read from syncthing's disk events with a cursor and a limit, never from the event poll", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    fake.emitDisk(diskChange("LocalChangeDetected", "a.txt", pcShort));
    await until(() => changes(log).length === 1, "the first change");
    fake.emitDisk(diskChange("LocalChangeDetected", "b.txt", pcShort));
    await until(() => changes(log).length === 2, "the second change");
    await until(() => fake.diskQueries.some((query) => query.since === 2), "a poll after the second change");
    assert.ok(fake.diskQueries.every((query) => query.limit === feedOptions.changesPerPoll), JSON.stringify(fake.diskQueries));
    assert.deepEqual(fake.diskQueries.map((query) => query.since).filter((since, index, all) => all.indexOf(since) === index), [0, 1, 2]);
    assert.ok(fake.typesSeen.length > 0 && fake.typesSeen.every((types) => !types.includes("ChangeDetected")), fake.typesSeen.join(" | "));
  });

  it("a burst of changes keeps the newest a poll may take", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    fake.emitDisk(...Array.from({ length: 10 }, (_, index) => diskChange("LocalChangeDetected", `file${index}`, pcShort)));
    feedsFor(log).reconcile([feed]);
    await until(() => changes(log).length > 0, "the burst");
    await until(() => fake.diskQueries.some((query) => query.since === 10), "a poll after the burst");
    assert.deepEqual(changes(log).map((entry) => entry.change?.path), ["file9", "file8", "file7", "file6"]);
  });

  it("a busy folder's changes do not push another folder's out", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(3);
    feedsFor(log).reconcile([feed]);
    fake.emitDisk(diskChange("LocalChangeDetected", "quiet.txt", pcShort, "dashboard-test-a"));
    await until(() => changes(log).length === 1, "the quiet folder's change");
    for (let batch = 0; batch < 3; batch++) {
      fake.emitDisk(...Array.from({ length: 4 }, (_, index) => diskChange("LocalChangeDetected", `busy${batch}-${index}`, pcShort)));
      await until(() => changes(log, { folder: "documents" }).some((entry) => entry.change?.path === `busy${batch}-3`), `busy batch ${batch}`);
    }
    assert.deepEqual(changes(log, { folder: "dashboard-test-a" }).map((entry) => entry.change?.path), ["quiet.txt"]);
    assert.equal(changes(log, { folder: "documents" }).length, 3);
  });

  it("a restart reads the disk events from the start again", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    fake.emitDisk(diskChange("LocalChangeDetected", "a.txt", pcShort), diskChange("LocalChangeDetected", "b.txt", pcShort));
    await until(() => changes(log).length === 2, "the changes before the restart");
    fake.restart();
    fake.emitDisk(diskChange("LocalChangeDetected", "after.txt", pcShort));
    await until(() => changes(log).length === 3, "the change after the restart");
    assert.equal(changes(log)[0].change?.path, "after.txt");
  });

  it("a restart whose new IDs run past the old cursor loses no change and enters none twice", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    fake.emitDisk(diskChange("LocalChangeDetected", "a.txt", pcShort), diskChange("LocalChangeDetected", "b.txt", pcShort));
    await until(() => changes(log).length === 2, "the changes before the restart");
    await until(() => fake.diskQueries.some((query) => query.since === 2), "a poll from the old cursor");
    const queriesBefore = fake.diskQueries.length;
    fake.restart();
    fake.emitDisk(...["c.txt", "d.txt", "e.txt"].map((path) => diskChange("LocalChangeDetected", path, pcShort)));
    await until(() => changes(log).length >= 5, "the changes after the restart");
    await until(() => fake.diskQueries.slice(queriesBefore).some((query) => query.since === 3), "a poll from the new run's cursor");
    assert.deepEqual(changes(log).map((entry) => entry.change?.path), ["e.txt", "d.txt", "c.txt", "b.txt", "a.txt"]);
    assert.equal(fake.diskQueries.slice(queriesBefore)[0].since, 0, "the first poll of the new run starts from 0, not from the old cursor 2");
  });

  it("a change's path or device carrying one of the node's secrets shows it replaced", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    fake.emitDisk(diskChange("RemoteChangeDetected", `keys/${eventFeedApiKey}.txt`, `${eventFeedApiKey}`));
    await until(() => changes(log).length === 1, "the change");
    assert.ok(!JSON.stringify(log.query({})).includes(eventFeedApiKey), JSON.stringify(log.query({})));
    assert.equal(changes(log)[0].change?.path, "keys/[redacted].txt");
  });

  it("a change's action or item carrying one of the node's secrets shows it replaced", async () => {
    const { fake, feed } = await instance("pc", "pc");
    const log = new ActivityLog(100);
    feedsFor(log).reconcile([feed]);
    fake.emitDisk(diskChange("RemoteChangeDetected", "a.txt", arrayShort, "documents", `${eventFeedApiKey}-action`, `${eventFeedApiKey}-item`));
    await until(() => changes(log).length === 1, "the change");
    assert.ok(!JSON.stringify(log.query({})).includes(eventFeedApiKey), JSON.stringify(log.query({})));
    assert.equal(changes(log)[0].change?.action, "[redacted]-action");
    assert.equal(changes(log)[0].change?.item, "[redacted]-item");
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

const crcTable = Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip archive as Go's `archive/zip` streams one: deflated files, their sizes only in a data descriptor and the central directory. */
function zipOf(files: Record<string, string>): Buffer {
  return zipOfBytes(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)])));
}

function zipOfBytes(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const packed = deflateRawSync(content);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(nameBytes.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc32(content), 4);
    descriptor.writeUInt32LE(packed.length, 8);
    descriptor.writeUInt32LE(content.length, 12);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0808, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(content), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, packed, descriptor);
    directory.push(entry, nameBytes);
    offset += local.length + nameBytes.length + packed.length + descriptor.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}

/** An instant in nanoseconds since the epoch, as precise as Syncthing writes it (`.9291837+02:00`). */
function nanosOf(when: string): bigint {
  const [, base, fraction = "", zone] = when.match(/^(.*?:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/) ?? [];
  return BigInt(Date.parse(`${base}${zone}`)) * 1_000_000n + BigInt(fraction.padEnd(9, "0").slice(0, 9) || "0");
}

const encryptionPassword = "fold<er>&pass";

/** A Syncthing 2.1.6 answering what the Log tab reads: its log, its errors, its log levels, its configuration and its support bundle. */
class FakeDiagnostics {
  readonly server: Server;
  readonly received: string[] = [];
  messages = [
    { when: "2026-10-27T10:00:00.5Z", level: "INF", message: "Ready to synchronize (folder.id=documents log.pkg=model)" },
    { when: "2026-10-27T10:00:01.25Z", level: "WRN", message: 'Failed to scan (path=iCloud/a.txt error="Access to the cloud file is denied" log.pkg=scanner)' },
    { when: "2026-10-27T10:00:02Z", level: "ERR", message: 'Loading ignores (error="invalid pattern \\"apikey-from-config.xml\\" in ignore file")' },
    { when: "2026-10-27T10:00:03Z", level: "DBG", message: "pulling (folder.id=documents)" },
  ];
  errors: { when: string; message: string }[] = [];
  levels: Record<string, string> = { model: "INFO", scanner: "DEBUG", db: "INFO" };
  bundle: Buffer = zipOf({});
  loseNextAnswer = false;
  supportReads = 0;
  /** `/rest/config` answers 500 while set. */
  configFails = false;
  /** An error Syncthing reports again right after a clear, as a recurring failure does. */
  errorsAfterClear: { when: string; message: string }[] = [];

  constructor(readonly apiKey: string) {
    this.server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://fake");
      let body = "";
      for await (const chunk of request) body += chunk;
      this.received.push(`${request.method} ${url.pathname}${url.search}${body ? ` ${body}` : ""}`);
      const reply = (answer: unknown, status = 200) => {
        if (this.loseNextAnswer && request.method === "POST") {
          this.loseNextAnswer = false;
          return request.socket.destroy();
        }
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(answer));
      };
      if (request.headers["x-api-key"] !== apiKey) return reply({ error: "forbidden" }, 403);
      if (url.pathname === "/rest/system/log") {
        const since = url.searchParams.get("since");
        return reply({ messages: this.messages.filter((message) => !since || nanosOf(message.when) > nanosOf(since)) });
      }
      if (url.pathname === "/rest/system/error" && request.method === "GET") return reply({ errors: this.errors.length ? this.errors : null });
      if (url.pathname === "/rest/system/error/clear" && request.method === "POST") {
        this.errors = [...this.errorsAfterClear];
        return reply(null);
      }
      if (url.pathname === "/rest/system/loglevels" && request.method === "GET") {
        return reply({ levels: this.levels, packages: { model: "The root hub", scanner: "File change detection and hashing", db: "SQLite database" } });
      }
      if (url.pathname === "/rest/system/loglevels" && request.method === "POST") {
        Object.assign(this.levels, JSON.parse(body) as Record<string, string>);
        return reply(null);
      }
      if (url.pathname === "/rest/config") {
        if (this.configFails) return reply({ error: "config unreadable" }, 500);
        return reply({ gui: { apiKey: this.apiKey, user: "finn", password: guiPasswordHash }, folders: [{ id: "documents", devices: [{ deviceID: arrayDevice, encryptionPassword }] }] });
      }
      if (url.pathname === "/rest/debug/support") {
        this.supportReads += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        response.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=support-bundle-PCAAAAA.zip" });
        return response.end(this.bundle);
      }
      reply({ error: "not faked" }, 404);
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  writes(): string[] {
    return this.received.filter((line) => line.startsWith("POST"));
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe("a node's log, errors, debug facilities and support bundle", () => {
  const diagnostics: FakeDiagnostics[] = [];
  const dashboards: Server[] = [];
  const notes: WriteNote[] = [];

  async function localNode(nodeId: string, name: string): Promise<{ fake: FakeDiagnostics; node: LocalInstance }> {
    const fake = new FakeDiagnostics(`${nodeId}-api-key-0123456789`);
    diagnostics.push(fake);
    const url = await fake.listen();
    return { fake, node: { kind: "local", nodeId, name, client: new SyncthingClient({ url, apiKey: fake.apiKey }), root: "/data", os: "linux", threshold: 0, source: "registry" } };
  }

  async function dashboardFor(nodes: ResolvedInstance[], maxBundleBytes?: number): Promise<string> {
    const resolve = async (nodeId: string) => nodes.find((node) => node.nodeId === nodeId) ?? Promise.reject(new RequestError(404, `no node ${nodeId}`));
    const effects: WriteEffects = { invalidate: () => {}, record: (note) => void notes.push(note) };
    const handle = requestHandler(nodeLogRoutes({ resolve, readBackDelaysMs: [5, 10, 20], maxBundleBytes }), effects);
    const server = createServer((request, response) => void handle(request, response));
    dashboards.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const post = (url: string, body?: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  after(async () => {
    for (const server of dashboards) {
      server.closeAllConnections();
      server.close();
    }
    await Promise.all(diagnostics.map((fake) => fake.close()));
  });

  it("log entries keep level and time", async () => {
    const { fake, node } = await localNode("fb98", "pc");
    const dashboard = await dashboardFor([node]);
    const log = (await (await fetch(`${dashboard}/api/nodes/fb98/log`)).json()) as NodeLog;
    assert.deepEqual(
      log.messages.map((message) => [message.when, message.level]),
      [
        ["2026-10-27T10:00:00.5Z", "info"],
        ["2026-10-27T10:00:01.25Z", "warning"],
        ["2026-10-27T10:00:02Z", "error"],
        ["2026-10-27T10:00:03Z", "debug"],
      ],
    );
    assert.equal(log.messages[1].message, fake.messages[1].message);
    assert.equal(log.messages[2].message, "error hidden: it quotes an ignore pattern; the folder's ignore patterns show it");
    const since = (await (await fetch(`${dashboard}/api/nodes/fb98/log?since=2026-10-27T10:00:01.5Z`)).json()) as NodeLog;
    assert.deepEqual(since.messages.map((message) => message.when), ["2026-10-27T10:00:02Z", "2026-10-27T10:00:03Z"]);
    assert.ok(fake.received.includes("GET /rest/system/log?since=2026-10-27T10%3A00%3A01.5Z"), fake.received.join("\n"));
    assert.equal((await fetch(`${dashboard}/api/nodes/fb98/log?since=yesterday`)).status, 400);
    assert.deepEqual([logLevelOf("WRN"), logLevelOf("ERROR"), logLevelOf(-4), logLevelOf(8), logLevelOf("odd")], ["warning", "error", "debug", "error", "info"]);
  });

  it("another host's node is read from its dashboard and shown through the redaction again", async () => {
    const answered: string[] = [];
    const other = createServer((request, response) => {
      answered.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.url?.startsWith("/api/nodes/c3d4/log")) return response.end(JSON.stringify({ messages: [{ when: "2026-10-27T10:00:00Z", level: "warning", message: "see #include x", extra: 1 }] }));
      if (request.url?.startsWith("/api/nodes/c3d4/errors")) return response.end(JSON.stringify({ errors: [{ when: "2026-10-27T10:00:00Z", message: 'invalid pattern "a" in ignore file' }] }));
      response.end(JSON.stringify({ facilities: [{ name: "model", description: "The root hub", debug: true }] }));
    });
    dashboards.push(other);
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const remote: RemoteInstance = { kind: "remote", nodeId: "c3d4", name: "laptop-data", host: "p53", dashboardUrl: `http://127.0.0.1:${(other.address() as AddressInfo).port}` };
    const dashboard = await dashboardFor([remote]);
    const log = (await (await fetch(`${dashboard}/api/nodes/c3d4/log?since=2026-10-27T09:00:00Z`)).json()) as NodeLog;
    assert.deepEqual(log.messages, [{ when: "2026-10-27T10:00:00Z", level: "warning", message: "error hidden: it mentions an include" }]);
    assert.ok(answered[0].includes("since=2026-10-27T09%3A00%3A00Z") && answered[0].includes("scope=local"), answered[0]);
    const errors = (await (await fetch(`${dashboard}/api/nodes/c3d4/errors`)).json()) as NodeErrors;
    assert.equal(errors.errors[0].message, "error hidden: it quotes an ignore pattern; the folder's ignore patterns show it");
    assert.deepEqual(((await (await fetch(`${dashboard}/api/nodes/c3d4/debug`)).json()) as DebugFacilities).facilities, [{ name: "model", description: "The root hub", debug: true }]);
    for (const write of [post(`${dashboard}/api/nodes/c3d4/errors/clear`), post(`${dashboard}/api/nodes/c3d4/debug`, { enable: ["model"], disable: [] })]) {
      const refused = await write;
      assert.equal(refused.status, 409);
      assert.deepEqual(await refused.json(), { error: "act on p53's dashboard" });
    }
    assert.equal((await fetch(`${dashboard}/api/nodes/c3d4/support-bundle`)).status, 409);
    assert.equal((await fetch(`${dashboard}/api/nodes/c3d4/log?scope=local`)).status, 404, "a forwarded read is never forwarded on");
    assert.equal(answered.length, 3);
  });

  it("clearing errors clears only that node", async () => {
    const pc = await localNode("fb98", "pc");
    const peer = await localNode("d7e5", "dashboard-test-peer");
    for (const { fake } of [pc, peer]) {
      fake.errors = [
        { when: "2026-10-27T10:00:00Z", message: "Listen (BEP/tcp): address in use" },
        { when: "2026-10-27T10:00:01Z", message: "failed to read #include .stglobalignore" },
      ];
    }
    const dashboard = await dashboardFor([pc.node, peer.node]);
    notes.length = 0;
    const shown = (await (await fetch(`${dashboard}/api/nodes/d7e5/errors`)).json()) as NodeErrors;
    assert.deepEqual(shown.errors.map((error) => error.message), ["Listen (BEP/tcp): address in use", "error hidden: it mentions an include"]);
    const cleared = await post(`${dashboard}/api/nodes/d7e5/errors/clear`);
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { errors: [] });
    assert.deepEqual(peer.fake.errors, []);
    assert.equal(pc.fake.errors.length, 2);
    assert.deepEqual(pc.fake.writes(), []);
    assert.deepEqual(notes.map((note) => [note.nodeId, note.text]), [["d7e5", "dashboard-test-peer: cleared 2 Syncthing errors"]]);
    assert.equal((await post(`${dashboard}/api/nodes/d7e5/errors/clear`)).status, 200);
    assert.equal(peer.fake.writes().length, 1, "with no errors left nothing is sent");
    assert.equal(notes.length, 1, "and nothing enters Activity");
  });

  it("a confirmed clear stays a clear when the node's secrets cannot be read: the errors left show hidden and Activity records it", async () => {
    const { fake, node } = await localNode("e1f2", "dashboard-test-peer");
    fake.configFails = true;
    fake.errors = [{ when: "2026-10-27T10:00:00Z", message: "Listen (BEP/tcp): address in use" }];
    fake.errorsAfterClear = [{ when: "2026-10-27T10:00:05Z", message: `password hash ${guiPasswordHash} rejected` }];
    const dashboard = await dashboardFor([node]);
    notes.length = 0;
    const cleared = await post(`${dashboard}/api/nodes/e1f2/errors/clear`);
    const body = await cleared.text();
    assert.equal(cleared.status, 200, body);
    assert.ok(!body.includes(guiPasswordHash), body);
    assert.deepEqual(JSON.parse(body), { errors: [{ when: "2026-10-27T10:00:05Z", message: secretsUnreadText }] });
    assert.deepEqual(notes.map((note) => [note.nodeId, note.text]), [["e1f2", "dashboard-test-peer: cleared 1 Syncthing error"]]);
  });

  it("a clear whose answer is lost is read back, and one that took effect enters Activity", async () => {
    const { fake, node } = await localNode("d7e5", "dashboard-test-peer");
    fake.errors = [{ when: "2026-10-27T10:00:00Z", message: "Listen (BEP/tcp): address in use" }];
    fake.loseNextAnswer = true;
    const dashboard = await dashboardFor([node]);
    notes.length = 0;
    assert.equal((await post(`${dashboard}/api/nodes/d7e5/errors/clear`)).status, 200);
    assert.deepEqual(notes.map((note) => note.text), ["dashboard-test-peer: cleared 1 Syncthing error"]);
  });

  it("debug facilities are turned on and off by name, and only what changes is sent", async () => {
    const { fake, node } = await localNode("d7e5", "dashboard-test-peer");
    const dashboard = await dashboardFor([node]);
    notes.length = 0;
    const read = (await (await fetch(`${dashboard}/api/nodes/d7e5/debug`)).json()) as DebugFacilities;
    assert.deepEqual(read.facilities, [
      { name: "db", description: "SQLite database", debug: false },
      { name: "model", description: "The root hub", debug: false },
      { name: "scanner", description: "File change detection and hashing", debug: true },
    ]);
    const changed = await post(`${dashboard}/api/nodes/d7e5/debug`, { enable: ["model", "scanner"], disable: ["db"] });
    assert.equal(changed.status, 200);
    assert.deepEqual(((await changed.json()) as DebugFacilities).facilities.filter((facility) => facility.debug).map((facility) => facility.name), ["model", "scanner"]);
    assert.deepEqual(fake.writes(), ['POST /rest/system/loglevels {"model":"DEBUG"}']);
    assert.deepEqual(notes.map((note) => note.text), ["dashboard-test-peer: turned on debug logging for model"]);
    assert.equal((await post(`${dashboard}/api/nodes/d7e5/debug`, { enable: [], disable: ["model", "scanner"] })).status, 200);
    assert.deepEqual(fake.levels, { model: "INFO", scanner: "INFO", db: "INFO" });
    assert.equal(notes.at(-1)?.text, "dashboard-test-peer: turned off debug logging for model, scanner");
    const writes = fake.writes().length;
    const refusals: [unknown, string][] = [
      [{ enable: ["nosuch"], disable: [] }, "dashboard-test-peer has no log facility nosuch"],
      [{ enable: ["model"], disable: ["model"] }, "model cannot be enabled and disabled at once"],
      [{ enable: [], disable: [] }, "name at least one facility to enable or disable"],
      [{ enable: "model" }, "enable and disable are lists of facility names"],
      [{ enable: ["model"], level: "TRACE" }, "level is not part of a debug change"],
    ];
    for (const [body, error] of refusals) {
      const refused = await post(`${dashboard}/api/nodes/d7e5/debug`, body);
      assert.equal(refused.status, 400);
      assert.deepEqual(await refused.json(), { error }, JSON.stringify(body));
    }
    assert.equal(fake.writes().length, writes);
    assert.equal((await post(`${dashboard}/api/nodes/d7e5/debug`, { enable: [], disable: ["model"] })).status, 200);
    assert.equal(fake.writes().length, writes, "a facility already off is not sent");
  });

  it("a since with more than millisecond digits is passed on as written, so the newest line is not read again", async () => {
    const { fake, node } = await localNode("fb98", "pc");
    fake.messages = [
      { when: "2026-10-27T14:33:12.9291837+02:00", level: "WRN", message: "Failed to scan (path=a.txt)" },
      { when: "2026-10-27T14:33:12.9297224+02:00", level: "WRN", message: "Failed to scan (path=b.txt)" },
    ];
    const dashboard = await dashboardFor([node]);
    const since = encodeURIComponent("2026-10-27T14:33:12.9291837+02:00");
    const log = (await (await fetch(`${dashboard}/api/nodes/fb98/log?since=${since}`)).json()) as NodeLog;
    assert.deepEqual(log.messages.map((message) => message.message), ["Failed to scan (path=b.txt)"]);
    assert.ok(fake.received.includes(`GET /rest/system/log?since=${since}`), fake.received.join("\n"));
    const newest = encodeURIComponent("2026-10-27T14:33:12.9297224+02:00");
    assert.deepEqual(((await (await fetch(`${dashboard}/api/nodes/fb98/log?since=${newest}`)).json()) as NodeLog).messages, []);
  });

  it("a log line or an error carrying one of the node's secrets shows it replaced", async () => {
    const { fake, node } = await localNode("d7e5", "dashboard-test-peer");
    fake.messages = [{ when: "2026-10-27T10:00:00Z", level: "INF", message: `GUI login with X-API-Key ${fake.apiKey} and folder password ${encryptionPassword}` }];
    fake.errors = [{ when: "2026-10-27T10:00:00Z", message: `password hash ${guiPasswordHash} rejected` }];
    const dashboard = await dashboardFor([node]);
    const log = (await (await fetch(`${dashboard}/api/nodes/d7e5/log`)).json()) as NodeLog;
    const errors = (await (await fetch(`${dashboard}/api/nodes/d7e5/errors`)).json()) as NodeErrors;
    const shown = JSON.stringify([log, errors]);
    for (const secret of [fake.apiKey, encryptionPassword, guiPasswordHash]) assert.ok(!shown.includes(secret), `${secret} in ${shown}`);
    assert.equal(log.messages[0].message, "GUI login with X-API-Key [redacted] and folder password [redacted]");
    assert.equal(errors.errors[0].message, "password hash [redacted] rejected");
  });

  it("a clear whose answer is lost counts as done once the errors it cleared are gone, even with a new one reported", async () => {
    const { fake, node } = await localNode("d7e5", "dashboard-test-peer");
    fake.errors = [{ when: "2026-10-27T10:00:00Z", message: "Listen (BEP/tcp): address in use" }];
    fake.errorsAfterClear = [{ when: "2026-10-27T10:00:05Z", message: "Listen (BEP/tcp): address in use again" }];
    fake.loseNextAnswer = true;
    const dashboard = await dashboardFor([node]);
    notes.length = 0;
    const cleared = await post(`${dashboard}/api/nodes/d7e5/errors/clear`);
    assert.equal(cleared.status, 200);
    assert.deepEqual(notes.map((note) => note.text), ["dashboard-test-peer: cleared 1 Syncthing error"]);
  });

  it("two downloads of a node's support bundle at once share one read", async () => {
    const { fake, node } = await localNode("d7e5", "dashboard-test-peer");
    fake.bundle = zipOf({ "metrics.txt": "x 1\n" });
    const dashboard = await dashboardFor([node]);
    const answers = await Promise.all([fetch(`${dashboard}/api/nodes/d7e5/support-bundle`), fetch(`${dashboard}/api/nodes/d7e5/support-bundle`)]);
    assert.deepEqual(answers.map((answer) => answer.status), [200, 200]);
    assert.equal(fake.supportReads, 1);
  });

  it("the support bundle carries no api key", async () => {
    const { fake, node } = await localNode("d7e5", "dashboard-test-peer");
    fake.bundle = zipOf({
      "config.json.txt": JSON.stringify({ gui: { apiKey: "REDACTED", user: "", password: "" }, folders: [{ devices: [{ encryptionPassword: "" }] }] }, null, 2),
      "log-inmemory.txt": "2026-10-27T12:33:38Z: Ready to synchronize (log.pkg=model)\n",
    });
    const dashboard = await dashboardFor([node]);
    const answer = await fetch(`${dashboard}/api/nodes/d7e5/support-bundle`);
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("content-type"), "application/zip");
    assert.match(answer.headers.get("content-disposition") ?? "", /^attachment; filename="support-bundle-dashboard-test-peer-\d{8}T\d{6}Z\.zip"$/);
    const files = zipEntries(Buffer.from(await answer.arrayBuffer()), 1 << 20);
    assert.deepEqual(files.map((file) => file.name), ["config.json.txt", "log-inmemory.txt"]);
    for (const file of files) {
      for (const secret of [fake.apiKey, guiPasswordHash, encryptionPassword]) assert.ok(!file.content.includes(secret), `${file.name} holds ${secret}`);
    }
  });

  it("a support bundle holding the api key, the gui password hash or an encryption password is refused, not streamed", async () => {
    const { fake, node } = await localNode("d7e5", "dashboard-test-peer");
    const dashboard = await dashboardFor([node]);
    const held: [string, string][] = [
      ["config.xml", `<apikey>${fake.apiKey}</apikey>`],
      ["config.json.txt", JSON.stringify({ gui: { password: guiPasswordHash } })],
      ["config.json.txt", JSON.stringify({ encryptionPassword }).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")],
    ];
    for (const [file, content] of held) {
      fake.bundle = zipOf({ "metrics.txt": "x 1\n", [file]: content });
      const refused = await fetch(`${dashboard}/api/nodes/d7e5/support-bundle`);
      assert.equal(refused.status, 501, content);
      assert.deepEqual(await refused.json(), { error: `the support bundle of dashboard-test-peer is not handed out: ${file} holds a password or the API key, or could not be searched` });
    }
    const profile = (content: string) => gzipSync(Buffer.from(content)).toString("latin1");
    for (const [content, why] of [
      [profile(`label ${fake.apiKey}`), "a gzipped profile is searched unpacked"],
      [profile("heap").slice(0, 12), "a gzipped file that does not unpack is not passed on unsearched"],
    ]) {
      fake.bundle = zipOfBytes({ "syncthing-heap.pprof": Buffer.from(content, "latin1") });
      assert.equal((await fetch(`${dashboard}/api/nodes/d7e5/support-bundle`)).status, 501, why);
    }
    fake.bundle = zipOfBytes({ "syncthing-heap.pprof": gzipSync(Buffer.from("no secret here")) });
    assert.equal((await fetch(`${dashboard}/api/nodes/d7e5/support-bundle`)).status, 200);
    const xmlEscaped = encryptionPassword.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    const refusedBundles: [Buffer, string][] = [
      [zipOf({ "config.xml": `<encryptionPassword>${xmlEscaped}</encryptionPassword>` }), "a secret escaped as XML is found"],
      [zipOfBytes({ "inner.zip": zipOf({ "config.json.txt": "{}" }) }), "a nested archive is not passed on unsearched"],
      [zipOfBytes({ "inner.pprof": gzipSync(gzipSync(Buffer.from("x"))) }), "a profile that unpacks to another archive is not passed on unsearched"],
      [zipOf({ [`names-${fake.apiKey}.txt`]: "x" }), "the whole archive is searched, its file names too"],
    ];
    for (const [bundle, why] of refusedBundles) {
      fake.bundle = bundle;
      assert.equal((await fetch(`${dashboard}/api/nodes/d7e5/support-bundle`)).status, 501, why);
    }
    fake.bundle = zipOf({ "a.txt": randomBytes(600).toString("hex"), "b.txt": randomBytes(600).toString("hex") });
    const overTotal = await fetch(`${await dashboardFor([node], 2000)}/api/nodes/d7e5/support-bundle`);
    assert.equal(overTotal.status, 501, "the files together unpack to more than the bound");
    fake.bundle = Buffer.from("not a zip archive at all, but long enough to be looked at");
    assert.equal((await fetch(`${dashboard}/api/nodes/d7e5/support-bundle`)).status, 501, "a bundle that cannot be read is not passed on unread");
    fake.bundle = zipOf({ "metrics.txt": randomBytes(4096).toString("hex") });
    const tooLarge = await fetch(`${await dashboardFor([node], 1024)}/api/nodes/d7e5/support-bundle`);
    assert.equal(tooLarge.status, 501);
    assert.match(((await tooLarge.json()) as { error: string }).error, /larger than/);
  });
});

describe("Syncthing's texts outside the event feed", () => {
  it("a refused request answers its status and Syncthing's text only through the redaction", async () => {
    const syncthing = createServer((_request, response) => {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end("failed to load #include ../../config/config.xml\n");
    });
    await new Promise<void>((resolve) => syncthing.listen(0, "127.0.0.1", resolve));
    try {
      const client = new SyncthingClient({ url: `http://127.0.0.1:${(syncthing.address() as AddressInfo).port}`, apiKey: "key" });
      const refusal = await client.request("GET", "/db/ignores?folder=documents").then(
        () => assert.fail("the request is refused"),
        (error: unknown) => error,
      );
      assert.ok(refusal instanceof SyncthingRefusal);
      assert.equal(refusal.status, 500);
      assert.equal(refusal.message, "GET /db/ignores?folder=documents: HTTP 500 error hidden: it mentions an include");
      assert.deepEqual(errorAnswer(refusal), { error: "Syncthing refused the request (HTTP 500): error hidden: it mentions an include" });
      assert.deepEqual(errorAnswer(new SyncthingRefusal("GET /x", 404, "")), { error: "Syncthing refused the request (HTTP 404)" });
    } finally {
      syncthing.close();
    }
  });

  it("a text without its folder's ignore file hides any mention of an include or a quoted pattern, and is cut when very long", () => {
    assert.equal(shownUnscopedText("open documents/a.txt: permission denied"), "open documents/a.txt: permission denied");
    assert.equal(shownUnscopedText("Include of x failed"), "error hidden: it mentions an include");
    assert.equal(shownUnscopedText("open src/include/x.h: permission denied"), "open src/include/x.h: permission denied", "a path with an include directory is no include");
    assert.equal(shownUnscopedText("failed to load include file ../x: file not found"), "error hidden: it mentions an include");
    assert.equal(shownUnscopedText("#include ../x"), "error hidden: it mentions an include");
    assert.equal(shownUnscopedText('parsing .stignore: line "secret"'), "error hidden: it quotes an ignore pattern; the folder's ignore patterns show it");
    assert.equal(shownUnscopedText("x".repeat(3000)).length, 2001);
  });

  it("a versions read waits for a slot and reads within what another host waits for it", () => {
    assert.ok(versionsSlotWaitMs + listTimeoutMs < forwardedListTimeoutMs, `${versionsSlotWaitMs} + ${listTimeoutMs} against ${forwardedListTimeoutMs}`);
    assert.equal(versionsReadLongestSeconds, (versionsSlotWaitMs + listTimeoutMs) / 1000);
  });
});

describe("log lines the Log tab keeps", () => {
  it("a line already kept is not added again, however precise its time", () => {
    const kept = [
      { when: "2026-10-27T14:33:12.9291837+02:00", level: "warning" as const, message: "a" },
      { when: "2026-10-27T14:33:12.9297224+02:00", level: "warning" as const, message: "b" },
    ];
    const answered = [kept[1], { when: "2026-10-27T14:33:12.9297224+02:00", level: "warning" as const, message: "c" }, { when: "2026-10-27T14:33:13.1+02:00", level: "info" as const, message: "d" }];
    assert.deepEqual(keptLogLines(kept, answered, 10).map((line) => line.message), ["a", "b", "c", "d"]);
    assert.deepEqual(keptLogLines(kept, answered, 2).map((line) => line.message), ["c", "d"]);
    assert.deepEqual(keptLogLines(null, kept, 10), kept);
  });
});
