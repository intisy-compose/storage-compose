import assert from "node:assert/strict";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DefaultIgnores, DeviceDefaults, FolderDefaults, GeneralEditResponse, IgnoredLists, Versioning } from "../src/api/types.js";
import { versioningWords } from "../src/api/versioningText.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, RemoteInstance, ResolvedInstance } from "../src/instanceResolver.js";
import { type WriteEffects, type WriteNote, requestHandler } from "../src/routes.js";
import { type NodeSettingsSources, nodeSettingsRoutes } from "../src/routes/nodeSettings.js";
import { SyncthingClient } from "../src/syncthing.js";

const apiKey = "secret-api-key";
const ownId = "D7E5AAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const tw1 = "TWONEAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const tw2 = "TWOTWOA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const tw3 = "TWOTHRE-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const passwordHash = "$2a$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012";

/** A whole Syncthing 2.1.6 configuration as measured on the test peer, secrets included, with ignored devices and folders. */
function wholeConfig(): Record<string, unknown> {
  return {
    version: 52,
    folders: [],
    devices: [
      { deviceID: ownId, name: "862540988a29", addresses: ["dynamic"], compression: "metadata", introducer: false, autoAcceptFolders: false, ignoredFolders: [] },
      {
        deviceID: tw1,
        name: "dashboard-test-tw1",
        addresses: ["tcp://127.0.0.1:22198"],
        compression: "metadata",
        ignoredFolders: [
          { time: "2026-10-27T09:00:00Z", id: "dashboard-test-b", label: "dashboard-test-b" },
          { time: "2026-10-27T09:01:00Z", id: "dashboard-test-c", label: "Dashboard Test C" },
        ],
      },
    ],
    gui: { enabled: true, address: "0.0.0.0:8389", user: "admin", password: passwordHash, apiKey, theme: "default" },
    ldap: {},
    options: {
      listenAddresses: ["tcp://:22199"],
      globalAnnounceEnabled: false,
      relaysEnabled: false,
      urAccepted: 0,
      urSeen: 0,
      urUniqueId: "",
      minHomeDiskFree: { value: 1, unit: "%" },
      crashReportingEnabled: true,
    },
    remoteIgnoredDevices: [
      { time: "2026-10-27T09:02:00Z", deviceID: tw2, name: "dashboard-test-tw2", address: "192.0.2.12:22000" },
      { time: "2026-10-27T09:03:00Z", deviceID: tw3, name: "dashboard-test-tw3", address: "192.0.2.13:22000" },
    ],
    defaults: {
      folder: {
        id: "",
        label: "",
        filesystemType: "basic",
        path: "",
        type: "sendreceive",
        devices: [{ deviceID: ownId, introducedBy: "", encryptionPassword: "" }],
        rescanIntervalS: 3600,
        fsWatcherEnabled: true,
        fsWatcherDelayS: 10,
        ignorePerms: false,
        minDiskFree: { value: 1, unit: "%" },
        versioning: { type: "", params: {}, cleanupIntervalS: 3600, fsPath: "", fsType: "basic" },
        order: "random",
        maxConflicts: 10,
        syncOwnership: false,
        syncXattrs: false,
        markerName: ".stfolder",
      },
      device: {
        deviceID: "",
        name: "",
        addresses: ["dynamic"],
        compression: "metadata",
        introducer: false,
        paused: false,
        allowedNetworks: [],
        autoAcceptFolders: false,
        maxSendKbps: 0,
        maxRecvKbps: 0,
        ignoredFolders: [],
        untrusted: false,
        numConnections: 0,
      },
      ignores: { lines: [] },
    },
  };
}

interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
}

interface FakeNode {
  url: string;
  config: Record<string, unknown>;
  requests: FakeRequest[];
  /** Set to refuse every options PATCH, as a Syncthing that fails mid-change does. */
  refuseOptions: boolean;
  /** Set to drop the options PATCH and every later request, as a Syncthing that stops answering mid-change does. */
  goesSilentOnOptions: boolean;
  silent: boolean;
  close(): void;
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : null;
}

type Config = Record<string, any>;

/** Syncthing 2.1.6's config endpoints over one whole configuration, so a narrow write shows in the whole read and back. */
function answer(node: FakeNode, method: string, path: string, body: unknown): [number, unknown] {
  const config = node.config as Config;
  const device = /^\/rest\/config\/devices\/([^/]+)$/.exec(path);
  if (path === "/rest/system/status") return [200, { myID: ownId, urVersionMax: 3 }];
  if (path === "/rest/config" && method === "GET") return [200, config];
  if (path === "/rest/config" && method === "PUT") return [200, void (node.config = body as Config)];
  if (path === "/rest/config/options" && method === "GET") return [200, config.options];
  if (path === "/rest/config/options" && method === "PATCH" && node.refuseOptions) return [500, { error: "options refused" }];
  if (path === "/rest/config/options" && method === "PATCH") return [200, void (config.options = { ...config.options, ...(body as object) })];
  if (path === "/rest/config/gui") return [200, config.gui];
  if (path === "/rest/config/devices" && method === "GET") return [200, config.devices];
  if (device && method === "GET") {
    const entry = (config.devices as Config[]).find((candidate) => candidate.deviceID === decodeURIComponent(device[1]));
    return entry ? [200, entry] : [404, { error: "no such device" }];
  }
  if (device && method === "PATCH") {
    const entry = (config.devices as Config[]).find((candidate) => candidate.deviceID === decodeURIComponent(device[1]));
    if (!entry) return [404, { error: "no such device" }];
    Object.assign(entry, body);
    return [200, null];
  }
  for (const kind of ["folder", "device"]) {
    if (path !== `/rest/config/defaults/${kind}`) continue;
    if (method === "GET") return [200, config.defaults[kind]];
    if (method === "PATCH") return [200, void (config.defaults[kind] = { ...config.defaults[kind], ...(body as object) })];
  }
  if (path === "/rest/config/defaults/ignores" && method === "GET") return [200, config.defaults.ignores];
  if (path === "/rest/config/defaults/ignores" && method === "PUT") return [200, void (config.defaults.ignores = body)];
  return [405, { error: "not faked" }];
}

async function fakeSyncthing(): Promise<FakeNode> {
  const node: FakeNode = { url: "", config: wholeConfig(), requests: [], refuseOptions: false, goesSilentOnOptions: false, silent: false, close: () => {} };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    const body = await requestBody(request);
    node.requests.push({ method: request.method ?? "", path, body });
    node.silent ||= node.goesSilentOnOptions && request.method === "PATCH" && path === "/rest/config/options";
    if (node.silent) return request.socket.destroy();
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

describe("a node's general settings, defaults and ignored lists", () => {
  let peer: FakeNode;
  let array: FakeNode;
  let pc: FakeNode;
  let effects: WriteEffects & { notes: WriteNote[]; invalidations: number };
  let dashboard: { url: string; close: () => void };

  function local(nodeId: string, name: string, node: FakeNode, source: LocalInstance["source"]): LocalInstance {
    return { kind: "local", nodeId, name, client: new SyncthingClient({ url: node.url, apiKey }), root: "/var/syncthing/data", os: "linux", threshold: 0, source };
  }

  beforeEach(async () => {
    peer = await fakeSyncthing();
    array = await fakeSyncthing();
    pc = await fakeSyncthing();
    const instances: Record<string, ResolvedInstance> = {
      d7e5: local("d7e5", "dashboard-test-peer", peer, "registry"),
      "5784": local("5784", "private-array", array, "array"),
      fb98: { ...local("fb98", "pc", pc, "host-agent"), root: "F:\\", os: "windows" },
      p53n: remote,
    };
    const sources: NodeSettingsSources = {
      resolve: async (nodeId) => instances[nodeId] ?? Promise.reject(new RequestError(404, `no node ${nodeId}`)),
      readBackDelaysMs: [5, 10],
    };
    effects = { notes: [], invalidations: 0, invalidate: () => void (effects.invalidations += 1), record: (note) => void effects.notes.push(note) };
    const handle = requestHandler(nodeSettingsRoutes(sources), effects);
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

  it("renaming the instance changes only its own device entry", async () => {
    const before = structuredClone(peer.config) as Config;
    const answer = await send("PATCH", "/api/nodes/d7e5/general", { deviceName: "dashboard-test-renamed" });
    assert.equal(answer.status, 200);
    const edit = (await answer.json()) as GeneralEditResponse;
    assert.equal(edit.settings?.options.deviceName, "dashboard-test-renamed");
    assert.equal(edit.problem, null);
    assert.deepEqual(writesTo(peer), [{ method: "PATCH", path: `/rest/config/devices/${ownId}`, body: { name: "dashboard-test-renamed" } }]);
    const after = peer.config as Config;
    assert.deepEqual(after.devices[1], before.devices[1], "the other device is untouched");
    assert.deepEqual(after.options, before.options, "no option is written");
    assert.deepEqual(effects.notes.map((note) => note.text), ["dashboard-test-peer: renamed this node's device from 862540988a29 to dashboard-test-renamed"]);
  });

  it("a rename whose options then fail is answered as done, with the options' problem, and enters Activity", async () => {
    peer.refuseOptions = true;
    const answer = await send("PATCH", "/api/nodes/d7e5/general", { deviceName: "dashboard-test-renamed", crashReportingEnabled: false });
    assert.equal(answer.status, 200);
    const edit = (await answer.json()) as GeneralEditResponse;
    assert.equal(edit.settings?.options.deviceName, "dashboard-test-renamed");
    assert.match(edit.problem ?? "", /^the other settings were not saved: /);
    assert.equal((peer.config as Config).options.crashReportingEnabled, true);
    assert.deepEqual(effects.notes.map((note) => note.text), ["dashboard-test-peer: renamed this node's device from 862540988a29 to dashboard-test-renamed"]);
    assert.equal(effects.invalidations, 1);

    const optionsOnly = await send("PATCH", "/api/nodes/d7e5/general", { crashReportingEnabled: false });
    assert.equal(optionsOnly.status, 502, "with nothing done, the failure is the answer");
    assert.equal(effects.notes.length, 1);
  });

  it("a rename whose options may not have been saved says so, as an options edit does", async () => {
    peer.goesSilentOnOptions = true;
    const answer = await send("PATCH", "/api/nodes/d7e5/general", { deviceName: "dashboard-test-renamed", crashReportingEnabled: false });
    assert.equal(answer.status, 200);
    const edit = (await answer.json()) as GeneralEditResponse;
    assert.equal(edit.problem, "the other settings may not have been saved: dashboard-test-peer's Syncthing stopped answering during the change, so it may have been saved; check once dashboard-test-peer answers again");
    assert.equal(edit.settings, null, "the node is not answering, so its settings cannot be read again");
    assert.deepEqual(effects.notes.map((note) => note.text), ["dashboard-test-peer: renamed this node's device from 862540988a29 to dashboard-test-renamed"]);
  });

  it("a general setting the host agent rewrites at each start is refused, and an ordinary one still saves", async () => {
    const refusals: [unknown, string][] = [
      [{ deviceName: "pc-renamed" }, "Device name: set by the host agent at each start, so not changed here"],
      [{ usageReporting: "declined" }, "Usage reports: set by the host agent at each start, so not changed here"],
      [{ crashReportingEnabled: true, minHomeDiskFree: { value: 2, unit: "%" } }, "Crash reports: set by the host agent at each start, so not changed here"],
    ];
    for (const [body, message] of refusals) {
      const refused = await send("PATCH", "/api/nodes/fb98/general", body);
      assert.equal(refused.status, 400, JSON.stringify(body));
      assert.equal(await error(refused), message);
    }
    assert.deepEqual(writesTo(pc), []);
    assert.equal(effects.notes.length, 0);

    assert.equal((await send("PATCH", "/api/nodes/fb98/general", { minHomeDiskFree: { value: 2, unit: "%" } })).status, 200);
    assert.equal((await send("PATCH", "/api/nodes/5784/general", { deviceName: "private-array-renamed", crashReportingEnabled: false })).status, 200, "the nodes service rewrites only the listen address");
    assert.deepEqual(writesTo(pc).map((write) => write.body), [{ minHomeDiskFree: { value: 2, unit: "%" } }]);
    assert.equal(writesTo(array).length, 2);
  });

  it("a general change sends only the options it changed, and a name already so is not sent", async () => {
    const answer = await send("PATCH", "/api/nodes/d7e5/general", { deviceName: "862540988a29", minHomeDiskFree: { value: 2, unit: "%" }, crashReportingEnabled: false });
    assert.equal(answer.status, 200);
    assert.deepEqual(writesTo(peer), [{ method: "PATCH", path: "/rest/config/options", body: { minHomeDiskFree: { value: 2, unit: "%" }, crashReportingEnabled: false } }]);
    assert.deepEqual(effects.notes.map((note) => note.text), ["dashboard-test-peer: changed general settings; keep free 2 % on its home disk; crash reports off"]);

    const again = await send("PATCH", "/api/nodes/d7e5/general", { crashReportingEnabled: false });
    assert.equal(again.status, 200);
    assert.equal(writesTo(peer).length, 1, "nothing is sent when nothing changes");
    assert.equal(effects.notes.length, 1);
  });

  it("usage reporting is accepted at the node's own report version or declined, never answered for the person", async () => {
    assert.equal((await send("PATCH", "/api/nodes/d7e5/general", { usageReporting: "declined" })).status, 200);
    assert.deepEqual(writesTo(peer).at(-1)?.body, { urAccepted: -1 });
    assert.equal((await send("PATCH", "/api/nodes/d7e5/general", { usageReporting: "accepted" })).status, 200);
    assert.deepEqual(writesTo(peer).at(-1)?.body, { urAccepted: 3, urSeen: 3 });
    assert.deepEqual(effects.notes.map((note) => note.text), ["dashboard-test-peer: changed general settings; usage reports declined", "dashboard-test-peer: changed general settings; usage reports accepted (version 3)"]);
    assert.equal((await send("PATCH", "/api/nodes/d7e5/general", { usageReporting: "yes" })).status, 400);
    assert.equal((await send("PATCH", "/api/nodes/d7e5/general", { urAccepted: 3 })).status, 400);
  });

  it("a general change is refused when it is malformed, empty, or for another host's node", async () => {
    const refusals: [unknown, string][] = [
      [{}, "nothing to change"],
      [{ deviceName: "   " }, "Device name cannot be empty: other devices show it"],
      [{ minHomeDiskFree: { value: 200, unit: "%" } }, "Keep free on its home disk cannot be more than 100 %"],
      [{ minHomeDiskFree: { value: 1, unit: "PB" } }, "Keep free on its home disk must be in %, kB, MB, GB, TB"],
      [{ crashReportingEnabled: "on" }, "Crash reports must be on or off"],
      [{ listenAddresses: ["default"] }, "listenAddresses is not a general setting"],
    ];
    for (const [body, message] of refusals) {
      const answer = await send("PATCH", "/api/nodes/d7e5/general", body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.equal(await error(answer), message);
    }
    const remoteAnswer = await send("PATCH", "/api/nodes/p53n/general", { crashReportingEnabled: false });
    assert.equal(remoteAnswer.status, 409);
    assert.equal(await error(remoteAnswer), "act on p53's dashboard");
    assert.deepEqual(writesTo(peer), []);
  });

  it("defaults round-trip", async () => {
    const folder = (await (await send("GET", "/api/nodes/d7e5/defaults/folder")).json()) as FolderDefaults;
    assert.deepEqual(folder, {
      type: "sendreceive",
      rescanIntervalS: 3600,
      fsWatcherEnabled: true,
      fsWatcherDelayS: 10,
      ignorePerms: false,
      order: "random",
      minDiskFree: { value: 1, unit: "%" },
      maxConflicts: 10,
      syncOwnership: false,
      syncXattrs: false,
      versioning: { type: "", params: {}, cleanupIntervalS: 3600, fsPath: "" },
    });
    const staggered: Versioning = { type: "staggered", params: { maxAge: "31536000" }, cleanupIntervalS: 3600, fsPath: "" };
    const changedFolder = await send("PATCH", "/api/nodes/d7e5/defaults/folder", { rescanIntervalS: 7200, versioning: staggered, type: "sendreceive" });
    assert.equal(changedFolder.status, 200);
    assert.deepEqual(await changedFolder.json(), { ...folder, rescanIntervalS: 7200, versioning: staggered });
    assert.deepEqual(writesTo(peer).map((write) => [write.path, write.body]), [["/rest/config/defaults/folder", { rescanIntervalS: 7200, versioning: staggered }]], "a field already so is not sent");
    assert.deepEqual(await (await send("GET", "/api/nodes/d7e5/defaults/folder")).json(), { ...folder, rescanIntervalS: 7200, versioning: staggered });

    const device = (await (await send("GET", "/api/nodes/d7e5/defaults/device")).json()) as DeviceDefaults;
    assert.deepEqual(device, { addresses: ["dynamic"], compression: "metadata", introducer: false, autoAcceptFolders: false, untrusted: false, allowedNetworks: [], maxSendKbps: 0, maxRecvKbps: 0, numConnections: 0 });
    const changedDevice = await send("PATCH", "/api/nodes/d7e5/defaults/device", { compression: "always" });
    assert.equal(changedDevice.status, 200);
    assert.deepEqual(await (await send("GET", "/api/nodes/d7e5/defaults/device")).json(), { ...device, compression: "always" });

    assert.deepEqual(await (await send("GET", "/api/nodes/d7e5/defaults/ignores")).json(), { lines: [] });
    const lines = ["(?d).DS_Store", "// scratch", "*.tmp"];
    const changedIgnores = await send("PUT", "/api/nodes/d7e5/defaults/ignores", { lines, opened: [] });
    assert.equal(changedIgnores.status, 200);
    assert.deepEqual((await (await send("GET", "/api/nodes/d7e5/defaults/ignores")).json()) as DefaultIgnores, { lines });

    assert.deepEqual(effects.notes.map((note) => note.text), [
      `dashboard-test-peer: changed the new folder defaults; full rescan interval 7200 s; file versioning ${versioningWords(staggered)}`,
      "dashboard-test-peer: changed the new device defaults; compression always",
      "dashboard-test-peer: changed the new folder ignore patterns; added (?d).DS_Store, // scratch, *.tmp",
    ]);
    assert.equal((await send("PUT", "/api/nodes/d7e5/defaults/ignores", { lines, opened: lines })).status, 200);
    assert.equal(effects.notes.length, 3, "the same patterns again write nothing");
    const stale = await send("PUT", "/api/nodes/d7e5/defaults/ignores", { lines: ["*.bak"], opened: [] });
    assert.equal(stale.status, 409, "patterns changed since the form opened are not overwritten");
    assert.deepEqual(((await (await send("GET", "/api/nodes/d7e5/defaults/ignores")).json()) as DefaultIgnores).lines, lines);
  });

  it("defaults refuse what a new folder or device cannot start with", async () => {
    const refusals: [string, string, unknown, string][] = [
      ["PATCH", "folder", { path: "/elsewhere" }, "path is not a new folder default"],
      ["PATCH", "folder", { versioning: { type: "external", params: { command: "/bin/true" }, cleanupIntervalS: 3600, fsPath: "" } }, "external versioning runs a program on the node, so it is set in the node's own Syncthing configuration, not from the dashboard"],
      ["PATCH", "device", { name: "x" }, "name is not a new device default"],
      ["PATCH", "device", { compression: "sometimes" }, "Compression must be metadata, always, never"],
      ["PUT", "ignores", { lines: ["#include ../../config/config.xml"], opened: [] }, "#include ../../config/config.xml refers to a file outside the folder; an included file must lie inside it"],
      ["PUT", "ignores", { lines: "*.tmp", opened: [] }, "the ignore patterns must be a list of lines"],
    ];
    for (const [method, kind, body, message] of refusals) {
      const answer = await send(method, `/api/nodes/d7e5/defaults/${kind}`, body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.equal(await error(answer), message);
    }
    assert.deepEqual(writesTo(peer), []);
  });

  it("an array's new devices never start as introducers or accepting folders automatically", async () => {
    for (const change of [{ autoAcceptFolders: true }, { introducer: true }]) {
      const answer = await send("PATCH", "/api/nodes/5784/defaults/device", change);
      assert.equal(answer.status, 400);
      assert.match(await error(answer), /stays off on private-array, an array/);
    }
    assert.deepEqual(writesTo(array), []);
    assert.equal((await send("PATCH", "/api/nodes/5784/defaults/device", { compression: "always" })).status, 200, "every other default stays editable on the array's own card");
  });

  it("lists ignored devices with time and address, and ignored folders per device", async () => {
    const lists = (await (await send("GET", "/api/nodes/d7e5/ignored")).json()) as IgnoredLists;
    assert.deepEqual(lists, {
      devices: [
        { deviceId: tw2, name: "dashboard-test-tw2", address: "192.0.2.12:22000", time: "2026-10-27T09:02:00Z" },
        { deviceId: tw3, name: "dashboard-test-tw3", address: "192.0.2.13:22000", time: "2026-10-27T09:03:00Z" },
      ],
      folders: [
        { folderId: "dashboard-test-b", label: "dashboard-test-b", offeredBy: tw1, offeredByName: "dashboard-test-tw1", time: "2026-10-27T09:00:00Z" },
        { folderId: "dashboard-test-c", label: "Dashboard Test C", offeredBy: tw1, offeredByName: "dashboard-test-tw1", time: "2026-10-27T09:01:00Z" },
      ],
    });
    assert.doesNotMatch(JSON.stringify(lists), /secret-api-key|\$2a\$/);
  });

  it("un-ignoring a device keeps the other ignored ones", async () => {
    const before = structuredClone(peer.config) as Config;
    const answer = await send("DELETE", `/api/nodes/d7e5/ignored/devices/${tw2}`);
    assert.equal(answer.status, 200);
    assert.deepEqual(((await answer.json()) as IgnoredLists).devices.map((device) => device.deviceId), [tw3]);
    const [put] = writesTo(peer);
    assert.equal(put.path, "/rest/config");
    assert.deepEqual(put.body, { ...before, remoteIgnoredDevices: [before.remoteIgnoredDevices[1]] }, "only that one entry leaves; secrets go back as read");
    assert.deepEqual(effects.notes.map((note) => note.text), ["dashboard-test-peer: un-ignored device dashboard-test-tw2 (TWOTWOA), it may ask to connect again"]);

    const missing = await send("DELETE", `/api/nodes/d7e5/ignored/devices/${tw2}`);
    assert.equal(missing.status, 404);
    assert.equal(writesTo(peer).length, 1);
  });

  it("un-ignoring a folder keeps the device's other ignored folders", async () => {
    const before = structuredClone(peer.config) as Config;
    const answer = await send("DELETE", `/api/nodes/d7e5/ignored/folders/dashboard-test-b?offeredBy=${tw1}`);
    assert.equal(answer.status, 200);
    assert.deepEqual(((await answer.json()) as IgnoredLists).folders.map((folder) => folder.folderId), ["dashboard-test-c"]);
    assert.deepEqual(writesTo(peer), [{ method: "PATCH", path: `/rest/config/devices/${tw1}`, body: { ignoredFolders: [before.devices[1].ignoredFolders[1]] } }], "only that device's list is sent");
    const after = peer.config as Config;
    assert.deepEqual(after.devices[0], before.devices[0]);
    assert.deepEqual(after.remoteIgnoredDevices, before.remoteIgnoredDevices);
    assert.deepEqual(effects.notes.map((note) => note.text), ["dashboard-test-peer: un-ignored folder dashboard-test-b offered by dashboard-test-tw1, it may be offered again"]);
    assert.equal((await send("DELETE", "/api/nodes/d7e5/ignored/folders/dashboard-test-b")).status, 400, "the offering device is named");
    assert.equal((await send("DELETE", `/api/nodes/d7e5/ignored/folders/dashboard-test-b?offeredBy=${tw1}`)).status, 404);
    assert.equal((await send("DELETE", `/api/nodes/p53n/ignored/devices/${tw2}`)).status, 409);
  });
});
