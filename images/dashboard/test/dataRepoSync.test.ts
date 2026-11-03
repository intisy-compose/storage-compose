import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ConnectionProfile } from "../src/api/types.js";
import { defaultProfile, formatProfile } from "../src/connectionProfile.js";
import { readProfile, saveProfile } from "../src/setupRepo.js";

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

function commitFile(directory: string, file: string, text: string, message: string): string {
  writeFileSync(join(directory, file), text);
  git(directory, "add", file);
  git(directory, "commit", "-q", "-m", message);
  return git(directory, "rev-parse", "HEAD");
}

describe("keeping the data repo in step with its remote", () => {
  let root: string;
  let remote: string;
  let ours: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "data-repo-sync-"));
    remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const seed = cloneOf(remote, join(root, "seed"));
    commitFile(seed, "drive-sync.toml", "# layout\n", "seed");
    git(seed, "push", "-q", "origin", "HEAD:main");
    ours = cloneOf(remote, join(root, "ours"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe("a save the commit already holds", () => {
    it("puts the committed profile back over a stale file on disk", async () => {
      await saveProfile(limited(500), "feat(connections): limit sending", ours);
      const head = git(ours, "rev-parse", "HEAD");
      writeFileSync(join(ours, "connections.toml"), formatProfile(limited(700)));
      await saveProfile(limited(500), "feat(connections): limit sending", ours);
      assert.equal(git(ours, "rev-parse", "HEAD"), head);
      assert.equal(git(ours, "status", "--porcelain"), "");
      assert.equal((await readProfile(ours)).profile.limits.maxSendKbps, 500);
    });
  });
});
