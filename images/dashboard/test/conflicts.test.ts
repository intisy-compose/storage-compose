import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConflictsPage, NodeFolder, StorageNode } from "../src/api/types.js";
import { conflictWarnings } from "../src/attention.js";
import { type ConflictIndexOptions, type ConflictReader, ConflictIndexes, conflictFile, conflictNameOf, retryDelayMs } from "../src/conflicts.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, RemoteInstance, ResolvedInstance } from "../src/instanceResolver.js";
import { requestHandler } from "../src/routes.js";
import { itemRoutes } from "../src/routes/items.js";
import { type BrowseEntry, type FolderStatus, type IndexFile, SyncthingClient, type SyncthingEvent, type SyncthingFolderConfig } from "../src/syncthing.js";
import { warningHref } from "../ui/src/attentionPage.js";
import { until } from "./until.js";

const directory = "FILE_INFO_TYPE_DIRECTORY";
const fileType = "FILE_INFO_TYPE_FILE";
const pcId = "H3SXFPD-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA";
const laptopId = "TUH2R66-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB";

function dir(name: string): BrowseEntry {
  return { name, modTime: "2026-10-27T10:00:00+01:00", size: 128, type: directory };
}

function file(name: string, size = 10): BrowseEntry {
  return { name, modTime: "2026-10-27T10:00:00+01:00", size, type: fileType };
}

function indexFile(size: number, deleted = false): IndexFile {
  const entry = { name: "", type: fileType, size, modified: "2026-10-27T11:00:00+01:00", deleted, ignored: false, invalid: false };
  return { availability: null, global: entry, local: entry };
}

/** One Syncthing's folders as `/rest/db/browse` answers them, one directory at a time. */
class FakeReader implements ConflictReader {
  readonly asked: string[] = [];
  readonly fileAsked: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  readonly trees = new Map<string, Map<string, BrowseEntry[]>>();
  readonly files = new Map<string, IndexFile | null>();
  readonly sequences = new Map<string, number>();
  readonly paused = new Set<string>();
  /** Directories whose next read fails, once each. */
  readonly failOnce = new Set<string>();
  readonly startedAt: number[] = [];
  hold: Promise<void> | null = null;

  async browse(folderId: string, prefix: string, levels: number): Promise<BrowseEntry[]> {
    this.asked.push(`${folderId}:${prefix}:${levels}`);
    this.startedAt.push(Date.now());
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (this.hold) await this.hold;
      if (this.failOnce.delete(`${folderId}:${prefix}`)) throw new Error(`${prefix} timed out`);
      return this.trees.get(folderId)?.get(prefix) ?? [];
    } finally {
      this.inFlight -= 1;
    }
  }

  async file(folderId: string, path: string): Promise<IndexFile | null> {
    this.fileAsked.push(`${folderId}:${path}`);
    return this.files.get(`${folderId}:${path}`) ?? null;
  }

  async folderStatus(folderId: string): Promise<FolderStatus> {
    return { state: "idle", globalBytes: 0, needBytes: 0, sequence: this.sequences.get(folderId) ?? 0 };
  }

  async folders(): Promise<SyncthingFolderConfig[]> {
    return [...this.trees.keys()].map((id) => ({ id, label: id, path: `/data/${id}`, type: "sendreceive", paused: this.paused.has(id), devices: [] }));
  }
}

function indexUpdated(folder: string, sequence: number, filenames: string[]): SyncthingEvent {
  return { id: sequence, time: "2026-10-27T11:00:00Z", type: "LocalIndexUpdated", data: { folder, items: filenames.length, filenames, sequence, version: sequence } };
}

const scratch: string[] = [];
const indexSets: ConflictIndexes[] = [];

async function indexesIn(directoryPath?: string, options: Partial<ConflictIndexOptions> = {}): Promise<{ indexes: ConflictIndexes; path: string }> {
  const path = directoryPath ?? (await mkdtemp(join(tmpdir(), "conflicts-")));
  if (!directoryPath) scratch.push(path);
  const indexes = new ConflictIndexes({ directory: path, recheckMs: 0, sequenceWriteDelayMs: 5, browsePauseMs: 0, report: () => {}, ...options });
  indexSets.push(indexes);
  return { indexes, path };
}

after(async () => {
  for (const indexes of indexSets) indexes.stop();
  for (const path of scratch) await rm(path, { recursive: true, force: true });
});

describe("conflict names", () => {
  it("conflict names are parsed with their original and device", () => {
    assert.deepEqual(conflictNameOf("Black Desert/GameOption.sync-conflict-20260606-110111-H3SXFPD.txt"), { original: "Black Desert/GameOption.txt", shortDeviceId: "H3SXFPD" });
    assert.deepEqual(conflictNameOf("Makefile.sync-conflict-20260606-110111-TUH2R66"), { original: "Makefile", shortDeviceId: "TUH2R66" });
    assert.deepEqual(conflictNameOf("home/.bashrc.sync-conflict-20260606-110111-TUH2R66"), { original: "home/.bashrc", shortDeviceId: "TUH2R66" });
    assert.deepEqual(conflictNameOf(".sync-conflict-20260606-110111-TUH2R66.bashrc"), { original: ".bashrc", shortDeviceId: "TUH2R66" });
    assert.deepEqual(conflictNameOf("a.sync-conflict-20260606-110111-TUH2R66.tar.gz"), { original: "a.tar.gz", shortDeviceId: "TUH2R66" });
    assert.equal(conflictNameOf("notes.txt"), null);
    assert.equal(conflictNameOf("notes.sync-conflict-2026-bad.txt"), null);
    assert.equal(conflictNameOf("notes.sync-conflict-20260606-110111-TUH2R66x"), null, "after the device ID only an extension may follow");
    assert.equal(conflictNameOf("dir.sync-conflict-20260606-110111-TUH2R66/inside.txt"), null, "only the last segment names a conflict copy");
    const devices = [{ deviceID: pcId, name: "pc" }, { deviceID: laptopId, name: "" }];
    assert.deepEqual(conflictFile({ path: "a/b.sync-conflict-20260606-110111-H3SXFPD.txt", size: 5, modified: "2026-06-06T11:01:11Z" }, devices), {
      path: "a/b.sync-conflict-20260606-110111-H3SXFPD.txt",
      original: "a/b.txt",
      size: 5,
      modified: "2026-06-06T11:01:11Z",
      device: "pc",
    });
    assert.equal(conflictFile({ path: "b.sync-conflict-20260606-110111-ZZZZZZZ.txt", size: 5, modified: "" }, devices).device, "ZZZZZZZ", "a device the node does not know is named by its short ID");
  });
});

describe("conflict index", () => {
  function documentsTree(reader: FakeReader): void {
    reader.trees.set(
      "documents",
      new Map([
        ["", [dir("big"), dir("small"), file("top.sync-conflict-20260606-110111-H3SXFPD.txt", 3), file("top.txt")]],
        ["big", [dir("deep"), file("a.txt")]],
        ["big/deep", [file("save.sync-conflict-20260606-110249-TUH2R66.bmp", 7)]],
        ["small", [file("b.txt")]],
      ]),
    );
    reader.trees.set("music", new Map([["", [file("song.mp3")]]]));
    reader.sequences.set("documents", 40);
    reader.sequences.set("music", 3);
  }

  it("the sweep lists one directory per call, one call at a time on the instance", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    const { indexes, path } = await indexesIn();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    assert.deepEqual(
      reader.asked.filter((entry) => entry.startsWith("documents:")),
      ["documents::0", "documents:big:0", "documents:small:0", "documents:big/deep:0"],
      "each directory is listed on its own, one level deep, never a whole tree with levels -1",
    );
    assert.ok(reader.asked.every((entry) => entry.endsWith(":0")));
    assert.equal(reader.maxInFlight, 1, "one directory at a time, and one folder's sweep at a time on the instance");
    assert.deepEqual(indexes.list("fb98", "documents"), {
      complete: true,
      more: false,
      conflicts: [
        { path: "big/deep/save.sync-conflict-20260606-110249-TUH2R66.bmp", size: 7, modified: "2026-10-27T10:00:00+01:00" },
        { path: "top.sync-conflict-20260606-110111-H3SXFPD.txt", size: 3, modified: "2026-10-27T10:00:00+01:00" },
      ],
    });
    assert.equal(indexes.count("fb98", "documents"), 2);
    assert.equal(indexes.count("fb98", "music"), 0);
    const stored = JSON.parse(await readFile(join(path, "fb98-documents.json"), "utf8")) as { sequence: number; conflicts: unknown[] };
    assert.equal(stored.sequence, 40);
    assert.equal(stored.conflicts.length, 2);
  });

  it("a folder not swept yet has no count, and a paused folder is not swept", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    reader.paused.add("music");
    let release = () => {};
    reader.hold = new Promise((resolve) => (release = resolve));
    const { indexes } = await indexesIn();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    assert.equal(indexes.count("fb98", "documents"), null);
    assert.deepEqual(indexes.list("fb98", "documents"), { complete: false, more: false, conflicts: [] });
    release();
    await indexes.idle();
    assert.equal(indexes.count("fb98", "documents"), 2);
    assert.ok(!reader.asked.some((entry) => entry.startsWith("music:")));
    assert.equal(indexes.list("fb98", "music"), null);
  });

  it("an index update adds and removes conflicts", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    const { indexes } = await indexesIn();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    const added = "big/new.sync-conflict-20261027-110000-TUH2R66.txt";
    reader.files.set(`documents:${added}`, indexFile(12));
    indexes.takeEvent("fb98", indexUpdated("documents", 42, [added, "big/plain.txt"]));
    await indexes.idle();
    assert.deepEqual(reader.fileAsked, [`documents:${added}`], "only a conflict copy's name is looked up");
    assert.deepEqual(indexes.list("fb98", "documents")?.conflicts.find((entry) => entry.path === added), { path: added, size: 12, modified: "2026-10-27T11:00:00+01:00" });
    assert.equal(indexes.count("fb98", "documents"), 3);
    reader.files.set(`documents:${added}`, indexFile(12, true));
    indexes.takeEvent("fb98", indexUpdated("documents", 43, [added]));
    const removed = "top.sync-conflict-20260606-110111-H3SXFPD.txt";
    indexes.takeEvent("fb98", indexUpdated("documents", 44, [removed]));
    await indexes.idle();
    assert.equal(indexes.count("fb98", "documents"), 1, "a deleted copy and one gone from the index are both removed");
    const windowsName = String.raw`big\deep\w.sync-conflict-20261027-110000-H3SXFPD.txt`;
    reader.files.set(`documents:${windowsName}`, indexFile(1));
    indexes.takeEvent("fb98", indexUpdated("documents", 45, [windowsName]));
    await indexes.idle();
    assert.ok(indexes.list("fb98", "documents")?.conflicts.some((entry) => entry.path === "big/deep/w.sync-conflict-20261027-110000-H3SXFPD.txt"), "a Windows name is looked up as given and listed with /");
    const sweptBefore = reader.asked.length;
    indexes.takeEvent("fb98", indexUpdated("documents", 30, [added]));
    await indexes.idle();
    assert.equal(reader.asked.length, sweptBefore, "an event replayed from before the index is ignored");
  });

  it("a sequence that jumps by more than its items is no reason to sweep again, a restart of the instance is where the folder moved", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    const { indexes } = await indexesIn();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    const documentsReads = () => reader.asked.filter((entry) => entry.startsWith("documents:")).length;
    const musicReads = () => reader.asked.filter((entry) => entry.startsWith("music:")).length;
    const sweptBefore = documentsReads();
    reader.sequences.set("documents", 43);
    indexes.takeEvent("fb98", indexUpdated("documents", 43, ["x.txt"]));
    await indexes.idle();
    assert.equal(documentsReads(), sweptBefore, "Syncthing 2.1.6 moved the sequence from 10 to 13 for one pulled item");
    reader.sequences.set("documents", 50);
    indexes.mayHaveMissedUpdates("fb98");
    await indexes.idle();
    assert.equal(documentsReads(), sweptBefore * 2, "documents moved past the index while the restart hid its updates");
    assert.equal(musicReads(), 1, "music did not move, so it is not read again");
  });

  it("an index stored at the folder's sequence is kept, and a stale one is swept again", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    const { indexes, path } = await indexesIn();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    indexes.stop();
    reader.asked.length = 0;
    const { indexes: restarted } = await indexesIn(path);
    await restarted.reconcile([{ nodeId: "fb98", client: reader }]);
    await restarted.idle();
    assert.equal(reader.asked.length, 0, "nothing changed since the index was stored");
    assert.equal(restarted.count("fb98", "documents"), 2);
    restarted.stop();
    reader.sequences.set("documents", 41);
    const { indexes: again } = await indexesIn(path);
    await again.reconcile([{ nodeId: "fb98", client: reader }]);
    assert.equal(again.count("fb98", "documents"), 2, "the stored copies are shown while the folder is read again");
    await again.idle();
    assert.equal(reader.asked.filter((entry) => entry.startsWith("documents:")).length, 4);
  });

  it("an index that is not complete is never stored, so a stale one is swept again after a restart", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    const { indexes, path } = await indexesIn();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    indexes.stop();
    reader.sequences.set("documents", 41);
    let release = () => {};
    reader.hold = new Promise((resolve) => (release = resolve));
    const { indexes: stale } = await indexesIn(path);
    await stale.reconcile([{ nodeId: "fb98", client: reader }]);
    await until(() => reader.inFlight === 1, "the new sweep to start");
    reader.sequences.set("documents", 42);
    stale.takeEvent("fb98", indexUpdated("documents", 42, ["x.txt"]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    stale.stop();
    release();
    reader.hold = null;
    const stored = JSON.parse(await readFile(join(path, "fb98-documents.json"), "utf8")) as { sequence: number };
    assert.equal(stored.sequence, 40, "the index under a sweep is not written with the update's sequence");
    reader.asked.length = 0;
    const { indexes: restarted } = await indexesIn(path);
    await restarted.reconcile([{ nodeId: "fb98", client: reader }]);
    await restarted.idle();
    assert.equal(reader.asked.filter((entry) => entry.startsWith("documents:")).length, 4, "still stale, so swept again");
  });

  it("a failed sweep waits, doubling, and goes on from the directories still to read", async () => {
    assert.deepEqual([1, 2, 3, 4, 10].map((failures) => retryDelayMs(failures, 300_000, 21_600_000)), [300_000, 600_000, 1_200_000, 2_400_000, 21_600_000]);
    const reader = new FakeReader();
    documentsTree(reader);
    reader.failOnce.add("documents:big");
    const { indexes } = await indexesIn(undefined, { retryFirstMs: 150, retryMaxMs: 1000 });
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    assert.deepEqual(reader.asked.filter((entry) => entry.startsWith("documents:")), ["documents::0", "documents:big:0"]);
    assert.equal(indexes.list("fb98", "documents")?.complete, false);
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    assert.equal(reader.asked.filter((entry) => entry.startsWith("documents:")).length, 2, "no new try before the wait is over");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    assert.deepEqual(reader.asked.filter((entry) => entry.startsWith("documents:")), ["documents::0", "documents:big:0", "documents:big:0", "documents:small:0", "documents:big/deep:0"], "the root is not read again");
    assert.equal(indexes.count("fb98", "documents"), 2);
    assert.equal(indexes.list("fb98", "documents")?.complete, true);
  });

  it("a folder in backoff stays in backoff across a failed poll", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    reader.failOnce.add("documents:big");
    const { indexes } = await indexesIn(undefined, { retryFirstMs: 60_000, retryMaxMs: 600_000 });
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    const readsBefore = reader.asked.filter((entry) => entry.startsWith("documents:")).length;
    indexes.mayHaveMissedUpdates("fb98");
    await indexes.idle();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    assert.equal(reader.asked.filter((entry) => entry.startsWith("documents:")).length, readsBefore, "the wait after the failure still holds");
    assert.equal(indexes.list("fb98", "documents")?.complete, false);
  });

  it("a restart of the instance ends the wait after a failed sweep", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    reader.failOnce.add("documents:big");
    const { indexes } = await indexesIn(undefined, { retryFirstMs: 60_000, retryMaxMs: 600_000 });
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    indexes.mayHaveMissedUpdates("fb98", true);
    await indexes.idle();
    assert.equal(indexes.list("fb98", "documents")?.complete, true);
    assert.equal(reader.asked.filter((entry) => entry === "documents::0").length, 1, "and the sweep goes on from where it failed");
  });

  it("a running sweep whose folder kept its sequence keeps its remaining directories across a failed poll", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    reader.trees.delete("music");
    let release = () => {};
    reader.hold = new Promise((resolve) => (release = resolve));
    const { indexes } = await indexesIn();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await until(() => reader.inFlight === 1, "the sweep to read the root");
    indexes.mayHaveMissedUpdates("fb98");
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    reader.hold = null;
    await indexes.idle();
    assert.deepEqual(reader.asked, ["documents::0", "documents:big:0", "documents:small:0", "documents:big/deep:0"], "the root is read once");
    assert.equal(indexes.count("fb98", "documents"), 2);
  });

  it("a node missing from one reconcile only is kept, missing from two it is deleted", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    const { indexes, path } = await indexesIn();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    await indexes.reconcile([], new Set(["5784"]));
    await indexes.idle();
    assert.deepEqual((await readdir(path)).sort(), ["fb98-documents.json", "fb98-music.json"], "one read without pc (a heartbeat that failed to read) deletes nothing");
    assert.equal(indexes.count("fb98", "documents"), 2);
    await indexes.reconcile([{ nodeId: "fb98", client: reader }], new Set(["fb98"]));
    await indexes.reconcile([], new Set(["5784"]));
    await indexes.idle();
    assert.equal((await readdir(path)).length, 2, "seen again in between, so the count starts over");
    await indexes.reconcile([], new Set(["5784"]));
    await indexes.idle();
    assert.deepEqual(await readdir(path), []);
  });

  it("a node known only from its stored files is deleted after two file scans that did not keep it", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    let clock = 1_000_000;
    const { indexes, path } = await indexesIn(undefined, { recheckMs: 150, now: () => clock });
    await writeFile(join(path, "zz99-old.json"), JSON.stringify({ nodeId: "zz99", folderId: "old", sequence: 1, sweptAt: "", conflicts: [] }));
    const round = async () => {
      await indexes.reconcile([{ nodeId: "fb98", client: reader }], new Set(["fb98"]));
      await indexes.idle();
      clock += 10;
    };
    for (let count = 0; count < 15; count += 1) await round();
    assert.ok((await readdir(path)).includes("zz99-old.json"), "one file scan and 14 rounds without one");
    await round();
    assert.ok(!(await readdir(path)).includes("zz99-old.json"), "rounds that did not read the files do not start its count over");
    assert.ok((await readdir(path)).includes("fb98-documents.json"));
  });

  it("a sequence that moves while a sweep runs starts it again from the root", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    reader.trees.delete("music");
    let release = () => {};
    reader.hold = new Promise((resolve) => (release = resolve));
    const { indexes } = await indexesIn();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await until(() => reader.inFlight === 1, "the sweep to read the root");
    reader.sequences.set("documents", 45);
    indexes.mayHaveMissedUpdates("fb98");
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    reader.hold = null;
    await indexes.idle();
    assert.equal(reader.asked.filter((entry) => entry === "documents::0").length, 2);
    assert.equal(indexes.list("fb98", "documents")?.complete, true);
  });

  it("a sequence that moves while a folder waits after a failure starts its sweep again but keeps the wait", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    reader.failOnce.add("documents:big");
    const { indexes } = await indexesIn(undefined, { retryFirstMs: 60_000, retryMaxMs: 600_000 });
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    const readsBefore = reader.asked.filter((entry) => entry.startsWith("documents:")).length;
    reader.sequences.set("documents", 45);
    indexes.mayHaveMissedUpdates("fb98");
    await indexes.idle();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    assert.equal(reader.asked.filter((entry) => entry.startsWith("documents:")).length, readsBefore, "still waiting");
    indexes.mayHaveMissedUpdates("fb98", true);
    await indexes.idle();
    assert.equal(reader.asked.filter((entry) => entry === "documents::0").length, 2, "the restart ends the wait, and the moved folder is read from the root");
  });

  it("a folder brought back under the cap by an update no longer says there are more, and is searched for the copies left out", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    reader.trees.get("documents")!.set("small", [file("b.txt"), file("b.sync-conflict-20260606-110111-H3SXFPD.txt", 4)]);
    const { indexes } = await indexesIn(undefined, { maxConflicts: 2 });
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    assert.equal(indexes.count("fb98", "documents"), 2);
    assert.equal(indexes.hasMore("fb98", "documents"), true);
    const kept = indexes.list("fb98", "documents")!.conflicts[0].path;
    const directory = kept.includes("/") ? kept.slice(0, kept.lastIndexOf("/")) : "";
    const tree = reader.trees.get("documents")!;
    tree.set(directory, tree.get(directory)!.filter((entry) => !kept.endsWith(entry.name)));
    reader.files.set(`documents:${kept}`, indexFile(1, true));
    reader.sequences.set("documents", 41);
    indexes.takeEvent("fb98", indexUpdated("documents", 41, [kept]));
    await indexes.idle();
    assert.equal(indexes.hasMore("fb98", "documents"), false);
    assert.equal(indexes.count("fb98", "documents"), 2, "the copy left out before is found");
  });

  it("the sweep pauses between two directory reads", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    reader.trees.delete("music");
    const { indexes } = await indexesIn(undefined, { browsePauseMs: 40 });
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    const gaps = reader.startedAt.slice(1).map((time, index) => time - reader.startedAt[index]);
    assert.equal(gaps.length, 3);
    assert.ok(gaps.every((gap) => gap >= 38), `gaps ${gaps.join(", ")} ms`);
  });

  it("the periodic check sweeps a folder whose sequence moved and leaves the others", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    const { indexes } = await indexesIn(undefined, { verifyEveryMs: 0 });
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    reader.asked.length = 0;
    reader.sequences.set("documents", 45);
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    assert.equal(reader.asked.filter((entry) => entry.startsWith("documents:")).length, 4);
    assert.equal(reader.asked.filter((entry) => entry.startsWith("music:")).length, 0);
    const { indexes: daily } = await indexesIn(undefined, { verifyEveryMs: 86_400_000 });
    await daily.reconcile([{ nodeId: "fb98", client: reader }]);
    await daily.idle();
    reader.asked.length = 0;
    reader.sequences.set("documents", 46);
    await daily.reconcile([{ nodeId: "fb98", client: reader }]);
    await daily.idle();
    assert.equal(reader.asked.length, 0, "a day has not passed");
  });

  it("at most the set number of copies is kept, and the folder says there are more", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    const { indexes, path } = await indexesIn(undefined, { maxConflicts: 1 });
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    assert.equal(indexes.count("fb98", "documents"), 1);
    assert.equal(indexes.hasMore("fb98", "documents"), true);
    assert.equal(indexes.list("fb98", "documents")?.more, true);
    const stored = JSON.parse(await readFile(join(path, "fb98-documents.json"), "utf8")) as { more: boolean; conflicts: unknown[] };
    assert.equal(stored.conflicts.length, 1);
    assert.equal(stored.more, true);
  });

  it("the indexes of a node the host no longer keeps are deleted, those of a detached node are kept", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    const { indexes, path } = await indexesIn();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    await writeFile(join(path, "zz99-old.json"), JSON.stringify({ nodeId: "zz99", folderId: "old", sequence: 1, sweptAt: "", conflicts: [] }));
    await indexes.reconcile([], new Set(["fb98", "5784"]));
    await indexes.reconcile([], new Set(["fb98", "5784"]));
    await indexes.idle();
    assert.deepEqual((await readdir(path)).sort(), ["fb98-documents.json", "fb98-music.json"], "fb98 is detached but kept; zz99 is gone");
    assert.equal(indexes.count("fb98", "documents"), 2);
    await indexes.reconcile([], new Set(["5784"]));
    await indexes.reconcile([], new Set(["5784"]));
    await indexes.idle();
    assert.deepEqual(await readdir(path), []);
    assert.equal(indexes.list("fb98", "documents"), null);
  });

  it("an update naming a directory adds nothing, and one naming fewer items than it counts is checked by sequence", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    const { indexes } = await indexesIn();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    const folderName = "odd.sync-conflict-20261027-110000-TUH2R66";
    reader.files.set(`documents:${folderName}`, { ...indexFile(0), global: { ...indexFile(0).global, type: directory } });
    reader.sequences.set("documents", 41);
    indexes.takeEvent("fb98", indexUpdated("documents", 41, [folderName]));
    await indexes.idle();
    assert.equal(indexes.count("fb98", "documents"), 2);
    reader.asked.length = 0;
    reader.sequences.set("documents", 43);
    indexes.takeEvent("fb98", { id: 43, time: "", type: "LocalIndexUpdated", data: { folder: "documents", items: 2, filenames: ["a.txt"], sequence: 43 } });
    await indexes.idle();
    assert.equal(reader.asked.length, 0, "the folder is at the update's sequence, so nothing was missed");
    reader.sequences.set("documents", 50);
    indexes.takeEvent("fb98", { id: 44, time: "", type: "LocalIndexUpdated", data: { folder: "documents", items: 2, filenames: ["a.txt"], sequence: 44 } });
    await indexes.idle();
    assert.equal(reader.asked.filter((entry) => entry.startsWith("documents:")).length, 4, "the folder moved on past the short update, so it is read again");
  });

  it("a copy changed while the sweep runs is taken from the event, and a folder removed from the config is forgotten", async () => {
    const reader = new FakeReader();
    documentsTree(reader);
    let release = () => {};
    reader.hold = new Promise((resolve) => (release = resolve));
    const { indexes, path } = await indexesIn();
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await until(() => reader.inFlight === 1, "the sweep to start");
    const late = "small/late.sync-conflict-20261027-110000-TUH2R66.txt";
    reader.files.set(`documents:${late}`, indexFile(4));
    indexes.takeEvent("fb98", indexUpdated("documents", 41, [late]));
    await until(() => reader.fileAsked.length === 1, "the lookup of the new copy");
    release();
    await indexes.idle();
    assert.equal(indexes.count("fb98", "documents"), 3);
    reader.trees.delete("documents");
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
    assert.equal(indexes.list("fb98", "documents"), null);
    await assert.rejects(readFile(join(path, "fb98-documents.json"), "utf8"));
  });
});

describe("conflicts on Attention", () => {
  function folder(overrides: Partial<NodeFolder>): NodeFolder {
    return {
      id: "documents",
      label: "Documents",
      path: "/x",
      type: "sendreceive",
      state: "idle",
      completion: 100,
      errors: 0,
      needItems: 0,
      needTotalItems: 0,
      needBytes: 0,
      globalBytes: 0,
      globalFiles: 0,
      globalDirectories: 0,
      lastScan: null,
      lastFile: null,
      localChanged: 0,
      conflicts: null,
      sharedWith: [],
      ...overrides,
    };
  }

  it("a folder with conflicts raises a warning that opens its list", () => {
    const node = { id: "fb98", name: "pc", folders: [folder({ conflicts: 3 }), folder({ id: "music", conflicts: 0 }), folder({ id: "pictures", conflicts: null })] } as unknown as StorageNode;
    const warnings = conflictWarnings(node);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].id, "conflicts:fb98:documents");
    assert.equal(warnings[0].kind, "conflicts");
    assert.equal(warnings[0].level, "warning");
    assert.equal(warnings[0].folderId, "documents");
    assert.equal(warnings[0].text, "Documents on pc: 3 sync conflicts");
    assert.equal(warningHref(warnings[0]), "#/folders/documents?node=all&path=&conflicts=fb98");
    const capped = conflictWarnings({ ...node, folders: [folder({ conflicts: 1000, conflictsMore: true })] } as StorageNode);
    assert.equal(capped[0].text, "Documents on pc: more than 1000 sync conflicts");
  });
});

describe("the conflicts route", () => {
  let syncthingUrl = "";
  let dashboardUrl = "";
  let peerDashboardUrl = "";
  const peerPaths: string[] = [];
  const reader = new FakeReader();
  const indexes = new ConflictIndexes({ directory: join(tmpdir(), "conflicts-route-unused"), recheckMs: 0, sequenceWriteDelayMs: 5, browsePauseMs: 0, report: () => {} });
  indexSets.push(indexes);

  function reply(response: ServerResponse, body: unknown, status = 200): void {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }

  const syncthing: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    if (url.pathname === "/rest/config/devices") return reply(response, [{ deviceID: pcId, name: "pc" }, { deviceID: laptopId, name: "laptop" }]);
    if (url.pathname === "/rest/config/folders") return reply(response, [{ id: "documents", label: "Documents", path: "/x", type: "sendreceive", paused: false, devices: [] }]);
    reply(response, { error: "not faked" }, 404);
  });

  const peerDashboard: Server = createServer((request, response) => {
    peerPaths.push(request.url ?? "");
    reply(response, { items: [{ path: "p.sync-conflict-20260606-110111-H3SXFPD.txt", original: "p.txt", size: 2, modified: "x", device: "pc", apiKey: "leak" }], page: 1, perPage: 50, total: 1, complete: false, more: true });
  });

  function local(): LocalInstance {
    return { kind: "local", nodeId: "fb98", name: "pc", client: new SyncthingClient({ url: syncthingUrl, apiKey: "k" }), root: "F:\\", os: "windows", threshold: 0, source: "host-agent" };
  }

  function remote(): RemoteInstance {
    return { kind: "remote", nodeId: "a1b2", name: "p53-data", host: "p53", dashboardUrl: peerDashboardUrl };
  }

  async function resolve(nodeId: string): Promise<ResolvedInstance> {
    if (nodeId === "fb98") return local();
    if (nodeId === "a1b2") return remote();
    throw new RequestError(404, `no node ${nodeId}`);
  }

  const dashboard: Server = createServer((request, response) => void requestHandler(itemRoutes({ resolve, conflicts: indexes }))(request, response));

  function listen(server: Server): Promise<string> {
    return new Promise((resolveUrl) => server.listen(0, "127.0.0.1", () => resolveUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  }

  before(async () => {
    syncthingUrl = await listen(syncthing);
    dashboardUrl = await listen(dashboard);
    peerDashboardUrl = await listen(peerDashboard);
    const names = Array.from({ length: 3 }, (_, index) => file(`f${index}.sync-conflict-20260606-110111-${index === 1 ? "TUH2R66" : "H3SXFPD"}.txt`, index));
    reader.trees.set("documents", new Map([["", names]]));
    await indexes.reconcile([{ nodeId: "fb98", client: reader }]);
    await indexes.idle();
  });

  after(async () => {
    syncthing.close();
    dashboard.close();
    peerDashboard.close();
    await rm(join(tmpdir(), "conflicts-route-unused"), { recursive: true, force: true });
  });

  it("pages the folder's conflict copies with their original and device", async () => {
    const response = await fetch(`${dashboardUrl}/api/nodes/fb98/folders/documents/conflicts?page=2&perPage=2`);
    assert.equal(response.status, 200);
    const page = (await response.json()) as ConflictsPage;
    assert.deepEqual(page, {
      items: [{ path: "f2.sync-conflict-20260606-110111-H3SXFPD.txt", original: "f2.txt", size: 2, modified: "2026-10-27T10:00:00+01:00", device: "pc" }],
      page: 2,
      perPage: 2,
      total: 3,
      complete: true,
      more: false,
    });
    const first = (await (await fetch(`${dashboardUrl}/api/nodes/fb98/folders/documents/conflicts`)).json()) as ConflictsPage;
    assert.equal(first.items[1].device, "laptop");
  });

  it("a folder the node does not have is 404, and another host's node is read from its dashboard", async () => {
    assert.equal((await fetch(`${dashboardUrl}/api/nodes/fb98/folders/nothing/conflicts`)).status, 404);
    const forwarded = (await (await fetch(`${dashboardUrl}/api/nodes/a1b2/folders/documents/conflicts?page=1&perPage=50`)).json()) as ConflictsPage;
    assert.deepEqual(peerPaths, ["/api/nodes/a1b2/folders/documents/conflicts?page=1&perPage=50&scope=local"]);
    assert.deepEqual(forwarded, { items: [{ path: "p.sync-conflict-20260606-110111-H3SXFPD.txt", original: "p.txt", size: 2, modified: "x", device: "pc" }], page: 1, perPage: 50, total: 1, complete: false, more: true });
  });
});
