import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { LayoutSaveAnswer, LayoutView, PriorityPreview } from "../src/api/types.js";
import { hostAllowlist } from "../src/http.js";
import { layoutVersion } from "../src/layoutEdit.js";
import { type AnyRoute } from "../src/routeTypes.js";
import { requestHandler } from "../src/routes.js";
import { priorityRoutes } from "../src/routes/priorities.js";

export function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function cloneOf(remote: string, directory: string): string {
  execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", remote, directory], { stdio: "ignore" });
  git(directory, "config", "user.email", "test@example.invalid");
  git(directory, "config", "user.name", "test");
  return directory;
}

export const testLayout = `[devices.pc]
id     = "PC-ID"
root   = "/data"
joined = true

[folders.Documents]
priority = 80

[folders.Videos]
priority = 30

[nodes.a1b2]
name      = "pc"
device    = "pc"
threshold = 50
admitted  = true
`;

/** A bare remote holding `testLayout` as drive-sync.toml, and two clones of it, ours and another host's. */
export function layoutRepos(prefix: string): { root: string; remote: string; ours: string; theirs: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const seed = cloneOf(remote, join(root, "seed"));
  writeFileSync(join(seed, "drive-sync.toml"), testLayout);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { root, remote, ours: cloneOf(remote, join(root, "ours")), theirs: cloneOf(remote, join(root, "theirs")) };
}

/** Answers `routes` on a loopback port for one request. */
export async function askRoutes(routes: AnyRoute[], method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const handler = requestHandler(routes, { invalidate: () => {}, record: () => {} }, hostAllowlist(["127.0.0.1"]));
  const server: Server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("priority editing through the setup repo", () => {
  let repos: ReturnType<typeof layoutRepos>;
  const routes = () => priorityRoutes({ repository: repos.ours, configured: async () => () => new Set(["documents", "videos"]) });
  const remoteLayout = () => git(repos.remote, "show", "main:drive-sync.toml");
  const version = () => layoutVersion(readFileSync(join(repos.ours, "drive-sync.toml"), "utf8"));

  before(() => (repos = layoutRepos("priorities-")));
  after(() => rmSync(repos.root, { recursive: true, force: true }));

  it("the layout is read with its version", async () => {
    const answer = await askRoutes(routes(), "GET", "/api/layout");
    const view = answer.body as LayoutView;
    assert.equal(answer.status, 200);
    assert.equal(view.version, layoutVersion(testLayout));
    assert.deepEqual(view.folders.map((folder) => [folder.path, folder.priority]), [["Documents", 80], ["Videos", 30]]);
    assert.equal(view.nodes[0].threshold, 50);
  });

  it("setting an entry's priority commits and pushes it, with the dashboard's trailer", async () => {
    const answer = await askRoutes(routes(), "PUT", "/api/priorities", { path: "Videos", priority: 40, base: version() });
    assert.equal(answer.status, 200);
    assert.equal((answer.body as LayoutSaveAnswer).saved.pushed, true);
    assert.match(remoteLayout(), /\[folders.Videos\]\npriority = 40/);
    assert.equal(git(repos.remote, "log", "-1", "--format=%s", "main"), "feat(layout): set the priority of Videos to 40");
    assert.match(git(repos.remote, "log", "-1", "--format=%b", "main"), /Committed-by: storage dashboard/);
    assert.equal((answer.body as LayoutSaveAnswer).layout.version, version());
  });

  it("a save from an older version is refused and changes nothing", async () => {
    const head = git(repos.ours, "rev-parse", "HEAD");
    const answer = await askRoutes(routes(), "PUT", "/api/priorities", { path: "Videos", priority: 20, base: layoutVersion(testLayout) });
    assert.equal(answer.status, 409);
    assert.match((answer.body as { error: string }).error, /changed since this page read it/);
    assert.equal(git(repos.ours, "rev-parse", "HEAD"), head);
  });

  it("a new entry is a folder boundary: previewed with every node's change, refused without the folder ID, saved with it", async () => {
    const preview = await askRoutes(routes(), "POST", "/api/priorities/preview", { path: "Documents/Backup", priority: 80 });
    const shown = preview.body as PriorityPreview;
    assert.equal(shown.boundary, "created");
    assert.equal(shown.folderId, "documents-backup");
    assert.ok(shown.nodes.find((node) => node.nodeId === "a1b2")?.changes.some((text) => text.startsWith("gains the folder")));
    const refused = await askRoutes(routes(), "PUT", "/api/priorities", { path: "Documents/Backup", priority: 80, base: version() });
    assert.equal(refused.status, 409);
    assert.match((refused.body as { error: string }).error, /makes the folder documents-backup \(pc: .*gains the folder.*confirm with the folder ID/);
    assert.doesNotMatch(remoteLayout(), /Backup/);
    const saved = await askRoutes(routes(), "PUT", "/api/priorities", { path: "Documents/Backup", priority: 80, base: version(), confirm: "documents-backup" });
    assert.equal(saved.status, 200);
    assert.match(remoteLayout(), /\[folders."Documents\/Backup"\]\npriority = 80/);
  });

  it("clearing the entry lets the path inherit again, behind the same confirmation", async () => {
    const refused = await askRoutes(routes(), "PUT", "/api/priorities", { path: "Documents/Backup", priority: null, base: version() });
    assert.equal(refused.status, 409);
    const saved = await askRoutes(routes(), "PUT", "/api/priorities", { path: "Documents/Backup", priority: null, base: version(), confirm: "documents-backup" });
    assert.equal(saved.status, 200);
    assert.doesNotMatch(remoteLayout(), /Backup/);
  });

  it("another host's push first is 409, nothing of the save remains, and the layout is pulled", async () => {
    git(repos.theirs, "pull", "-q", "--ff-only");
    writeFileSync(join(repos.theirs, "other.txt"), "x");
    git(repos.theirs, "add", ".");
    git(repos.theirs, "commit", "-q", "-m", "elsewhere");
    git(repos.theirs, "push", "-q");
    const before = readFileSync(join(repos.ours, "drive-sync.toml"), "utf8");
    const answer = await askRoutes(routes(), "PUT", "/api/priorities", { path: "Videos", priority: 45, base: version() });
    assert.equal(answer.status, 409);
    assert.match((answer.body as { error: string }).error, /another host pushed/);
    assert.equal(git(repos.ours, "rev-parse", "HEAD"), git(repos.remote, "rev-parse", "main"));
    assert.equal(readFileSync(join(repos.ours, "drive-sync.toml"), "utf8"), before);
    assert.equal(git(repos.ours, "status", "--porcelain"), "");
  });

  it("an unreachable remote keeps the commit, answered as not pushed yet", async () => {
    const moved = `${repos.remote}-away`;
    renameSync(repos.remote, moved);
    try {
      const answer = await askRoutes(routes(), "PUT", "/api/priorities", { path: "Videos", priority: 55, base: version() });
      assert.equal(answer.status, 200);
      const saved = (answer.body as LayoutSaveAnswer).saved;
      assert.deepEqual([saved.committed, saved.pushed], [true, false]);
      assert.match(saved.message, /not pushed yet/);
      assert.equal(git(repos.ours, "log", "-1", "--format=%s"), "feat(layout): set the priority of Videos to 55");
    } finally {
      renameSync(moved, repos.remote);
    }
  });

  it("a body without a base or with a bad priority is refused before anything is read", async () => {
    assert.equal((await askRoutes(routes(), "PUT", "/api/priorities", { path: "Videos", priority: 5 })).status, 400);
    assert.equal((await askRoutes(routes(), "PUT", "/api/priorities", { path: "Videos", priority: 500, base: version() })).status, 400);
  });
});
