import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { StorageNode } from "../src/api/types.js";
import type { ResolverSources } from "../src/instanceResolver.js";

const fakeDeviceId = "FAKEAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function remoteNode(overrides: Partial<StorageNode>): StorageNode {
  return {
    id: "a1b2",
    name: "p53-data",
    kind: "drive",
    threshold: 0,
    assigned: [],
    local: false,
    online: true,
    host: "p53",
    space: null,
    sync: { state: "idle", completion: 100, lastSeen: null },
    offersWaiting: 0,
    syncthing: null,
    instance: null,
    peers: [],
    folders: [],
    dashboardUrl: null,
    ...overrides,
  };
}

describe("instance resolver", () => {
  let resolver: typeof import("../src/instanceResolver.js");
  let settings: typeof import("../src/settings.js");
  let directory: string;
  let fakeSyncthing: Server;
  let fakeDashboard: Server;
  let syncthingPort: number;
  let deadPort: number;
  let dashboardUrl: string;
  const dashboardPaths: string[] = [];
  let sources: ResolverSources;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "resolver-"));
    fakeSyncthing = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(request.url === "/rest/system/status" ? JSON.stringify({ myID: fakeDeviceId }) : "{}");
    });
    syncthingPort = await listen(fakeSyncthing);
    fakeDashboard = createServer((request, response) => {
      dashboardPaths.push(request.url ?? "");
      if (request.url?.startsWith("/api/refused")) {
        response.writeHead(409, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ error: "no folder dashboard-test-x on p53-data" }));
      }
      if (request.url?.startsWith("/api/broken")) {
        response.writeHead(500, { "Content-Type": "text/plain" });
        return response.end("panic");
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ items: [] }));
    });
    dashboardUrl = `http://127.0.0.1:${await listen(fakeDashboard)}`;
    const closed = createServer();
    deadPort = await listen(closed);
    await close(closed);

    process.env.STORAGE_ROOT = directory;
    process.env.ARRAY_PREFIX = "storage";
    process.env.CLUSTER_SYNCTHING_URL = `http://127.0.0.1:${syncthingPort}`;
    process.env.HOST_AGENT_SYNCTHING_HOST = "127.0.0.1";
    process.env.STORAGE_PEERS = "";
    process.env.TAILNET_PROXY = "";
    settings = await import("../src/settings.js");
    resolver = await import("../src/instanceResolver.js");

    await mkdir(join(directory, "storage-data1", ".storage", "syncthing"), { recursive: true });
    await writeFile(join(directory, "storage-data1", ".storage", "syncthing", "config.xml"), "<configuration><gui><apikey>cluster-key</apikey></gui></configuration>");
    const registry = join(directory, "nodes");
    await mkdir(registry);
    const updated = new Date().toISOString();
    await writeFile(
      join(registry, "d7e5.json"),
      JSON.stringify({ id: "d7e5", name: "dashboard-test-peer", kind: "folder", threshold: 0, assigned: [], root: "/var/syncthing/data", present: true, space: { size: null, used: null }, syncthing: { url: `http://127.0.0.1:${deadPort}`, apiKey: "peer-key" }, updated }),
    );
    await writeFile(
      join(registry, "0ff1.json"),
      JSON.stringify({ id: "0ff1", name: "pulled-drive", kind: "drive", threshold: 0, assigned: [], root: "/mnt/storage/0ff1", present: false, space: { size: null, used: null }, syncthing: null, updated }),
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
        nodes: [{ id: "fb98", name: "pc", kind: "folder", threshold: 0, assigned: [], root: "F:\\", syncthing: { state: "running", deviceId: fakeDeviceId, guiPort: syncthingPort, listenPort: 22001, apiKey: "pc-key", problem: null } }],
      }),
    );
    sources = {
      registryDirectory: registry,
      heartbeatPath,
      otherHostNodes: async () => [
        remoteNode({ dashboardUrl }),
        remoteNode({ id: "device-abcdefg", name: "laptop", host: "laptop", dashboardUrl: null }),
        remoteNode({ id: "dead", name: "gone-data", host: "gone", dashboardUrl: `http://127.0.0.1:${deadPort}` }),
      ],
    };
  });

  after(async () => {
    await close(fakeSyncthing);
    await close(fakeDashboard);
    await rm(directory, { recursive: true, force: true });
  });

  it("resolves the cluster to the gateway", async () => {
    const instance = resolver.requireLocal(await resolver.resolveInstance("storage", sources));
    assert.equal(instance.client.endpoint.url, settings.clusterSyncthingUrl);
    assert.equal(instance.root, settings.poolPath("storage"));
    assert.equal(instance.os, "linux");
    assert.equal(await instance.client.myId(), fakeDeviceId);
  });

  it("resolves a host agent node with os windows", async () => {
    const instance = resolver.requireLocal(await resolver.resolveInstance("fb98", sources));
    assert.equal(instance.os, "windows");
    assert.equal(instance.root, "F:\\");
    assert.equal(instance.client.endpoint.url, `http://127.0.0.1:${syncthingPort}`);
  });

  it("lists this host's addressable instances, the cluster first, without a detached node", async () => {
    const instances = await resolver.localInstances(sources);
    assert.deepEqual(instances.map((instance) => instance.nodeId), ["storage", "d7e5", "fb98"]);
  });

  it("an unknown node is 404", async () => {
    await assert.rejects(resolver.resolveInstance("beef", sources), { status: 404, message: "no node beef" });
  });

  it("a local node that is not attached is 409 not connected, not a Syncthing that does not answer", async () => {
    await assert.rejects(resolver.resolveInstance("0ff1", sources), { status: 409, message: "pulled-drive is not connected" });
  });

  it("a remote node's write is 409 naming its host", async () => {
    const instance = await resolver.resolveInstance("a1b2", sources);
    assert.equal(instance.kind, "remote");
    assert.throws(() => resolver.requireLocal(instance), { status: 409, message: "act on p53's dashboard" });
  });

  it("a write to an instance that does not answer is 503 and names the node", async () => {
    const instance = resolver.requireLocal(await resolver.resolveInstance("d7e5", sources));
    await assert.rejects(
      resolver.callSyncthing(instance, (client) => client.request("POST", "/db/scan")),
      { status: 503, message: "dashboard-test-peer's Syncthing is not answering" },
    );
  });

  it("a remote read keeps the path's own query and adds scope=local", async () => {
    const instance = await resolver.resolveInstance("a1b2", sources);
    assert(instance.kind === "remote");
    assert.deepEqual(await resolver.forwardRead(instance, "/api/nodes/a1b2/need?page=2"), { items: [] });
    assert.equal(dashboardPaths.at(-1), "/api/nodes/a1b2/need?page=2&scope=local");
  });

  it("a remote refusal keeps the peer dashboard's status and error", async () => {
    const instance = await resolver.resolveInstance("a1b2", sources);
    assert(instance.kind === "remote");
    await assert.rejects(resolver.forwardRead(instance, "/api/refused"), { status: 409, message: "no folder dashboard-test-x on p53-data" });
  });

  it("a remote answer without an error keeps its status and names the host", async () => {
    const instance = await resolver.resolveInstance("a1b2", sources);
    assert(instance.kind === "remote");
    await assert.rejects(resolver.forwardRead(instance, "/api/broken"), { status: 500, message: "p53's dashboard answered HTTP 500" });
  });

  it("a peer dashboard that cannot be reached is 502", async () => {
    const instance = await resolver.resolveInstance("dead", sources);
    assert(instance.kind === "remote");
    await assert.rejects(resolver.forwardRead(instance, "/api/nodes"), (error: { status: number; message: string }) => error.status === 502 && error.message.startsWith("gone's dashboard: "));
  });

  it("a node known only to Syncthing has no dashboard to read and refuses writes", async () => {
    const instance = await resolver.resolveInstance("device-abcdefg", sources);
    assert(instance.kind === "remote");
    await assert.rejects(resolver.forwardRead(instance, "/api/nodes/device-abcdefg/folders"), { status: 404, message: "no dashboard for laptop" });
    assert.throws(() => resolver.requireLocal(instance), { status: 409, message: "act on laptop's dashboard" });
  });
});
