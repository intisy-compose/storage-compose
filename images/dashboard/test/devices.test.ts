import assert from "node:assert/strict";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { deviceDisplayName } from "../src/api/deviceText.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, RemoteInstance } from "../src/instanceResolver.js";
import { type WriteEffects, type WriteNote, requestHandler } from "../src/routes.js";
import { addDevice, checkDeviceId, deviceEditText, deviceRoutes, editDevice, nearbyDevices, readDeviceDefaults, readDeviceSettings } from "../src/routes/devices.js";
import { SyncthingClient } from "../src/syncthing.js";
import { addressProblem, changedFields, deviceChangeProblem, deviceSettings } from "../src/syncthingConfig.js";

const apiKey = "devices-test-key";
const ownId = "PCAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const peerId = "D7E5AAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const newId = "NEWAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const nearbyId = "NEARBYA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Syncthing's own defaults for a new device, as `/rest/config/defaults/device` answers; deliberately not the dashboard's. */
const syncthingDefaults = {
  deviceID: "",
  name: "",
  addresses: ["dynamic"],
  compression: "always",
  certName: "",
  introducer: false,
  skipIntroductionRemovals: false,
  introducedBy: "",
  paused: false,
  allowedNetworks: [],
  autoAcceptFolders: true,
  maxSendKbps: 0,
  maxRecvKbps: 0,
  ignoredFolders: [],
  maxRequestKiB: 0,
  untrusted: false,
  remoteGUIPort: 0,
  numConnections: 0,
};

/** As Syncthing 2.1.6 reads a typed ID: case and separators do not matter, the length does, and its reason quotes the ID. */
function syncthingDeviceIdAnswer(typed: string): { id: string } | { error: string } {
  const letters = typed.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (letters.length !== 56) return { error: `"${typed}": device ID invalid: incorrect length` };
  return { id: letters.match(/.{7}/g)!.join("-") };
}

const syncthingPeer = {
  deviceID: peerId,
  name: "dashboard-test-peer",
  addresses: ["dynamic"],
  compression: "metadata",
  certName: "",
  introducer: false,
  skipIntroductionRemovals: false,
  introducedBy: "",
  paused: false,
  allowedNetworks: [],
  autoAcceptFolders: false,
  maxSendKbps: 0,
  maxRecvKbps: 0,
  ignoredFolders: [],
  maxRequestKiB: 0,
  untrusted: false,
  remoteGUIPort: 0,
  numConnections: 0,
};

interface Received {
  method: string;
  path: string;
  body: unknown;
}

function reply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : null;
}

describe("a node's devices", () => {
  const writes: Received[] = [];
  let configured: Record<string, unknown>[] = [];
  let folders: Record<string, unknown>[] = [];
  let discovered: Record<string, unknown> = {};
  /** Drops the connection of the request this many requests from now, as a Syncthing that stops answering mid-edit; null keeps answering. */
  let dropAfter: number | null = null;
  let syncthingUrl = "";
  let deadUrl = "";
  const syncthing = createServer(async (request, response) => {
    if (dropAfter !== null && dropAfter-- === 0) return request.socket.destroy();
    if (request.headers["x-api-key"] !== apiKey) return reply(response, { error: "forbidden" }, 403);
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    const query = new URL(request.url ?? "/", "http://fake").searchParams;
    if (request.method === "GET" && path === "/rest/config/devices") return reply(response, configured);
    if (request.method === "GET" && path === "/rest/config/defaults/device") return reply(response, syncthingDefaults);
    if (request.method === "GET" && path === "/rest/svc/deviceid") return reply(response, syncthingDeviceIdAnswer(query.get("id") ?? ""));
    if (request.method === "GET" && path === "/rest/system/discovery") return reply(response, discovered);
    if (request.method === "GET" && path === "/rest/config/folders") return reply(response, folders);
    if (request.method === "GET" && path === "/qr/") {
      writes.push({ method: "GET", path: `/qr/?text=${query.get("text")}`, body: null });
      response.writeHead(200, { "Content-Type": "image/png" });
      return response.end(pngBytes);
    }
    if (request.method === "POST" && path === "/rest/config/devices") {
      const body = (await bodyOf(request)) as Record<string, unknown>;
      writes.push({ method: "POST", path, body });
      configured = [...configured, body];
      return reply(response, null);
    }
    const folderPath = path.match(/^\/rest\/config\/folders\/(.+)$/);
    if (request.method === "PATCH" && folderPath) {
      const body = await bodyOf(request);
      writes.push({ method: "PATCH", path, body });
      return reply(response, null);
    }
    const devicePath = path.match(/^\/rest\/config\/devices\/(.+)$/);
    if (request.method === "PATCH" && devicePath) {
      const body = await bodyOf(request);
      writes.push({ method: "PATCH", path, body });
      configured = configured.map((device) => (device.deviceID === decodeURIComponent(devicePath[1]) ? { ...device, ...(body as object) } : device));
      return reply(response, null);
    }
    reply(response, { error: "not faked" }, 404);
  });

  function pc(url = syncthingUrl): LocalInstance {
    return { kind: "local", nodeId: "fb98", name: "pc", client: new SyncthingClient({ url, apiKey }), root: "F:\\", os: "windows", threshold: 50 };
  }

  before(async () => {
    syncthingUrl = await listen(syncthing);
    const closed = createServer();
    deadUrl = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
  });

  beforeEach(() => {
    writes.length = 0;
    dropAfter = null;
    configured = [{ deviceID: ownId, name: "pc", addresses: ["dynamic"] }, { ...syncthingPeer }];
    folders = [
      { id: "dashboard-test-a", label: "dashboard-test-a", path: "F:/dashboard-test-a", type: "sendreceive", paused: false, devices: [{ deviceID: ownId }] },
      { id: "dashboard-test-b", label: "dashboard-test-b", path: "F:/dashboard-test-b", type: "sendreceive", paused: false, devices: [{ deviceID: ownId }, { deviceID: peerId }] },
    ];
    discovered = {
      [nearbyId]: { addresses: ["tcp://192.0.2.7:22000", "quic://192.0.2.7:22000"] },
      [peerId]: { addresses: ["tcp://192.0.2.8:22000"] },
      [ownId]: { addresses: ["tcp://192.0.2.9:22000"] },
    };
  });

  after(() => {
    syncthing.close();
  });

  it("reading a device gives its settings and nothing else Syncthing keeps", async () => {
    assert.deepEqual(await readDeviceSettings(pc(), peerId), {
      deviceId: peerId,
      name: "dashboard-test-peer",
      addresses: ["dynamic"],
      compression: "metadata",
      introducer: false,
      autoAcceptFolders: false,
      paused: false,
      untrusted: false,
      allowedNetworks: [],
      maxSendKbps: 0,
      maxRecvKbps: 0,
      numConnections: 0,
    });
  });

  it("a device the node does not know is 404 naming the node", async () => {
    await assert.rejects(readDeviceSettings(pc(), "UNKNOWN-AAAAAAA"), (error: Error & { status?: number }) => error.status === 404 && /pc has no device UNKNOWN/.test(error.message));
  });

  it("editing a device's name sends only name", async () => {
    const result = await editDevice(pc(), peerId, { name: "dashboard-test-renamed" });

    assert.deepEqual(writes, [{ method: "PATCH", path: `/rest/config/devices/${peerId}`, body: { name: "dashboard-test-renamed" } }]);
    assert.equal(result.settings.name, "dashboard-test-renamed");
    assert.equal(result.settings.compression, "metadata");
  });

  it("an address list is validated (tcp://, quic://, relay://, dynamic)", async () => {
    for (const address of ["dynamic", "tcp://192.168.1.5:22000", "tcp4://host.docker.internal", "quic://[fd7a:115c:a1e0::1]:22000", "relay://relay.example:22067/?id=ABC"]) {
      assert.equal(addressProblem(address), null, address);
    }
    for (const address of ["192.168.1.5:22000", "http://example.com", "tcp://", "tcp:// spaced:22000", "dynamic,tcp://x", "", "relay://relay.example:22067", "relay://relay.example:22067/?id="]) {
      assert.notEqual(addressProblem(address), null, address);
    }
    assert.match(addressProblem("relay://relay.example:22067") ?? "", /needs \?id=/);
    assert.match(deviceChangeProblem({ addresses: [] }) ?? "", /^Addresses needs at least one address/);
    await assert.rejects(editDevice(pc(), peerId, { addresses: ["tcp://ok:22000", "ftp://bad"] }), (error: Error & { status?: number }) => error.status === 400 && /ftp:\/\/bad/.test(error.message));
    assert.deepEqual(writes, []);
  });

  it("the device ID, a field the form does not show and a wrong type are refused, named by the form's labels", () => {
    assert.equal(deviceChangeProblem({ deviceId: peerId }), "the device ID cannot be changed");
    assert.equal(deviceChangeProblem({ ignoredFolders: [] }), "ignoredFolders is not a device setting");
    assert.equal(deviceChangeProblem({ compression: "sometimes" }), "Compression must be metadata, always, never");
    assert.equal(deviceChangeProblem({ maxSendKbps: -1 }), "Send limit must be a whole number, 0 or more");
    assert.equal(deviceChangeProblem(JSON.parse(JSON.stringify({ maxRecvKbps: Number.NaN }))), "Receive limit must be a whole number, 0 or more", "a cleared number field arrives as null");
    assert.equal(deviceChangeProblem({ paused: "yes" }), "Paused must be on or off");
    assert.match(deviceChangeProblem({}) ?? "", /nothing to change/);
    assert.match(deviceChangeProblem([]) ?? "", /nothing to change/);
    assert.equal(deviceChangeProblem({ name: "", allowedNetworks: ["192.168.0.0/16"], numConnections: 2, introducer: true }), null);
  });

  it("a remote node's device edit is 409", async () => {
    const remote: RemoteInstance = { kind: "remote", nodeId: "a1b2", name: "p53-data", host: "p53", dashboardUrl: "http://127.0.0.1:1" };
    await assert.rejects(editDevice(remote, peerId, { name: "x" }), (error: Error & { status?: number }) => error.status === 409 && error.message === "act on p53's dashboard");
    assert.deepEqual(writes, []);
  });

  it("an edit on a node whose Syncthing does not answer is 503 and names the node", async () => {
    await assert.rejects(editDevice(pc(deadUrl), peerId, { name: "x" }), (error: Error & { status?: number }) => error.status === 503 && error.message === "pc's Syncthing is not answering");
  });

  function recordingEffects(): WriteEffects & { notes: WriteNote[]; invalidations: number } {
    const effects = { notes: [] as WriteNote[], invalidations: 0, invalidate: () => void (effects.invalidations += 1), record: (note: WriteNote) => void effects.notes.push(note) };
    return effects;
  }

  async function dashboardWith(effects: WriteEffects): Promise<{ url: string; close: () => void }> {
    const handle = requestHandler(deviceRoutes({ resolve: async (nodeId) => (nodeId === "fb98" ? pc() : Promise.reject(new RequestError(404, `no node ${nodeId}`))) }), effects);
    const dashboard = createServer((request, response) => void handle(request, response));
    return { url: await listen(dashboard), close: () => dashboard.close() };
  }

  function patch(url: string, body: unknown): Promise<Response> {
    return fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  it("a device PATCH through the router enters its note in Activity and drops the shared build", async () => {
    const effects = recordingEffects();
    const dashboard = await dashboardWith(effects);
    try {
      const devicePath = `${dashboard.url}/api/nodes/fb98/devices/${encodeURIComponent(peerId)}`;
      assert.equal(((await (await fetch(devicePath)).json()) as { name: string }).name, "dashboard-test-peer");
      assert.equal(effects.invalidations, 0, "a read drops nothing");

      const patched = await patch(devicePath, { compression: "always" });
      assert.equal(patched.status, 200);
      assert.equal(((await patched.json()) as { compression: string }).compression, "always");
      assert.deepEqual(writes.map((write) => write.body), [{ compression: "always" }]);
      assert.deepEqual(effects.notes, [{ nodeId: "fb98", nodeName: "pc", folderId: null, text: "pc: changed device dashboard-test-peer; compression always" }]);
      assert.equal(effects.invalidations, 1);

      assert.equal((await patch(devicePath, { maxSendKbps: null })).status, 400);
      assert.equal((await patch(`${dashboard.url}/api/nodes/zzzz/devices/${encodeURIComponent(peerId)}`, { name: "x" })).status, 404);
      assert.equal(effects.notes.length, 1, "a refused write enters nothing");
      assert.equal(effects.invalidations, 1);
    } finally {
      dashboard.close();
    }
  });

  it("a Syncthing that stops answering between the read and the PATCH is 503 and nothing is written or entered", async () => {
    const effects = recordingEffects();
    const dashboard = await dashboardWith(effects);
    try {
      dropAfter = 1;
      const answer = await patch(`${dashboard.url}/api/nodes/fb98/devices/${encodeURIComponent(peerId)}`, { name: "dashboard-test-renamed" });
      assert.equal(answer.status, 503);
      assert.deepEqual(await answer.json(), { error: "pc's Syncthing is not answering" });
      assert.deepEqual(writes, []);
      assert.deepEqual(effects.notes, []);
      assert.equal(effects.invalidations, 0);
    } finally {
      dashboard.close();
    }
  });

  it("a Syncthing that stops answering after the PATCH still reports the edit saved and enters it", async () => {
    const effects = recordingEffects();
    const dashboard = await dashboardWith(effects);
    try {
      dropAfter = 2;
      const answer = await patch(`${dashboard.url}/api/nodes/fb98/devices/${encodeURIComponent(peerId)}`, { name: "dashboard-test-renamed", maxSendKbps: 100 });
      assert.equal(answer.status, 200);
      const settings = (await answer.json()) as { name: string; maxSendKbps: number; addresses: string[] };
      assert.deepEqual([settings.name, settings.maxSendKbps, settings.addresses], ["dashboard-test-renamed", 100, ["dynamic"]]);
      assert.equal(writes.length, 1);
      assert.deepEqual(effects.notes.map((note) => note.text), ["pc: renamed device dashboard-test-peer to dashboard-test-renamed; send limit 100 KiB/s"]);
      assert.equal(effects.invalidations, 1);
    } finally {
      dashboard.close();
    }
  });

  it("an edit's activity entry names the node, the device and what changed", async () => {
    const result = await editDevice(pc(), peerId, { name: "dashboard-test-renamed" });
    assert.deepEqual(result.note, { nodeId: "fb98", nodeName: "pc", folderId: null, text: "pc: renamed device dashboard-test-peer to dashboard-test-renamed" });

    assert.equal(deviceEditText("pc", "dashboard-test-peer", { paused: true }), "pc: paused device dashboard-test-peer");
    assert.equal(
      deviceEditText("pc", "dashboard-test-peer", { name: "new", addresses: ["tcp://a:1", "dynamic"], maxSendKbps: 0, introducer: true }),
      "pc: renamed device dashboard-test-peer to new; addresses tcp://a:1, dynamic; introducer on; send limit unlimited",
    );
    assert.equal(deviceEditText("pc", "D7E5AAA", { name: "" }), "pc: removed the name of device D7E5AAA");
  });

  it("adding a device fills defaults from syncthing's defaults", async () => {
    const result = await addDevice(pc(), { deviceId: newId, name: "dashboard-test-device", introducer: true });

    assert.deepEqual(writes, [{ method: "POST", path: "/rest/config/devices", body: { ...syncthingDefaults, deviceID: newId, name: "dashboard-test-device", introducer: true } }]);
    assert.equal(result.added.device.compression, "always", "Syncthing's default, not the dashboard's");
    assert.equal(result.added.device.autoAcceptFolders, true);
    assert.deepEqual(result.added.shared, []);
    assert.deepEqual(result.note, { nodeId: "fb98", nodeName: "pc", folderId: null, text: "pc: added device dashboard-test-device; introducer on" });
    assert.deepEqual(await readDeviceDefaults(pc()), deviceSettings(syncthingDefaults));
  });

  it("an invalid device id is refused with syncthing's reason", async () => {
    await assert.rejects(addDevice(pc(), { deviceId: "NOT-A-DEVICE" }), (error: Error & { status?: number }) => error.status === 400 && error.message === '"NOT-A-DEVICE": device ID invalid: incorrect length');
    await assert.rejects(addDevice(pc(), { name: "no id" }), (error: Error & { status?: number }) => error.status === 400 && error.message === "the device ID is missing");
    assert.deepEqual(writes, []);
    assert.deepEqual(await checkDeviceId(pc(), "NOT-A-DEVICE"), { deviceId: null, problem: '"NOT-A-DEVICE": device ID invalid: incorrect length' });
  });

  it("a device id is taken as syncthing reads it, whatever its case and separators", async () => {
    const typed = newId.toLowerCase().replaceAll("-", " ");
    assert.deepEqual(await checkDeviceId(pc(), typed), { deviceId: newId, problem: null });
    await addDevice(pc(), { deviceId: typed });
    assert.equal((writes[0].body as { deviceID: string }).deviceID, newId);
  });

  it("adding a known device is 409", async () => {
    await assert.rejects(addDevice(pc(), { deviceId: peerId.toLowerCase(), name: "again" }), (error: Error & { status?: number }) => error.status === 409 && error.message === "pc already has device dashboard-test-peer");
    await assert.rejects(addDevice(pc(), { deviceId: ownId }), (error: Error & { status?: number }) => error.status === 409 && error.message === "pc already has device pc");
    assert.deepEqual(writes, []);
    assert.deepEqual(await checkDeviceId(pc(), peerId), { deviceId: peerId, problem: "pc already has device dashboard-test-peer" });
  });

  it("the ticked folders are shared with the new device, and a folder the node lacks is refused before anything is written", async () => {
    await assert.rejects(addDevice(pc(), { deviceId: newId, shareFolders: ["dashboard-test-a", "documents-nowhere"] }), (error: Error & { status?: number }) => error.status === 400 && error.message === "pc has no folder documents-nowhere");
    assert.equal(writes.length, 0);

    const result = await addDevice(pc(), { deviceId: newId, name: "dashboard-test-device", shareFolders: ["dashboard-test-a"] });
    assert.deepEqual(writes.map((write) => `${write.method} ${write.path}`), ["POST /rest/config/devices", "PATCH /rest/config/folders/dashboard-test-a"]);
    assert.deepEqual(writes[1].body, { devices: [{ deviceID: ownId }, { deviceID: newId }] });
    assert.deepEqual(result.added.shared, ["dashboard-test-a"]);
    assert.equal(result.note.text, "pc: added device dashboard-test-device; shared dashboard-test-a");
  });

  it("settings and folders are checked like an edit's, and a remote node's add is 409", async () => {
    await assert.rejects(addDevice(pc(), { deviceId: newId, addresses: ["ftp://bad"] }), (error: Error & { status?: number }) => error.status === 400 && /ftp:\/\/bad/.test(error.message));
    await assert.rejects(addDevice(pc(), { deviceId: newId, shareFolders: "dashboard-test-a" }), (error: Error & { status?: number }) => error.status === 400 && error.message === "Share these folders must be a list of folder IDs");
    await assert.rejects(addDevice(pc(), { deviceId: newId, ignoredFolders: [] }), (error: Error & { status?: number }) => error.status === 400 && error.message === "ignoredFolders is not a device setting");
    const remote: RemoteInstance = { kind: "remote", nodeId: "a1b2", name: "p53-data", host: "p53", dashboardUrl: "http://127.0.0.1:1" };
    await assert.rejects(addDevice(remote, { deviceId: newId }), (error: Error & { status?: number }) => error.status === 409 && error.message === "act on p53's dashboard");
    assert.deepEqual(writes, []);
  });

  it("a share that fails after the device is added still reports and enters the add", async () => {
    dropAfter = 5;
    const result = await addDevice(pc(), { deviceId: newId, name: "dashboard-test-device", shareFolders: ["dashboard-test-a"] });
    assert.deepEqual(result.added.shared, []);
    assert.deepEqual(result.added.notShared, [{ folderId: "dashboard-test-a", problem: "pc's Syncthing is not answering" }]);
    assert.equal(result.note.text, "pc: added device dashboard-test-device; not shared dashboard-test-a (pc's Syncthing is not answering)");
  });

  it("the add form's reads of another host's node are 409, like the add", async () => {
    const remote: RemoteInstance = { kind: "remote", nodeId: "a1b2", name: "p53-data", host: "p53", dashboardUrl: "http://127.0.0.1:1" };
    const refusedForRemote = (error: Error & { status?: number }) => error.status === 409 && error.message === "act on p53's dashboard";
    await assert.rejects(readDeviceDefaults(remote), refusedForRemote);
    await assert.rejects(nearbyDevices(remote), refusedForRemote);
    await assert.rejects(checkDeviceId(remote, newId), refusedForRemote);
    const dashboard = requestHandler(deviceRoutes({ resolve: async () => remote }), recordingEffects());
    const server = createServer((request, response) => void dashboard(request, response));
    const url = await listen(server);
    try {
      const qr = await fetch(`${url}/api/nodes/a1b2/qr?text=${encodeURIComponent(ownId)}`);
      assert.equal(qr.status, 409);
      assert.deepEqual(await qr.json(), { error: "act on p53's dashboard" });
    } finally {
      server.close();
    }
  });

  it("nearby lists the devices discovery found that the node has not configured", async () => {
    assert.deepEqual(await nearbyDevices(pc()), [{ deviceId: nearbyId, addresses: ["tcp://192.0.2.7:22000", "quic://192.0.2.7:22000"] }]);
    discovered = { [nearbyId]: ["tcp://192.0.2.7:22000"] };
    assert.deepEqual(await nearbyDevices(pc()), [{ deviceId: nearbyId, addresses: ["tcp://192.0.2.7:22000"] }], "an older Syncthing lists the addresses bare");
  });

  it("the add, the checks and the QR code go through the router, and only the add enters Activity", async () => {
    const effects = recordingEffects();
    const dashboard = await dashboardWith(effects);
    try {
      const nodePath = `${dashboard.url}/api/nodes/fb98`;
      assert.equal(((await (await fetch(`${nodePath}/device-defaults`)).json()) as { compression: string }).compression, "always");
      assert.deepEqual(await (await fetch(`${nodePath}/nearby`)).json(), [{ deviceId: nearbyId, addresses: ["tcp://192.0.2.7:22000", "quic://192.0.2.7:22000"] }]);
      assert.deepEqual(await (await fetch(`${nodePath}/device-id-check?id=${encodeURIComponent(peerId)}`)).json(), { deviceId: peerId, problem: "pc already has device dashboard-test-peer" });

      const qr = await fetch(`${nodePath}/qr?text=${encodeURIComponent(ownId)}`);
      assert.equal(qr.status, 200);
      assert.equal(qr.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await qr.arrayBuffer()), pngBytes);
      assert.equal(writes.at(-1)?.path, `/qr/?text=${ownId}`);
      assert.equal((await fetch(`${nodePath}/qr?text=`)).status, 400);
      assert.equal(effects.invalidations, 0, "reads drop nothing");

      const added = await fetch(`${nodePath}/devices`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: newId, name: "dashboard-test-device" }) });
      assert.equal(added.status, 201);
      assert.equal(((await added.json()) as { device: { deviceId: string } }).device.deviceId, newId);
      assert.deepEqual(effects.notes.map((note) => note.text), ["pc: added device dashboard-test-device"]);
      assert.equal(effects.invalidations, 1);

      const again = await fetch(`${nodePath}/devices`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: newId }) });
      assert.equal(again.status, 409);
      assert.equal(effects.notes.length, 1, "a refused add enters nothing");
    } finally {
      dashboard.close();
    }
  });
});

describe("device settings", () => {
  it("changedFields keeps only the fields that differ, lists by content", () => {
    const before = deviceSettings(syncthingPeer);
    const after = { ...before, name: "renamed", addresses: ["dynamic"], allowedNetworks: ["10.0.0.0/8"] };

    assert.deepEqual(changedFields(before, after), { name: "renamed", allowedNetworks: ["10.0.0.0/8"] });
    assert.deepEqual(changedFields(before, { ...before }), {});
  });

  it("settings Syncthing leaves out read as the defaults", () => {
    assert.deepEqual(deviceSettings({ deviceID: peerId }), {
      deviceId: peerId,
      name: "",
      addresses: [],
      compression: "metadata",
      introducer: false,
      autoAcceptFolders: false,
      paused: false,
      untrusted: false,
      allowedNetworks: [],
      maxSendKbps: 0,
      maxRecvKbps: 0,
      numConnections: 0,
    });
  });
});

describe("a device's name", () => {
  it("falls back to the short device ID when empty or blank", () => {
    assert.equal(deviceDisplayName("dashboard-test-peer", peerId), "dashboard-test-peer");
    assert.equal(deviceDisplayName("", peerId), "D7E5AAA");
    assert.equal(deviceDisplayName("  ", peerId), "D7E5AAA");
    assert.equal(deviceDisplayName(null, peerId), "D7E5AAA");
    assert.equal(deviceDisplayName(undefined, peerId), "D7E5AAA");
  });
});
