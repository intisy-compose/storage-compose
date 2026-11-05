import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { followLayout, formatNodeFile, nodeFileFromLayout, parseNodeFile } from "../src/nodeFile.js";
import { type LayoutNode, parseLayout } from "../src/setupRepo.js";

const arrayFile = `[node]
id        = "a3f9"
name      = "private-array"
kind      = "array"
threshold = 0
assigned  = []

[array]
revision = 7

[[array.members]]
role   = "data1"
label  = "a3f9-data1"
serial = "SERIAL-1"
size   = 4000787030016
`;

const stickFile = `[node]
id        = "b001"
name      = "stick"
kind      = "folder"
threshold = 80
assigned  = []
access    = "closed"
`;

function layoutNode(id: string, policy: string): LayoutNode {
  return parseLayout(`[nodes.${id}]\nname = "renamed"\n${policy}\n`).nodes[0];
}

describe("the node file's access", () => {
  it("round-trips", () => {
    const file = parseNodeFile(stickFile);

    assert.equal(file.node.access, "closed");
    assert.deepEqual(parseNodeFile(formatNodeFile(file)), file);
  });

  it("is open when the file does not say", () => {
    assert.equal(parseNodeFile(arrayFile).node.access, "open");
  });
});

describe("a node file following the layout", () => {
  it("takes threshold, assigned and access from the layout", () => {
    const followed = nodeFileFromLayout(parseNodeFile(arrayFile), layoutNode("a3f9", `threshold = 30\nassigned = ["Videos"]\naccess = "closed"`));

    assert.equal(followed.node.threshold, 30);
    assert.deepEqual(followed.node.assigned, ["Videos"]);
    assert.equal(followed.node.access, "closed");
  });

  it("keeps its id, name, kind and members", () => {
    const file = parseNodeFile(arrayFile);
    const followed = nodeFileFromLayout(file, layoutNode("a3f9", "threshold = 30"));

    assert.equal(followed.node.id, "a3f9");
    assert.equal(followed.node.name, "private-array");
    assert.equal(followed.node.kind, "array");
    assert.deepEqual(followed.array, file.array);
  });

  describe("on disk", () => {
    let root = "";

    before(async () => {
      root = await mkdtemp(join(tmpdir(), "node-file-"));
    });

    after(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("writes the layout's values", async () => {
      const path = join(root, "changed.toml");
      await writeFile(path, stickFile);

      const wrote = await followLayout(path, layoutNode("b001", `threshold = 50\naccess = "closed"`));

      assert.equal(wrote, true);
      assert.equal(parseNodeFile(await readFile(path, "utf8")).node.threshold, 50);
    });

    it("writes nothing when the layout changes nothing", async () => {
      const path = join(root, "same.toml");
      await writeFile(path, stickFile);
      const before = await stat(path);

      const wrote = await followLayout(path, layoutNode("b001", `threshold = 80\naccess = "closed"`));

      assert.equal(wrote, false);
      assert.equal(await readFile(path, "utf8"), stickFile);
      assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
    });

    it("writes nothing for a node without a node file", async () => {
      const path = join(root, "missing", ".storage", "node.toml");

      assert.equal(await followLayout(path, layoutNode("b001", "threshold = 50")), false);
      await assert.rejects(stat(path));
    });

    it("writes nothing for another node's layout entry", async () => {
      const path = join(root, "other.toml");
      await writeFile(path, stickFile);

      assert.equal(await followLayout(path, layoutNode("c0de", "threshold = 10")), false);
      assert.equal(await readFile(path, "utf8"), stickFile);
    });
  });
});
