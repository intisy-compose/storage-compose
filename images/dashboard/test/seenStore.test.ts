import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Peer } from "../src/api/types.js";
import { syncthingOnlyNodes } from "../src/nodes.js";
import { type DeviceSeen, SeenStore, recordDevices, rememberedLocalDeviceIds } from "../src/seenStore.js";
import type { InstanceView } from "../src/syncthing.js";

const pcId = "PBMD2SH-RS3UNJU-L77BP7K-X7VFKHE-73FF74D-RRCUVRY-XNUNII3-WWU53Q6";
const arrayId = "X7KCOB7-4ZJQ2RT-W352REX-D36FWRQ-YSGVXEA-6YA5PZK-PHYIU5M-32WVQQ4";
const minute = 60_000;

interface Counter {
  key: string;
  count: number;
}

function peer(overrides: Partial<Peer>): Peer {
  return {
    deviceId: arrayId,
    name: "private-array",
    connected: false,
    paused: false,
    connectionType: null,
    connectionKind: null,
    address: null,
    version: null,
    inRate: 0,
    outRate: 0,
    lastSeen: null,
    completion: 100,
    needBytes: 0,
    remoteState: "valid",
    folders: [],
    ...overrides,
  };
}

function view(nodeName: string, deviceId: string, peers: Peer[]): InstanceView {
  return {
    nodeName,
    device: { deviceId, addresses: [], connectionType: null, inRate: 0, outRate: 0, version: "v2.1.6" },
    instance: { uptime: 0, cpuPercent: 0, memoryBytes: 0, listeners: [], discoveryErrors: [], inTotal: 0, outTotal: 0 },
    folders: [],
    sync: { state: "idle", completion: 100, lastSeen: null },
    peers,
    pendingDevices: {},
    pendingFolders: {},
    offersWaiting: 0,
    systemErrors: [],
  };
}

describe("seen store", () => {
  let directory: string;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "seen-store-"));
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("the store writes only on a change and at most once an interval", async () => {
    const path = join(directory, "nested", "counters.json");
    const store = new SeenStore<Counter>(path, minute);
    const bump = (records: Counter[]) => [{ key: "a", count: (records[0]?.count ?? 0) + 1 }];
    const unchanged = (records: Counter[]) => records;

    await store.update(bump, 0);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), [{ key: "a", count: 1 }]);

    await store.update(bump, 10_000);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), [{ key: "a", count: 1 }], "a change within the interval waits");
    assert.deepEqual(await store.load(), [{ key: "a", count: 2 }], "the change is kept in memory meanwhile");

    await store.update(unchanged, minute + 1);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), [{ key: "a", count: 2 }], "the waiting change is written once the interval is over");

    await writeFile(path, "written by someone else");
    await store.update(unchanged, 5 * minute);
    assert.equal(await readFile(path, "utf8"), "written by someone else", "nothing changed, so nothing is written");
  });

  it("a corrupt file starts empty and is replaced", async () => {
    const path = join(directory, "corrupt.json");
    await writeFile(path, "{ not json");
    const store = new SeenStore<Counter>(path, minute);
    assert.deepEqual(await store.load(), []);
    await store.update((records) => records, 0);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);
    await assert.rejects(readFile(`${path}.new`, "utf8"), "the temporary file is renamed into place");
  });

  it("the last kind survives a disconnect", async () => {
    const store = new SeenStore<DeviceSeen>(join(directory, "devices.json"), minute);
    const localDeviceIds = new Set([pcId, arrayId]);
    const connected = peer({ connected: true, connectionType: "tcp-client", connectionKind: "this-device", address: "100.75.83.74:22000" });
    await recordDevices([view("pc", pcId, [connected])], localDeviceIds, new Date("2026-10-21T12:00:00Z"), store, "finn");

    const gone = peer({ lastSeen: "2026-10-21T12:30:00Z" });
    const records = await recordDevices([view("pc", pcId, [gone])], new Set([pcId]), new Date("2026-10-26T12:00:00Z"), store, "finn");

    const array = records.find((record) => record.key === arrayId)!;
    assert.deepEqual(array, {
      key: arrayId,
      name: "private-array",
      deviceIds: [arrayId],
      lastSeen: "2026-10-21T12:30:00.000Z",
      lastKind: "this-device",
      lastAddress: "100.75.83.74:22000",
      seenBy: "pc",
    });
    assert.deepEqual([...rememberedLocalDeviceIds(records, "finn")].sort(), [arrayId, pcId].sort(), "an instance seen once stays one of this host's");
  });

  it("a device several instances reach keeps the closest connection", async () => {
    const store = new SeenStore<DeviceSeen>(join(directory, "closest.json"), minute);
    const laptopId = "LAPTOPA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
    const overTailnet = peer({ deviceId: laptopId, name: "laptop", connected: true, connectionType: "tcp-client", connectionKind: "tailscale", address: "100.70.1.2:22000" });
    const overLan = peer({ deviceId: laptopId, name: "laptop", connected: true, connectionType: "quic-client", connectionKind: "local-network", address: "192.168.1.20:22000" });
    const records = await recordDevices([view("pc", pcId, [overTailnet]), view("private-array", arrayId, [overLan])], new Set([pcId, arrayId]), new Date("2026-10-26T12:00:00Z"), store, "finn");
    const laptop = records.find((record) => record.key === laptopId)!;
    assert.equal(laptop.lastKind, "local-network");
    assert.equal(laptop.lastAddress, "192.168.1.20:22000");
    assert.equal(laptop.seenBy, "private-array");
    assert.equal(laptop.lastSeen, "2026-10-26T12:00:00.000Z");
  });
});

describe("devices of this host", () => {
  it("a remembered instance of this host is not listed again as a device of its own", async () => {
    const offlineArray = peer({ lastSeen: "2026-10-21T12:35:28Z" });
    const stranger = peer({ deviceId: "STRAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH", name: "phone" });
    const records = { all: async () => ({}), put: async () => {} };
    const nodes = await syncthingOnlyNodes([], [view("pc", pcId, [offlineArray, stranger])], records, new Set([pcId, arrayId]));
    assert.deepEqual(nodes.map((node) => node.name), ["phone"]);
  });
});
