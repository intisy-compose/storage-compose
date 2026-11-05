import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { NodePolicyPreview } from "../src/api/types.js";
import { LayoutRound, mountedNodeFiles, nodeFileAction } from "../src/applyLayout.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, ResolvedInstance } from "../src/instanceResolver.js";
import { layoutVersion } from "../src/layoutEdit.js";
import { formatNodeFile, nodeFileFromLayout, parseNodeFile, withoutApply } from "../src/nodeFile.js";
import { nodePolicyRoutes } from "../src/routes/nodePolicy.js";
import { type LayoutNode, type SetupLayout, parseLayout, readCommittedLayout } from "../src/setupRepo.js";
import type { SyncthingClient } from "../src/syncthing.js";
import { FakeSyncthing, clientOf } from "./fakeFolderSyncthing.js";
import { askRoutes, git, layoutRepos } from "./layoutRepos.js";

const folderNode = `[node]
id        = "a1b2"
name      = "pc"
kind      = "folder"
threshold = 50
assigned  = []
access    = "open"
`;

function policy(apply: boolean, admitted = true): LayoutNode {
  return parseLayout(`[nodes.a1b2]\nname = "pc"\nthreshold = 80\nadmitted = ${admitted}\napply = ${apply}\n`).nodes[0];
}

describe("apply in the node file", () => {
  it("is written only while the layout lets an admitted node act, and read back", () => {
    const followed = nodeFileFromLayout(parseNodeFile(folderNode), policy(true));
    assert.match(formatNodeFile(followed), /\napply {5}= true\n/);
    assert.equal(parseNodeFile(formatNodeFile(followed)).node.apply, true);
    assert.doesNotMatch(formatNodeFile(nodeFileFromLayout(followed, policy(false))), /apply/);
    assert.doesNotMatch(formatNodeFile(nodeFileFromLayout(parseNodeFile(folderNode), policy(true, false))), /apply/);
  });

  it("a node file without the line has no apply, as the executors read it", () => {
    assert.equal(parseNodeFile(folderNode).node.apply, undefined);
    assert.equal(formatNodeFile(parseNodeFile(folderNode)), folderNode);
  });
});

describe("the layout round brings mounted node files to the committed layout", () => {
  let root: string;
  before(() => (root = mkdtempSync(join(tmpdir(), "node-files-"))));
  after(() => rmSync(root, { recursive: true, force: true }));

  function nodeRoot(name: string, text = folderNode): string {
    const path = join(root, "nodes", name);
    mkdirSync(join(path, ".storage"), { recursive: true });
    writeFileSync(join(path, ".storage", "node.toml"), text);
    return path;
  }

  function instance(path: string, overrides: Partial<LocalInstance> = {}): LocalInstance {
    return { kind: "local", nodeId: "a1b2", name: "pc", client: {} as SyncthingClient, root: path, os: "linux", threshold: 50, source: "registry", ...overrides };
  }

  const nodeFile = (path: string) => readFileSync(join(path, ".storage", "node.toml"), "utf8");

  it("follow writes apply and the threshold into a Linux node file under a mounted root; withdraw takes only the apply line out", async () => {
    const path = nodeRoot("one");
    const files = mountedNodeFiles([join(root, "nodes")]);
    assert.equal(await files.follow(instance(path), policy(true)), true);
    assert.match(nodeFile(path), /threshold = 80\n[\s\S]*apply {5}= true/);
    assert.equal(await files.follow(instance(path), policy(true)), false);
    writeFileSync(join(path, ".storage", "node.toml"), nodeFile(path).replace("assigned  = []", "assigned  = [] # kept as written"));
    const before = nodeFile(path);
    assert.equal(await files.withdraw(instance(path)), true);
    assert.equal(nodeFile(path), before.replace(/apply {5}= true\n/, ""));
    assert.equal(await files.withdraw(instance(path)), false);
  });

  it("withdraw takes out an apply line of any value, quoted included", () => {
    assert.equal(withoutApply(`[node]\nid = "a1b2"\napply = "true"\n\n[other]\napply = 1\n`), `[node]\nid = "a1b2"\n\n[other]\napply = 1\n`);
  });

  it("leaves a Windows node, an array instance and a root this host does not mount alone", async () => {
    const path = nodeRoot("two", formatNodeFile(nodeFileFromLayout(parseNodeFile(folderNode), policy(true))));
    const before = nodeFile(path);
    assert.equal(await mountedNodeFiles([join(root, "elsewhere")]).withdraw(instance(path)), false);
    const mounted = mountedNodeFiles([join(root, "nodes")]);
    assert.equal(await mounted.withdraw(instance(path, { os: "windows" })), false);
    assert.equal(await mounted.follow(instance(path, { source: "array" }), policy(true)), false);
    assert.equal(nodeFile(path), before);
  });

  it("never rewrites an array's node file, whatever the instance says it is", async () => {
    const arrayFile = `[node]\nid        = "a1b2"\nname      = "pc"\nkind      = "array"\nthreshold = 0\nassigned  = []\napply = true\n\n[array]\nrevision = 3\n`;
    const path = nodeRoot("array-kind", arrayFile);
    const files = mountedNodeFiles([join(root, "nodes")]);
    assert.equal(await files.follow(instance(path), policy(true)), false);
    assert.equal(await files.withdraw(instance(path)), false);
    assert.equal(nodeFile(path), arrayFile);
  });

  it("refuses a link at .storage and a link at the temporary file, writing nothing through either", async () => {
    const elsewhere = join(root, "elsewhere-storage");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "node.toml"), folderNode);
    const linked = join(root, "nodes", "linked");
    mkdirSync(linked, { recursive: true });
    symlinkSync(elsewhere, join(linked, ".storage"), "junction");
    const files = mountedNodeFiles([join(root, "nodes")]);
    assert.equal(await files.follow(instance(linked), policy(true)), false);
    assert.equal(readFileSync(join(elsewhere, "node.toml"), "utf8"), folderNode);

    const path = nodeRoot("temp-link");
    const target = join(root, "target.toml");
    writeFileSync(target, "untouched\n");
    symlinkSync(target, join(path, ".storage", "node.toml.new"), "file");
    await assert.rejects(files.follow(instance(path), policy(true)), /is not a regular file/);
    assert.equal(readFileSync(target, "utf8"), "untouched\n");
    assert.equal(nodeFile(path), folderNode);
  });

  it("follows only a listed, admitted, unblocked, enabled node whose pushed layout says apply = true; withdraws on any doubt", () => {
    const committed = (body: string, pushed = true) => ({ layout: parseLayout(`[devices.pc]\nid = "PC-ID"\n[nodes.a1b2]\nname = "pc"\ndevice = "pc"\nthreshold = 80\n${body}\n`), pushed });
    assert.equal(nodeFileAction(committed("admitted = true\napply = true"), "a1b2").kind, "follow");
    const reasons = [
      nodeFileAction(null, "a1b2"),
      nodeFileAction(committed("admitted = true\napply = true"), "c3d4"),
      nodeFileAction(committed("apply = true"), "a1b2"),
      nodeFileAction(committed('admitted = true\napply = true\nenabled = "yes"'), "a1b2"),
      nodeFileAction(committed("admitted = true\napply = true\nenabled = false"), "a1b2"),
      nodeFileAction(committed("admitted = true\napply = false"), "a1b2"),
      nodeFileAction(committed("admitted = true"), "a1b2"),
      nodeFileAction(committed("admitted = true\napply = true", false), "a1b2"),
    ].map((action) => (action.kind === "withdraw" ? action.reason : "follow"));
    assert.deepEqual(reasons, [
      "no committed layout can be read",
      "the layout does not list it",
      "it is not admitted",
      "the layout blocks it",
      "it is not enabled",
      "the committed layout does not say apply = true",
      "the committed layout does not say apply = true",
      "the commit that says apply = true is not on the upstream yet",
    ]);
  });

  it("a round withdraws for every node of this host when there is no layout at all, and for a node the layout does not list", async () => {
    const calls: string[] = [];
    const recorded: string[] = [];
    const nodeOf = (nodeId: string): LocalInstance => ({ kind: "local", nodeId, name: nodeId, client: clientOf(new FakeSyncthing()), root: "/data", os: "linux", threshold: 80, source: "registry" });
    let committed: { layout: SetupLayout; pushed: boolean } | null = null;
    let layout: SetupLayout | null = null;
    const round = new LayoutRound({
      layout: async () => layout,
      committedLayout: async () => committed,
      instances: async () => [nodeOf("a1b2"), nodeOf("c3d4")],
      handoffFiles: { ensure: async () => null },
      nodeFiles: {
        follow: async (entry) => calls.push(`follow ${entry.nodeId}`) > 0,
        withdraw: async (entry) => calls.push(`withdraw ${entry.nodeId}`) > 0,
      },
      record: (_nodeId, _folderId, text) => recorded.push(text),
      readBackDelaysMs: [],
    });
    await round.run();
    assert.deepEqual(calls.splice(0), ["withdraw a1b2", "withdraw c3d4"]);
    assert.equal(recorded[0], "a1b2: apply taken out of its node file: no committed layout can be read");
    layout = parseLayout(`[devices.pc]\nid = "LAPTOP-ID"\nroot = "/data"\n[nodes.a1b2]\nname = "a1b2"\ndevice = "pc"\nthreshold = 80\nadmitted = true\napply = true\n`);
    committed = { layout, pushed: true };
    await round.run();
    assert.deepEqual(calls.splice(0), ["follow a1b2", "withdraw c3d4"]);
    committed = null;
    await round.run();
    assert.deepEqual(calls.splice(0), ["withdraw a1b2", "withdraw c3d4"], "a committed layout that cannot be read withdraws even while the working tree has one");
  });

  it("reads the committed layout from HEAD, and pushed only once its commit is on the upstream", async () => {
    const repos = layoutRepos("committed-layout-");
    try {
      const text = readFileSync(join(repos.ours, "drive-sync.toml"), "utf8");
      writeFileSync(join(repos.ours, "drive-sync.toml"), text.replace("admitted  = true", "admitted  = true\napply     = true"));
      assert.equal((await readCommittedLayout(repos.ours))?.layout.nodes[0].apply, false, "the working tree does not count");
      git(repos.ours, "commit", "-q", "-am", "apply");
      const unpushed = await readCommittedLayout(repos.ours);
      assert.deepEqual([unpushed?.layout.nodes[0].apply, unpushed?.pushed], [true, false]);
      git(repos.ours, "push", "-q");
      assert.equal((await readCommittedLayout(repos.ours))?.pushed, true);
      writeFileSync(join(repos.ours, "drive-sync.toml"), "[nodes\n");
      git(repos.ours, "commit", "-q", "-am", "break it");
      assert.equal(await readCommittedLayout(repos.ours), null);
      assert.equal(await readCommittedLayout(""), null);
    } finally {
      rmSync(repos.root, { recursive: true, force: true });
    }
  });
});

describe("node policy editing through the setup repo", () => {
  let repos: ReturnType<typeof layoutRepos>;
  const local: LocalInstance = { kind: "local", nodeId: "a1b2", name: "pc", client: {} as SyncthingClient, root: "/data", os: "linux", threshold: 50, source: "registry" };
  const keeperLayout = `[devices.array]
id     = "ARRAY-ID"
role   = "archive"
root   = "/mnt/storage/pool"
joined = true

[nodes.5784]
name     = "private-array"
device   = "array"
admitted = true
`;

  const routes = () =>
    nodePolicyRoutes({
      repository: repos.ours,
      resolve: async (nodeId): Promise<ResolvedInstance> => {
        if (nodeId === "a1b2") return local;
        if (nodeId === "c3d4") return { kind: "remote", nodeId, name: "p53-data", host: "p53", dashboardUrl: "http://127.0.0.1:9" };
        throw new RequestError(404, `no node ${nodeId}`);
      },
      configured: async () => new Set(["documents", "videos"]),
      localSize: async (_instance, folderId) => (folderId === "documents" ? { files: 12, bytes: 4096 } : { files: 3, bytes: 100 }),
    });
  const version = () => layoutVersion(readFileSync(join(repos.ours, "drive-sync.toml"), "utf8"));
  const remoteLayout = () => git(repos.remote, "show", "main:drive-sync.toml");

  before(() => {
    repos = layoutRepos("node-policy-");
    writeFileSync(join(repos.ours, "drive-sync.toml"), `${readFileSync(join(repos.ours, "drive-sync.toml"), "utf8")}\n${keeperLayout}`);
    git(repos.ours, "commit", "-q", "-am", "add the array");
    git(repos.ours, "push", "-q");
  });
  after(() => rmSync(repos.root, { recursive: true, force: true }));

  it("a raise is previewed with what it would hand off, how much, and to which keeper", async () => {
    const answer = await askRoutes(routes(), "GET", "/api/nodes/a1b2/policy/preview?threshold=90");
    const preview = answer.body as NodePolicyPreview;
    assert.equal(answer.status, 200);
    assert.deepEqual(preview.handoffs, [{ folderId: "documents", label: "Documents", files: 12, bytes: 4096, keepers: ["private-array"] }]);
    assert.deepEqual([preview.files, preview.bytes], [12, 4096]);
    assert.ok(preview.changes.some((text) => text.startsWith("Documents (documents) turns send only")));
  });

  it("a lower threshold hands nothing off", async () => {
    const preview = (await askRoutes(routes(), "GET", "/api/nodes/a1b2/policy/preview?threshold=10")).body as NodePolicyPreview;
    assert.deepEqual(preview.handoffs, []);
  });

  it("the threshold, assigned paths, pins and enabled are committed and pushed", async () => {
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy", { base: version(), threshold: 60, assigned: ["Documents\\GitHub"], pins: { Videos: 85 }, enabled: true });
    assert.equal(answer.status, 200);
    const node = parseLayout(remoteLayout()).nodes.find((entry) => entry.id === "a1b2");
    assert.deepEqual([node?.threshold, node?.assigned, node?.pins], [60, ["Documents/GitHub"], { Videos: 85 }]);
    assert.equal(git(repos.remote, "log", "-1", "--format=%s", "main"), "feat(layout): threshold 50 to 60; assigned Documents/GitHub; pins Videos at 85 for pc");
  });

  it("another host's node is 409 and nothing is written", async () => {
    const head = git(repos.remote, "rev-parse", "main");
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/c3d4/policy", { base: version(), threshold: 10 });
    assert.equal(answer.status, 409);
    assert.match((answer.body as { error: string }).error, /act on p53's dashboard/);
    assert.equal((await askRoutes(routes(), "GET", "/api/nodes/c3d4/policy/preview?threshold=10")).status, 409);
    assert.equal(git(repos.remote, "rev-parse", "main"), head);
  });

  it("apply is never changed with the other fields", async () => {
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy", { base: version(), threshold: 70, apply: true });
    assert.equal(answer.status, 400);
    const mixed = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy/apply", { base: version(), apply: true, confirm: "pc", threshold: 70 });
    assert.equal(mixed.status, 400);
    assert.equal(parseLayout(remoteLayout()).nodes.find((entry) => entry.id === "a1b2")?.apply, false);
  });

  it("turning apply on takes the node's name typed exactly", async () => {
    for (const confirm of [undefined, "PC", "pc "]) {
      const answer = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy/apply", { base: version(), apply: true, confirm });
      assert.equal(answer.status, 400, String(confirm));
      assert.match((answer.body as { error: string }).error, /type the node's name pc/);
    }
    assert.equal(parseLayout(remoteLayout()).nodes.find((entry) => entry.id === "a1b2")?.apply, false);
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy/apply", { base: version(), apply: true, confirm: "pc" });
    assert.equal(answer.status, 200);
    assert.equal(parseLayout(remoteLayout()).nodes.find((entry) => entry.id === "a1b2")?.apply, true);
    assert.equal(git(repos.remote, "log", "-1", "--format=%s", "main"), "feat(layout): turn apply on for pc");
  });

  it("turning apply off needs no name", async () => {
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy/apply", { base: version(), apply: false });
    assert.equal(answer.status, 200);
    assert.equal(parseLayout(remoteLayout()).nodes.find((entry) => entry.id === "a1b2")?.apply, false);
  });

  it("a node that is not admitted cannot be let act", async () => {
    writeFileSync(join(repos.ours, "drive-sync.toml"), readFileSync(join(repos.ours, "drive-sync.toml"), "utf8").replace("admitted  = true\n", "admitted  = false\n"));
    git(repos.ours, "commit", "-q", "-am", "unadmit");
    git(repos.ours, "push", "-q");
    const answer = await askRoutes(routes(), "PUT", "/api/nodes/a1b2/policy/apply", { base: version(), apply: true, confirm: "pc" });
    assert.equal(answer.status, 409);
    assert.match((answer.body as { error: string }).error, /not admitted/);
  });
});
