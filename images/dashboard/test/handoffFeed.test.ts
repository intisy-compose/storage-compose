import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { KeeperState } from "../src/handoffPlan.js";
import {
  type HandoffContract,
  type HandoffInput,
  type HandoffReads,
  type IndexEntry,
  decideHandoffContract,
  emptyContract,
  handoffContractSchema,
  modifiedSecondsOf,
  readHandoffContract,
  writeHandoffContract,
} from "../src/handoffFeed.js";
import { hostAllowlist } from "../src/http.js";
import type { LocalInstance } from "../src/instanceResolver.js";
import { requestHandler } from "../src/routes.js";
import { handoffRoutes } from "../src/routes/handoff.js";
import { nodePlan } from "../src/nodePlan.js";
import type { SpaceDecision } from "../src/spacePlan.js";
import { type SetupLayout, parseLayout } from "../src/setupRepo.js";
import type { SyncthingClient } from "../src/syncthing.js";

function layoutText(apply = true): string {
  return `
[devices.stick]
id   = "STICK-ID"
root = "/media/stick"

[devices.laptop]
id   = "LAPTOP-ID"
root = "/home/someone"

[devices.array]
id   = "ARRAY-ID"
role = "archive"
root = "/mnt/storage/pool"

[folders.Videos]
priority = 30

[folders.Work]
priority = 80

[nodes.b001]
name      = "stick"
device    = "stick"
threshold = 80
admitted  = true
apply     = ${apply}

[nodes.a002]
name      = "laptop"
device    = "laptop"
threshold = 20
admitted  = true

[nodes.c1c1]
name      = "private-array"
device    = "array"
threshold = 0
admitted  = true
apply     = true
`;
}

const now = new Date("2026-11-05T12:00:00Z");
const anHourAgo = "2026-11-05T11:00:00.123456789Z";

function instance(nodeId: string): LocalInstance {
  return { kind: "local", nodeId, name: nodeId, client: {} as SyncthingClient, root: "/", os: "linux", threshold: 0, source: "registry" };
}

function entry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return { type: "FILE_INFO_TYPE_FILE", version: ["STICK:3"], size: 1200, numBlocks: 1, blocksHash: "hash-a", modified: anHourAgo, deleted: false, ignored: false, invalid: false, ...overrides };
}

interface FakeNode {
  files: Record<string, Record<string, IndexEntry>>;
  completion: Record<string, number>;
  state: KeeperState;
  space: { totalBytes: number; freeBytes: number } | null;
  fails?: boolean;
}

/** In-memory reads for each node; `reads` counts every call, `afterFirstEntry` changes an entry once it has been read once. */
class FakeReads implements HandoffReads {
  calls = 0;
  readonly entryReads = new Map<string, number>();
  changeOnSecondRead: { nodeId: string; folderId: string; path: string; to: IndexEntry } | null = null;

  constructor(readonly nodes: Record<string, FakeNode>) {}

  private node(instance: LocalInstance): FakeNode {
    this.calls++;
    const node = this.nodes[instance.nodeId];
    if (!node || node.fails) throw new Error(`${instance.nodeId} does not answer`);
    return node;
  }

  async files(instance: LocalInstance, folderId: string) {
    return Object.entries(this.node(instance).files[folderId] ?? {}).map(([path, file]) => ({ path, modified: file.modified }));
  }

  async entry(instance: LocalInstance, folderId: string, path: string) {
    const node = this.node(instance);
    const key = `${instance.nodeId} ${folderId} ${path}`;
    const count = (this.entryReads.get(key) ?? 0) + 1;
    this.entryReads.set(key, count);
    const change = this.changeOnSecondRead;
    if (change && count >= 2 && change.nodeId === instance.nodeId && change.folderId === folderId && change.path === path) return change.to;
    return node.files[folderId]?.[path] ?? null;
  }

  async completion(instance: LocalInstance, folderId: string) {
    return this.node(instance).completion[folderId] ?? 0;
  }

  async sizes(instance: LocalInstance, folderId: string) {
    this.node(instance);
    return { globalBytes: folderId === "work" ? 1000 : 5000, localBytes: 1000 };
  }

  async space(instance: LocalInstance) {
    return this.node(instance).space;
  }

  async keeperState(instance: LocalInstance) {
    return this.node(instance).state;
  }
}

const roomy = { totalBytes: 1_000_000, freeBytes: 900_000 };

function network(overrides: Partial<Record<"stick" | "laptop", Partial<FakeNode>>> = {}): FakeReads {
  return new FakeReads({
    b001: { files: { videos: { "clip.mp4": entry() } }, completion: {}, state: "ok", space: roomy, ...overrides.stick },
    a002: { files: { videos: { "clip.mp4": entry() } }, completion: { videos: 100 }, state: "ok", space: roomy, ...overrides.laptop },
  });
}

function inputFor(layout: SetupLayout, reads: HandoffReads, nodeId = "b001", overrides: Partial<HandoffInput> = {}): HandoffInput {
  return { layout, nodeId, localFolders: new Set(["Videos", "Work"]), instance: instance(nodeId), instances: [instance("b001"), instance("a002")], reads, now: () => now, ...overrides };
}

describe("the hand-off contract", () => {
  it("records each confirmed file's version, size, block count, hash and modification time with its keeper", async () => {
    const contract = await decideHandoffContract(inputFor(parseLayout(layoutText()), network()));

    assert.equal(contract.schema, handoffContractSchema);
    assert.equal(contract.nodeId, "b001");
    assert.equal(contract.writtenAt, "2026-11-05T12:00:00.000Z");
    assert.equal(contract.apply, true);
    assert.equal(contract.cluster, false);
    assert.equal(contract.quietMinutes, 10);
    assert.deepEqual(contract.entries, [
      {
        folderId: "videos",
        folderPath: "/media/stick/Videos",
        path: "clip.mp4",
        type: "FILE_INFO_TYPE_FILE",
        version: ["STICK:3"],
        size: 1200,
        numBlocks: 1,
        blocksHash: "hash-a",
        modified: anHourAgo,
        modifiedSeconds: Date.parse("2026-11-05T11:00:00Z") / 1000,
        keeper: "a002",
        keeperDevice: "LAPTOP-ID",
      },
    ]);
  });

  it("gives a node with apply = false an empty list and reads nothing", async () => {
    const reads = network();
    const contract = await decideHandoffContract(inputFor(parseLayout(layoutText(false)), reads));

    assert.deepEqual([contract.apply, contract.trashOnly], [false, undefined], "a node that only reports gets no trash-only contract: its executor runs nothing");
    assert.deepEqual(contract.entries, []);
    assert.equal(reads.calls, 0);
  });

  it("gives the cluster an empty list, whatever its apply", async () => {
    const reads = network();
    const contract = await decideHandoffContract(inputFor(parseLayout(layoutText()), reads, "c1c1", { localFolders: new Set() }));

    assert.equal(contract.cluster, true);
    assert.deepEqual(contract.entries, []);
    assert.equal(reads.calls, 0);
  });

  it("leaves out a file whose own entry changed between the candidate read and the decision", async () => {
    const reads = network();
    reads.changeOnSecondRead = { nodeId: "b001", folderId: "videos", path: "clip.mp4", to: entry({ version: ["STICK:4"], blocksHash: "hash-b" }) };

    const contract = await decideHandoffContract(inputFor(parseLayout(layoutText()), reads));

    assert.deepEqual(contract.entries, []);
    assert.deepEqual(contract.waiting.map((waiting) => `${waiting.path} ${waiting.reason}`), ["clip.mp4 changed"]);
  });

  it("never takes a record from an entry that is already ignored, which reads size 0 and no hash", async () => {
    const ignored = entry({ ignored: true, invalid: true, size: 0, numBlocks: 0, blocksHash: null });
    const reads = network({ stick: { files: { videos: { "clip.mp4": ignored } } } });

    const contract = await decideHandoffContract(inputFor(parseLayout(layoutText()), reads));

    assert.deepEqual(contract.entries, []);
    assert.deepEqual(contract.waiting, []);
  });

  it("takes a deleted or invalid entry, a directory and a file without a hash for no record", async () => {
    const files = {
      "gone.mp4": entry({ deleted: true }),
      "bad.mp4": entry({ invalid: true }),
      folder: entry({ type: "FILE_INFO_TYPE_DIRECTORY" }),
      "nohash.mp4": entry({ blocksHash: null }),
    };
    const reads = network({ stick: { files: { videos: files } }, laptop: { files: { videos: files } } });

    const contract = await decideHandoffContract(inputFor(parseLayout(layoutText()), reads));

    assert.deepEqual(contract.entries, []);
  });

  it("holds everything while the node's space cannot be read: the contract is not in apply mode, so not even a pending path moves", async () => {
    const contract = await decideHandoffContract(inputFor(parseLayout(layoutText()), network({ stick: { space: null } })));

    assert.deepEqual([contract.apply, contract.entries], [false, []]);
    assert.match(contract.notes.join(" "), /space cannot be read/);
  });

  it("holds everything while the round's space decision is stopped or unknown, or the node is not enabled", async () => {
    const decided = (state: "stopped" | "unknown") => ({ decision: { state, threshold: 80, neededBytes: 1, availableBytes: 0, handoffAllowed: false, pullAllowed: false } });
    const cases: [string, HandoffInput, RegExp][] = [
      ["stopped", inputFor(parseLayout(layoutText()), network(), "b001", { decided: decided("stopped") }), /space decision is stopped/],
      ["unknown", inputFor(parseLayout(layoutText()), network(), "b001", { decided: decided("unknown") }), /space decision is unknown/],
      ["no decision", inputFor(parseLayout(layoutText()), network(), "b001", { decided: { decision: null } }), /space cannot be read/],
      ["disabled", inputFor(parseLayout(layoutText().replace("apply     = true", "apply     = true\nenabled   = false")), network()), /stick is not enabled/],
    ];
    for (const [name, input, note] of cases) {
      const contract = await decideHandoffContract(input);
      assert.deepEqual([contract.apply, contract.trashOnly, contract.entries, contract.waiting], [false, true, [], []], name);
      assert.match(contract.notes.join(" "), note, name);
    }
  });

  it("decides with the round's decision when it allows hand-offs, without reading the space again", async () => {
    const reads = network({ stick: { space: null } });
    const contract = await decideHandoffContract(inputFor(parseLayout(layoutText()), reads, "b001", { decided: { decision: { state: "fits", threshold: 80, neededBytes: 0, availableBytes: 1, handoffAllowed: true, pullAllowed: true } } }));

    assert.equal(contract.apply, true);
    assert.equal(contract.entries.length, 1);
  });

  it("waits for a keeper whose Syncthing does not answer", async () => {
    const contract = await decideHandoffContract(inputFor(parseLayout(layoutText()), network({ laptop: { fails: true } })));

    assert.deepEqual(contract.entries, []);
    assert.deepEqual(contract.waiting.map((waiting) => waiting.reason), ["keeper-offline"]);
  });

  it("waits for a keeper that is frozen or not complete", async () => {
    for (const laptop of [{ state: "frozen" as const }, { completion: { videos: 99 } }]) {
      const contract = await decideHandoffContract(inputFor(parseLayout(layoutText()), network({ laptop })));
      assert.deepEqual(contract.entries, [], JSON.stringify(laptop));
    }
  });

  it("takes each keeper's state and threshold from its own space decision this round", async () => {
    const decision = (state: SpaceDecision["state"], threshold: number): SpaceDecision => ({ state, threshold, neededBytes: 0, availableBytes: 0, handoffAllowed: state === "fits" || state === "raised", pullAllowed: state === "fits" || state === "raised" });
    const withKeeper = (space: SpaceDecision | null) => inputFor(parseLayout(layoutText()), network(), "b001", { keeperSpace: (nodeId) => (nodeId === "a002" ? space : null) });

    assert.equal((await decideHandoffContract(withKeeper(decision("fits", 20)))).entries.length, 1);
    assert.equal((await decideHandoffContract(withKeeper(null))).entries.length, 1, "a keeper whose space is not known still confirms what it already holds");
    const stopped = await decideHandoffContract(withKeeper(decision("stopped", 20)));
    assert.deepEqual([stopped.entries, stopped.waiting.map((entry) => entry.reason)], [[], ["not-confirmed"]], "a stopped keeper is paused, so it confirms nothing");
    const raised = await decideHandoffContract(withKeeper(decision("raised", 50)));
    assert.deepEqual([raised.entries, raised.waiting.map((entry) => entry.reason)], [[], ["keeper-offline"]], "raised past Videos, the laptop keeps it no more; only the cluster does");
  });

  it("waits for a file changed within the quiet period", async () => {
    const recent = entry({ modified: "2026-11-05T11:55:00Z" });
    const reads = network({ stick: { files: { videos: { "clip.mp4": recent } } }, laptop: { files: { videos: { "clip.mp4": recent } } } });

    const contract = await decideHandoffContract(inputFor(parseLayout(layoutText()), reads));

    assert.deepEqual(contract.entries, []);
  });

  it("takes at most a batch of files per round", async () => {
    const files = Object.fromEntries(["a", "b", "c"].map((name) => [`${name}.mp4`, entry()]));
    const reads = network({ stick: { files: { videos: files } }, laptop: { files: { videos: files } } });

    const contract = await decideHandoffContract(inputFor(parseLayout(layoutText()), reads, "b001", { batch: 2 }));

    assert.equal(contract.entries.length, 2);
  });

  it("never offers a file of a folder the node keeps", async () => {
    const reads = network({ stick: { files: { work: { "plan.txt": entry() } } }, laptop: { files: { work: { "plan.txt": entry() } }, completion: { work: 100 } } });

    const contract = await decideHandoffContract(inputFor(parseLayout(layoutText()), reads));

    assert.deepEqual(contract.entries, []);
  });

  it("is empty when the node's Syncthing does not answer", async () => {
    const contract = await decideHandoffContract(inputFor(parseLayout(layoutText()), network({ stick: { fails: true } })));

    assert.deepEqual(contract.entries, []);
    assert.match(contract.notes.join(" "), /does not answer/);
  });

  it("is empty for a node with a blocking layout problem", async () => {
    const layout = parseLayout(layoutText().replace('name      = "laptop"', 'name      = "stick"'));
    assert.ok(nodePlan(layout, "b001", new Set())?.problems.length);
    const reads = network();

    const contract = await decideHandoffContract(inputFor(layout, reads));

    assert.deepEqual(contract.entries, []);
    assert.equal(reads.calls, 0);
  });
});

describe("modification times", () => {
  it("reads whole seconds from Syncthing's nanosecond times in any offset", () => {
    assert.equal(modifiedSecondsOf("2026-11-05T11:00:00.999999999Z"), Date.parse("2026-11-05T11:00:00Z") / 1000);
    assert.equal(modifiedSecondsOf("2026-11-05T12:00:00.5+01:00"), Date.parse("2026-11-05T11:00:00Z") / 1000);
    assert.equal(modifiedSecondsOf("2026-11-05T11:00:00Z"), Date.parse("2026-11-05T11:00:00Z") / 1000);
    assert.equal(modifiedSecondsOf("1969-12-31T23:59:59.5Z"), -1);
    assert.equal(modifiedSecondsOf("yesterday"), null);
  });
});

describe("the contract file", () => {
  const scratch = mkdtempSync(join(tmpdir(), "handoff-feed-"));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it("is replaced in one rename and reads back as written", async () => {
    const path = join(scratch, "handoff", "b001.json");
    const contract: HandoffContract = { ...emptyContract("b001", true, false, now), notes: ["first"] };

    await writeHandoffContract(path, contract);
    await writeHandoffContract(path, { ...contract, notes: ["second"] });

    assert.deepEqual(await readHandoffContract(path), { ...contract, notes: ["second"] });
    assert.deepEqual(readdirSync(join(scratch, "handoff")), ["b001.json"]);
    assert.ok(readFileSync(path, "utf8").endsWith("\n"));
  });

  it("reads a missing or malformed file as none", async () => {
    assert.equal(await readHandoffContract(join(scratch, "missing.json")), null);
    assert.ok(!existsSync(join(scratch, "missing.json")));
  });
});

describe("GET /api/handoff/node/<id>", () => {
  async function ask(path: string, contracts: Record<string, HandoffContract>): Promise<{ status: number; body: unknown }> {
    const handler = requestHandler(handoffRoutes((nodeId) => contracts[nodeId] ?? null), { invalidate: () => {}, record: () => {} }, hostAllowlist(["localhost", "127.0.0.1"]));
    const server: Server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
      return { status: response.status, body: await response.json() };
    } finally {
      server.close();
    }
  }

  it("serves the contract this host last wrote for the node", async () => {
    const contract = emptyContract("b001", false, false, now);

    assert.deepEqual(await ask("/api/handoff/node/b001", { b001: contract }), { status: 200, body: contract });
  });

  it("is 404 for a node this host wrote none for", async () => {
    const answer = await ask("/api/handoff/node/b002", {});

    assert.equal(answer.status, 404);
    assert.match(String((answer.body as { error: string }).error), /no hand-off contract for node b002/);
  });
});
