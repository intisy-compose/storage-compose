import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SharedLists } from "../src/versionLists.js";

interface List {
  bytes: number;
  name: string;
}

function deferred(): { promise: Promise<List>; resolve: (value: List) => void } {
  let resolve: (value: List) => void = () => {};
  const promise = new Promise<List>((done) => (resolve = done));
  return { promise, resolve };
}

describe("shared versions lists", () => {
  it("a list is released once it expires, by its timer and on access", async () => {
    let now = 1_000;
    const lists = new SharedLists<List>({ keptMs: 30, maxTotalBytes: 100, maxReading: 2, slotWaitMs: 1_000 }, () => now);
    let reads = 0;
    const start = async () => ({ bytes: 10, name: `read ${++reads}` });
    await lists.read("a", false, start);
    await lists.read("a", false, start);
    assert.equal(reads, 1);
    now += 31;
    assert.deepEqual(lists.keys(), [], "an expired list is gone at the next access");
    await lists.read("b", false, start);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(lists.totalBytes(), 0, "the timer released it with no access at all");
  });

  it("past the byte limit the least recently used settled lists go first", async () => {
    let now = 0;
    const lists = new SharedLists<List>({ keptMs: 60_000, maxTotalBytes: 30, maxReading: 2, slotWaitMs: 1_000 }, () => now);
    const start = (name: string) => async () => ({ bytes: 10, name });
    for (const name of ["a", "b", "c"]) {
      now += 1;
      await lists.read(name, false, start(name));
    }
    now += 1;
    await lists.read("a", false, start("a"));
    now += 1;
    await lists.read("d", false, start("d"));
    assert.deepEqual(lists.keys(), ["c", "a", "d"], "b was the least recently used");
    assert.equal(lists.totalBytes(), 30);
  });

  it("a list still being read is never dropped, and a fresh read of it shares the read in flight", async () => {
    const lists = new SharedLists<List>({ keptMs: 60_000, maxTotalBytes: 15, maxReading: 2, slotWaitMs: 1_000 }, () => 0);
    const first = deferred();
    const second = deferred();
    const a = lists.read("a", false, () => first.promise);
    void lists.read("b", false, () => second.promise);
    const again = lists.read("a", true, () => assert.fail("a second read of a list being read"));
    first.resolve({ bytes: 10, name: "a" });
    assert.equal(await again, await a);
    assert.deepEqual(lists.keys(), ["a", "b"], "settling a does not drop b while it is read");
    second.resolve({ bytes: 10, name: "b" });
    await second.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(lists.keys(), ["b"], "once b settles past the limit, a goes");
  });

  it("a read past the limit of reads waits for a free slot", async () => {
    const lists = new SharedLists<List>({ keptMs: 60_000, maxTotalBytes: 100, maxReading: 1, slotWaitMs: 5_000 }, () => 0);
    const first = deferred();
    void lists.read("a", false, () => first.promise);
    let started = false;
    const waiting = lists.read("b", false, async () => {
      started = true;
      return { bytes: 1, name: "b" };
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(started, false, "b waits while a is read");
    first.resolve({ bytes: 1, name: "a" });
    assert.equal((await waiting).name, "b");
  });

  it("a read that finds no free slot within its wait is refused in plain words, and a refused fresh read keeps the kept list", async () => {
    const lists = new SharedLists<List>({ keptMs: 60_000, maxTotalBytes: 100, maxReading: 1, slotWaitMs: 30 }, () => 0);
    await lists.read("a", false, async () => ({ bytes: 1, name: "a kept" }));
    const slow = deferred();
    void lists.read("b", false, () => slow.promise);
    await assert.rejects(lists.read("a", true, () => assert.fail("no slot is free")), { status: 409, message: "1 versions list is being read right now; try again in a moment" });
    assert.equal((await lists.read("a", false, () => assert.fail("the kept list is shared"))).name, "a kept");
    slow.resolve({ bytes: 1, name: "b" });
  });

  it("a list forgotten while it is read still holds its slot until Syncthing answers, and a read of it waits for that walk", async () => {
    const lists = new SharedLists<List>({ keptMs: 60_000, maxTotalBytes: 100, maxReading: 1, slotWaitMs: 5_000 }, () => 0);
    const outdated = deferred();
    void lists.read("a", false, () => outdated.promise);
    lists.forget("a");
    let readsOfA = 0;
    const reread = lists.read("a", false, async () => ({ bytes: 1, name: `a read ${++readsOfA}` }));
    let startedB = false;
    void lists.read("b", false, async () => {
      startedB = true;
      return { bytes: 1, name: "b" };
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(readsOfA, 0, "the outdated walk is not shared, and no second walk starts beside it");
    assert.equal(startedB, false, "forgetting a list does not free the slot of its walk");
    outdated.resolve({ bytes: 1, name: "a outdated" });
    assert.equal((await reread).name, "a read 1");
  });

  it("a list forgotten while it is read is not kept when it arrives", async () => {
    const lists = new SharedLists<List>({ keptMs: 60_000, maxTotalBytes: 100, maxReading: 2, slotWaitMs: 1_000 }, () => 0);
    const pending = deferred();
    const read = lists.read("a", false, () => pending.promise);
    lists.forget("a");
    pending.resolve({ bytes: 10, name: "a" });
    await read;
    assert.deepEqual(lists.keys(), []);
  });
});
