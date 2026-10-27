import assert from "node:assert/strict";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import type { RequestsResponse } from "../src/api/types.js";
import type { LocalInstance, RemoteInstance } from "../src/instanceResolver.js";
import { type JoinedDevice, fileJoinRecords } from "../src/join.js";
import { requestHandler } from "../src/routes.js";
import { type RequestNode, type RequestSources, type SetupRecorder, acceptPendingDevice, dismissPendingDevice, ignorePendingDevice, pendingRoutes, requestsResponse } from "../src/routes/pending.js";
import type { SetupLayout } from "../src/setupRepo.js";
import { SyncthingClient, SyncthingError } from "../src/syncthing.js";

const pcId = "PCAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const strangerId = "STRANGE-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const apiKey = "secret-api-key";

function reply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function fakeArraySyncthing(): Server {
  return createServer((request, response) => {
    if (request.headers["x-api-key"] !== apiKey) return reply(response, { error: "forbidden" }, 403);
    switch (new URL(request.url ?? "/", "http://fake").pathname) {
      case "/rest/config/devices":
        return reply(response, [{ deviceID: pcId, name: "pc", addresses: ["dynamic"] }]);
      case "/rest/cluster/pending/devices":
        return reply(response, { [strangerId]: { time: "2026-10-26T09:00:00Z", name: "laptop", address: "192.168.1.20:22000" } });
      case "/rest/cluster/pending/folders":
        return reply(response, {
          documents: { offeredBy: { [pcId]: { time: "2026-10-21T02:00:00Z", label: "Documents", receiveEncrypted: false, remoteEncrypted: false } } },
          music: { offeredBy: { [pcId]: { time: "2026-10-21T03:00:00Z", label: "Music", receiveEncrypted: false, remoteEncrypted: false } } },
        });
      default:
        return reply(response, { error: "not faked" }, 404);
    }
  });
}

const peerAnswer: RequestsResponse = {
  devices: [{ nodeId: "p53n", nodeName: "p53", deviceId: strangerId, name: "phone", address: "10.0.0.5:22000", time: "2026-10-25T10:00:00Z" }],
  folders: [
    { nodeId: "p53n", nodeName: "p53", folderId: "pictures", label: "Pictures", offeredBy: pcId, offeredByName: "pc", time: "2026-10-24T10:00:00Z", receiveEncrypted: false },
  ],
  joins: [{ name: "p53", joinedAt: "2026-10-24T09:00:00Z", setup: "p53 recorded" }],
  unreadable: [{ name: "p53-stick", reason: "not connected" }],
};

function fakePeerDashboard(seen: string[]): Server {
  return createServer((request, response) => {
    seen.push(request.url ?? "");
    const url = new URL(request.url ?? "/", "http://peer");
    if (url.pathname !== "/api/requests" || url.searchParams.get("scope") !== "local") return reply(response, { error: "wrong path" }, 404);
    reply(response, peerAnswer);
  });
}

const pcJoin: JoinedDevice = {
  name: "pc",
  syncthingDeviceId: pcId,
  os: "windows",
  nodes: [],
  joinedAt: "2026-10-21T01:38:06.691Z",
  tailnetName: "pc.example.ts.net",
  setup: { committed: true, pushed: true, message: "pc is already in the setup repo" },
};

describe("requests", () => {
  const arraySyncthing = fakeArraySyncthing();
  const peerRequests: string[] = [];
  const peerDashboard = fakePeerDashboard(peerRequests);
  let arrayUrl = "";
  let peerUrl = "";

  before(async () => {
    arrayUrl = await listen(arraySyncthing);
    peerUrl = await listen(peerDashboard);
  });

  after(() => {
    arraySyncthing.close();
    peerDashboard.close();
  });

  function sources(nodes: RequestNode[], peers: string[] = []): RequestSources {
    return { localNodes: async () => nodes, peerDashboards: peers, joins: async () => ({ pc: pcJoin }) };
  }

  it("pending devices and folders of every local instance are listed with the node they wait on", async () => {
    const array: RequestNode = { nodeId: "5784", name: "private-array", present: true, client: new SyncthingClient({ url: arrayUrl, apiKey }) };
    const detached: RequestNode = { nodeId: "a1b2", name: "stick", present: false, client: null };
    const response = await requestsResponse("all", sources([array, detached]));

    assert.deepEqual(response.devices, [{ nodeId: "5784", nodeName: "private-array", deviceId: strangerId, name: "laptop", address: "192.168.1.20:22000", time: "2026-10-26T09:00:00Z" }]);
    assert.deepEqual(
      response.folders.map((offer) => [offer.nodeId, offer.nodeName, offer.folderId, offer.offeredByName, offer.time]),
      [
        ["5784", "private-array", "music", "pc", "2026-10-21T03:00:00Z"],
        ["5784", "private-array", "documents", "pc", "2026-10-21T02:00:00Z"],
      ],
    );
    assert.deepEqual(response.joins, [{ name: "pc", joinedAt: "2026-10-21T01:38:06.691Z", setup: "pc is already in the setup repo" }]);
    assert.deepEqual(response.unreadable, [{ name: "stick", reason: "not connected", notConnected: true }]);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(apiKey));
  });

  it("a remote host's pending items come from its dashboard", async () => {
    const response = await requestsResponse("all", sources([], [peerUrl]));

    assert.deepEqual(peerRequests, ["/api/requests?scope=local"]);
    assert.deepEqual(response.devices, peerAnswer.devices);
    assert.deepEqual(response.folders, peerAnswer.folders);
    assert.deepEqual(
      response.joins.map((join) => join.name),
      ["p53", "pc"],
    );
    assert.deepEqual(response.unreadable, peerAnswer.unreadable);
  });

  it("asked for its own nodes only, a host does not read its peers", async () => {
    peerRequests.length = 0;
    const response = await requestsResponse("local", sources([], [peerUrl]));

    assert.deepEqual(peerRequests, []);
    assert.deepEqual(response.devices, []);
  });

  it("a peer that cannot be reached is named as unreadable", async () => {
    const response = await requestsResponse("all", sources([], ["http://127.0.0.1:1"]));

    assert.equal(response.unreadable.length, 1);
    assert.equal(response.unreadable[0].name, "127.0.0.1");
    assert.match(response.unreadable[0].reason, /^its dashboard/);
  });

  it("a malformed peer address is named as unreadable instead of failing the page", async () => {
    const response = await requestsResponse("all", sources([], ["not a url"]));

    assert.deepEqual(response.unreadable, [{ name: "not a url", reason: "not a dashboard address in STORAGE_PEERS" }]);
  });

  it("join records that cannot be read are named as unreadable", async () => {
    const response = await requestsResponse("local", { localNodes: async () => [], peerDashboards: [], joins: () => Promise.reject(new Error("joins.json is not JSON")) });

    assert.deepEqual(response.joins, []);
    assert.deepEqual(response.unreadable, [{ name: "the join records", reason: "joins.json is not JSON" }]);
  });

  it("a node whose Syncthing does not answer is named as unreadable", async () => {
    const gone: RequestNode = { nodeId: "fb98", name: "pc", present: true, client: new SyncthingClient({ url: "http://127.0.0.1:1", apiKey }, 500) };
    const response = await requestsResponse("local", sources([gone]));

    assert.deepEqual(response.unreadable, [{ name: "pc", reason: "its Syncthing is not answering" }]);
  });
});

const ownId = "D7E5AAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const otherStrangerId = "OTHERST-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const secondStrangerId = "SECONDS-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const newcomerId = "NEWCOME-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const guiPasswordHash = "$2a$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012";

/** A whole `/rest/config` as Syncthing 2.1.6 answers it, secrets included: every section the ignore must hand back unchanged. */
function syncthingConfig(): Record<string, unknown> {
  return {
    version: 51,
    folders: [
      {
        id: "dashboard-test-a",
        label: "dashboard-test-a",
        filesystemType: "basic",
        path: "/var/syncthing/dashboard-test-a",
        type: "sendreceive",
        devices: [{ deviceID: ownId, introducedBy: "", encryptionPassword: "folder-secret" }],
        rescanIntervalS: 3600,
        fsWatcherEnabled: true,
        fsWatcherDelayS: 10,
        ignorePerms: false,
        autoNormalize: true,
        minDiskFree: { value: 1, unit: "%" },
        versioning: { type: "staggered", params: { maxAge: "31536000" }, cleanupIntervalS: 3600, fsPath: "", fsType: "basic" },
        copiers: 0,
        pullerMaxPendingKiB: 0,
        hashers: 0,
        order: "random",
        paused: false,
        markerName: ".stfolder",
        xattrFilter: { entries: [], maxSingleEntrySize: 1024, maxTotalSize: 4096 },
      },
    ],
    devices: [
      {
        deviceID: ownId,
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
        ignoredFolders: [{ time: "2026-10-20T10:00:00Z", id: "music", label: "Music" }],
        maxRequestKiB: 0,
        untrusted: false,
        remoteGUIPort: 0,
        numConnections: 0,
      },
    ],
    gui: {
      enabled: true,
      address: "0.0.0.0:8389",
      unixSocketPermissions: "",
      user: "admin",
      password: guiPasswordHash,
      authMode: "static",
      useTLS: false,
      apiKey,
      insecureAdminAccess: false,
      theme: "default",
      debugging: false,
      insecureSkipHostcheck: false,
      insecureAllowFrameLoading: false,
      sendBasicAuthPrompt: false,
    },
    ldap: { address: "", bindDN: "", transport: "plain", insecureSkipVerify: false, searchBaseDN: "", searchFilter: "" },
    options: {
      listenAddresses: ["tcp://0.0.0.0:22199", "quic://0.0.0.0:22199"],
      globalAnnounceServers: ["default"],
      globalAnnounceEnabled: true,
      localAnnounceEnabled: true,
      localAnnouncePort: 21027,
      localAnnounceMCAddr: "[ff12::8384]:21027",
      maxSendKbps: 0,
      maxRecvKbps: 0,
      reconnectionIntervalS: 60,
      relaysEnabled: true,
      relayReconnectIntervalM: 10,
      startBrowser: false,
      natEnabled: true,
      urAccepted: -1,
      urSeen: 3,
      urUniqueId: "",
      urURL: "https://data.syncthing.net/newdata",
      minHomeDiskFree: { value: 1, unit: "%" },
      releasesURL: "https://upgrades.syncthing.net/meta.json",
      alwaysLocalNets: [],
      overwriteRemoteDeviceNamesOnConnect: false,
      tempIndexMinBlocks: 10,
      unackedNotificationIDs: ["authenticationUserAndPassword"],
      trafficClass: 0,
      setLowPriority: true,
      maxFolderConcurrency: 0,
      crashReportingURL: "https://crash.syncthing.net/newcrash",
      crashReportingEnabled: true,
      stunKeepaliveStartS: 180,
      stunKeepaliveMinS: 20,
      stunServers: ["default"],
      maxConcurrentIncomingRequestKiB: 0,
      announceLANAddresses: true,
      sendFullIndexOnUpgrade: false,
      featureFlags: [],
      auditEnabled: false,
      auditFile: "",
      connectionLimitEnough: 0,
      connectionLimitMax: 0,
      connectionPriorityTcpLan: 10,
      connectionPriorityQuicLan: 20,
      connectionPriorityTcpWan: 30,
      connectionPriorityQuicWan: 40,
      connectionPriorityRelay: 50,
      connectionPriorityUpgradeThreshold: 0,
    },
    remoteIgnoredDevices: [{ time: "2026-10-01T08:00:00Z", deviceID: otherStrangerId, name: "old-phone", address: "10.0.0.9:22000" }],
    defaults: {
      folder: { id: "", label: "", path: "~", type: "sendreceive", devices: [], versioning: { type: "", params: {} } },
      device: { deviceID: "", name: "", addresses: ["dynamic"], compression: "metadata", autoAcceptFolders: false, ignoredFolders: [] },
      ignores: { lines: [] },
    },
  };
}

interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : null;
}

type Refusal = Error & { status?: number };

function laptopOffer(): { time: string; name: string; address: string } {
  return { time: "2026-10-26T09:00:00Z", name: "laptop", address: "192.168.1.20:22000" };
}

describe("answering a device that asks to connect", () => {
  const received: FakeRequest[] = [];
  let pending: Record<string, { time: string; name: string; address: string }> = {};
  let config: Record<string, unknown> = {};
  let configured: Record<string, unknown>[] = [];
  /** Runs before each full-config read is answered, so a test can change the config between reads as Syncthing changing itself would. */
  let beforeConfigRead: (read: number) => void = () => {};
  let configReads = 0;
  /** Overrides of the node's `/rest/config/defaults/device`. */
  let deviceDefaults: Record<string, unknown> = {};
  let url = "";
  const syncthing = createServer(async (request, response) => {
    const parsed = new URL(request.url ?? "/", "http://fake");
    const body = request.method === "GET" ? null : await requestBody(request);
    received.push({ method: request.method ?? "", path: `${parsed.pathname}${parsed.search}`, body });
    if (request.headers["x-api-key"] !== apiKey) return reply(response, { error: "forbidden" }, 403);
    switch (`${request.method} ${parsed.pathname}`) {
      case "GET /rest/cluster/pending/devices":
        return reply(response, pending);
      case "DELETE /rest/cluster/pending/devices":
        delete pending[parsed.searchParams.get("device") ?? ""];
        return reply(response, null);
      case "GET /rest/config":
        beforeConfigRead(configReads++);
        return reply(response, config);
      case "PUT /rest/config":
        config = body as Record<string, unknown>;
        return reply(response, null);
      case "GET /rest/config/devices":
        return reply(response, configured);
      case "POST /rest/config/devices":
        configured = [...configured, body as Record<string, unknown>];
        delete pending[(body as { deviceID: string }).deviceID];
        return reply(response, null);
      case "GET /rest/config/defaults/device":
        return reply(response, { deviceID: "", name: "", addresses: ["dynamic"], compression: "metadata", introducer: false, paused: false, autoAcceptFolders: false, untrusted: false, numConnections: 0, ignoredFolders: [], ...deviceDefaults });
      case "GET /rest/config/folders":
        return reply(response, []);
      case "GET /rest/svc/deviceid":
        return reply(response, { id: parsed.searchParams.get("id") });
      default:
        return reply(response, { error: "not faked" }, 404);
    }
  });

  function peer(): LocalInstance {
    return { kind: "local", nodeId: "d7e5", name: "dashboard-test-peer", client: new SyncthingClient({ url, apiKey }), root: "/var/syncthing", os: "linux", threshold: 0, source: "registry" };
  }

  const remote: RemoteInstance = { kind: "remote", nodeId: "a1b2", name: "p53-data", host: "p53", dashboardUrl: "http://127.0.0.1:1" };

  function writesSent(): string[] {
    return received.filter((entry) => entry.method !== "GET").map((entry) => `${entry.method} ${entry.path}`);
  }

  function recordingSetup(layout: SetupLayout | null = { devices: [], folders: [], bands: [] }) {
    const recorded: [string, string, string | null][] = [];
    const setup: SetupRecorder = {
      layout: async () => layout,
      record: async (name, deviceId, root) => {
        recorded.push([name, deviceId, root]);
        return { committed: true, pushed: false, message: "committed, not pushed yet: no remote" };
      },
    };
    return { recorded, setup };
  }

  before(async () => {
    url = await listen(syncthing);
  });

  beforeEach(() => {
    received.length = 0;
    deviceDefaults = {};
    configReads = 0;
    beforeConfigRead = () => {};
    pending = { [strangerId]: laptopOffer(), [secondStrangerId]: { time: "2026-10-26T09:05:00Z", name: "phone", address: "192.168.1.21:22000" } };
    config = syncthingConfig();
    configured = [{ deviceID: ownId, name: "dashboard-test-peer", addresses: ["dynamic"] }];
  });

  after(() => {
    syncthing.close();
  });

  it("accepting on an array never takes introducer or accept folders automatically from the node's defaults", async () => {
    deviceDefaults = { introducer: true, autoAcceptFolders: true };
    const array: LocalInstance = { ...peer(), nodeId: "a3f9", name: "private-array", root: "/mnt/a3f9/pool", source: "array" };
    await acceptPendingDevice(array, strangerId, { name: "laptop", recordInSetup: false }, null);
    const added = received.find((entry) => entry.method === "POST")?.body as Record<string, unknown>;
    assert.equal(added.introducer, false);
    assert.equal(added.autoAcceptFolders, false);
  });

  it("accepting adds the device with its offered name", async () => {
    const { recorded, setup } = recordingSetup();
    const result = await acceptPendingDevice(peer(), strangerId, { name: "laptop" }, setup);

    assert.deepEqual(writesSent(), ["POST /rest/config/devices"]);
    const added = received.find((entry) => entry.method === "POST")?.body as Record<string, unknown>;
    assert.equal(added.deviceID, strangerId);
    assert.equal(added.name, "laptop");
    assert.deepEqual(added.addresses, ["dynamic"]);
    assert.equal(result.accepted.device.name, "laptop");
    assert.deepEqual(recorded, [["laptop", strangerId, null]]);
    assert.equal(result.accepted.setup, "committed, not pushed yet: no remote");
    assert.equal(result.note.text, "dashboard-test-peer: accepted device laptop; committed, not pushed yet: no remote");
    assert.equal(strangerId in pending, false);
  });

  it("accepting under another name adds that name, and the setup repo can be left out", async () => {
    const { recorded, setup } = recordingSetup();
    const result = await acceptPendingDevice(peer(), strangerId, { name: "work-laptop", recordInSetup: false }, setup);

    assert.equal((received.find((entry) => entry.method === "POST")?.body as { name: string }).name, "work-laptop");
    assert.deepEqual(recorded, []);
    assert.equal(result.accepted.setup, "not recorded in the setup repo, as asked");
  });

  it("an accepted device is recorded in the setup repo only under a name it takes and no other device holds", async () => {
    const { recorded, setup } = recordingSetup({ devices: [{ name: "laptop", id: otherStrangerId, joined: true }], folders: [], bands: [] });
    const spaced = await acceptPendingDevice(peer(), strangerId, { name: "Finn's Laptop" }, setup);
    assert.equal(spaced.accepted.setup, `"Finn's Laptop" is not a setup repo device name (a-z, 0-9 and -), so it is recorded on dashboard-test-peer only`);

    configured = configured.filter((device) => device.deviceID !== strangerId);
    pending[strangerId] = laptopOffer();
    const taken = await acceptPendingDevice(peer(), strangerId, { name: "laptop" }, setup);
    assert.equal(taken.accepted.setup, "laptop is already admitted as device OTHERST, so it is recorded on dashboard-test-peer only");
    assert.deepEqual(recorded, []);
  });

  it("without a setup repo the device is still accepted and the answer says where it is recorded", async () => {
    const result = await acceptPendingDevice(peer(), strangerId, { name: "laptop" }, null);
    assert.equal(result.accepted.setup, "no setup repo is configured (SETUP_REPO_DIR), so it is recorded on dashboard-test-peer only");
  });

  it("a setup repo that fails does not undo the accept", async () => {
    const setup: SetupRecorder = { layout: async () => ({ devices: [], folders: [], bands: [] }), record: () => Promise.reject(new Error("EACCES: drive-sync.toml")) };
    const result = await acceptPendingDevice(peer(), strangerId, { name: "laptop" }, setup);
    assert.equal(result.accepted.device.deviceId, strangerId);
    assert.equal(result.accepted.setup, "not recorded in the setup repo: EACCES: drive-sync.toml");
  });

  it("credentials in the setup repo's remote never reach the answer or Activity", async () => {
    const leaky = "https://finn:ghp_secret@github.com/intisy/setup.git";
    const answered: SetupRecorder = { layout: async () => ({ devices: [], folders: [], bands: [] }), record: async () => ({ committed: true, pushed: false, message: `committed, not pushed yet: fatal: unable to access '${leaky}/'` }) };
    const answer = await acceptPendingDevice(peer(), strangerId, { name: "laptop" }, answered);
    configured = configured.filter((device) => device.deviceID !== strangerId);
    pending[strangerId] = laptopOffer();
    const thrown: SetupRecorder = { ...answered, record: () => Promise.reject(new Error(`git push ${leaky} failed`)) };
    const failure = await acceptPendingDevice(peer(), strangerId, { name: "laptop" }, thrown);
    for (const text of [answer.accepted.setup, answer.note.text, failure.accepted.setup, failure.note.text]) {
      assert.doesNotMatch(text, /ghp_secret|finn:/, text);
      assert.match(text, /https:\/\/\*\*\*@github\.com\/intisy\/setup\.git/);
    }
  });

  it("a device that is not asking, or a body without a name, is refused before anything is written", async () => {
    await assert.rejects(acceptPendingDevice(peer(), newcomerId, { name: "x" }, null), (error: Refusal) => error.status === 404 && error.message === "NEWCOME is not asking to connect to dashboard-test-peer");
    await assert.rejects(acceptPendingDevice(peer(), strangerId, {}, null), (error: Refusal) => error.status === 400 && error.message === "the name to accept the device under is missing");
    await assert.rejects(acceptPendingDevice(peer(), strangerId, { name: "laptop", recordInSetup: "yes" }, null), (error: Refusal) => error.status === 400 && error.message === "recordInSetup must be true or false");
    await assert.rejects(ignorePendingDevice(peer(), newcomerId), (error: Refusal) => error.status === 404);
    await assert.rejects(dismissPendingDevice(peer(), newcomerId), (error: Refusal) => error.status === 404);
    assert.deepEqual(writesSent(), []);
  });

  it("ignoring keeps every other config field", async () => {
    const original = syncthingConfig();
    const result = await ignorePendingDevice(peer(), strangerId, () => new Date("2026-10-26T12:00:00Z"));

    assert.deepEqual(writesSent(), ["PUT /rest/config"]);
    const written = received.find((entry) => entry.method === "PUT")?.body as Record<string, unknown>;
    const { remoteIgnoredDevices, ...rest } = written;
    const { remoteIgnoredDevices: ignoredBefore, ...restBefore } = original;
    assert.deepEqual(rest, restBefore);
    assert.deepEqual(Object.keys(written), Object.keys(original));
    assert.deepEqual(remoteIgnoredDevices, [...(ignoredBefore as unknown[]), { time: "2026-10-26T12:00:00.000Z", deviceID: strangerId, name: "laptop", address: "192.168.1.20:22000" }]);
    assert.equal((written.gui as { apiKey: string }).apiKey, apiKey);
    assert.equal((written.gui as { password: string }).password, guiPasswordHash);
    assert.deepEqual(result.ignored, { nodeId: "d7e5", nodeName: "dashboard-test-peer", deviceId: strangerId, name: "laptop", address: "192.168.1.20:22000", time: "2026-10-26T09:00:00Z", alreadyIgnored: false });
    assert.deepEqual(result.note, { nodeId: "d7e5", nodeName: "dashboard-test-peer", folderId: null, text: "dashboard-test-peer: ignored device laptop asking to connect" });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${apiKey}|folder-secret|\\$2a\\$`));
  });

  it("a device the node has ignored already is answered as such, with nothing written and nothing for Activity", async () => {
    config = { ...config, remoteIgnoredDevices: [...(config.remoteIgnoredDevices as unknown[]), { time: "2026-10-25T08:00:00Z", deviceID: strangerId, name: "laptop", address: "" }] };
    const result = await ignorePendingDevice(peer(), strangerId);

    assert.deepEqual(writesSent(), []);
    assert.equal(result.ignored.alreadyIgnored, true);
    assert.deepEqual(result.note, { nothingWritten: true });

    const notes: string[] = [];
    let invalidations = 0;
    const handler = requestHandler(pendingRoutes(fileJoinRecords("/nonexistent/joins.json"), { resolve: async () => peer(), setup: null }), { invalidate: () => void (invalidations += 1), record: (note) => void notes.push(note.text) });
    const server = createServer((request, response) => void handler(request, response));
    const dashboard = await listen(server);
    try {
      const answer = await fetch(`${dashboard}/api/nodes/d7e5/pending/devices/${strangerId}/ignore`, { method: "POST", headers: { "Content-Type": "application/json" } });
      assert.equal(answer.status, 200);
      assert.equal(((await answer.json()) as { alreadyIgnored: boolean }).alreadyIgnored, true);
      assert.deepEqual(notes, []);
      assert.equal(invalidations, 0);
    } finally {
      server.close();
    }
  });

  it("ignoring a config that changed meanwhile starts once more from the changed one", async () => {
    beforeConfigRead = (read) => {
      if (read === 1) config = { ...config, options: { ...(config.options as object), relaysEnabled: false } };
    };
    await ignorePendingDevice(peer(), strangerId);

    assert.deepEqual(writesSent(), ["PUT /rest/config"]);
    const written = received.find((entry) => entry.method === "PUT")?.body as { options: { relaysEnabled: boolean }; remoteIgnoredDevices: { deviceID: string }[] };
    assert.equal(written.options.relaysEnabled, false);
    assert.deepEqual(
      written.remoteIgnoredDevices.map((device) => device.deviceID),
      [otherStrangerId, strangerId],
    );
  });

  it("a config that keeps changing is not written, and says so", async () => {
    beforeConfigRead = (read) => {
      config = { ...config, version: 51 + read };
    };
    await assert.rejects(ignorePendingDevice(peer(), strangerId), (error: Refusal) => error.status === 409 && error.message === "dashboard-test-peer's configuration changed twice while laptop was being ignored; nothing was written, try again");
    assert.deepEqual(writesSent(), []);
  });

  it("a config with a number too large to hand back unchanged is not written", async () => {
    config = { ...config, options: { ...(config.options as object), maxConcurrentIncomingRequestKiB: 2 ** 60 } };
    await assert.rejects(ignorePendingDevice(peer(), strangerId), (error: Error) => error instanceof SyncthingError && /too large/.test(error.message));
    assert.deepEqual(writesSent(), []);
  });

  it("dismiss removes only that offer", async () => {
    const result = await dismissPendingDevice(peer(), strangerId);

    assert.deepEqual(writesSent(), [`DELETE /rest/cluster/pending/devices?device=${strangerId}`]);
    assert.deepEqual(Object.keys(pending), [secondStrangerId]);
    assert.deepEqual(config, syncthingConfig());
    assert.equal(result.dismissed.deviceId, strangerId);
    assert.equal(result.note.text, "dashboard-test-peer: dismissed device laptop asking to connect");
  });

  it("another host's node is answered on that host's dashboard, before any request", async () => {
    const refused = (error: Refusal) => error.status === 409 && error.message === "act on p53's dashboard";
    await assert.rejects(acceptPendingDevice(remote, strangerId, { name: "laptop" }, null), refused);
    await assert.rejects(ignorePendingDevice(remote, strangerId), refused);
    await assert.rejects(dismissPendingDevice(remote, strangerId), refused);
    assert.deepEqual(received, []);
  });

  it("the three answers are node writes that enter Activity", async () => {
    const notes: string[] = [];
    const routes = pendingRoutes(fileJoinRecords("/nonexistent/joins.json"), { resolve: async () => peer(), setup: null });
    const handler = requestHandler(routes, { invalidate: () => {}, record: (note) => void notes.push(note.text) });
    const server = createServer((request, response) => void handler(request, response));
    const dashboard = await listen(server);
    try {
      const post = (path: string, body?: unknown) =>
        fetch(`${dashboard}/api/nodes/d7e5/pending/devices/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal((await post(`${strangerId}/dismiss`)).status, 200);
      assert.equal((await post(`${secondStrangerId}/ignore`)).status, 200);
      pending[strangerId] = laptopOffer();
      assert.equal((await post(`${strangerId}/accept`, { name: "laptop" })).status, 201);
      assert.deepEqual(notes, [
        "dashboard-test-peer: dismissed device laptop asking to connect",
        "dashboard-test-peer: ignored device phone asking to connect",
        "dashboard-test-peer: accepted device laptop; no setup repo is configured (SETUP_REPO_DIR), so it is recorded on dashboard-test-peer only",
      ]);
    } finally {
      server.close();
    }
  });
});
