import assert from "node:assert/strict";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { LocalInstance, RemoteInstance } from "../src/instanceResolver.js";
import { hostSettings, nodeOptions } from "../src/routes/options.js";
import { parseLayout } from "../src/setupRepo.js";
import { SyncthingClient } from "../src/syncthing.js";
import { instanceGui, instanceOptions, redactConfig } from "../src/syncthingConfig.js";

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
    const instance: LocalInstance = { kind: "local", nodeId: "fb98", name: "pc", client: new SyncthingClient({ url: syncthingUrl, apiKey: syncthingGui.apiKey }), root: "F:\\", os: "windows", threshold: 50 };
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
