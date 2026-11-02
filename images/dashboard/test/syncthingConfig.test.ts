import assert from "node:assert/strict";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { isKeeperManaged, keeperManagedKeys, keeperManagedText } from "../src/api/keeperText.js";
import { listenAddressProblem } from "../src/api/optionsText.js";
import type { Versioning } from "../src/api/types.js";
import { folderSettings } from "../src/folderIndex.js";
import { RequestError } from "../src/http.js";
import { type LocalInstance, type LocalNodeSource, type RemoteInstance, type ResolvedInstance, settingsKeeperOf } from "../src/instanceResolver.js";
import { type WriteEffects, type WriteNote, requestHandler } from "../src/routes.js";
import { type OptionsRouteSources, hostSettings, nodeOptions, optionsRoutes } from "../src/routes/options.js";
import { clusterArrayId } from "../src/settings.js";
import { localNodeRules } from "../src/nodeSource.js";
import { parseLayout } from "../src/setupRepo.js";
import { SyncthingClient, type SyncthingFolderSettings } from "../src/syncthing.js";
import { folderChangeProblem, instanceGui, instanceOptions, optionsChangeProblem, redactConfig } from "../src/syncthingConfig.js";

const syncthingOptions = {
  listenAddresses: ["default"],
  globalAnnounceServers: ["default"],
  globalAnnounceEnabled: true,
  localAnnounceEnabled: true,
  localAnnouncePort: 21027,
  maxSendKbps: 0,
  maxRecvKbps: 2048,
  reconnectionIntervalS: 60,
  relaysEnabled: true,
  natEnabled: false,
  urAccepted: -1,
  urUniqueId: "abcdefgh",
  limitBandwidthInLan: false,
  minHomeDiskFree: { value: 1, unit: "%" },
  alwaysLocalNets: ["10.0.0.0/8"],
  crashReportingEnabled: true,
  stunServers: ["default"],
};

const syncthingGui = {
  enabled: true,
  address: "0.0.0.0:8384",
  unixSocketPermissions: "",
  user: "admin",
  password: "$2a$10$hash",
  authMode: "static",
  useTLS: false,
  apiKey: "secret-api-key",
  insecureAdminAccess: false,
  theme: "default",
};

describe("syncthing configuration", () => {
  it("redactConfig drops api keys and passwords at any depth", () => {
    const redacted = redactConfig({
      gui: syncthingGui,
      folders: [{ id: "documents", devices: [{ deviceID: "A", encryptionPassword: "folder-secret" }] }],
      nested: { deeper: [{ APIKey: "upper-case-key", Password: "upper-case-password", keep: 1 }] },
    });

    const text = JSON.stringify(redacted);
    for (const secret of ["secret-api-key", "$2a$10$hash", "folder-secret", "upper-case-key", "upper-case-password"]) assert.ok(!text.includes(secret), `${secret} is gone`);
    assert.deepEqual((redacted as { nested: unknown }).nested, { deeper: [{ keep: 1 }] });
    assert.equal((redacted as { gui: { user: string } }).gui.user, "admin");
  });

  it("options map syncthing's names to ours", () => {
    assert.deepEqual(instanceOptions(syncthingOptions, "pc"), {
      deviceName: "pc",
      listenAddresses: ["default"],
      globalAnnounceEnabled: true,
      localAnnounceEnabled: true,
      globalAnnounceServers: ["default"],
      relaysEnabled: true,
      natEnabled: false,
      maxSendKbps: 0,
      maxRecvKbps: 2048,
      limitBandwidthInLan: false,
      minHomeDiskFree: { value: 1, unit: "%" },
      urAccepted: -1,
      crashReportingEnabled: true,
      reconnectionIntervalS: 60,
      alwaysLocalNets: ["10.0.0.0/8"],
    });
  });

  it("options Syncthing leaves out read as off, empty or zero", () => {
    const options = instanceOptions({}, "");

    assert.deepEqual(options.listenAddresses, []);
    assert.equal(options.relaysEnabled, false);
    assert.deepEqual(options.minHomeDiskFree, { value: 0, unit: "%" });
  });

  it("the gui is read without its password or api key and marked as the stack's", () => {
    assert.deepEqual(instanceGui(syncthingGui), { address: "0.0.0.0:8384", useTLS: false, authMode: "static", user: "admin", managedBy: "stack" });
  });
});

/** A folder's configuration as Syncthing 2.1.6 answers it after a PATCH: `params` keeps the keys of the types it had before. */
function syncthingFolder(versioning: object): SyncthingFolderSettings {
  return { id: "dashboard-test-a", label: "", path: "/var/syncthing/data/dashboard-test-a", type: "sendreceive", paused: false, devices: [], versioning };
}

describe("file versioning", () => {
  it("versioning params are strings in syncthing's shape and round-trip", () => {
    const staggered: Versioning = { type: "staggered", params: { maxAge: "31536000" }, cleanupIntervalS: 3600, fsPath: "" };
    assert.equal(folderChangeProblem({ versioning: staggered }), null);
    const answered = syncthingFolder({ ...staggered, params: { cleanoutDays: "0", keep: "5", maxAge: "31536000" }, fsType: "basic" });
    assert.deepEqual(folderSettings(answered).versioning, staggered, "keys left over from an earlier type are not the folder's");
    for (const versioning of [
      { type: "", params: {}, cleanupIntervalS: 3600, fsPath: "" },
      { type: "trashcan", params: { cleanoutDays: "0" }, cleanupIntervalS: 3600, fsPath: "/var/syncthing/data/versions" },
      { type: "simple", params: { keep: "5", cleanoutDays: "30" }, cleanupIntervalS: 0, fsPath: "" },
    ] as Versioning[]) {
      assert.equal(folderChangeProblem({ versioning }), null, versioning.type);
      assert.deepEqual(folderSettings(syncthingFolder(versioning)).versioning, versioning, versioning.type);
    }
  });

  it("a versioning change is refused unless it is whole and in syncthing's shape", () => {
    const refusals: [unknown, string][] = [
      [{ type: "staggered", params: { maxAge: 31536000 }, cleanupIntervalS: 3600, fsPath: "" }, "Maximum age, in seconds, must be a whole number, 0 or more"],
      [{ type: "staggered", params: { maxAge: "-1" }, cleanupIntervalS: 3600, fsPath: "" }, "Maximum age, in seconds, must be a whole number, 0 or more"],
      [{ type: "simple", params: { keep: "0", cleanoutDays: "0" }, cleanupIntervalS: 3600, fsPath: "" }, "Versions kept must be a whole number, 1 or more"],
      [{ type: "simple", params: { keep: "5" }, cleanupIntervalS: 3600, fsPath: "" }, "simple versioning takes Versions kept, Clean out after (days)"],
      [{ type: "trashcan", params: { cleanoutDays: "0", maxAge: "1" }, cleanupIntervalS: 3600, fsPath: "" }, "trash can versioning takes Clean out after (days)"],
      [{ type: "", params: { keep: "5" }, cleanupIntervalS: 3600, fsPath: "" }, "no versioning takes no settings"],
      [{ type: "staggered", params: { maxAge: "1" } }, "File versioning must give its type, settings, cleanup interval and versions path"],
      [{ type: "staggered", params: { maxAge: "1" }, cleanupIntervalS: 3600, fsPath: "", fsType: "basic" }, "File versioning must give its type, settings, cleanup interval and versions path"],
      [{ type: "weekly", params: {}, cleanupIntervalS: 3600, fsPath: "" }, "File versioning must be none, trash can, simple, staggered"],
      [{ type: "staggered", params: { maxAge: "1" }, cleanupIntervalS: -5, fsPath: "" }, "Cleanup interval must be a whole number, 0 or more"],
      [{ type: "staggered", params: { maxAge: "1" }, cleanupIntervalS: 3600, fsPath: 7 }, "Versions path must be text"],
      [{ type: "external", params: { command: "/bin/true" }, cleanupIntervalS: 3600, fsPath: "" }, "external versioning runs a program on the node, so it is set in the node's own Syncthing configuration, not from the dashboard"],
    ];
    for (const [versioning, message] of refusals) assert.equal(folderChangeProblem({ versioning }), message, JSON.stringify(versioning));
  });
});

const ownId = "PCAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";

function reply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function fakeSyncthing(): Server {
  return createServer((request, response) => {
    if (request.headers["x-api-key"] !== syncthingGui.apiKey) return reply(response, { error: "forbidden" }, 403);
    switch (new URL(request.url ?? "/", "http://fake").pathname) {
      case "/rest/config/options":
        return reply(response, syncthingOptions);
      case "/rest/config/gui":
        return reply(response, syncthingGui);
      case "/rest/system/status":
        return reply(response, { myID: ownId });
      case "/rest/config/devices":
        return reply(response, [{ deviceID: ownId, name: "pc", addresses: ["dynamic"] }]);
      default:
        return reply(response, { error: "not faked" }, 404);
    }
  });
}

function fakeOlderDashboard(): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://peer");
    if (url.pathname !== "/api/nodes/p53n/options" || url.searchParams.get("scope") !== "local") return reply(response, { error: "wrong path" }, 404);
    reply(response, { options: instanceOptions(syncthingOptions, "p53"), gui: syncthingGui });
  });
}

describe("a node's options", () => {
  const syncthing = fakeSyncthing();
  const peer = fakeOlderDashboard();
  let syncthingUrl = "";
  let peerUrl = "";

  before(async () => {
    syncthingUrl = await listen(syncthing);
    peerUrl = await listen(peer);
  });

  after(() => {
    syncthing.close();
    peer.close();
  });

  it("are read from the node's own Syncthing, named after its own device entry", async () => {
    const instance: LocalInstance = { kind: "local", nodeId: "fb98", name: "pc", client: new SyncthingClient({ url: syncthingUrl, apiKey: syncthingGui.apiKey }), root: "F:\\", os: "windows", threshold: 50, source: "host-agent" };
    const answer = await nodeOptions(instance);

    assert.equal(answer.options.deviceName, "pc");
    assert.deepEqual(answer.options.listenAddresses, ["default"]);
    assert.equal(answer.gui.user, "admin");
    assert.equal(answer.keeper, "host-agent", "the form shows what the host agent rewrites as read only");
    assert.doesNotMatch(JSON.stringify(answer), /apikey|password|secret-api-key|\$2a\$/i);
  });

  it("of another host come from its dashboard without any secret it sent", async () => {
    const instance: RemoteInstance = { kind: "remote", nodeId: "p53n", name: "p53", host: "p53", dashboardUrl: peerUrl };
    const answer = await nodeOptions(instance);

    assert.equal(answer.options.deviceName, "p53");
    assert.deepEqual(Object.keys(answer.gui).sort(), ["address", "authMode", "managedBy", "useTLS", "user"]);
    assert.doesNotMatch(JSON.stringify(answer), /apikey|password|secret-api-key|\$2a\$/i);
  });
});

describe("the host's priority bands", () => {
  it("are the layout's own bands, highest first", () => {
    const layout = parseLayout(["[bands]", "local = 0", "essential = 80", "working = 50", "", "[folders.Documents]", 'category = "synced"', ""].join("\n"));

    assert.deepEqual(hostSettings(layout).priorityBands, [
      { name: "essential", from: 80 },
      { name: "working", from: 50 },
      { name: "local", from: 0 },
    ]);
  });

  it("are not set while the layout defines none or there is no setup repo", () => {
    assert.equal(hostSettings(parseLayout(["[folders.Documents]", 'category = "synced"', ""].join("\n"))).priorityBands, null);
    assert.equal(hostSettings(null).priorityBands, null);
  });
});

interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
}

interface FakeNode {
  url: string;
  options: Record<string, unknown>;
  /** Every request that reached this node's Syncthing, reads included. */
  requests: FakeRequest[];
  close(): void;
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : null;
}

/** A Syncthing 2.1.6 that keeps its options, with `PATCH /rest/config/options` merging the fields it is sent. */
async function optionsSyncthing(name: string, options: Record<string, unknown>): Promise<FakeNode> {
  const node = { url: "", options: { ...options }, requests: [] as FakeRequest[], close: () => {} };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    const body = await requestBody(request);
    node.requests.push({ method: request.method ?? "", path, body });
    if (request.headers["x-api-key"] !== syncthingGui.apiKey) return reply(response, { error: "forbidden" }, 403);
    if (path === "/rest/config/options" && request.method === "GET") return reply(response, node.options);
    if (path === "/rest/config/options" && request.method === "PATCH") {
      node.options = { ...node.options, ...(body as object) };
      return reply(response, null);
    }
    if (path === "/rest/config/gui") return reply(response, syncthingGui);
    if (path === "/rest/system/status") return reply(response, { myID: ownId });
    if (path === "/rest/config/devices") return reply(response, [{ deviceID: ownId, name, addresses: ["dynamic"] }]);
    return reply(response, { error: "not faked" }, 404);
  });
  node.url = await listen(server);
  node.close = () => server.close();
  return node;
}

function writesTo(node: FakeNode): FakeRequest[] {
  return node.requests.filter((request) => request.method !== "GET");
}

describe("a listen address", () => {
  it("is taken only on a port of the storage stack's rows in PORTS.md", () => {
    for (const address of ["default", "tcp://:22000", "quic://0.0.0.0:22001", "tcp4://100.75.76.90:22099", "tcp6://[::]:22050", "dynamic+https://relays.syncthing.net/endpoint", "relay://192.0.2.1:22067/?id=ABC"]) {
      assert.equal(listenAddressProblem(address), null, address);
    }
    assert.equal(
      listenAddressProblem("tcp://:30000"),
      "tcp://:30000 listens on port 30000, outside the storage stack's rows in access/PORTS.md: Syncthing sync (22000), Syncthing sync of the host agent's native nodes (22001-22020), Syncthing sync of the nodes service's nodes (22021-22099)",
    );
    assert.match(listenAddressProblem("tcp://:21999") ?? "", /port 21999, outside/);
    assert.match(listenAddressProblem("quic://[::]:22100") ?? "", /port 22100, outside/);
    assert.match(listenAddressProblem("tcp://0.0.0.0") ?? "", /names no port/);
    assert.match(listenAddressProblem("http://:22000") ?? "", /is not a listen address/);
    assert.equal(listenAddressProblem("DYNAMIC+HTTPS://relays.syncthing.net/endpoint"), null, "the scheme is case-insensitive, as relay:// is");
  });

  it("is refused where Go's SplitHostPort would refuse its host and port", () => {
    for (const address of ["tcp://::22000", "tcp://[::22000", "tcp://[::]x:22000", "quic://1.2.3.4:22000:1", "tcp://[::]]:22000"]) {
      assert.match(listenAddressProblem(address) ?? "", /is not host:port/, address);
    }
    assert.match(listenAddressProblem("tcp://[::]") ?? "", /names no port/);
    assert.match(listenAddressProblem("tcp://[::]:") ?? "", /names no port/);
  });
});

describe("a node's connection options", () => {
  let pc: FakeNode;
  let array: FakeNode;

  function local(nodeId: string, name: string, node: FakeNode): LocalInstance {
    return { kind: "local", nodeId, name, client: new SyncthingClient({ url: node.url, apiKey: syncthingGui.apiKey }), root: "/", os: "linux", threshold: 0, source: "registry" };
  }

  const remote: RemoteInstance = { kind: "remote", nodeId: "p53n", name: "p53", host: "p53", dashboardUrl: "http://127.0.0.1:1" };

  function instances(): Record<string, ResolvedInstance> {
    return { "5784": { ...local("5784", "private-array", array), source: "array" }, fb98: { ...local("fb98", "pc", pc), source: "host-agent", os: "windows" }, p53n: remote };
  }

  async function dashboard(effects: WriteEffects & { notes: WriteNote[] }): Promise<{ url: string; close: () => void }> {
    const sources: OptionsRouteSources = { resolve: async (nodeId) => instances()[nodeId] ?? Promise.reject(new RequestError(404, `no node ${nodeId}`)) };
    const handle = requestHandler(optionsRoutes(sources), effects);
    const server = createServer((request, response) => void handle(request, response));
    return { url: await listen(server), close: () => server.close() };
  }

  async function refusal(url: string, body: unknown): Promise<{ status: number; error: string }> {
    const answer = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: answer.status, error: ((await answer.json()) as { error: string }).error };
  }

  beforeEach(async () => {
    pc = await optionsSyncthing("pc", { ...syncthingOptions, listenAddresses: ["tcp://100.75.76.90:22001"] });
    array = await optionsSyncthing("private-array", syncthingOptions);
  });

  afterEach(() => {
    for (const node of [pc, array]) node.close();
  });

  it("a profile-owned option is refused on the node, naming the connection profile", async () => {
    const effects = { notes: [] as WriteNote[], invalidate: () => {}, record: (note: WriteNote) => void effects.notes.push(note) };
    const server = await dashboard(effects);
    try {
      const profileWords = "set by the connection profile, so changed for the whole cluster in Settings under Connections, a node's limits as its override there";
      assert.deepEqual(await refusal(`${server.url}/api/nodes/fb98/options`, { maxSendKbps: 100 }), { status: 400, error: `Send limit: ${profileWords}` });
      assert.deepEqual(await refusal(`${server.url}/api/nodes/5784/options`, { listenAddresses: ["tcp://:22021"], relaysEnabled: false }), { status: 400, error: `Listen addresses, Relays: ${profileWords}` });
      assert.deepEqual(await refusal(`${server.url}/api/nodes/5784/options`, { deviceName: "x" }), { status: 400, error: "deviceName is not a connection option" });
      assert.deepEqual(await refusal(`${server.url}/api/nodes/p53n/options`, { natEnabled: true }), { status: 409, error: "act on p53's dashboard" });
      for (const node of [pc, array]) assert.deepEqual(writesTo(node), [], "nothing reaches any node");
      assert.deepEqual(effects.notes, []);
    } finally {
      server.close();
    }
  });

  it("an option of the wrong kind is named before the profile is", () => {
    assert.equal(optionsChangeProblem({ deviceName: "x" }), "deviceName is not a connection option");
    assert.equal(optionsChangeProblem({ relaysEnabled: "yes" }), "Relays must be on or off");
    assert.equal(optionsChangeProblem({ maxSendKbps: -1 }), "Send limit must be a whole number, 0 or more");
    assert.equal(optionsChangeProblem({ globalAnnounceServers: ["ftp://x"] }), "ftp://x is not a discovery server: default, default-v4, default-v6 or an https:// address");
    assert.equal(optionsChangeProblem({}), "nothing to change");
    assert.equal(optionsChangeProblem({ globalAnnounceServers: ["default", "https://disco.example:8443/?id=ABC"], limitBandwidthInLan: true }), null);
  });
});

describe("which keeper rewrites a node's settings", () => {
  const node = (source: LocalNodeSource, nodeId: string, root: string | null) => ({ source, nodeId, root });

  it("names the host agent, the nodes service, or nothing, by where the node is known from", () => {
    assert.equal(settingsKeeperOf(node("host-agent", "fb98", "F:\\")), "host-agent");
    assert.equal(settingsKeeperOf(node("array", "5784", "/mnt/storage/5784")), "nodes-service", "an array other than ARRAY_PREFIX; on a host whose ARRAY_PREFIX is 5784 it is the cluster");
    assert.equal(settingsKeeperOf(node("registry", "c3d4", "/mnt/nodes/c3d4")), "nodes-service");
    assert.equal(settingsKeeperOf(node("array", clusterArrayId, "/mnt/storage/pool")), null, "the cluster's own service sets only its GUI");
    assert.equal(settingsKeeperOf(node("registry", "d7e5", "/var/syncthing/data")), null, "the test peer runs its own Syncthing");
    assert.equal(settingsKeeperOf(node("registry", "e1e1", null)), null);
  });

  it("a node on the page carries its keeper and whether a restart needs its name, by the rules the routes apply", () => {
    assert.deepEqual(localNodeRules("host-agent", "fb98", "F:\\"), { keeper: "host-agent", restartConfirmRequired: true });
    assert.deepEqual(localNodeRules("array", "5784", "/mnt/storage/5784"), { keeper: "nodes-service", restartConfirmRequired: true }, "an array other than ARRAY_PREFIX");
    assert.deepEqual(localNodeRules("array", clusterArrayId, "/mnt/storage/pool"), { keeper: null, restartConfirmRequired: true });
    assert.deepEqual(localNodeRules("registry", "c3d4", "/mnt/nodes/c3d4"), { keeper: "nodes-service", restartConfirmRequired: false });
    assert.deepEqual(localNodeRules("registry", "d7e5", "/var/syncthing/data"), { keeper: null, restartConfirmRequired: false });
  });

  it("keeps one table, read by every route and form", () => {
    assert.deepEqual([...keeperManagedKeys["host-agent"]].sort(), ["autoUpgradeIntervalH", "crashReportingEnabled", "deviceName", "startBrowser", "urAccepted"]);
    assert.deepEqual(keeperManagedKeys["nodes-service"], [], "the connection options are the profile's on every node");
    assert.equal(isKeeperManaged("host-agent", "urAccepted"), true);
    assert.equal(isKeeperManaged("nodes-service", "relaysEnabled"), false);
    assert.equal(isKeeperManaged("host-agent", "listenAddresses"), false);
    assert.equal(keeperManagedText("nodes-service"), "set by the nodes service at each start");
  });
});
