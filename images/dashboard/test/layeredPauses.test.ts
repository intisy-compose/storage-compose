import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileLayeredPauses } from "../src/layeredPauses.js";
import { queueNotification } from "../src/notifyOutbox.js";

describe("the record of layered pauses", () => {
  let root: string;
  before(() => (root = mkdtempSync(join(tmpdir(), "layered-pauses-"))));
  after(() => rmSync(root, { recursive: true, force: true }));

  it("keeps each node's paused folders across instances of the store, and forgets a node with none left", async () => {
    const path = join(root, "layered", "paused.json");
    await fileLayeredPauses(path).mark("a001", "documents");
    await fileLayeredPauses(path).mark("a001", "archive");
    await fileLayeredPauses(path).mark("b002", "videos");

    assert.deepEqual([...(await fileLayeredPauses(path).of("a001"))], ["archive", "documents"]);
    await fileLayeredPauses(path).unmark("b002", "videos");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { a001: ["archive", "documents"] });
    assert.deepEqual([...(await fileLayeredPauses(join(root, "none.json")).of("a001"))], []);
  });

  it("refuses a record it cannot read rather than taking it for empty", async () => {
    const path = join(root, "broken.json");
    writeFileSync(path, "{ not json");
    await assert.rejects(fileLayeredPauses(path).of("a001"));
    writeFileSync(path, JSON.stringify({ a001: "documents" }));
    await assert.rejects(fileLayeredPauses(path).mark("a001", "x"), /not a record of layered pauses/);
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
