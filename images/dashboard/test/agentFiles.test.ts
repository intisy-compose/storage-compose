import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { agentHandoffFiles, agentNodeFiles } from "../src/agentFiles.js";
import type { LocalInstance } from "../src/instanceResolver.js";
import type { LayoutNode } from "../src/setupRepo.js";

const now = new Date("2026-11-08T12:00:00Z");
const instance = { nodeId: "d1e2", os: "windows" } as LocalInstance;
const policy = { threshold: 50, assigned: ["Pictures"], access: "open" } as unknown as LayoutNode;
const read = (directory: string, name: string) => JSON.parse(readFileSync(join(directory, name), "utf8"));

describe("the policy the round leaves a Windows node", () => {
  it("follows with the committed policy and withdraws on any other answer, the host agent's file carrying its time", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-policy-"));
    const files = agentNodeFiles(directory, () => now);

    assert.equal(await files.follow(instance, policy), true);
    const written = read(directory, "d1e2.policy.json");
    assert.equal(written.action, "follow");
    assert.deepEqual(written.policy, { threshold: 50, assigned: ["Pictures"], access: "open" });
    assert.equal(written.writtenAt, now.toISOString());

    assert.equal(await files.follow(instance, policy), false, "written again each round but no Activity entry");
    assert.equal(await files.withdraw(instance, "not admitted"), true);
    const withdrawn = read(directory, "d1e2.policy.json");
    assert.equal(withdrawn.action, "withdraw");
    assert.equal(withdrawn.reason, "not admitted");
  });
});

describe("the hand-off list on a Windows node", () => {
  it("is asked of the host agent and waits until the agent says it exists at that path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-lists-"));
    const files = agentHandoffFiles(directory, () => now);
    const folder = { id: "essential", path: "E:\\Essential" };

    assert.match((await files.ensure(instance, folder)) ?? "", /creates it/);
    assert.deepEqual(read(directory, "d1e2.lists.json").folders, { essential: "E:\\Essential" });

    writeFileSync(join(directory, "d1e2.lists.result.json"), JSON.stringify({ folders: { essential: { path: "E:\\Essential", state: "ready" } } }));
    assert.equal(await files.ensure(instance, folder), null);
  });

  it("reports what the agent refused, and does not count a list at another path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-lists-"));
    const files = agentHandoffFiles(directory, () => now);
    writeFileSync(join(directory, "d1e2.lists.result.json"), JSON.stringify({ folders: { essential: { path: "E:\\Essential", state: "refused", problem: "it is a link" } } }));

    assert.match((await files.ensure(instance, { id: "essential", path: "E:\\Essential" })) ?? "", /could not create it: it is a link/);
    assert.notEqual(await files.ensure(instance, { id: "essential", path: "E:\\Other" }), null);
  });
});
