import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeyedSharedReads, ScopedShare, SharedRead } from "../src/sharedRead.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("a shared read", () => {
  it("callers while a read runs share it", async () => {
    const shared = new SharedRead<number>(0);
    const pending = deferred<number>();
    let starts = 0;
    const start = () => {
      starts += 1;
      return pending.promise;
    };
    const reads = [shared.read(start), shared.read(start)];
    pending.resolve(7);
    assert.deepEqual(await Promise.all(reads), [7, 7]);
    assert.equal(starts, 1);
  });

  it("a settled read is shared until its age passes, then a new one starts", async () => {
    let now = 1_000;
    const shared = new SharedRead<number>(4_000, () => now);
    let starts = 0;
    const start = async () => ++starts;
    assert.equal(await shared.read(start), 1);
    now += 3_999;
    assert.equal(await shared.read(start), 1);
    now += 1;
    assert.equal(await shared.read(start), 2);
  });

  it("a read someone else started is shared too", async () => {
    const shared = new SharedRead<string>(4_000);
    shared.offer(Promise.resolve("from the full build"));
    assert.equal(await shared.read(async () => "a read of its own"), "from the full build");
  });

  it("a failed read is not shared with the next caller", async () => {
    const shared = new SharedRead<number>(4_000);
    await assert.rejects(shared.read(async () => Promise.reject(new Error("refused"))), /refused/);
    assert.equal(await shared.read(async () => 3), 3);
  });

  it("a failed read someone else started does not leave an unhandled rejection", async () => {
    const shared = new SharedRead<number>(4_000);
    shared.offer(Promise.reject(new Error("build failed")));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await shared.read(async () => 5), 5);
  });
});

describe("a share by scope", () => {
  it("a local-scope read never waits on a running full build", async () => {
    const share = new ScopedShare<string>(4_000);
    share.offer("all", new Promise<string>(() => {}));
    assert.equal(await share.read("local", async () => "a local build"), "a local build");
  });

  it("a full read shares a running local-scope build", async () => {
    const share = new ScopedShare<string>(4_000);
    share.offer("local", Promise.resolve("from the local build"));
    assert.equal(await share.read("all", async () => "a read of its own"), "from the local build");
  });

  it("after a write the next read of either scope starts a new build", async () => {
    const share = new ScopedShare<number>(4_000);
    let builds = 0;
    const start = async () => ++builds;
    assert.equal(await share.read("local", start), 1);
    assert.equal(await share.read("all", start), 1);
    share.invalidate();
    assert.equal(await share.read("local", start), 2);
    share.invalidate();
    assert.equal(await share.read("all", start), 3);
  });
});

describe("shared reads by key", () => {
  it("past the limit the least recently used settled reads go, and one still being read is never dropped", async () => {
    const reads = new KeyedSharedReads<string>(60_000, 2);
    const slow = deferred<string>();
    const first = reads.read("slow", () => slow.promise);
    await reads.read("a", async () => "a");
    await reads.read("b", async () => "b");
    await reads.read("a", async () => assert.fail("a is shared"));
    await reads.read("c", async () => "c");
    assert.deepEqual(reads.keys(), ["slow", "a", "c"], "b was the least recently used settled read; slow is still being read");
    let restarted = false;
    const again = reads.read("slow", async () => {
      restarted = true;
      return "second";
    });
    slow.resolve("slow");
    assert.deepEqual([await first, await again], ["slow", "slow"]);
    assert.equal(restarted, false, "no second read of slow started beside the first");
  });
});
