import assert from "node:assert/strict";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { deviceDisplayName } from "../src/api/deviceText.js";
import { RequestError } from "../src/http.js";
import type { LocalInstance, RemoteInstance } from "../src/instanceResolver.js";
import { type WriteEffects, type WriteNote, requestHandler } from "../src/routes.js";
import { deviceEditText, deviceRoutes, editDevice, readDeviceSettings } from "../src/routes/devices.js";
import { SyncthingClient } from "../src/syncthing.js";
import { addressProblem, changedFields, deviceChangeProblem, deviceSettings } from "../src/syncthingConfig.js";

const apiKey = "devices-test-key";
const ownId = "PCAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const peerId = "D7E5AAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";

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
  /** Drops the connection of the request this many requests from now, as a Syncthing that stops answering mid-edit; null keeps answering. */
  let dropAfter: number | null = null;
  let syncthingUrl = "";
  let deadUrl = "";
  const syncthing = createServer(async (request, response) => {
    if (dropAfter !== null && dropAfter-- === 0) return request.socket.destroy();
    if (request.headers["x-api-key"] !== apiKey) return reply(response, { error: "forbidden" }, 403);
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    if (request.method === "GET" && path === "/rest/config/devices") return reply(response, configured);
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
