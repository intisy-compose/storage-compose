import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type ArrayStatus, type DriveStatus, arrayStatus } from "../src/arrayStatus.js";
import { arrayHealth } from "../src/nodes.js";

const now = Date.parse("2026-10-26T13:30:00Z");

function drive(role: string, overrides: Partial<DriveStatus> = {}): DriveStatus {
  return { label: `5784-${role}`, role, condition: "present", detail: "", asset: null, mounted: true, size: 1000, used: 500, serial: null, ...overrides };
}

function status(overrides: Partial<ArrayStatus>): ArrayStatus {
  return {
    id: "5784",
    name: "private-array",
    node: "finn",
    updated: "2026-10-26T13:29:55Z",
    state: "healthy",
    since: "2026-10-21T00:43:49Z",
    complete: true,
    present: true,
    reasons: [],
    drives: [drive("data1"), drive("data2"), drive("parity1")],
    splitFolders: [],
    pausedFolders: [],
    description: null,
    ...overrides,
  };
}

describe("array status", () => {
  let directory: string;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "array-status-"));
  });

  after(() => rm(directory, { recursive: true, force: true }));

  async function read(written: ArrayStatus): Promise<ArrayStatus> {
    await writeFile(join(directory, "status.json"), JSON.stringify(written));
    return (await arrayStatus("5784", directory, now))!;
  }

  it("an array whose mounter stopped reporting has every member absent and reads not connected", async () => {
    const silent = await read(status({ updated: "2026-10-21T12:35:32Z" }));
    assert.equal(silent.present, false);
    assert.equal(silent.complete, false);
    assert.ok(silent.drives.every((entry) => entry.condition === "missing" && !entry.mounted));
    assert.ok(silent.drives.every((entry) => entry.detail === "not connected since 2026-10-21T12:35:32Z"));
    assert.equal(arrayHealth(silent), "absent");
  });

  it("an array whose members are all absent is not connected, not healthy or frozen", async () => {
    const missing = { condition: "missing" as const, mounted: false };
    const absent = await read(status({ state: "stopped", complete: false, present: false, drives: [drive("data1", missing), drive("data2", missing), drive("parity1", missing)] }));
    assert.equal(absent.present, false);
    assert.equal(arrayHealth(absent), "absent");
  });

  it("an array the mounter reports in time keeps its state", async () => {
    const fresh = await read(status({}));
    assert.equal(fresh.present, true);
    assert.equal(fresh.drives[0].condition, "present");
    assert.equal(arrayHealth(fresh), "healthy");
    assert.equal(arrayHealth(await read(status({ state: "stopped" }))), "frozen");
  });
});
