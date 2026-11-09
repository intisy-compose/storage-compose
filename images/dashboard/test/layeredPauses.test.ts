import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileLayeredPauses } from "../src/layeredPauses.js";
import { fileNotifiedState } from "../src/notifiedState.js";
import { queueNotification } from "../src/notifyOutbox.js";

const mark = (bytes: number | null) => ({ at: "2026-11-05T12:00:00.000Z", size: bytes === null ? null : { globalBytes: bytes, localBytes: bytes, needBytes: 0 } });

describe("the record of layered pauses", () => {
  let root: string;
  before(() => (root = mkdtempSync(join(tmpdir(), "layered-pauses-"))));
  after(() => rmSync(root, { recursive: true, force: true }));

  it("keeps each node's paused folders with their size across instances of the store, and forgets a node with none left", async () => {
    const path = join(root, "layered", "paused.json");
    await fileLayeredPauses(path).mark("a001", "documents", mark(100));
    await fileLayeredPauses(path).mark("a001", "archive", mark(null));
    await fileLayeredPauses(path).mark("b002", "videos", mark(5));

    const marks = await fileLayeredPauses(path).of("a001");
    assert.deepEqual([...marks.keys()].sort(), ["archive", "documents"]);
    assert.equal(marks.get("documents")?.size?.globalBytes, 100);
    assert.deepEqual(await fileLayeredPauses(path).nodes(), ["a001", "b002"]);
    await fileLayeredPauses(path).unmark("b002", "videos");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))), ["a001"]);
    assert.equal((await fileLayeredPauses(join(root, "none.json")).of("a001")).size, 0);
  });

  it("refuses resumes from a record it cannot read, while a pause sets it aside and starts a new one", async () => {
    const path = join(root, "broken.json");
    writeFileSync(path, "{ not json");
    await assert.rejects(fileLayeredPauses(path).of("a001"), /not a record of layered pauses/);
    await assert.rejects(fileLayeredPauses(path).unmark("a001", "x"));

    await fileLayeredPauses(path).mark("a001", "documents", mark(1));

    assert.equal(readFileSync(`${path}.bad`, "utf8"), "{ not json");
    assert.deepEqual([...(await fileLayeredPauses(path).of("a001")).keys()], ["documents"]);
    writeFileSync(path, JSON.stringify({ a001: ["documents"] }));
    await assert.rejects(fileLayeredPauses(path).of("a001"), /not a record/, "the old list shape is no record either");
  });
});

describe("what was last notified", () => {
  it("survives a new store on the same file, as a dashboard restart reads it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "notified-"));
    try {
      const path = join(directory, "layered", "notified.json");
      await fileNotifiedState(path).set("full:c1c1", "full");
      assert.equal(await fileNotifiedState(path).get("full:c1c1"), "full");
      await fileNotifiedState(path).set("full:c1c1", null);
      assert.equal(await fileNotifiedState(path).get("full:c1c1"), null);
      writeFileSync(path, "{ broken");
      assert.equal(await fileNotifiedState(path).get("full:c1c1"), null);
      assert.ok(existsSync(path));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("a notification queued for the mounter", () => {
  it("is one file of title, priority, tags and message, named to sort after the mounter's own of the same moment", async () => {
    const outbox = mkdtempSync(join(tmpdir(), "outbox-"));
    try {
      await queueNotification(outbox, { priority: 4, tags: "warning", title: "pc stopped", message: "2 folders paused" }, 1_762_000_000_000);
      const files = readdirSync(outbox);
      assert.equal(files.length, 1);
      assert.match(files[0], /^1762000000000\d{6}-dashboard$/);
      assert.equal(readFileSync(join(outbox, files[0]), "utf8"), "pc stopped\n4\nwarning\n2 folders paused\n");
    } finally {
      rmSync(outbox, { recursive: true, force: true });
    }
  });
});
