import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Bridge, ConnectionProfile, NodeAddresses, PeerTable } from "../src/api/types.js";
import { defaultProfile } from "../src/connectionProfile.js";
import { dockerNetworks, localPeerTable } from "../src/peerSources.js";
import { buildPeerTable, resolveNode } from "../src/peerTable.js";
import { hostName } from "../src/settings.js";

const publicPool = "dynamic+https://relays.syncthing.net/endpoint";

const lanOnly: NodeAddresses = { nodeId: "aa01", deviceId: "DEV-LAN", syncPort: 22001, networks: [{ kind: "lan", address: "192.168.1.10", category: "Private" }] };
const tailnetOnly: NodeAddresses = { nodeId: "bb02", deviceId: "DEV-TAILNET", syncPort: 22002, networks: [{ kind: "tailnet", address: "100.64.0.2" }] };
const both: NodeAddresses = {
  nodeId: "cc03",
  deviceId: "DEV-BOTH",
  syncPort: 22003,
  networks: [
    { kind: "lan", address: "192.168.1.30", category: "Private" },
    { kind: "tailnet", address: "100.64.0.3" },
  ],
};
const bridge: Bridge = {
  host: "pc",
  relayId: "RELAY-PC",
  port: 22100,
  addresses: [
    { kind: "lan", address: "192.168.1.5", category: "Private" },
    { kind: "tailnet", address: "100.64.0.5" },
  ],
};

function profileWith(change: (profile: ConnectionProfile) => void): ConnectionProfile {
  const profile = defaultProfile();
  change(profile);
  return profile;
}

function table(nodes: NodeAddresses[], bridges: Bridge[] = [bridge]): PeerTable {
  return buildPeerTable(nodes, bridges, [], "2026-11-02T10:00:00.000Z");
}

function everyAddress(profile: ConnectionProfile, peers: PeerTable): string[] {
  return peers.nodes.flatMap((node) => {
    const resolved = resolveNode(profile, peers, node.nodeId);
    return [...resolved.listenAddresses, ...Object.values(resolved.deviceAddresses).flat()];
  });
}

describe("peer table", () => {
  it("a lan-only node gets the bridge's lan relay address for a tailnet-only peer", () => {
    const resolved = resolveNode(defaultProfile(), table([lanOnly, tailnetOnly]), "aa01");
    assert.deepEqual(resolved.deviceAddresses["DEV-TAILNET"], ["relay://192.168.1.5:22100/?id=RELAY-PC", "dynamic"]);
    assert.deepEqual(resolved.listenAddresses, ["tcp://0.0.0.0:22001", "quic://0.0.0.0:22001", "relay://192.168.1.5:22100/?id=RELAY-PC", publicPool]);
    assert.equal(resolved.options.relaysEnabled, true);
  });

  it("with bridges off no relay:// address is listed", () => {
    const profile = profileWith((value) => (value.relays.bridges = false));
    const addresses = everyAddress(profile, table([lanOnly, tailnetOnly, both]));
    assert.ok(addresses.length > 0);
    assert.deepEqual(addresses.filter((address) => address.startsWith("relay://")), []);
    assert.deepEqual(resolveNode(profile, table([lanOnly, tailnetOnly]), "aa01").deviceAddresses["DEV-TAILNET"], ["dynamic"]);
  });

  it("with tailnet off no tailnet address is listed", () => {
    const profile = profileWith((value) => (value.methods.tailnet = false));
    const peers = table([lanOnly, tailnetOnly, both]);
    assert.deepEqual(everyAddress(profile, peers).filter((address) => address.includes("100.64.")), []);
    assert.deepEqual(resolveNode(profile, peers, "aa01").deviceAddresses["DEV-BOTH"], [
      "tcp://192.168.1.30:22003",
      "quic://192.168.1.30:22003",
      "relay://192.168.1.5:22100/?id=RELAY-PC",
      "dynamic",
    ]);
  });

  it("a node's new lan address reaches every peer's device addresses on the next round", () => {
    const moved: NodeAddresses = { ...both, networks: [{ kind: "lan", address: "192.168.1.31", category: "Private" }, both.networks[1]] };
    const first = table([lanOnly, tailnetOnly, both]);
    const next = table([lanOnly, tailnetOnly, moved]);
    for (const peer of ["aa01", "bb02"]) {
      const before = resolveNode(defaultProfile(), first, peer).deviceAddresses["DEV-BOTH"];
      const after = resolveNode(defaultProfile(), next, peer).deviceAddresses["DEV-BOTH"];
      assert.deepEqual(after.filter((address) => address.includes("192.168.1.30")), []);
      if (peer === "aa01") {
        assert.ok(before.includes("tcp://192.168.1.30:22003"));
        assert.ok(after.includes("tcp://192.168.1.31:22003"));
        assert.ok(after.includes("quic://192.168.1.31:22003"));
      }
    }
  });

  it("remote tables are merged and a node seen twice keeps the newer entry", () => {
    const older: PeerTable = { nodes: [{ ...tailnetOnly, networks: [{ kind: "tailnet", address: "100.64.0.20" }] }, both], bridges: [], builtAt: "2026-11-02T09:00:00.000Z" };
    const newer: PeerTable = { nodes: [tailnetOnly], bridges: [bridge], builtAt: "2026-11-02T09:30:00.000Z" };
    const recent: PeerTable = { nodes: [{ ...lanOnly, syncPort: 22009 }], bridges: [{ ...bridge, relayId: "RELAY-OLD" }], builtAt: "2026-11-02T09:59:00.000Z" };
    const merged = buildPeerTable([lanOnly], [], [older, recent, newer], "2026-11-02T10:00:00.000Z");
    assert.deepEqual(
      merged.nodes.map((node) => node.nodeId),
      ["aa01", "bb02", "cc03"],
    );
    assert.deepEqual(merged.nodes.find((node) => node.nodeId === "bb02"), tailnetOnly);
    assert.deepEqual(merged.nodes.find((node) => node.nodeId === "aa01"), lanOnly);
    assert.deepEqual(merged.bridges, [{ ...bridge, relayId: "RELAY-OLD" }]);
    assert.equal(merged.builtAt, "2026-11-02T10:00:00.000Z");
  });

  it("listen addresses never name a port other than the node's own and the bridge's", () => {
    const laptop: Bridge = { host: "laptop", relayId: "RELAY-LAPTOP", port: 22101, addresses: [{ kind: "tailnet", address: "100.64.0.9" }] };
    const peers = table([lanOnly, tailnetOnly, both], [bridge, laptop]);
    for (const node of peers.nodes) {
      const allowed = new Set([node.syncPort, bridge.port, laptop.port]);
      const ports = resolveNode(defaultProfile(), peers, node.nodeId)
        .listenAddresses.map((address) => /^[a-z+]+:\/\/[^/]*:(\d+)/.exec(address)?.[1])
        .filter((port): port is string => port !== undefined)
        .map(Number);
      assert.ok(ports.length >= 2);
      assert.deepEqual(ports.filter((port) => !allowed.has(port)), []);
      assert.ok(ports.includes(node.syncPort));
    }
  });
});

describe("this host's part of the peer table", () => {
  it("a Docker node is on the host's LAN and, TCP only, on the tailnet", () => {
    const host = [
      { kind: "lan", address: "192.168.1.5", category: "Private" },
      { kind: "tailnet", address: "100.64.0.5" },
      { kind: "public", address: "203.0.113.7" },
    ] as const;
    assert.deepEqual(dockerNetworks([...host], "storage.example.ts.net"), [
      { kind: "lan", address: "192.168.1.5", category: "Private" },
      { kind: "tailnet", address: "100.64.0.5", tcpOnly: true },
      { kind: "tailnet", address: "storage.example.ts.net", tcpOnly: true },
    ]);
    const docker: NodeAddresses = { nodeId: "storage", deviceId: "DEV-CLUSTER", syncPort: 22000, networks: dockerNetworks([...host], "") };
    assert.deepEqual(resolveNode(defaultProfile(), table([both, docker], []), "cc03").deviceAddresses["DEV-CLUSTER"], [
      "tcp://192.168.1.5:22000",
      "quic://192.168.1.5:22000",
      "tcp://100.64.0.5:22000",
      "dynamic",
    ]);
  });

  it("the host agent's nodes come from its heartbeat and the host's one bridge from bridge.json", async () => {
    const directory = mkdtempSync(join(tmpdir(), "peer-sources-"));
    try {
      const networks = [{ kind: "lan", address: "192.168.1.5", category: "Private" }, { kind: "tailnet", address: "100.64.0.5" }];
      const syncthing = { state: "running", deviceId: "DEV-AGENT", guiPort: 8385, listenPort: 22004, listenAddress: "tcp://0.0.0.0:22004", apiKey: "key", problem: null };
      const heartbeat = {
        heartbeat: new Date().toISOString(),
        heartbeatEpoch: Date.now() / 1000,
        host: "pc",
        os: "windows",
        state: "running",
        problems: [],
        nodes: [{ id: "d004", name: "D004", kind: "drive", threshold: 0, assigned: [], root: "D:\\", syncthing }],
        networks,
      };
      writeFileSync(join(directory, "heartbeat.json"), JSON.stringify(heartbeat));
      writeFileSync(join(directory, "bridge.json"), JSON.stringify({ relayId: "RELAY-DOCKER", port: 22100 }));
      const resolver = { registryDirectory: join(directory, "nodes"), heartbeatPath: join(directory, "heartbeat.json"), otherHostNodes: async () => [] };
      const local = await localPeerTable({ resolver, dockerNodeInfos: async () => [], dockerBridgeFile: join(directory, "bridge.json"), gatewayTailnetName: "storage.example.ts.net" });
      assert.deepEqual(local.nodes, [{ nodeId: "d004", name: "D004", deviceId: "DEV-AGENT", syncPort: 22004, networks }]);
      assert.deepEqual(
        local.bridges.map((entry) => [entry.host, entry.relayId, entry.addresses.map((network) => network.address)]),
        [[hostName, "RELAY-DOCKER", ["192.168.1.5", "100.64.0.5", "storage.example.ts.net"]]],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
