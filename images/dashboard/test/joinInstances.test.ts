import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ResolverSources } from "../src/instanceResolver.js";

const clusterId = "CLUSTER-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

describe("the instances a joining device is added to", () => {
  let directory: string;
  let fakeSyncthing: Server;
  let sources: ResolverSources;
  let joinInstances: typeof import("../src/joinInstances.js").joinInstances;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "join-instances-"));
    fakeSyncthing = createServer((request, response) => {
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

    await mkdir(join(directory, "storage-data1", ".storage", "syncthing"), { recursive: true });
    await writeFile(join(directory, "storage-data1", ".storage", "syncthing", "config.xml"), "<configuration><gui><apikey>cluster-key</apikey></gui></configuration>");
    const registry = join(directory, "status", "nodes");
    await mkdir(registry, { recursive: true });
    const privateArray = join(directory, "status", "arrays", "5784");
    await mkdir(privateArray, { recursive: true });
    const updated = new Date().toISOString();
    await writeFile(join(privateArray, "status.json"), JSON.stringify({ id: "5784", name: "private-array", present: true, state: "healthy", complete: true, updated, since: updated, drives: [] }));
    await writeFile(join(registry, "5784.syncthing.json"), JSON.stringify({ url: syncthingUrl, apiKey: "array-key" }));
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

  after(async () => {
    fakeSyncthing.close();
    await rm(directory, { recursive: true, force: true });
  });

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
});
