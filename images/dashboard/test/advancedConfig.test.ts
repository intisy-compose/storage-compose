import assert from "node:assert/strict";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AdvancedConfig, NodeRestartState, RestartAnswer } from "../src/api/types.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, RemoteInstance, ResolvedInstance } from "../src/instanceResolver.js";
import { type WriteEffects, type WriteNote, requestHandler } from "../src/routes.js";
import { type AdvancedConfigSources, advancedConfigRoutes } from "../src/routes/advancedConfig.js";
import type { HostNode } from "../src/routes/options.js";
import { SyncthingClient } from "../src/syncthing.js";

const apiKey = "secret-api-key";
const folderSecret = "folder-encryption-secret";
const ownId = "D7E5AAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const otherId = "OTHERAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";

type Config = Record<string, any>;

/** The parts of a Syncthing 2.1.6 configuration the advanced editor reads, shaped as measured on the test peer, secrets included. */
function nodeConfig(listenAddress: string): Config {
  return {
    options: {
      listenAddresses: [listenAddress],
      globalAnnounceServers: ["default"],
      globalAnnounceEnabled: false,
      maxSendKbps: 0,
      reconnectionIntervalS: 20,
      relaysEnabled: false,
      urAccepted: 0,
      urSeen: 0,
      urUniqueId: "",
      urURL: "https://data.syncthing.net/newdata",
      crURL: "https://crash.syncthing.net/newcrash",
      releasesURL: "https://upgrades.syncthing.net/meta.json",
      keepTemporariesH: 24,
      minHomeDiskFree: { value: 1, unit: "%" },
      alwaysLocalNets: [],
      crashReportingEnabled: true,
      featureFlags: [],
      auditEnabled: false,
      auditFile: "",
    },
    gui: { enabled: true, address: "0.0.0.0:8389", user: "", password: "", authMode: "static", useTLS: false, apiKey, theme: "default" },
    folders: [
      {
        id: "dashboard-test-a",
        label: "dashboard-test-a",
        filesystemType: "basic",
        path: "/var/syncthing/data/dashboard-test-a",
        type: "sendreceive",
        devices: [
          { deviceID: ownId, introducedBy: "", encryptionPassword: "" },
          { deviceID: otherId, introducedBy: "", encryptionPassword: folderSecret },
        ],
        rescanIntervalS: 3600,
        fsWatcherEnabled: true,
        versioning: { type: "", params: {}, cleanupIntervalS: 3600, fsPath: "", fsType: "basic" },
        copiers: 0,
        order: "random",
        maxConflicts: 10,
        paused: false,
        markerName: ".stfolder",
        xattrFilter: { entries: [], maxSingleEntrySize: 1024, maxTotalSize: 4096 },
      },
    ],
    devices: [
      { deviceID: ownId, name: "862540988a29", addresses: ["dynamic"], compression: "metadata", introducer: false, autoAcceptFolders: false, ignoredFolders: [], remoteGUIPort: 0, numConnections: 0 },
      { deviceID: otherId, name: "dashboard-test-other", addresses: ["dynamic"], compression: "metadata", introducer: false, autoAcceptFolders: false, ignoredFolders: [], remoteGUIPort: 0, numConnections: 0 },
    ],
  };
}

interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
}

interface FakeNode {
  url: string;
  config: Config;
  requiresRestart: boolean;
  requests: FakeRequest[];
  close(): void;
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : null;
}

function entryOf(list: Config[], key: string, id: string): Config | undefined {
  return list.find((entry) => entry[key] === decodeURIComponent(id));
}

/** Syncthing 2.1.6's answers: a PATCH merges its keys, a key of the wrong type is 400, the restart answers before Syncthing exits. */
function answer(node: FakeNode, method: string, path: string, body: unknown): [number, unknown] {
  const config = node.config;
  const folder = /^\/rest\/config\/folders\/([^/]+)$/.exec(path);
  const device = /^\/rest\/config\/devices\/([^/]+)$/.exec(path);
  if (path === "/rest/system/status") return [200, { myID: ownId }];
  if (path === "/rest/config/restart-required") return [200, { requiresRestart: node.requiresRestart }];
  if (path === "/rest/system/restart" && method === "POST") {
    node.requiresRestart = false;
    return [200, { ok: "restarting" }];
  }
  if (path === "/rest/config/options" && method === "GET") return [200, config.options];
  if (path === "/rest/config/options" && method === "PATCH") {
    Object.assign(config.options, body);
    if ("auditEnabled" in (body as Config)) node.requiresRestart = true;
    return [200, null];
  }
  if (path === "/rest/config/gui") return [200, config.gui];
  if (path === "/rest/config/folders" && method === "GET") return [200, config.folders];
  if (path === "/rest/config/devices" && method === "GET") return [200, config.devices];
  const entry = folder ? entryOf(config.folders, "id", folder[1]) : device ? entryOf(config.devices, "deviceID", device[1]) : undefined;
  if ((folder || device) && !entry) return [404, { error: "no such entry" }];
  if (entry && method === "GET") return [200, entry];
  if (entry && method === "PATCH") {
    if (typeof (body as Config).maxConflicts === "string") return [400, { error: "json: cannot unmarshal string into Go struct field FolderConfiguration.maxConflicts of type int" }];
    Object.assign(entry, body);
    return [200, null];
  }
  return [405, { error: "not faked" }];
}

async function fakeSyncthing(listenAddress: string): Promise<FakeNode> {
  const node: FakeNode = { url: "", config: nodeConfig(listenAddress), requiresRestart: false, requests: [], close: () => {} };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    const body = await requestBody(request);
    node.requests.push({ method: request.method ?? "", path, body });
    const [status, reply] = request.headers["x-api-key"] === apiKey ? answer(node, request.method ?? "", path, body) : [403, { error: "forbidden" }];
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(reply === undefined || reply === null ? "" : JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  node.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  node.close = () => server.close();
  return node;
}

function writesTo(node: FakeNode): FakeRequest[] {
  return node.requests.filter((request) => request.method !== "GET");
}

const remote: RemoteInstance = { kind: "remote", nodeId: "p53n", name: "p53", host: "p53", dashboardUrl: "http://127.0.0.1:1" };
const gone: LocalInstance = { kind: "local", nodeId: "dead", name: "gone-node", client: new SyncthingClient({ url: "http://127.0.0.1:9", apiKey }), root: "/data", os: "linux", threshold: 0, source: "registry" };

describe("the advanced config editor and restarts", () => {
  let peer: FakeNode;
  let array: FakeNode;
  let pc: FakeNode;
  let effects: WriteEffects & { notes: WriteNote[] };
  let dashboard: { url: string; close: () => void };

  function local(nodeId: string, name: string, node: FakeNode, source: LocalInstance["source"], root: string, os: LocalInstance["os"]): LocalInstance {
    return { kind: "local", nodeId, name, client: new SyncthingClient({ url: node.url, apiKey }), root, os, threshold: 0, source };
  }

  beforeEach(async () => {
    peer = await fakeSyncthing("tcp://:22199");
    array = await fakeSyncthing("tcp://:22001");
    pc = await fakeSyncthing("tcp://100.75.76.90:22002");
    const instances: Record<string, ResolvedInstance> = {
      d7e5: local("d7e5", "dashboard-test-peer", peer, "registry", "/var/syncthing/data", "linux"),
      "5784": local("5784", "private-array", array, "array", "/mnt/storage", "linux"),
      fb98: local("fb98", "pc", pc, "host-agent", "F:\\", "windows"),
      dead: gone,
      p53n: remote,
    };
    const hostNodes: HostNode[] = ["d7e5", "5784", "fb98"].map((nodeId) => {
      const instance = instances[nodeId] as LocalInstance;
      return { nodeId, name: instance.name, source: instance.source, instance, present: true };
    });
    const sources: AdvancedConfigSources = {
      resolve: async (nodeId) => instances[nodeId] ?? Promise.reject(new RequestError(404, `no node ${nodeId}`)),
      hostNodes: async () => hostNodes,
      readBackDelaysMs: [5, 10],
    };
    effects = { notes: [], invalidate: () => {}, record: (note) => void effects.notes.push(note) };
    const handle = requestHandler(advancedConfigRoutes(sources), effects);
    const server = createServer((request, response) => void handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    dashboard = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
  });

  afterEach(() => {
    for (const closable of [peer, array, pc, dashboard]) closable.close();
  });

  function send(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${dashboard.url}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  async function error(response: Response): Promise<string> {
    return ((await response.json()) as { error: string }).error;
  }

  async function refused(path: string, body: unknown, message: string | RegExp, status = 400): Promise<void> {
    const answer = await send("PATCH", path, body);
    assert.equal(answer.status, status, `${path} ${JSON.stringify(body)}`);
    const text = await error(answer);
    if (typeof message === "string") assert.equal(text, message, JSON.stringify(body));
    else assert.match(text, message, JSON.stringify(body));
  }

  it("the advanced editor refuses gui and api key keys", async () => {
    await refused("/api/nodes/d7e5/advanced/options", { gui: { address: "0.0.0.0:8443" } }, "the GUI is managed by the stack, so it is not changed here");
    await refused("/api/nodes/d7e5/advanced/options", { apiKey: "mine" }, "apiKey is a secret, which the dashboard never reads or sends");
    await refused("/api/nodes/d7e5/advanced/options", { password: "hunter2" }, "password is a secret, which the dashboard never reads or sends");
    await refused("/api/nodes/d7e5/advanced/options", { featureFlags: [], address: "0.0.0.0:8443" }, "the GUI is managed by the stack, so it is not changed here");
    await refused("/api/nodes/d7e5/advanced/folders/dashboard-test-a", { xattrFilter: { entries: [], apiKey: "x", maxSingleEntrySize: 1024, maxTotalSize: 4096 } }, "apiKey is a secret, which the dashboard never reads or sends");
    await refused("/api/nodes/d7e5/advanced/devices/" + otherId, { encryptionPassword: "x" }, "encryptionPassword is a secret, which the dashboard never reads or sends");
    for (const method of ["GET", "PATCH"]) {
      const gui = await send(method, "/api/nodes/d7e5/advanced/gui", method === "PATCH" ? { address: "0.0.0.0:8443" } : undefined);
      assert.equal(gui.status, 400, method);
      assert.equal(await error(gui), "the GUI is managed by the stack, so it is not changed here");
    }
    assert.deepEqual(writesTo(peer), []);

    for (const path of ["options", "folders/dashboard-test-a", `devices/${otherId}`]) {
      const read = await send("GET", `/api/nodes/d7e5/advanced/${path}`);
      assert.equal(read.status, 200, path);
      const text = await read.text();
      assert.ok(!text.includes(apiKey) && !text.includes(folderSecret), `${path} carries no secret`);
      assert.ok(!/apiKey|password/i.test(text), `${path} carries no secret key`);
    }
    const folder = (await (await send("GET", "/api/nodes/d7e5/advanced/folders/dashboard-test-a")).json()) as AdvancedConfig;
    assert.equal(folder.config.maxConflicts, 10);
    assert.equal(folder.restartRequired, false);
  });

  it("only the keys that change are sent, and the answer says whether a restart is needed", async () => {
    const answer = await send("PATCH", "/api/nodes/d7e5/advanced/folders/dashboard-test-a", { maxConflicts: 11, rescanIntervalS: 3600 });
    assert.equal(answer.status, 200);
    const saved = (await answer.json()) as AdvancedConfig;
    assert.equal(saved.config.maxConflicts, 11);
    assert.equal(saved.restartRequired, false);
    assert.deepEqual(writesTo(peer), [{ method: "PATCH", path: "/rest/config/folders/dashboard-test-a", body: { maxConflicts: 11 } }]);
    assert.deepEqual(effects.notes, [{ nodeId: "d7e5", nodeName: "dashboard-test-peer", folderId: "dashboard-test-a", text: "dashboard-test-peer: changed folder dashboard-test-a in the advanced editor; maxConflicts 11" }]);

    const again = await send("PATCH", "/api/nodes/d7e5/advanced/folders/dashboard-test-a", { maxConflicts: 11 });
    assert.equal(again.status, 200);
    assert.equal(writesTo(peer).length, 1, "a value already so is not sent");
    assert.equal(effects.notes.length, 1);

    const options = await send("PATCH", "/api/nodes/d7e5/advanced/options", { auditEnabled: true, reconnectionIntervalS: 30 });
    assert.equal(options.status, 200);
    assert.deepEqual(writesTo(peer).at(-1), { method: "PATCH", path: "/rest/config/options", body: { auditEnabled: true, reconnectionIntervalS: 30 } });
    assert.equal(effects.notes.at(-1)?.text, "dashboard-test-peer: changed options in the advanced editor; auditEnabled true; reconnectionIntervalS 30");

    const device = await send("PATCH", `/api/nodes/d7e5/advanced/devices/${otherId}`, { remoteGUIPort: 8384 });
    assert.equal(device.status, 200);
    assert.equal(((await device.json()) as AdvancedConfig).config.remoteGUIPort, 8384);
    assert.equal(effects.notes.at(-1)?.text, "dashboard-test-peer: changed device dashboard-test-other in the advanced editor; remoteGUIPort 8384");
  });

  it("the advanced editor keeps every guard of the forms", async () => {
    const refusals: [string, unknown, string | RegExp][] = [
      ["options", { listenAddresses: ["tcp://:30000"] }, /^tcp:\/\/:30000 listens on port 30000, outside the storage stack's rows in access\/PORTS\.md/],
      ["options", { listenAddresses: ["tcp://:22001"] }, "tcp://:22001 listens on port 22001, which private-array already lists (tcp://:22001)"],
      ["options", { globalAnnounceServers: ["http://plain"] }, /is not a discovery server/],
      ["options", { urAccepted: 3 }, "usage reporting is the person's own answer: give it in General's usage reports"],
      ["options", { urUniqueId: "abc" }, "usage reporting is the person's own answer: give it in General's usage reports"],
      ["options", { crURL: "https://elsewhere.example/crash" }, "crURL stays Syncthing's own: where a node sends reports or looks for releases is not changed here"],
      ["options", { auditFile: "/etc/cron.d/audit" }, "auditFile: /etc/cron.d/audit is outside dashboard-test-peer's root /var/syncthing/data"],
      ["options", { minHomeDiskFree: { value: 200, unit: "%" } }, /cannot be more than 100 %/],
      ["options", { madeUpOption: 1 }, "madeUpOption is not a setting of these options"],
      ["options", { keepTemporariesH: "24" }, "keepTemporariesH must be a number, as Syncthing has it"],
      ["folders/dashboard-test-a", { id: "renamed" }, "the folder ID cannot be changed"],
      ["folders/dashboard-test-a", { path: "/etc" }, "path is changed in the folder's own form, which checks it"],
      ["folders/dashboard-test-a", { devices: [] }, "devices is changed in the folder's own form, which checks it"],
      ["folders/dashboard-test-a", { versioning: { type: "external", params: { command: "/bin/sh" }, cleanupIntervalS: 3600, fsPath: "" } }, "versioning is changed in the folder's own form, which checks it"],
      ["folders/dashboard-test-a", { filesystemType: "fake" }, "filesystemType stays as Syncthing set it"],
      ["folders/dashboard-test-a", { markerName: "../../etc" }, "markerName must be a name inside the folder, without / or \\ or .."],
      ["folders/dashboard-test-a", { type: "receiveencrypted" }, /^Type must be /],
      ["folders/dashboard-test-a", { maxConflicts: -5 }, /^Conflict copies kept must be/],
      ["folders/missing", { maxConflicts: 1 }, "dashboard-test-peer has no folder missing"],
      [`devices/${otherId}`, { deviceID: ownId }, "the device ID cannot be changed"],
      [`devices/${otherId}`, { addresses: ["ftp://x"] }, /is not dynamic or a tcp:\/\//],
      [`devices/${otherId}`, { ignoredFolders: "none" }, "ignoredFolders must be a list, as Syncthing has it"],
      [`devices/${ownId}`, { name: " " }, "Device name cannot be empty: other devices show it"],
    ];
    for (const [target, body, message] of refusals) await refused(`/api/nodes/d7e5/advanced/${target}`, body, message, target === "folders/missing" ? 404 : 400);
    await refused(`/api/nodes/5784/advanced/devices/${otherId}`, { introducer: true }, "Introducer stays off on private-array, an array: Syncthing would then add or share its folders with nothing typed");
    await refused(`/api/nodes/5784/advanced/devices/${otherId}`, { autoAcceptFolders: true }, /^Accept folders automatically stays off on private-array, an array/);
    await refused("/api/nodes/d7e5/advanced/options", {}, "nothing to change");
    await refused("/api/nodes/p53n/advanced/options", { featureFlags: [] }, "act on p53's dashboard", 409);
    await refused("/api/nodes/dead/advanced/options", { featureFlags: [] }, /gone-node's Syncthing is not answering/, 503);
    for (const node of [peer, array, pc]) assert.deepEqual(writesTo(node), []);
    assert.equal(effects.notes.length, 0);

    const inRoot = await send("PATCH", "/api/nodes/d7e5/advanced/options", { auditFile: "/var/syncthing/data/audit.log", listenAddresses: ["tcp://:22003"] });
    assert.equal(inRoot.status, 200, "an audit file inside the root and a free port in the rows pass");
    const refusedBySyncthing = await send("PATCH", "/api/nodes/d7e5/advanced/folders/dashboard-test-a", { maxConflicts: 11, markerName: ".stmarker" });
    assert.equal(refusedBySyncthing.status, 200);
  });

  it("restart required is reported per node", async () => {
    array.requiresRestart = true;
    const peerState = await send("GET", "/api/nodes/d7e5/restart-required");
    assert.equal(peerState.status, 200);
    assert.deepEqual((await peerState.json()) as NodeRestartState, { restartRequired: false, confirmRequired: false });
    assert.deepEqual(await (await send("GET", "/api/nodes/5784/restart-required")).json(), { restartRequired: true, confirmRequired: true });
    assert.deepEqual(await (await send("GET", "/api/nodes/fb98/restart-required")).json(), { restartRequired: false, confirmRequired: true });
    assert.equal((await send("GET", "/api/nodes/p53n/restart-required")).status, 409);
    assert.equal((await send("GET", "/api/nodes/dead/restart-required")).status, 503);

    await send("PATCH", "/api/nodes/d7e5/advanced/options", { auditEnabled: true });
    assert.equal(((await (await send("GET", "/api/nodes/d7e5/restart-required")).json()) as NodeRestartState).restartRequired, true);
    assert.equal(((await (await send("GET", "/api/nodes/5784/restart-required")).json()) as NodeRestartState).restartRequired, true);
    assert.equal(((await (await send("GET", "/api/nodes/fb98/restart-required")).json()) as NodeRestartState).restartRequired, false, "one node's restart need is not another's");
  });

  it("a restart of an array or the host's native node needs its name typed", async () => {
    for (const [nodeId, name, node] of [["5784", "private-array", array], ["fb98", "pc", pc]] as const) {
      const unconfirmed = await send("POST", `/api/nodes/${nodeId}/restart`, {});
      assert.equal(unconfirmed.status, 400);
      assert.equal(await error(unconfirmed), `type ${name} to restart its Syncthing: its folders stop syncing until it is back`);
      assert.equal((await send("POST", `/api/nodes/${nodeId}/restart`, { confirm: "wrong" })).status, 400);
      assert.deepEqual(writesTo(node), []);
    }
    const confirmed = await send("POST", "/api/nodes/5784/restart", { confirm: "private-array" });
    assert.equal(confirmed.status, 200);
    assert.deepEqual((await confirmed.json()) as RestartAnswer, { restarting: true });
    assert.deepEqual(writesTo(array), [{ method: "POST", path: "/rest/system/restart", body: null }]);

    const peerRestart = await send("POST", "/api/nodes/d7e5/restart", {});
    assert.equal(peerRestart.status, 200, "a container node restarts without a typed name");
    assert.deepEqual(writesTo(peer), [{ method: "POST", path: "/rest/system/restart", body: null }]);
    assert.deepEqual(effects.notes.map((note) => note.text), ["private-array: restarted its Syncthing", "dashboard-test-peer: restarted its Syncthing"]);

    assert.equal((await send("POST", "/api/nodes/p53n/restart", {})).status, 409);
    const dead = await send("POST", "/api/nodes/dead/restart", {});
    assert.equal(dead.status, 503);
    assert.match(await error(dead), /gone-node's Syncthing is not answering/);
  });
});
