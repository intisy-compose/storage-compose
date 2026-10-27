import assert from "node:assert/strict";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { applyToHostQuery, listenAddressProblem, perNodeListenText } from "../src/api/optionsText.js";
import { type OptionsEditResponse, type Versioning, connectionOptionsOf } from "../src/api/types.js";
import { folderSettings } from "../src/folderIndex.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, RemoteInstance, ResolvedInstance } from "../src/instanceResolver.js";
import { type WriteEffects, type WriteNote, requestHandler } from "../src/routes.js";
import { type HostNode, type OptionsRouteSources, editOptions, hostSettings, nodeOptions, optionsRoutes } from "../src/routes/options.js";
import { parseLayout } from "../src/setupRepo.js";
import { SyncthingClient, type SyncthingFolderSettings } from "../src/syncthing.js";
import { changedFields, folderChangeProblem, instanceGui, instanceOptions, optionsChangeProblem, redactConfig } from "../src/syncthingConfig.js";

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
      "tcp://:30000 listens on port 30000, outside the storage stack's rows in access/PORTS.md: Syncthing sync (22000), Syncthing sync of each further node on a host, reserved (22001-22099)",
    );
    assert.match(listenAddressProblem("tcp://:21999") ?? "", /port 21999, outside/);
    assert.match(listenAddressProblem("quic://[::]:22100") ?? "", /port 22100, outside/);
    assert.match(listenAddressProblem("tcp://0.0.0.0") ?? "", /names no port/);
    assert.match(listenAddressProblem("http://:22000") ?? "", /is not a listen address/);
  });
});

describe("editing a node's connection options", () => {
  const peerOptions = { ...syncthingOptions, listenAddresses: ["tcp://:22002"], relaysEnabled: false, maxSendKbps: 0 };
  let peer: FakeNode;
  let pc: FakeNode;
  let array: FakeNode;
  /** How often the route listed this host's nodes. */
  let hostNodeReads = 0;

  function local(nodeId: string, name: string, node: FakeNode): LocalInstance {
    return { kind: "local", nodeId, name, client: new SyncthingClient({ url: node.url, apiKey: syncthingGui.apiKey }), root: "/", os: "linux", threshold: 0, source: "registry" };
  }

  const remote: RemoteInstance = { kind: "remote", nodeId: "p53n", name: "p53", host: "p53", dashboardUrl: "http://127.0.0.1:1" };

  function instances(): Record<string, ResolvedInstance> {
    return { d7e5: local("d7e5", "dashboard-test-peer", peer), fb98: { ...local("fb98", "pc", pc), source: "host-agent", os: "windows" }, p53n: remote };
  }

  /** This host's nodes: the array 5784, whose drives are attached only with `arrayAttached`, the peer and pc. */
  function hostNodes(arrayAttached: boolean): HostNode[] {
    const all = instances();
    return [
      { nodeId: "5784", name: "private-array", instance: arrayAttached ? { ...local("5784", "private-array", array), source: "array" } : null, present: arrayAttached },
      { nodeId: "d7e5", name: "dashboard-test-peer", instance: all.d7e5 as LocalInstance, present: true },
      { nodeId: "fb98", name: "pc", instance: all.fb98 as LocalInstance, present: true },
    ];
  }

  function recordingEffects(): WriteEffects & { notes: WriteNote[]; invalidations: number } {
    const effects = { notes: [] as WriteNote[], invalidations: 0, invalidate: () => void (effects.invalidations += 1), record: (note: WriteNote) => void effects.notes.push(note) };
    return effects;
  }

  async function dashboardWith(effects: WriteEffects, arrayAttached = false): Promise<{ url: string; close: () => void }> {
    const sources: OptionsRouteSources = {
      resolve: async (nodeId) => instances()[nodeId] ?? Promise.reject(new RequestError(404, `no node ${nodeId}`)),
      hostNodes: async () => {
        hostNodeReads += 1;
        return hostNodes(arrayAttached);
      },
      readBackDelaysMs: [5, 10],
    };
    const handle = requestHandler(optionsRoutes(sources), effects);
    const dashboard = createServer((request, response) => void handle(request, response));
    return { url: await listen(dashboard), close: () => dashboard.close() };
  }

  function patch(url: string, body: unknown): Promise<Response> {
    return fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  beforeEach(async () => {
    hostNodeReads = 0;
    peer = await optionsSyncthing("dashboard-test-peer", peerOptions);
    pc = await optionsSyncthing("pc", { ...syncthingOptions, listenAddresses: ["tcp://100.75.76.90:22001"] });
    array = await optionsSyncthing("private-array", syncthingOptions);
  });

  afterEach(() => {
    for (const node of [peer, pc, array]) node.close();
  });

  it("apply to all never sends listen addresses", async () => {
    const effects = recordingEffects();
    const dashboard = await dashboardWith(effects, true);
    try {
      const refused = await patch(`${dashboard.url}/api/nodes/d7e5/options?${applyToHostQuery}`, { listenAddresses: ["tcp://:22003"], relaysEnabled: true });
      assert.equal(refused.status, 400);
      assert.equal(((await refused.json()) as { error: string }).error, perNodeListenText);
      for (const node of [peer, pc, array]) assert.deepEqual(node.requests, [], "nothing reaches any node");
      assert.equal(hostNodeReads, 0, "the host's nodes are not even listed");

      const answer = await patch(`${dashboard.url}/api/nodes/d7e5/options?${applyToHostQuery}`, { relaysEnabled: true, maxSendKbps: 1000 });
      assert.equal(answer.status, 200);
      const edit = (await answer.json()) as OptionsEditResponse;
      assert.deepEqual(
        edit.nodes.map((result) => [result.nodeId, result.outcome]),
        [
          ["d7e5", "saved"],
          ["5784", "saved"],
          ["fb98", "saved"],
        ],
      );
      for (const node of [peer, pc, array]) {
        for (const write of writesTo(node)) assert.ok(!Object.hasOwn(write.body as object, "listenAddresses"), "no write carries listen addresses");
      }
      assert.deepEqual(writesTo(peer).map((write) => write.body), [{ relaysEnabled: true, maxSendKbps: 1000 }]);
      assert.deepEqual(pc.options.listenAddresses, ["tcp://100.75.76.90:22001"], "each node keeps its own port");
      assert.deepEqual(effects.notes.map((note) => note.text), [
        "dashboard-test-peer: changed connection options; relays on; send limit 1000 KiB/s",
        "private-array: changed connection options; send limit 1000 KiB/s",
        "pc: changed connection options; send limit 1000 KiB/s",
      ]);
      assert.equal(effects.invalidations, 1, "the refused request dropped nothing, the saved one once");
    } finally {
      dashboard.close();
    }
  });

  it("a listen port outside the stack's rows is 400", async () => {
    const effects = recordingEffects();
    const dashboard = await dashboardWith(effects);
    try {
      const refused = await patch(`${dashboard.url}/api/nodes/d7e5/options`, { listenAddresses: ["tcp://:30000"] });
      assert.equal(refused.status, 400);
      assert.match(((await refused.json()) as { error: string }).error, /port 30000, outside the storage stack's rows in access\/PORTS\.md: Syncthing sync \(22000\), Syncthing sync of each further node on a host, reserved \(22001-22099\)/);
      assert.deepEqual(writesTo(peer), []);
      assert.equal((await patch(`${dashboard.url}/api/nodes/d7e5/options`, { listenAddresses: [] })).status, 400);

      const taken = await patch(`${dashboard.url}/api/nodes/d7e5/options`, { listenAddresses: ["tcp://:22003", "quic://:22003"] });
      assert.equal(taken.status, 200);
      assert.deepEqual(writesTo(peer).map((write) => write.body), [{ listenAddresses: ["tcp://:22003", "quic://:22003"] }]);
      assert.deepEqual(effects.notes.map((note) => note.text), ["dashboard-test-peer: changed connection options; listen addresses tcp://:22003, quic://:22003"]);
    } finally {
      dashboard.close();
    }
  });

  it("only changed options are sent", async () => {
    const saved = connectionOptionsOf(instanceOptions(peerOptions, "dashboard-test-peer"));
    const draft = { ...saved, relaysEnabled: true, globalAnnounceServers: [...saved.globalAnnounceServers] };
    assert.deepEqual(changedFields(saved, draft), { relaysEnabled: true }, "the form sends only what the person changed");

    const effects = recordingEffects();
    const dashboard = await dashboardWith(effects);
    try {
      const answer = await patch(`${dashboard.url}/api/nodes/d7e5/options`, { relaysEnabled: true, natEnabled: false });
      assert.equal(answer.status, 200);
      assert.deepEqual(writesTo(peer).map((write) => write.body), [{ relaysEnabled: true }], "an option already so is not sent");
      const [result] = ((await answer.json()) as OptionsEditResponse).nodes;
      assert.equal(result.outcome, "saved");
      assert.equal(result.options?.relaysEnabled, true);

      const again = await patch(`${dashboard.url}/api/nodes/d7e5/options`, { relaysEnabled: true });
      assert.equal(((await again.json()) as OptionsEditResponse).nodes[0].outcome, "unchanged");
      assert.equal(writesTo(peer).length, 1, "nothing is sent when nothing changes");
      assert.equal(effects.notes.length, 1, "and Activity records nothing");
    } finally {
      dashboard.close();
    }
  });

  it("an edit of one node reaches no other node", async () => {
    const dashboard = await dashboardWith(recordingEffects(), true);
    try {
      assert.equal((await patch(`${dashboard.url}/api/nodes/d7e5/options`, { relaysEnabled: true })).status, 200);
      assert.deepEqual(pc.requests, []);
      assert.deepEqual(array.requests, []);
    } finally {
      dashboard.close();
    }
  });

  it("apply to all leaves a node that is not connected alone and says so", async () => {
    const dashboard = await dashboardWith(recordingEffects(), false);
    try {
      const edit = (await (await patch(`${dashboard.url}/api/nodes/d7e5/options?${applyToHostQuery}`, { natEnabled: true })).json()) as OptionsEditResponse;
      assert.deepEqual(
        edit.nodes.map((result) => [result.nodeId, result.outcome, result.problem]),
        [
          ["d7e5", "saved", null],
          ["5784", "not connected", "private-array is not connected, so it was not changed"],
          ["fb98", "saved", null],
        ],
      );
      assert.deepEqual(array.requests, []);
    } finally {
      dashboard.close();
    }
  });

  it("apply to all reports a node that does not answer and still changes the others", async () => {
    pc.close();
    const dashboard = await dashboardWith(recordingEffects(), true);
    try {
      const edit = (await (await patch(`${dashboard.url}/api/nodes/d7e5/options?${applyToHostQuery}`, { localAnnounceEnabled: false })).json()) as OptionsEditResponse;
      assert.deepEqual(
        edit.nodes.map((result) => [result.nodeId, result.outcome]),
        [
          ["d7e5", "saved"],
          ["5784", "saved"],
          ["fb98", "failed"],
        ],
      );
      assert.equal(edit.nodes[2].problem, "pc's Syncthing is not answering");
    } finally {
      dashboard.close();
    }
  });

  it("is refused for another host's node, and for an option this form does not change", async () => {
    await assert.rejects(editOptions(remote, { relaysEnabled: true }, null), (error: Error & { status?: number }) => error.status === 409 && error.message === "act on p53's dashboard");
    assert.equal(optionsChangeProblem({ deviceName: "x" }, false), "deviceName is not a connection option");
    assert.equal(optionsChangeProblem({ relaysEnabled: "yes" }, false), "Relays must be on or off");
    assert.equal(optionsChangeProblem({ maxSendKbps: -1 }, false), "Send limit must be a whole number, 0 or more");
    assert.equal(optionsChangeProblem({ globalAnnounceServers: ["ftp://x"] }, false), "ftp://x is not a discovery server: default, default-v4, default-v6 or an https:// address");
    assert.equal(optionsChangeProblem({}, false), "nothing to change");
    assert.equal(optionsChangeProblem({ globalAnnounceServers: ["default", "https://disco.example:8443/?id=ABC"], limitBandwidthInLan: true }, true), null);
  });

  it("a node whose Syncthing does not answer is 503 and names it", async () => {
    pc.close();
    await assert.rejects(editOptions(instances().fb98, { relaysEnabled: true }, null), (error: Error & { status?: number }) => error.status === 503 && error.message === "pc's Syncthing is not answering");
  });
});
