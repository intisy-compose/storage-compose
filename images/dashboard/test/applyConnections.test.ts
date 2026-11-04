import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ConnectionProfile, NodeAddresses, PeerTable } from "../src/api/types.js";
import { type ApplyDependencies, type ApplyReport, ConnectionsRound, startConnectionRounds } from "../src/applyConnections.js";
import { ProfileError, defaultProfile } from "../src/connectionProfile.js";
import { connectionsStateOf } from "../src/connectionsDrift.js";
import type { LocalInstance } from "../src/instanceResolver.js";
import { type JoinedDevice, type JoinRecords, joinedNodeId } from "../src/join.js";
import { readRemoteTable } from "../src/peerSources.js";
import { resolveNode } from "../src/peerTable.js";
import { joinedNodeConnections } from "../src/routes/connections.js";
import { type SyncthingClient, SyncthingUnavailable } from "../src/syncthing.js";
import type { WhoIs } from "../src/tailnet.js";

const clusterDevice = "CLUSTER-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA";
const arrayDevice = "ARRAYXX-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB";
const remoteDevice = "REMOTEX-CCCCCCC-CCCCCCC-CCCCCCC-CCCCCCC-CCCCCCC-CCCCCCC-CCCCCCC";
const laptopDevice = "LAPTOPX-DDDDDDD-DDDDDDD-DDDDDDD-DDDDDDD-DDDDDDD-DDDDDDD-DDDDDDD";

const lan = { kind: "lan" as const, address: "192.168.1.5" };
const clusterNode: NodeAddresses = { nodeId: "storage", deviceId: clusterDevice, syncPort: 22000, networks: [lan] };
const arrayNode: NodeAddresses = { nodeId: "a1b2", deviceId: arrayDevice, syncPort: 22001, networks: [lan] };
const remoteNode: NodeAddresses = { nodeId: "r9c8", deviceId: remoteDevice, syncPort: 22000, networks: [{ kind: "lan", address: "192.168.1.9" }] };

const localTable: PeerTable = { nodes: [clusterNode, arrayNode], bridges: [], builtAt: "2026-11-02T10:00:00.000Z" };
const remoteTable: PeerTable = { nodes: [remoteNode], bridges: [], builtAt: "2026-11-02T09:59:00.000Z" };
const wholeTable: PeerTable = { nodes: [arrayNode, remoteNode, clusterNode], bridges: [], builtAt: localTable.builtAt };

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

type SyncthingObject = Record<string, unknown>;

/** A node's Syncthing in memory: GET and PATCH of `/config/options` and `/config/devices`, every write kept, and its restart need. */
class FakeSyncthing {
  sent: Sent[] = [];
  answers = true;
  /** What `/config/restart-required` answers; an Error makes the read fail. */
  requiresRestart: boolean | Error = false;
  restartReads = 0;
  /** The next options PATCH is applied, then the node stops answering before its answer, as a restart does. */
  losePatchAnswer = false;

  constructor(
    public options: SyncthingObject,
    public devices: SyncthingObject[],
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.answers) throw new SyncthingUnavailable(`${method} ${path}: connection refused`);
    if (method !== "GET") this.sent.push({ method, path, body });
    if (method === "GET" && path === "/config/restart-required") {
      this.restartReads++;
      if (this.requiresRestart instanceof Error) throw this.requiresRestart;
      return { requiresRestart: this.requiresRestart } as T;
    }
    if (method === "GET" && path === "/config/options") return structuredClone(this.options) as T;
    if (method === "GET" && path === "/config/devices") return structuredClone(this.devices) as T;
    if (method === "PATCH" && path === "/config/options") {
      Object.assign(this.options, body);
      if (this.losePatchAnswer) {
        this.losePatchAnswer = false;
        this.answers = false;
        throw new SyncthingUnavailable(`${method} ${path}: connection reset`);
      }
      return null as T;
    }
    const device = /^\/config\/devices\/([^/]+)$/.exec(path);
    if (method === "PATCH" && device) {
      const entry = this.devices.find((candidate) => candidate.deviceID === decodeURIComponent(device[1]));
      if (!entry) throw new Error(`no device ${device[1]}`);
      Object.assign(entry, body);
      return null as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
}

function instanceOf(nodeId: string, syncthing: FakeSyncthing, source: LocalInstance["source"] = "registry"): LocalInstance {
  return { kind: "local", nodeId, name: `node-${nodeId}`, client: syncthing as unknown as SyncthingClient, root: "/data", os: "linux", threshold: 0, source };
}

function device(deviceID: string, addresses: string[], extra: SyncthingObject = {}): SyncthingObject {
  return { deviceID, name: deviceID.slice(0, 7), addresses, introducer: false, autoAcceptFolders: false, ...extra };
}

/** A node already on `profile` for `table`: its options, listen addresses and every peer's addresses as resolved. */
function onProfile(profile: ConnectionProfile, table: PeerTable, nodeId: string, extraDevice: SyncthingObject = {}): FakeSyncthing {
  const resolved = resolveNode(profile, table, nodeId);
  const devices = Object.entries(resolved.deviceAddresses).map(([deviceId, addresses]) => device(deviceId, addresses, extraDevice));
  return new FakeSyncthing({ ...resolved.options, listenAddresses: resolved.listenAddresses, urAccepted: -1 }, devices);
}

const scratch = mkdtempSync(join(tmpdir(), "apply-connections-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let roundCount = 0;

function round(instances: LocalInstance[], overrides: Partial<ApplyDependencies> = {}): { round: ConnectionsRound; files: string[] } {
  const directory = join(scratch, `round-${++roundCount}`);
  const files = [join(directory, "status", "connections.json"), join(directory, "host-agent-connections", "connections.json")];
  const dependencies: ApplyDependencies = {
    pull: async () => {},
    profile: async () => defaultProfile(),
    localTable: async () => localTable,
    dashboards: ["https://storage-p53.example"],
    remoteTable: async () => remoteTable,
    instances: async () => instances,
    connectionsFiles: files,
    readBackDelaysMs: [],
    ...overrides,
  };
  return { round: new ConnectionsRound(dependencies), files };
}

function limitedProfile(maxSendKbps: number): ConnectionProfile {
  const profile = defaultProfile();
  profile.limits.maxSendKbps = maxSendKbps;
  return profile;
}

describe("applying the connection profile to this host's nodes", () => {
  it("a round sends only options that differ", async () => {
    const cluster = onProfile(defaultProfile(), wholeTable, "storage");
    cluster.devices.find((entry) => entry.deviceID === remoteDevice)!.addresses = ["dynamic"];
    const { round: connections, files } = round([instanceOf("storage", cluster, "array")], { profile: async () => limitedProfile(1000) });

    const report = await connections.run();

    const expected = resolveNode(limitedProfile(1000), wholeTable, "storage");
    assert.deepEqual(cluster.sent, [
      { method: "PATCH", path: "/config/options", body: { maxSendKbps: 1000 } },
      { method: "PATCH", path: `/config/devices/${remoteDevice}`, body: { addresses: expected.deviceAddresses[remoteDevice] } },
    ]);
    assert.deepEqual(report.applied, ["storage"]);
    assert.deepEqual(report.notYet, ["a1b2"], "a node of this host in the table without an answering instance");
    assert.deepEqual(report.failed, {});
    const written = JSON.parse(readFileSync(files[0], "utf8"));
    assert.deepEqual(Object.keys(written).sort(), ["a1b2", "storage"], "only this host's nodes");
    assert.deepEqual(written.storage, expected);
    assert.equal(readFileSync(files[1], "utf8"), readFileSync(files[0], "utf8"), "the host agent's copy is the same file");
  });

  it("a profile that cannot be read keeps the last one applied and is logged once", async (context) => {
    const errors = context.mock.method(console, "error", () => undefined);
    let currentProfile: ConnectionProfile | Error = limitedProfile(1000);
    const cluster = onProfile(limitedProfile(1000), wholeTable, "storage");
    const { round: connections, files } = round([instanceOf("storage", cluster)], {
      profile: async () => {
        if (currentProfile instanceof Error) throw currentProfile;
        return currentProfile;
      },
    });
    await connections.run();
    currentProfile = new ProfileError("limits.max_send_kbps must be a whole number from 0");

    const reports = [await connections.run(), await connections.run()];

    assert.deepEqual(cluster.sent, []);
    for (const report of reports) assert.deepEqual(report.applied, ["storage"]);
    assert.deepEqual(JSON.parse(readFileSync(files[0], "utf8")).storage, resolveNode(limitedProfile(1000), wholeTable, "storage"));
    assert.deepEqual(errors.mock.calls.map((call) => call.arguments[0]), [
      "connections: connections.toml rejected: limits.max_send_kbps must be a whole number from 0; the previous profile is still applied",
    ]);
    assert.deepEqual(connections.appliedProfile(), limitedProfile(1000));
    currentProfile = limitedProfile(1000);
    await connections.run();
    assert.equal(errors.mock.calls.at(-1)?.arguments[0], "connections: the profile can be read again");
  });

  it("a profile never read writes and sends nothing", async (context) => {
    const errors = context.mock.method(console, "error", () => undefined);
    const cluster = new FakeSyncthing({ listenAddresses: ["default"], urAccepted: -1 }, []);
    const { round: connections, files } = round([instanceOf("storage", cluster)], {
      profile: async () => {
        throw new ProfileError("relays.bridge_port must be a whole number from 1 to 65535");
      },
    });

    const report = await connections.run();

    assert.deepEqual(report, { applied: [], restartNeeded: [], notYet: [], failed: {} });
    assert.deepEqual(cluster.sent, []);
    assert.equal(existsSync(files[0]), false);
    assert.equal(connections.appliedProfile(), null);
    assert.deepEqual(errors.mock.calls.map((call) => call.arguments[0]), [
      "connections: connections.toml cannot be read: relays.bridge_port must be a whole number from 1 to 65535; nothing applied",
    ]);
  });

  it("a second round with nothing changed sends nothing", async () => {
    const cluster = new FakeSyncthing({ listenAddresses: ["default"], urAccepted: -1 }, [device(arrayDevice, ["dynamic"]), device(remoteDevice, ["dynamic"])]);
    const { round: connections } = round([instanceOf("storage", cluster)]);
    await connections.run();
    assert.ok(cluster.sent.length > 0, "the first round brings the node onto the profile");
    cluster.sent = [];

    const report = await connections.run();

    assert.deepEqual(cluster.sent, []);
    assert.deepEqual(report.applied, ["storage"]);
    assert.equal(connectionsStateOf("storage"), "on-profile");
  });

  it("a node that does not answer is reported failed and the others are still applied", async () => {
    const dead = new FakeSyncthing({}, []);
    dead.answers = false;
    const cluster = onProfile(defaultProfile(), wholeTable, "storage");
    const { round: connections } = round([instanceOf("a1b2", dead, "array"), instanceOf("storage", cluster)], { profile: async () => limitedProfile(500) });

    const report = await connections.run();

    assert.deepEqual(Object.keys(report.failed), ["a1b2"]);
    assert.match(report.failed.a1b2, /not answering/);
    assert.deepEqual(report.applied, ["storage"]);
    assert.deepEqual(cluster.sent, [{ method: "PATCH", path: "/config/options", body: { maxSendKbps: 500 } }]);
    assert.equal(connectionsStateOf("a1b2"), "not-yet");
    assert.equal(connectionsStateOf("storage"), "on-profile");
    assert.equal(connectionsStateOf("nowhere"), "unknown");
  });

  it("introducer and autoAcceptFolders are never sent", async () => {
    const array = onProfile(defaultProfile(), wholeTable, "a1b2", { introducer: true, autoAcceptFolders: true });
    for (const entry of array.devices) entry.addresses = ["dynamic"];
    const { round: connections } = round([instanceOf("a1b2", array, "array")], { profile: async () => limitedProfile(250) });

    await connections.run();

    assert.ok(array.sent.length > 0);
    for (const { path, body } of array.sent) {
      assert.match(path, /^\/config\/(options|devices\/[^/]+)$/, "never a folder or a pending folder");
      assert.equal(Object.hasOwn(body as object, "introducer"), false);
      assert.equal(Object.hasOwn(body as object, "autoAcceptFolders"), false);
    }
    assert.ok(array.devices.every((entry) => entry.introducer === true && entry.autoAcceptFolders === true), "left as they were");
  });

  it("an unreadable remote dashboard keeps its nodes' last known addresses", async () => {
    const cluster = onProfile(defaultProfile(), wholeTable, "storage");
    let remoteAnswers = true;
    const { round: connections, files } = round([instanceOf("storage", cluster)], { remoteTable: async () => (remoteAnswers ? remoteTable : null) });
    await connections.run();
    remoteAnswers = false;

    const report = await connections.run();

    assert.deepEqual(report.applied, ["storage"]);
    assert.deepEqual(cluster.sent, [], "no device address is stripped to dynamic");
    const written = JSON.parse(readFileSync(files[0], "utf8"));
    assert.deepEqual(written.storage.deviceAddresses[remoteDevice], resolveNode(defaultProfile(), wholeTable, "storage").deviceAddresses[remoteDevice]);
  });

  it("a write that needs a restart leaves the node restart-needed, logged once, and never restarts it", async (context) => {
    const errors = context.mock.method(console, "error", () => undefined);
    const array = onProfile(defaultProfile(), wholeTable, "a1b2");
    array.requiresRestart = true;
    const { round: connections } = round([instanceOf("a1b2", array, "array")], { profile: async () => limitedProfile(750) });

    const first = await connections.run();
    const second = await connections.run();

    assert.deepEqual(array.sent, [{ method: "PATCH", path: "/config/options", body: { maxSendKbps: 750 } }], "no POST /system/restart");
    for (const report of [first, second]) {
      assert.deepEqual(report.restartNeeded, ["a1b2"]);
      assert.deepEqual(report.applied, []);
    }
    assert.equal(connectionsStateOf("a1b2"), "restart-needed");
    assert.deepEqual(errors.mock.calls.map((call) => call.arguments[0]), ["connections: a1b2 has the profile's values saved; its Syncthing applies them after it restarts"]);

    array.requiresRestart = false;
    const afterRestart = await connections.run();

    assert.deepEqual(afterRestart.applied, ["a1b2"]);
    assert.deepEqual(afterRestart.restartNeeded, []);
    assert.equal(connectionsStateOf("a1b2"), "on-profile");
  });

  it("the restart need is read only after a write or while one is outstanding", async () => {
    const cluster = onProfile(defaultProfile(), wholeTable, "storage");
    cluster.requiresRestart = true;
    const { round: connections } = round([instanceOf("storage", cluster, "array")]);

    const report = await connections.run();

    assert.deepEqual(cluster.sent, []);
    assert.equal(cluster.restartReads, 0, "a restart another change left pending is not the profile's");
    assert.deepEqual(report.applied, ["storage"]);
  });

  it("a restart need that cannot be read after a write leaves the node on the profile and is read again next round", async () => {
    const cluster = onProfile(defaultProfile(), wholeTable, "storage");
    cluster.requiresRestart = new SyncthingUnavailable("GET /config/restart-required: connection refused");
    const { round: connections } = round([instanceOf("storage", cluster, "array")], { profile: async () => limitedProfile(300) });

    const first = await connections.run();
    cluster.requiresRestart = true;
    const second = await connections.run();

    assert.deepEqual(first.applied, ["storage"]);
    assert.deepEqual(first.failed, {});
    assert.deepEqual(second.restartNeeded, ["storage"], "the next round asks again although it writes nothing");
    assert.equal(cluster.sent.length, 1);
  });

  it("a write whose answer is lost after Syncthing applied it still leaves the node waiting for a restart", async (context) => {
    context.mock.method(console, "error", () => undefined);
    const array = onProfile(defaultProfile(), wholeTable, "a1b2");
    array.losePatchAnswer = true;
    const { round: connections } = round([instanceOf("a1b2", array, "array")], { profile: async () => limitedProfile(640) });

    const lost = await connections.run();
    array.answers = true;
    array.requiresRestart = true;
    const next = await connections.run();

    assert.deepEqual(Object.keys(lost.failed), ["a1b2"]);
    assert.equal(array.sent.length, 1, "the next round finds the values in place and writes nothing");
    assert.deepEqual(next.restartNeeded, ["a1b2"]);
  });

  it("a peer missing from the table keeps the addresses it has", async () => {
    const cluster = onProfile(defaultProfile(), wholeTable, "storage");
    const { round: connections } = round([instanceOf("storage", cluster)], { remoteTable: async () => null });

    await connections.run();

    assert.deepEqual(cluster.sent, []);
  });
});

describe("another host's part of the table", () => {
  it("is asked for that host's own nodes only, so a node removed there leaves this host's table", async () => {
    const paths: string[] = [];
    let answer: PeerTable = remoteTable;
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(answer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const dashboardUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { round: connections } = round([], { dashboards: [dashboardUrl], remoteTable: readRemoteTable });
      await connections.run();
      assert.ok(connections.lastTable()?.nodes.some((node) => node.nodeId === remoteNode.nodeId));
      answer = { ...remoteTable, nodes: [] };

      await connections.run();

      assert.deepEqual(paths, ["/api/connections/addresses?scope=local", "/api/connections/addresses?scope=local"]);
      assert.deepEqual(connections.lastTable()?.nodes.map((node) => node.nodeId), ["a1b2", "storage"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("the connection rounds", () => {
  it("run at once, one at a time, and stop when told", async () => {
    let started = 0;
    let finish: (report: ApplyReport) => void = () => {};
    const stop = startConnectionRounds(0.01, () => {
      started++;
      return new Promise((resolve) => (finish = resolve));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(started, 1, "a round still running is not started again");
    finish({ applied: [], restartNeeded: [], notYet: [], failed: {} });
    stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(started, 1, "no round after stop");
  });
});

describe("a joined device's connections", () => {
  const laptop: JoinedDevice = {
    name: "laptop",
    syncthingDeviceId: laptopDevice,
    os: "linux",
    nodes: [{ kind: "folder", path: "/home/finn/storage", threshold: 50 }],
    joinedAt: "2026-11-01T10:00:00.000Z",
    tailnetName: "laptop.tail.ts.net",
    setup: null,
  };
  const records: JoinRecords = { all: async () => ({ laptop }), put: async () => {} };
  const callers: Record<string, WhoIs> = {
    "100.64.0.9": { loginName: "finn@birich.de", tags: [], nodeName: "laptop.tail.ts.net", addresses: ["100.64.0.9/32"] },
    "100.64.0.10": { loginName: "finn@birich.de", tags: [], nodeName: "phone.tail.ts.net", addresses: ["100.64.0.10/32"] },
  };

  async function connectionsRound(): Promise<ConnectionsRound> {
    const { round: connections } = round([]);
    await connections.run();
    return connections;
  }

  function dependencies(connections: ConnectionsRound) {
    return {
      admit: async (addresses: string[]) => {
        const caller = callers[addresses[0]];
        if (!caller) throw new Error("not a device of this tailnet");
        return caller;
      },
      records,
      connectionsOf: (node: NodeAddresses) => connections.connectionsFor(node),
    };
  }

  it("the node endpoint refuses a caller that is not the owning device", async () => {
    const connections = await connectionsRound();
    const nodeId = joinedNodeId(laptopDevice);

    await assert.rejects(joinedNodeConnections(dependencies(connections), ["100.64.0.10"], nodeId), { status: 404 });
    await assert.rejects(joinedNodeConnections(dependencies(connections), ["100.64.0.77"], nodeId), { status: 404 });
    await assert.rejects(joinedNodeConnections(dependencies(connections), ["100.64.0.9"], "storage"), { status: 404 });
  });

  it("the owning device gets its node's entry, its peers on the tailnet included", async () => {
    const connections = await connectionsRound();

    const answer = await joinedNodeConnections(dependencies(connections), ["100.64.0.9"], joinedNodeId(laptopDevice));

    assert.deepEqual(answer.options, resolveNode(defaultProfile(), wholeTable, "storage").options);
    assert.deepEqual(Object.keys(answer.deviceAddresses).sort(), [arrayDevice, clusterDevice, remoteDevice].sort());
    assert.ok(answer.deviceAddresses[clusterDevice].includes("dynamic"));
  });
});
