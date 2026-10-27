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
    const lists = new SharedLists<List>({ keptMs: 30, maxTotalBytes: 100, maxReading: 2 }, () => now);
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
    const lists = new SharedLists<List>({ keptMs: 60_000, maxTotalBytes: 30, maxReading: 2 }, () => now);
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

  it("a list still being read is never dropped, and a read past the limit of reads is refused in plain words", async () => {
    const lists = new SharedLists<List>({ keptMs: 60_000, maxTotalBytes: 15, maxReading: 2 }, () => 0);
    const first = deferred();
    const second = deferred();
    const a = lists.read("a", false, () => first.promise);
    lists.read("b", false, () => second.promise);
    assert.equal(lists.read("a", true, () => assert.fail("a second read of a list being read")), a, "a fresh read shares the read in flight");
    assert.throws(() => lists.read("c", false, async () => ({ bytes: 1, name: "c" })), { status: 409, message: "2 versions lists are being read right now; try again in a moment" });
    first.resolve({ bytes: 10, name: "a" });
    await a;
    assert.deepEqual(lists.keys(), ["a", "b"], "settling a does not drop b while it is read");
    second.resolve({ bytes: 10, name: "b" });
    await second.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(lists.keys(), ["b"], "once b settles past the limit, a goes");
  });

  it("a list forgotten while it is read is not kept when it arrives", async () => {
    const lists = new SharedLists<List>({ keptMs: 60_000, maxTotalBytes: 100, maxReading: 2 }, () => 0);
    const pending = deferred();
    const read = lists.read("a", false, () => pending.promise);
    lists.forget("a");
    pending.resolve({ bytes: 10, name: "a" });
    await read;
    assert.deepEqual(lists.keys(), []);
  });
});
