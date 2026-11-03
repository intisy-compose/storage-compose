import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ConnectionProfile } from "../src/api/types.js";
import { defaultProfile, formatProfile } from "../src/connectionProfile.js";
import { RequestError } from "../src/http.js";
import { ProfileStuck, readProfile, saveProfile } from "../src/setupRepo.js";

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

function shortCommit(directory: string, commit: string): string {
  return git(directory, "rev-parse", "--short", commit);
}

describe("keeping the data repo in step with its remote", () => {
  let root: string;
  let remote: string;
  let ours: string;
  let theirs: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "data-repo-sync-"));
    remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const seed = cloneOf(remote, join(root, "seed"));
    commitFile(seed, "drive-sync.toml", "# layout\n", "seed");
    git(seed, "push", "-q", "origin", "HEAD:main");
    ours = cloneOf(remote, join(root, "ours"));
    theirs = cloneOf(remote, join(root, "theirs"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function pushElsewhere(file: string, text: string, message: string): void {
    git(theirs, "pull", "-q", "--ff-only");
    commitFile(theirs, file, text, message);
    git(theirs, "push", "-q");
  }

  describe("a save whose commit cannot be undone", () => {
    it("answers 503 naming the commit left unpushed, and keeps the file as committed", async () => {
      pushElsewhere("other.txt", "x", "elsewhere");
      writeFileSync(join(ours, ".git", "hooks", "pre-push"), ["#!/bin/sh", "git commit -q --allow-empty -m interleaved", ""].join("\n"), { mode: 0o755 });
      const error = await saveProfile(limited(1500), "feat(connections): stale save", ours).then(
        () => assert.fail("the save was refused"),
        (refusal: unknown) => refusal,
      );
      assert.ok(error instanceof ProfileStuck);
      assert.equal((error as RequestError).status, 503);
      const saved = git(ours, "rev-parse", "HEAD~1");
      assert.equal(git(ours, "log", "-1", "--format=%s", saved), "feat(connections): stale save");
      assert.equal(git(ours, "log", "-1", "--format=%s"), "interleaved");
      assert.match((error as Error).message, new RegExp(shortCommit(ours, saved)));
      assert.doesNotMatch((error as Error).message, /nothing of the save remains/);
      assert.equal(git(ours, "status", "--porcelain"), "");
    });
  });

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
