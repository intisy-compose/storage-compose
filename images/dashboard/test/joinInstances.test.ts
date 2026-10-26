import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ResolverSources } from "../src/instanceResolver.js";
import type { JoinDependencies, JoinedDevice } from "../src/join.js";

const clusterId = "CLUSTER-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const joiningId = "JOINING-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

describe("the instances a joining device is added to", () => {
  let directory: string;
  let fakeSyncthing: Server;
  let sources: ResolverSources;
  let clusterStatusPath: string;
  let clusterConfigPath: string;
  const writes: string[] = [];
  let joinInstances: typeof import("../src/joinInstances.js").joinInstances;
  let handleJoin: typeof import("../src/join.js").handleJoin;

  async function writeClusterStatus(present: boolean): Promise<void> {
    const updated = new Date().toISOString();
    await writeFile(clusterStatusPath, JSON.stringify({ id: "storage", name: "storage", present, state: "healthy", complete: true, updated, since: updated, drives: [] }));
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "join-instances-"));
    fakeSyncthing = createServer((request, response) => {
      if (request.method !== "GET") writes.push(`${request.method} ${request.url}`);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(request.url === "/rest/system/status" ? JSON.stringify({ myID: clusterId }) : "[]");
    });
    const port = await listen(fakeSyncthing);
    const syncthingUrl = `http://127.0.0.1:${port}`;

    process.env.STORAGE_ROOT = directory;
    process.env.STATUS_DIRECTORY = join(directory, "status");
    process.env.ARRAY_PREFIX = "storage";
    process.env.STORAGE_HOST = "storage.example.ts.net";
    process.env.CLUSTER_SYNCTHING_URL = syncthingUrl;
    process.env.HOST_AGENT_SYNCTHING_HOST = "127.0.0.1";
    process.env.STORAGE_PEERS = "";
    process.env.TAILNET_PROXY = "";
    ({ joinInstances } = await import("../src/joinInstances.js"));
    ({ handleJoin } = await import("../src/join.js"));

    await mkdir(join(directory, "storage-data1", ".storage", "syncthing"), { recursive: true });
    clusterConfigPath = join(directory, "storage-data1", ".storage", "syncthing", "config.xml");
    const registry = join(directory, "status", "nodes");
    await mkdir(registry, { recursive: true });
    const clusterStatus = join(directory, "status", "arrays", "storage");
    await mkdir(clusterStatus, { recursive: true });
    clusterStatusPath = join(clusterStatus, "status.json");
    const otherArray = join(directory, "status", "arrays", "beef");
    await mkdir(otherArray, { recursive: true });
    const updated = new Date().toISOString();
    await writeFile(join(otherArray, "status.json"), JSON.stringify({ id: "beef", name: "other-array", present: true, state: "healthy", complete: true, updated, since: updated, drives: [] }));
    await writeFile(join(registry, "beef.syncthing.json"), JSON.stringify({ url: syncthingUrl, apiKey: "array-key" }));
    await writeFile(
      join(registry, "d7e5.json"),
      JSON.stringify({ id: "d7e5", name: "dashboard-test-peer", kind: "folder", threshold: 0, assigned: [], root: "/var/syncthing/data", present: true, space: { size: null, used: null }, syncthing: { url: syncthingUrl, apiKey: "peer-key" }, updated }),
    );
    await writeFile(join(registry, "d7e5.syncthing.json"), JSON.stringify({ url: syncthingUrl, apiKey: "peer-key", syncPort: 22199 }));
    await writeFile(
      join(registry, "0ff1.json"),
      JSON.stringify({ id: "0ff1", name: "pulled-drive", kind: "drive", threshold: 0, assigned: [], root: "/mnt/storage/0ff1", present: false, space: { size: null, used: null }, syncthing: { url: syncthingUrl, apiKey: "x" }, updated }),
    );
    const heartbeatPath = join(directory, "heartbeat.json");
    await writeFile(
      heartbeatPath,
      JSON.stringify({
        heartbeat: updated,
        heartbeatEpoch: Date.now() / 1000,
        host: "pc",
        os: "windows",
        state: "running",
        problems: [],
        nodes: [{ id: "fb98", name: "pc", kind: "folder", threshold: 0, assigned: [], root: "F:/", syncthing: { state: "running", deviceId: clusterId, guiPort: port, listenPort: 22001, apiKey: "pc-key", problem: null } }],
      }),
    );
    sources = { registryDirectory: registry, heartbeatPath, otherHostNodes: async () => [] };
  });

  beforeEach(async () => {
    writes.length = 0;
    await writeClusterStatus(true);
    await writeFile(clusterConfigPath, "<configuration><gui><apikey>cluster-key</apikey></gui></configuration>");
  });

  after(async () => {
    fakeSyncthing.close();
    await rm(directory, { recursive: true, force: true });
  });

  function joinDependencies() {
    const recorded: JoinedDevice[] = [];
    const pushed: string[] = [];
    const dependencies: JoinDependencies = {
      whois: async () => ({ loginName: "owner@example.com", tags: [], nodeName: "laptop.example.ts.net", addresses: ["100.64.0.5/32"] }),
      allowedUsers: async () => ["owner@example.com"],
      requiredTag: "tag:storage",
      instances: () => joinInstances(sources),
      layout: async () => null,
      records: { all: async () => ({}), put: async (device) => void recorded.push(device) },
      recordInSetup: async (name) => {
        pushed.push(name);
        return { committed: true, pushed: true, message: "committed and pushed" };
      },
      now: () => new Date("2026-10-26T12:00:00Z"),
    };
    return { dependencies, recorded, pushed };
  }

  const laptopRequest = { name: "laptop", os: "linux", syncthingDeviceId: joiningId, nodes: [{ kind: "folder", path: "/home/laptop", threshold: 50 }] };

  it("are the cluster, then the registry's and the host agent's attached nodes, each at its sync port, and never another array", async () => {
    const instances = await joinInstances(sources);
    assert.deepEqual(
      instances.map((instance) => [instance.name, instance.addresses]),
      [
        ["storage", ["tcp://storage.example.ts.net:22000", "dynamic"]],
        ["dashboard-test-peer", ["tcp://storage.example.ts.net:22199", "dynamic"]],
        ["pc", ["dynamic"]],
      ],
    );
    assert.equal(await instances[0].myId(), clusterId);
  });

  it("a cluster that is not connected refuses the join with 503 and nothing is written, recorded or pushed", async () => {
    await writeClusterStatus(false);
    const { dependencies, recorded, pushed } = joinDependencies();
    await assert.rejects(handleJoin(dependencies, ["100.64.0.5"], laptopRequest), { status: 503, message: "storage is not connected, so the device cannot join yet" });
    assert.deepEqual(writes, []);
    assert.deepEqual(recorded, []);
    assert.deepEqual(pushed, []);
  });

  async function assertRefusedWithoutWrites(message: string): Promise<void> {
    const { dependencies, recorded, pushed } = joinDependencies();
    await assert.rejects(handleJoin(dependencies, ["100.64.0.5"], laptopRequest), { status: 503, message });
    assert.deepEqual(writes, []);
    assert.deepEqual(recorded, []);
    assert.deepEqual(pushed, []);
  }

  it("a connected cluster whose Syncthing cannot be addressed refuses the join with 503 and nothing is written, recorded or pushed", async () => {
    await rm(clusterConfigPath);
    await assertRefusedWithoutWrites("storage's Syncthing is not answering, so the device cannot join yet");
  });

  it("a cluster with neither a status nor an addressable Syncthing refuses the join with 503 and nothing is written, recorded or pushed", async () => {
    await rm(clusterConfigPath);
    await rm(clusterStatusPath);
    await assertRefusedWithoutWrites("storage is not connected, so the device cannot join yet");
  });

  it("a connected cluster joins as before: the device is added to every instance, recorded and pushed", async () => {
    const { dependencies, recorded, pushed } = joinDependencies();
    const { response } = await handleJoin(dependencies, ["100.64.0.5"], laptopRequest);
    assert.deepEqual(response.devices.map((device) => device.name), ["storage", "dashboard-test-peer", "pc"]);
    assert.deepEqual(writes, ["POST /rest/config/devices", "POST /rest/config/devices", "POST /rest/config/devices"]);
    assert.deepEqual(recorded.map((device) => device.name), ["laptop"]);
    assert.deepEqual(pushed, ["laptop"]);
  });
});
