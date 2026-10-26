import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coalesceWhileRunning, readUntilSettled } from "../ui/src/pollGuard.js";

function gate() {
  const releases: (() => void)[] = [];
  return {
    wait: () => new Promise<void>((resolve) => releases.push(resolve)),
    release: () => releases.shift()?.(),
  };
}

describe("the page poll", () => {
  it("calls while the previous poll still runs do not pile up but make one more run after it", async () => {
    const running = gate();
    let runs = 0;
    const poll = coalesceWhileRunning(async () => {
      runs += 1;
      await running.wait();
    });
    const first = poll();
    const second = poll();
    const third = poll();
    assert.equal(runs, 1);
    running.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 2, "a refresh asked for during a poll is not dropped");
    running.release();
    await Promise.all([first, second, third]);
    assert.equal(runs, 2, "three calls during one run make one more run, not three");
  });

  it("a call with nothing running runs at once", async () => {
    let runs = 0;
    const poll = coalesceWhileRunning(async () => void (runs += 1));
    await poll();
    await poll();
    assert.equal(runs, 2);
  });

  it("a poll that fails does not stop the next one", async () => {
    let runs = 0;
    const poll = coalesceWhileRunning(async () => {
      runs += 1;
      throw new Error("the dashboard is not answering");
    });
    await assert.rejects(poll());
    await assert.rejects(poll());
    assert.equal(runs, 2);
  });

  it("a run asked for during a failing one still runs", async () => {
    const running = gate();
    let runs = 0;
    const poll = coalesceWhileRunning(async () => {
      runs += 1;
      await running.wait();
      if (runs === 1) throw new Error("the dashboard is not answering");
    });
    const first = poll();
    const again = poll();
    running.release();
    await new Promise((resolve) => setImmediate(resolve));
    running.release();
    await Promise.all([first, again]);
    assert.equal(runs, 2);
  });
});

describe("a read that a saved write may overtake", () => {
  it("is read again when a write was saved while it ran, so the answer shows the write", async () => {
    let writes = 0;
    const answers = ["before the write", "after the write"];
    const read = async () => {
      const answer = answers.shift() ?? "unexpected";
      if (answer === "before the write") writes += 1;
      return answer;
    };
    assert.equal(await readUntilSettled(read, () => writes), "after the write");
  });

  it("is read once when no write was saved meanwhile", async () => {
    let reads = 0;
    assert.equal(await readUntilSettled(async () => (reads += 1), () => 7), 1);
    assert.equal(reads, 1);
  });

  it("passes a failed read on", async () => {
    await assert.rejects(readUntilSettled(async () => Promise.reject(new Error("HTTP 503")), () => 0), /HTTP 503/);
  });
});
