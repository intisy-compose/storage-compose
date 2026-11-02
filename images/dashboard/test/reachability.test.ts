import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Bridge, ConnectionProfile, NodeAddresses, PeerTable } from "../src/api/types.js";
import { defaultProfile } from "../src/connectionProfile.js";
import { hostAllowlist } from "../src/http.js";
import { pairsWithoutCommonMethod } from "../src/reachability.js";
import { requestHandler } from "../src/routes.js";
import { connectionRoutes } from "../src/routes/connections.js";
import { readProfile } from "../src/setupRepo.js";

const lanAndTailnet: NodeAddresses = {
  nodeId: "aa01",
  deviceId: "DEV-AA",
  syncPort: 22001,
  networks: [
    { kind: "lan", address: "192.168.1.10", category: "Private" },
    { kind: "tailnet", address: "100.64.0.1" },
  ],
};
const tailnetOnly: NodeAddresses = { nodeId: "bb02", deviceId: "DEV-BB", syncPort: 22002, networks: [{ kind: "tailnet", address: "100.64.0.2" }] };
const lanOnly: NodeAddresses = { nodeId: "cc03", deviceId: "DEV-CC", syncPort: 22003, networks: [{ kind: "lan", address: "192.168.1.30", category: "Private" }] };
const bridgeOnBoth: Bridge = {
  host: "pc",
  relayId: "RELAY-PC",
  port: 22100,
  addresses: [
    { kind: "lan", address: "192.168.1.5", category: "Private" },
    { kind: "tailnet", address: "100.64.0.5" },
  ],
};

function table(nodes: NodeAddresses[], bridges: Bridge[] = []): PeerTable {
  return { nodes, bridges, builtAt: "2026-11-02T10:00:00.000Z" };
}

function withoutRelays(change: (profile: ConnectionProfile) => void = () => {}): ConnectionProfile {
  const profile = defaultProfile();
  profile.relays.public = false;
  profile.relays.bridges = false;
  change(profile);
  return profile;
}

describe("pairs without a common method", () => {
  it("turning tailnet off names the pairs that share no other method", () => {
    const peers = table([lanAndTailnet, tailnetOnly, lanOnly]);
    assert.deepEqual(pairsWithoutCommonMethod(withoutRelays(), peers), [["bb02", "cc03"]]);
    assert.deepEqual(
      pairsWithoutCommonMethod(withoutRelays((profile) => (profile.methods.tailnet = false)), peers),
      [
        ["aa01", "bb02"],
        ["bb02", "cc03"],
      ],
    );
  });

  it("with a bridge on both networks no pair is named", () => {
    const bridged = withoutRelays((profile) => (profile.relays.bridges = true));
    assert.deepEqual(pairsWithoutCommonMethod(bridged, table([lanAndTailnet, tailnetOnly, lanOnly], [bridgeOnBoth])), []);
    assert.deepEqual(pairsWithoutCommonMethod(withoutRelays(), table([tailnetOnly, lanOnly], [bridgeOnBoth])), [["bb02", "cc03"]], "the bridge carries nothing while bridges are off");
  });

  it("the public relays and a public address reach every node", () => {
    const peers = table([tailnetOnly, lanOnly]);
    assert.deepEqual(pairsWithoutCommonMethod(defaultProfile(), peers), []);
    const publicNode: NodeAddresses = { nodeId: "dd04", deviceId: "DEV-DD", syncPort: 22000, networks: [{ kind: "public", address: "203.0.113.4" }] };
    assert.deepEqual(pairsWithoutCommonMethod(withoutRelays(), table([tailnetOnly, publicNode])), []);
    assert.deepEqual(pairsWithoutCommonMethod(withoutRelays((profile) => (profile.methods.nat = false)), table([tailnetOnly, publicNode])), [["bb02", "dd04"]]);
  });
});

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("saving a profile that strands pairs", () => {
  let root: string;
  let remote: string;
  let ours: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "strand-repo-"));
    remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    ours = join(root, "ours");
    execFileSync("git", ["clone", "-q", remote, ours], { stdio: "ignore" });
    git(ours, "config", "user.email", "test@example.invalid");
    git(ours, "config", "user.name", "test");
    writeFileSync(join(ours, "drive-sync.toml"), "# layout\n");
    git(ours, "add", ".");
    git(ours, "commit", "-q", "-m", "seed");
    git(ours, "push", "-q", "origin", "HEAD:main");
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  async function put(profile: object): Promise<{ status: number; body: { error?: string } }> {
    const named = (node: NodeAddresses, name: string): NodeAddresses => ({ ...node, name });
    const peers = table([named(lanAndTailnet, "alpha"), named(tailnetOnly, "bravo"), lanOnly]);
    const body = { ...profile, base: (await readProfile(ours)).profile };
    const handler = requestHandler(connectionRoutes(ours, { local: async () => peers, all: async () => peers }), { invalidate: () => {}, record: () => {} }, hostAllowlist(["localhost"]));
    const server: Server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const text = JSON.stringify(body);
    try {
      return await new Promise((resolve, reject) => {
        const outgoing = httpRequest(
          { host: "127.0.0.1", port, method: "PUT", path: "/api/connections/profile", headers: { Host: "localhost", "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)) } },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
          },
        );
        outgoing.on("error", reject);
        outgoing.end(text);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("a save that strands a pair without the confirmation is 409", async () => {
    const headBefore = git(ours, "rev-parse", "HEAD");
    const stranding = withoutRelays((profile) => (profile.methods.tailnet = false));
    const refused = await put(stranding);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "alpha and bravo, bravo and cc03 would share no connection method; confirm to save anyway");
    assert.equal(git(ours, "rev-parse", "HEAD"), headBefore, "nothing is committed");

    const confirmed = await put({ ...stranding, confirmUnreachable: true });
    assert.equal(confirmed.status, 200);
    assert.match(readFileSync(join(ours, "connections.toml"), "utf8"), /tailnet = false/);
    assert.equal(git(remote, "rev-parse", "main"), git(ours, "rev-parse", "HEAD"));
  });

  it("a save that strands no pair beyond those already stranded needs no confirmation", async () => {
    const limited = withoutRelays((profile) => {
      profile.methods.tailnet = false;
      profile.nodeLimits.bb02 = { maxSendKbps: 500 };
    });
    const answer = await put(limited);
    assert.equal(answer.status, 200);
    assert.match(readFileSync(join(ours, "connections.toml"), "utf8"), /\[limits\.node\.bb02\]\nmax_send_kbps = 500/);
  });
});
