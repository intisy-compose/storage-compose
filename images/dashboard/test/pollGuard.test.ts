import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { skipWhileRunning } from "../ui/src/pollGuard.js";

describe("the page poll", () => {
  it("a tick while the previous poll still runs is skipped instead of piling up", async () => {
    let release!: () => void;
    let runs = 0;
    const poll = skipWhileRunning(async () => {
      runs += 1;
      await new Promise<void>((resolve) => (release = resolve));
    });
    const first = poll();
    await poll();
    assert.equal(runs, 1);
    release();
    await first;
    const next = poll();
    assert.equal(runs, 2);
    release();
    await next;
  });

  it("a poll that fails does not stop the next one", async () => {
    let runs = 0;
    const poll = skipWhileRunning(async () => {
      runs += 1;
      throw new Error("the dashboard is not answering");
    });
    await assert.rejects(poll());
    await assert.rejects(poll());
    assert.equal(runs, 2);
  });
});
