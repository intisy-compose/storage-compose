import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ConnectionProfile } from "../src/api/types.js";
import { defaultProfile, formatProfile } from "../src/connectionProfile.js";
import { RequestError } from "../src/http.js";
import { ProfileStuck, pullDataRepo, readProfile, recordDevice, saveProfile } from "../src/setupRepo.js";

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

  async function strandAdmission(name: string): Promise<string> {
    const result = await recordDevice(name, `${name.toUpperCase()}-ID`, null, ours);
    assert.equal(result.committed, true);
    assert.equal(result.pushed, false);
    return git(ours, "rev-parse", "HEAD");
  }

  describe("a pull that cannot fast-forward", () => {
    it("rebases the dashboard's own unpushed admission onto the remote and pushes it", async () => {
      pushElsewhere("other.txt", "x", "elsewhere");
      await strandAdmission("box");
      pushElsewhere("more.txt", "y", "elsewhere again");
      await pullDataRepo(ours);
      const read = await readProfile(ours);
      assert.equal(read.pullProblem, null);
      assert.notEqual(read.pulledAt, null);
      assert.equal(git(ours, "rev-parse", "HEAD"), git(remote, "rev-parse", "main"));
      assert.match(git(remote, "log", "-1", "--format=%s", "main"), /admit box/);
      assert.match(readFileSync(join(ours, "more.txt"), "utf8"), /y/);
      assert.equal(git(ours, "status", "--porcelain"), "");
    });

    it("rebases an admission committed before the dashboard marked its commits", async () => {
      const legacy = commitFile(ours, "drive-sync.toml", '[devices.old]\nid = "OLD"\njoined = true\n\n# layout\n', "feat(devices): admit old to the storage network");
      pushElsewhere("other.txt", "x", "elsewhere");
      await pullDataRepo(ours);
      assert.equal((await readProfile(ours)).pullProblem, null);
      assert.equal(git(ours, "rev-parse", "HEAD"), git(remote, "rev-parse", "main"));
      assert.notEqual(git(ours, "rev-parse", "HEAD"), legacy);
      assert.match(git(remote, "log", "-1", "--format=%s", "main"), /admit old/);
    });

    it("leaves a commit that is not the dashboard's alone and names it", async () => {
      const foreign = commitFile(ours, "notes.txt", "mine", "docs: a note made by hand");
      pushElsewhere("other.txt", "x", "elsewhere");
      await pullDataRepo(ours);
      const read = await readProfile(ours);
      assert.equal(git(ours, "rev-parse", "HEAD"), foreign);
      assert.match(read.pullProblem ?? "", new RegExp(shortCommit(ours, foreign)));
      assert.match(read.pullProblem ?? "", /not the dashboard's/);
    });

    it("leaves a dashboard commit beneath a foreign one alone", async () => {
      pushElsewhere("other.txt", "x", "elsewhere");
      const admission = await strandAdmission("box");
      const foreign = commitFile(ours, "notes.txt", "mine", "docs: a note made by hand");
      pushElsewhere("more.txt", "y", "elsewhere again");
      await pullDataRepo(ours);
      assert.equal(git(ours, "rev-parse", "HEAD"), foreign);
      assert.equal(git(ours, "rev-parse", "HEAD~1"), admission);
      assert.match((await readProfile(ours)).pullProblem ?? "", new RegExp(shortCommit(ours, foreign)));
    });

    it("aborts a rebase that conflicts and names the stuck commit", async () => {
      pushElsewhere("other.txt", "x", "elsewhere");
      const admission = await strandAdmission("box");
      pushElsewhere("drive-sync.toml", '[devices.box]\nid = "THEIRS"\njoined = true\n\n# layout\n', "feat(devices): admit box elsewhere");
      await pullDataRepo(ours);
      const read = await readProfile(ours);
      assert.equal(git(ours, "rev-parse", "HEAD"), admission);
      assert.equal(git(ours, "status", "--porcelain"), "");
      assert.match(read.pullProblem ?? "", new RegExp(shortCommit(ours, admission)));
      assert.match(read.pullProblem ?? "", /conflicts/);
    });

    it("lets a save through once the pull has recovered", async () => {
      pushElsewhere("other.txt", "x", "elsewhere");
      await strandAdmission("box");
      pushElsewhere("more.txt", "y", "elsewhere again");
      await pullDataRepo(ours);
      await saveProfile(limited(600), "feat(connections): limit sending", ours, defaultProfile());
      assert.equal(git(remote, "show", "main:connections.toml"), formatProfile(limited(600)).trim());
    });
  });

  describe("the dashboard's commits a pull leaves unpushed", () => {
    function refusePushes(refuse: boolean): void {
      const hook = join(ours, ".git", "hooks", "pre-push");
      if (refuse) writeFileSync(hook, ["#!/bin/sh", "exit 1", ""].join("\n"), { mode: 0o755 });
      else rmSync(hook, { force: true });
    }

    it("keeps naming them on every round until a push takes them", async () => {
      pushElsewhere("other.txt", "x", "elsewhere");
      await strandAdmission("box");
      pushElsewhere("more.txt", "y", "elsewhere again");
      refusePushes(true);
      await pullDataRepo(ours);
      const rebased = shortCommit(ours, "HEAD");
      assert.match((await readProfile(ours)).pullProblem ?? "", new RegExp(`${rebased}.*not pushed yet`));
      await pullDataRepo(ours);
      assert.match((await readProfile(ours)).pullProblem ?? "", new RegExp(`${rebased}.*not pushed yet`));
      refusePushes(false);
      await pullDataRepo(ours);
      assert.equal((await readProfile(ours)).pullProblem, null);
      assert.equal(git(remote, "rev-parse", "main"), git(ours, "rev-parse", "HEAD"));
    });

    it("pushes an admission whose own push failed once the remote is reachable again", async () => {
      refusePushes(true);
      const admission = (await recordDevice("box", "BOX-ID", null, ours)).pushed;
      assert.equal(admission, false);
      refusePushes(false);
      await pullDataRepo(ours);
      assert.equal((await readProfile(ours)).pullProblem, null);
      assert.match(git(remote, "log", "-1", "--format=%s", "main"), /admit box/);
    });

    it("names a commit that is not the dashboard's and pushes nothing", async () => {
      const foreign = commitFile(ours, "notes.txt", "mine", "docs: a note made by hand");
      const remoteBefore = git(remote, "rev-parse", "main");
      await pullDataRepo(ours);
      assert.equal(git(remote, "rev-parse", "main"), remoteBefore);
      assert.match((await readProfile(ours)).pullProblem ?? "", new RegExp(`${shortCommit(ours, foreign)}.*not the dashboard's`));
    });
  });

  describe("a rebase left in progress in the data repo", () => {
    function leaveRebase(directory: string): string {
      const path = join(ours, ".git", directory);
      mkdirSync(path);
      writeFileSync(join(path, "head-name"), "refs/heads/main\n");
      return path;
    }

    for (const directory of ["rebase-merge", "rebase-apply"]) {
      it(`stops a pull and names the ${directory} left behind, without aborting it`, async () => {
        const path = leaveRebase(directory);
        pushElsewhere("other.txt", "x", "elsewhere");
        const head = git(ours, "rev-parse", "HEAD");
        await pullDataRepo(ours);
        const problem = (await readProfile(ours)).pullProblem ?? "";
        assert.match(problem, new RegExp(directory));
        assert.match(problem, /git rebase --abort/);
        assert.equal(git(ours, "rev-parse", "HEAD"), head);
        assert.equal(existsSync(path), true);
      });
    }

    it("refuses a save with 503 and commits nothing", async () => {
      leaveRebase("rebase-merge");
      const head = git(ours, "rev-parse", "HEAD");
      const error = await saveProfile(limited(500), "feat(connections): limit sending", ours).then(
        () => assert.fail("the save was refused"),
        (refusal: unknown) => refusal,
      );
      assert.equal((error as RequestError).status, 503);
      assert.match((error as Error).message, /git rebase --abort/);
      assert.equal(git(ours, "rev-parse", "HEAD"), head);
      assert.equal(existsSync(join(ours, "connections.toml")), false);
    });

    it("records no admission and says why", async () => {
      leaveRebase("rebase-merge");
      const head = git(ours, "rev-parse", "HEAD");
      const result = await recordDevice("box", "BOX-ID", null, ours);
      assert.equal(result.committed, false);
      assert.match(result.message, /git rebase --abort/);
      assert.equal(git(ours, "rev-parse", "HEAD"), head);
      assert.equal(git(ours, "status", "--porcelain"), "");
    });
  });

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
