import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type ArrayStatus, type DriveStatus, arrayStatus, listedArrayIds } from "../src/arrayStatus.js";
import { arrayHealth } from "../src/nodes.js";
import { discoveryPollSecondsOf } from "../src/settings.js";

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

  it("a silent mounter's members keep when its last round had them on this host", async () => {
    const healthy = await read(status({ updated: "2026-10-21T12:35:32Z" }));
    assert.ok(healthy.drives.every((entry) => entry.lastPresent?.since === "2026-10-21T00:43:49Z" && entry.lastPresent.at === "2026-10-21T12:35:32Z"));
    const drives = [drive("data1"), drive("data2", { condition: "missing", mounted: false })];
    const degraded = await read(status({ updated: "2026-10-21T12:35:32Z", state: "degraded", complete: false, drives }));
    assert.deepEqual(
      degraded.drives.map((entry) => entry.lastPresent),
      [{ since: "2026-10-21T12:35:32Z", at: "2026-10-21T12:35:32Z" }, undefined],
      "a degraded state's start does not date each member's arrival",
    );
    const fresh = await read(status({}));
    assert.ok(fresh.drives.every((entry) => entry.lastPresent === undefined), "a connected array's members are seen now");
  });

  it("an arrays directory that cannot be listed reads as unknown, not empty", async () => {
    assert.equal(await listedArrayIds(join(directory, "missing")), null);
    await mkdir(join(directory, "arrays", "5784"), { recursive: true });
    assert.deepEqual(await listedArrayIds(join(directory, "arrays")), ["5784"]);
  });

  it("an array whose members are all absent is not connected, not healthy or frozen", async () => {
    const missing = { condition: "missing" as const, mounted: false };
    const absent = await read(status({ state: "stopped", complete: false, present: false, drives: [drive("data1", missing), drive("data2", missing), drive("parity1", missing)] }));
    assert.equal(absent.present, false);
    assert.equal(arrayHealth(absent), "absent");
  });

  it("a status the mounter says is absent stays absent with its reasons, however fresh", async () => {
    const held = await read(status({ state: "stopped", complete: false, present: false, reasons: ["in use by p53"], drives: [] }));
    assert.equal(held.present, false);
    assert.deepEqual(held.reasons, ["in use by p53"]);
    assert.equal(arrayHealth(held), "absent");
  });

  it("a round as long as the discovery poll does not make the array absent", async () => {
    const slow = await read(status({ updated: new Date(now - 6 * 60_000).toISOString() }));
    assert.equal(slow.present, true);
    assert.equal(slow.drives[0].condition, "present");
    const silent = await read(status({ updated: new Date(now - 8 * 60_000).toISOString(), reasons: ["5784-data3 is missing"] }));
    assert.equal(silent.present, false);
    assert.deepEqual(silent.reasons, ["5784-data3 is missing"]);
  });

  it("an array the mounter reports in time keeps its state", async () => {
    const fresh = await read(status({}));
    assert.equal(fresh.present, true);
    assert.equal(fresh.drives[0].condition, "present");
    assert.equal(arrayHealth(fresh), "healthy");
    assert.equal(arrayHealth(await read(status({ state: "stopped" }))), "frozen");
  });
});

describe("the discovery poll the silence check waits on", () => {
  it("an unusable DISCOVERY_POLL_SECONDS takes the default instead of never calling the mounter silent", () => {
    assert.equal(discoveryPollSecondsOf({ DISCOVERY_POLL_SECONDS: "5m" }), 300);
    assert.equal(discoveryPollSecondsOf({ DISCOVERY_POLL_SECONDS: "-1" }), 300);
    assert.equal(discoveryPollSecondsOf({}), 300);
    assert.equal(discoveryPollSecondsOf({ DISCOVERY_POLL_SECONDS: "60" }), 60);
  });
});
