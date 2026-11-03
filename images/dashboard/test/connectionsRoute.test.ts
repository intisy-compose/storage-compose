import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConnectionProfile } from "../src/api/types.js";
import { defaultProfile, formatProfile } from "../src/connectionProfile.js";
import { hostAllowlist } from "../src/http.js";
import { requestHandler } from "../src/routes.js";
import { connectionRoutes } from "../src/routes/connections.js";
import { pullDataRepo, readProfile, saveProfile } from "../src/setupRepo.js";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function cloneOf(remote: string, directory: string): string {
  execFileSync("git", ["clone", "-q", remote, directory], { stdio: "ignore" });
  git(directory, "config", "user.email", "test@example.invalid");
  git(directory, "config", "user.name", "test");
  return directory;
}

function limited(maxSendKbps: number): ConnectionProfile {
  const profile = defaultProfile();
  profile.limits.maxSendKbps = maxSendKbps;
  return profile;
}

describe("the connection profile in the data repo", () => {
  let root: string;
  let remote: string;
  let ours: string;
  let theirs: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "profile-repo-"));
    remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const seed = cloneOf(remote, join(root, "seed"));
    writeFileSync(join(seed, "drive-sync.toml"), "# layout\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "seed");
    git(seed, "push", "-q", "origin", "HEAD:main");
    ours = cloneOf(remote, join(root, "ours"));
    theirs = cloneOf(remote, join(root, "theirs"));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  async function ask(method: string, body: string, appliedProfile: () => ConnectionProfile | null = () => null): Promise<{ status: number; body: string }> {
    const noPeers = { nodes: [], bridges: [], builtAt: "2026-11-02T10:00:00.000Z" };
    const handler = requestHandler(connectionRoutes(ours, { local: async () => noPeers, all: async () => noPeers }, appliedProfile),{ invalidate: () => {}, record: () => {} }, hostAllowlist(["localhost"]));
    const server: Server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      return await new Promise((resolve, reject) => {
        const outgoing = httpRequest({ host: "127.0.0.1", port, method, path: "/api/connections/profile", headers: { Host: "localhost", "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } }, (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        });
        outgoing.on("error", reject);
        outgoing.end(body);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("saving commits and pushes connections.toml", async () => {
    await saveProfile(limited(500), "feat(connections): limit sending", ours);
    assert.equal(git(remote, "show", "main:connections.toml"), formatProfile(limited(500)).trim());
    assert.equal(git(remote, "log", "-1", "--format=%s", "main"), "feat(connections): limit sending");
  });

  it("a push rejected as non-fast-forward leaves the file and answers 409", async () => {
    git(theirs, "pull", "-q", "--ff-only");
    writeFileSync(join(theirs, "other.txt"), "x");
    git(theirs, "add", ".");
    git(theirs, "commit", "-q", "-m", "elsewhere");
    git(theirs, "push", "-q");
    const fileBefore = readFileSync(join(ours, "connections.toml"), "utf8");
    const answer = await ask("PUT", JSON.stringify({ ...limited(900), base: limited(500) }));
    assert.equal(answer.status, 409);
    assert.equal(git(ours, "rev-parse", "HEAD"), git(remote, "rev-parse", "main"));
    assert.equal(readFileSync(join(ours, "connections.toml"), "utf8"), fileBefore);
    assert.equal(git(ours, "status", "--porcelain"), "");
  });

  it("a pull brings another host's profile in", async () => {
    await pullDataRepo(ours);
    writeFileSync(join(theirs, "connections.toml"), formatProfile(limited(1200)));
    git(theirs, "add", ".");
    git(theirs, "commit", "-q", "-m", "their limit");
    git(theirs, "push", "-q");
    await pullDataRepo(ours);
    const read = await readProfile(ours);
    assert.equal(read.profile.limits.maxSendKbps, 1200);
    assert.equal(read.pullProblem, null);
    assert.notEqual(read.pulledAt, null);
  });

  it("a failed pull keeps the last profile and reports pullProblem", async () => {
    const good = await readProfile(ours);
    const moved = `${remote}.gone`;
    renameSync(remote, moved);
    try {
      await pullDataRepo(ours);
      const read = await readProfile(ours);
      assert.equal(read.profile.limits.maxSendKbps, 1200);
      assert.equal(read.pulledAt, good.pulledAt);
      assert.equal(typeof read.pullProblem, "string");
      const headBefore = git(ours, "rev-parse", "HEAD");
      const answer = await ask("PUT", JSON.stringify({ ...limited(1300), base: good.profile }));
      assert.equal(answer.status, 503);
      assert.equal(git(ours, "rev-parse", "HEAD"), headBefore);
      assert.equal(existsSync(join(ours, "connections.toml")) && readFileSync(join(ours, "connections.toml"), "utf8").includes("1300"), false);
    } finally {
      renameSync(moved, remote);
    }
  });

  it("a PUT whose base differs from the file is 409 and commits nothing", async () => {
    await pullDataRepo(ours);
    const headBefore = git(ours, "rev-parse", "HEAD");
    const onDisk = (await readProfile(ours)).profile;
    const answer = await ask("PUT", JSON.stringify({ ...limited(2000), base: limited(onDisk.limits.maxSendKbps + 1) }));
    assert.equal(answer.status, 409);
    assert.equal(JSON.parse(answer.body).error, "the profile changed since you read it; it has been reloaded");
    assert.equal(git(ours, "rev-parse", "HEAD"), headBefore);
    assert.equal((await readProfile(ours)).profile.limits.maxSendKbps, onDisk.limits.maxSendKbps);
    assert.equal((await ask("PUT", JSON.stringify(limited(2000)))).status, 400, "a save names the profile it was made from");
  });

  it("answers 400 to a body that is not a profile, and commits nothing", async () => {
    const headBefore = git(ours, "rev-parse", "HEAD");
    const answer = await ask("PUT", JSON.stringify({ methods: 5 }));
    assert.equal(answer.status, 400);
    assert.equal(git(ours, "rev-parse", "HEAD"), headBefore);
  });

  it("answers 400 naming the key to a negative limit, and commits nothing", async () => {
    await pullDataRepo(ours);
    const headBefore = git(ours, "rev-parse", "HEAD");
    const base = (await readProfile(ours)).profile;
    const answer = await ask("PUT", JSON.stringify({ ...limited(-5), base }));
    assert.equal(answer.status, 400);
    assert.match(JSON.parse(answer.body).error, /limits\.max_send_kbps/);
    assert.equal(git(ours, "rev-parse", "HEAD"), headBefore);
  });

  it("a connections.toml that does not parse is shown with the profile still applied, or with nothing applied", async () => {
    const path = join(ours, "connections.toml");
    const saved = readFileSync(path, "utf8");
    writeFileSync(path, "[limits]\nmax_send_kbps = -5\n");
    try {
      const previous = JSON.parse((await ask("GET", "", () => limited(700))).body);
      assert.equal(previous.profile.limits.maxSendKbps, 700);
      assert.match(previous.profileProblem, /^connections\.toml rejected: limits\.max_send_kbps must be a whole number from 0.*; the previous profile is still applied$/);
      const none = JSON.parse((await ask("GET", "", () => null)).body);
      assert.deepEqual(none.profile, defaultProfile());
      assert.match(none.profileProblem, /^connections\.toml cannot be read: limits\.max_send_kbps .*; nothing applied$/);
    } finally {
      writeFileSync(path, saved);
    }
    assert.equal(JSON.parse((await ask("GET", "")).body).profileProblem, null);
  });

  function pushHandEdit(text: string): void {
    writeFileSync(join(ours, "connections.toml"), text);
    git(ours, "add", "connections.toml");
    git(ours, "commit", "-q", "-m", "hand edit");
    git(ours, "push", "-q", "origin", "HEAD:main");
  }

  it("a save made from the view of a connections.toml that does not parse repairs the file", async () => {
    await pullDataRepo(ours);
    pushHandEdit("[limits]\nmax_send_kbps = -5\n");
    const applied = () => limited(700);
    const view = JSON.parse((await ask("GET", "", applied)).body);
    assert.notEqual(view.profileProblem, null);
    const answer = await ask("PUT", JSON.stringify({ ...limited(900), base: view.profile }), applied);
    assert.equal(answer.status, 200, answer.body);
    assert.equal(JSON.parse(answer.body).profileProblem, null);
    assert.equal((await readProfile(ours)).profile.limits.maxSendKbps, 900);
    assert.equal(git(remote, "show", "main:connections.toml"), formatProfile(limited(900)).trim());
    assert.equal(JSON.parse((await ask("GET", "", applied)).body).profileProblem, null);
  });

  it("a save over a connections.toml that does not parse is still 409 when its base is not the profile shown", async () => {
    await pullDataRepo(ours);
    const broken = "[limits\nmax_send_kbps = 1\n";
    pushHandEdit(broken);
    const applied = () => limited(700);
    const view = JSON.parse((await ask("GET", "", applied)).body);
    assert.match(view.profileProblem, /^connections\.toml rejected: line 2: unclosed table header;/);
    const headBefore = git(ours, "rev-parse", "HEAD");
    const answer = await ask("PUT", JSON.stringify({ ...limited(900), base: limited(701) }), applied);
    assert.equal(answer.status, 409);
    assert.equal(JSON.parse(answer.body).error, "the profile changed since you read it; it has been reloaded");
    assert.equal(git(ours, "rev-parse", "HEAD"), headBefore);
    assert.equal(readFileSync(join(ours, "connections.toml"), "utf8"), broken);
    const repaired = await ask("PUT", JSON.stringify({ ...limited(900), base: defaultProfile() }), () => null);
    assert.equal(repaired.status, 200, "with nothing ever applied the defaults stand in");
  });
});
