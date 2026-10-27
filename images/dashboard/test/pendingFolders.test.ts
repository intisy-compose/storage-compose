import assert from "node:assert/strict";
import { type IncomingMessage, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AcceptFolderBody, Versioning } from "../src/api/types.js";
import type { LocalInstance, RemoteInstance } from "../src/instanceResolver.js";
import type { NodeRoot } from "../src/pathGuard.js";
import { requestHandler } from "../src/routes.js";
import { acceptFolderDefaults, acceptPendingFolder, dismissPendingFolder, ignorePendingFolder, pendingFolderRoutes } from "../src/routes/pendingFolders.js";
import { SyncthingClient } from "../src/syncthing.js";

const apiKey = "secret-api-key";
const ownId = "D7E5AAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const offererId = "TWONEAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const otherId = "OTHERAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const guiPasswordHash = "$2a$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012";

const noVersioning: Versioning = { type: "", params: {}, cleanupIntervalS: 0, fsPath: "" };
const staggered: Versioning = { type: "staggered", params: { maxAge: "31536000" }, cleanupIntervalS: 3600, fsPath: "" };

type Offers = Record<string, { offeredBy: Record<string, { time: string; label: string; receiveEncrypted: boolean; remoteEncrypted: boolean }> }>;

function offers(): Offers {
  return {
    "dashboard-test-a": { offeredBy: { [offererId]: { time: "2026-10-27T09:00:00Z", label: "Dashboard Test A", receiveEncrypted: false, remoteEncrypted: false } } },
    "dashboard-test-b": {
      offeredBy: {
        [offererId]: { time: "2026-10-27T09:05:00Z", label: "dashboard-test-b", receiveEncrypted: false, remoteEncrypted: false },
        [otherId]: { time: "2026-10-27T09:06:00Z", label: "dashboard-test-b", receiveEncrypted: false, remoteEncrypted: false },
      },
    },
    documents: { offeredBy: { [offererId]: { time: "2026-10-21T02:00:00Z", label: "Documents", receiveEncrypted: false, remoteEncrypted: false } } },
    sealed: { offeredBy: { [offererId]: { time: "2026-10-27T09:10:00Z", label: "Sealed", receiveEncrypted: true, remoteEncrypted: false } } },
  };
}

function devices(): Record<string, unknown>[] {
  return [
    { deviceID: ownId, name: "dashboard-test-peer", addresses: ["dynamic"], ignoredFolders: [] },
    { deviceID: offererId, name: "dashboard-test-tw1", addresses: ["tcp://127.0.0.1:22301"], ignoredFolders: [{ time: "2026-10-20T10:00:00Z", id: "music", label: "Music" }] },
    { deviceID: otherId, name: "dashboard-test-tw2", addresses: ["dynamic"], ignoredFolders: [] },
  ];
}

function existingFolder(): Record<string, unknown> {
  return {
    id: "kept",
    label: "Kept",
    path: "/var/syncthing/kept",
    type: "sendreceive",
    devices: [{ deviceID: ownId, introducedBy: "", encryptionPassword: "" }],
    versioning: { type: "simple", params: { keep: "5", cleanoutDays: "0" }, cleanupIntervalS: 3600, fsPath: "/var/syncthing/kept-versions", fsType: "basic" },
    paused: false,
  };
}

/** A whole `/rest/config` with its secrets, as the ignore must hand it back with only one device's ignored folders changed. */
function wholeConfig(): Record<string, unknown> {
  return {
    version: 51,
    folders: [{ ...existingFolder(), devices: [{ deviceID: ownId, introducedBy: "", encryptionPassword: "folder-secret" }] }],
    devices: devices(),
    gui: { enabled: true, address: "0.0.0.0:8389", user: "admin", password: guiPasswordHash, apiKey },
    options: { listenAddresses: ["tcp://0.0.0.0:22199"], relaysEnabled: false, maxConcurrentIncomingRequestKiB: 0 },
    remoteIgnoredDevices: [],
    defaults: { folder: { id: "", path: "~" }, device: { deviceID: "" }, ignores: { lines: [] } },
  };
}

function folderDefaults(): Record<string, unknown> {
  return {
    id: "",
    label: "",
    path: "~",
    type: "sendreceive",
    devices: [],
    rescanIntervalS: 3600,
    fsWatcherEnabled: true,
    fsWatcherDelayS: 10,
    versioning: { type: "", params: {}, cleanupIntervalS: 3600, fsPath: "", fsType: "basic" },
    paused: false,
    order: "random",
    minDiskFree: { value: 1, unit: "%" },
  };
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : null;
}

type Refusal = Error & { status?: number };

describe("answering a folder offered to a node", () => {
  const received: { method: string; path: string; body: unknown }[] = [];
  let pending: Offers = {};
  let folders: Record<string, unknown>[] = [];
  let config: Record<string, unknown> = {};
  let ignoreLines: string[] = [];
  let beforeConfigRead: (read: number) => void = () => {};
  let configReads = 0;
  let url = "";
  /** A write (`POST /rest/config/folders`) applied and then answered by a dropped connection, as a Syncthing that restarts on it. */
  let loseAnswerOf = "";
  /** A write dropped before it is applied, as a Syncthing that stops before the change. */
  let dropWriteOf = "";
  const fastReadBacks = [5, 10, 20];

  function reply(response: import("node:http").ServerResponse, body: unknown, status = 200): void {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }

  const syncthing = createServer(async (request, response) => {
    const parsed = new URL(request.url ?? "/", "http://fake");
    const body = request.method === "GET" ? null : await requestBody(request);
    received.push({ method: request.method ?? "", path: `${parsed.pathname}${parsed.search}`, body });
    const write = `${request.method} ${parsed.pathname}`;
    if (write === dropWriteOf) return request.socket.destroy();
    const answer = write === loseAnswerOf ? () => request.socket.destroy() : null;
    if (request.headers["x-api-key"] !== apiKey) return reply(response, { error: "forbidden" }, 403);
    const folderMatch = parsed.pathname.match(/^\/rest\/config\/folders\/(.+)$/);
    if (folderMatch) {
      const folder = folders.find((candidate) => candidate.id === decodeURIComponent(folderMatch[1]));
      if (!folder) return reply(response, { error: "no such folder" }, 404);
      if (request.method === "PATCH") Object.assign(folder, body);
      return reply(response, folder);
    }
    switch (`${request.method} ${parsed.pathname}`) {
      case "GET /rest/cluster/pending/folders":
        return reply(response, pending);
      case "DELETE /rest/cluster/pending/folders": {
        const entry = pending[parsed.searchParams.get("folder") ?? ""];
        if (entry) delete entry.offeredBy[parsed.searchParams.get("device") ?? ""];
        return reply(response, null);
      }
      case "GET /rest/config/devices":
        return reply(response, devices());
      case "GET /rest/config/folders":
        return reply(response, folders);
      case "POST /rest/config/folders":
        folders = [...folders, body as Record<string, unknown>];
        delete pending[(body as { id: string }).id];
        return answer ? answer() : reply(response, null);
      case "GET /rest/config/defaults/folder":
        return reply(response, folderDefaults());
      case "GET /rest/config/defaults/ignores":
        return reply(response, { lines: ignoreLines });
      case "GET /rest/system/status":
        return reply(response, { myID: ownId });
      case "GET /rest/config":
        beforeConfigRead(configReads++);
        return reply(response, config);
      case "PUT /rest/config":
        config = body as Record<string, unknown>;
        return answer ? answer() : reply(response, null);
      default:
        return reply(response, { error: "not faked" }, 404);
    }
  });

  function peer(): LocalInstance {
    return { kind: "local", nodeId: "d7e5", name: "dashboard-test-peer", client: new SyncthingClient({ url, apiKey }), root: "/var/syncthing", os: "linux", threshold: 0, source: "registry" };
  }

  function array(): LocalInstance {
    return { kind: "local", nodeId: "a3f9", name: "private-array", client: new SyncthingClient({ url, apiKey }), root: "/mnt/a3f9/pool", os: "linux", threshold: 0, source: "array" };
  }

  const remote: RemoteInstance = { kind: "remote", nodeId: "a1b2", name: "p53-data", host: "p53", dashboardUrl: "http://127.0.0.1:1" };

  const nodes: NodeRoot[] = [
    { nodeId: "d7e5", name: "dashboard-test-peer", root: "/var/syncthing", os: "linux" },
    { nodeId: "c0de", name: "nested-stick", root: "/var/syncthing/stick", os: "linux" },
    { nodeId: "a3f9", name: "private-array", root: "/mnt/a3f9/pool", os: "linux" },
  ];

  function acceptBody(change: Partial<AcceptFolderBody> = {}): AcceptFolderBody {
    return { offeredBy: offererId, path: "/var/syncthing/dashboard-test-a", type: "sendreceive", versioning: noVersioning, ...change };
  }

  function writesSent(): string[] {
    return received.filter((entry) => entry.method !== "GET").map((entry) => `${entry.method} ${entry.path}`);
  }

  before(async () => {
    url = await new Promise((resolve) => syncthing.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(syncthing.address() as AddressInfo).port}`)));
  });

  beforeEach(() => {
    received.length = 0;
    pending = offers();
    folders = [existingFolder()];
    config = wholeConfig();
    ignoreLines = [];
    configReads = 0;
    beforeConfigRead = () => {};
    loseAnswerOf = "";
    dropWriteOf = "";
  });

  after(() => {
    syncthing.close();
  });

  it("accepting creates the folder shared with the offering device", async () => {
    const result = await acceptPendingFolder(peer(), "dashboard-test-a", acceptBody(), nodes);

    assert.deepEqual(writesSent(), ["POST /rest/config/folders"]);
    const created = received.find((entry) => entry.method === "POST")?.body as Record<string, unknown>;
    assert.equal(created.id, "dashboard-test-a");
    assert.equal(created.label, "Dashboard Test A");
    assert.equal(created.path, "/var/syncthing/dashboard-test-a");
    assert.equal(created.type, "sendreceive");
    assert.deepEqual(
      (created.devices as { deviceID: string }[]).map((device) => device.deviceID),
      [ownId, offererId],
    );
    assert.equal(created.rescanIntervalS, 3600, "every setting the accept leaves out is the node's default");
    assert.equal(result.added.id, "dashboard-test-a");
    assert.deepEqual(
      result.added.devices.map((device) => device.deviceId),
      [ownId, offererId],
    );
    assert.equal(result.note.text, "dashboard-test-peer: accepted folder Dashboard Test A (dashboard-test-a) from dashboard-test-tw1 at /var/syncthing/dashboard-test-a; send and receive; versioning off");
    assert.equal(result.note.folderId, "dashboard-test-a");
    assert.equal("dashboard-test-a" in pending, false);
  });

  it("the chosen type and versioning are what the folder is created with", async () => {
    await acceptPendingFolder(peer(), "dashboard-test-a", acceptBody({ type: "receiveonly", versioning: { ...staggered, fsPath: "../dashboard-test-a-versions" } }), nodes);
    const created = received.find((entry) => entry.method === "POST")?.body as { type: string; versioning: Record<string, unknown> };
    assert.equal(created.type, "receiveonly");
    assert.deepEqual(created.versioning, { type: "staggered", params: { maxAge: "31536000" }, cleanupIntervalS: 3600, fsPath: "/var/syncthing/dashboard-test-a-versions", fsType: "basic" });
  });

  it("a lost answer to an accept is read back: the folder in place at its path is accepted, one missing is the 503 of a node that does not answer", async () => {
    loseAnswerOf = "POST /rest/config/folders";
    const result = await acceptPendingFolder(peer(), "dashboard-test-a", acceptBody(), nodes, fastReadBacks);
    assert.equal(result.added.id, "dashboard-test-a");
    assert.match(result.note.text, /^dashboard-test-peer: accepted folder Dashboard Test A/);

    loseAnswerOf = "";
    dropWriteOf = "POST /rest/config/folders";
    await assert.rejects(acceptPendingFolder(peer(), "dashboard-test-b", acceptBody({ path: "/var/syncthing/dashboard-test-b" }), nodes, fastReadBacks), { status: 503, message: "dashboard-test-peer's Syncthing is not answering" });
  });

  it("a lost answer to an ignore is read back: the device's ignored folder in place is ignored, one missing is the 503 of a node that does not answer", async () => {
    loseAnswerOf = "PUT /rest/config";
    const result = await ignorePendingFolder(peer(), "dashboard-test-b", { offeredBy: offererId }, () => new Date("2026-10-27T12:00:00Z"), fastReadBacks);
    assert.equal(result.ignored.alreadyIgnored, false);
    assert.equal("text" in result.note && result.note.text, "dashboard-test-peer: ignored folder dashboard-test-b offered by dashboard-test-tw1");

    config = wholeConfig();
    loseAnswerOf = "";
    dropWriteOf = "PUT /rest/config";
    await assert.rejects(ignorePendingFolder(peer(), "dashboard-test-b", { offeredBy: offererId }, () => new Date(), fastReadBacks), { status: 503, message: "dashboard-test-peer's Syncthing is not answering" });
  });

  it("accepting on an array without the typed id is 400", async () => {
    const refusal = (error: Refusal) => error.status === 400 && error.message === "type the folder ID documents to accept it on private-array, an array";
    const body = acceptBody({ path: "/mnt/a3f9/pool/Documents", type: "receiveonly", versioning: staggered });
    await assert.rejects(acceptPendingFolder(array(), "documents", body, nodes), refusal);
    await assert.rejects(acceptPendingFolder(array(), "documents", { ...body, confirm: "Documents" }, nodes), refusal);
    await assert.rejects(acceptPendingFolder(array(), "documents", { ...body, confirm: " documents" }, nodes), refusal);
    assert.deepEqual(received, [], "an array is never asked before the ID is typed");

    await acceptPendingFolder(array(), "documents", { ...body, confirm: "documents" }, nodes);
    assert.deepEqual(writesSent(), ["POST /rest/config/folders"]);
  });

  it("the array form defaults to receive only with versioning", async () => {
    const defaults = await acceptFolderDefaults(array(), "documents", offererId, nodes);

    assert.equal(defaults.confirmRequired, true);
    assert.equal(defaults.settings.type, "receiveonly");
    assert.deepEqual(defaults.settings.versioning, staggered);
    assert.equal(defaults.settings.path, "/mnt/a3f9/pool/Documents");
    assert.equal(defaults.settings.label, "Documents");
    assert.equal(defaults.root, "/mnt/a3f9/pool");
    assert.equal(defaults.placementProblem, null);
    assert.equal(defaults.offer.offeredByName, "dashboard-test-tw1");
    assert.deepEqual(writesSent(), []);
  });

  it("another node's form defaults to the node's own folder defaults, with nothing to type", async () => {
    const defaults = await acceptFolderDefaults(peer(), "dashboard-test-a", offererId, nodes);

    assert.equal(defaults.confirmRequired, false);
    assert.equal(defaults.settings.type, "sendreceive");
    assert.deepEqual(defaults.settings.versioning, { type: "", params: {}, cleanupIntervalS: 3600, fsPath: "" });
    assert.equal(defaults.settings.path, "/var/syncthing/Dashboard Test A");
    assert.deepEqual(
      defaults.settings.devices.map((device) => device.deviceId),
      [ownId, offererId],
    );
  });

  it("an offer received encrypted is accepted receive encrypted, and only such an offer", async () => {
    const defaults = await acceptFolderDefaults(array(), "sealed", offererId, nodes);
    assert.equal(defaults.settings.type, "receiveencrypted");

    await assert.rejects(acceptPendingFolder(peer(), "sealed", acceptBody({ path: "/var/syncthing/sealed" }), nodes), (error: Refusal) => error.status === 400 && error.message === "Sealed is offered encrypted, so it is accepted receive encrypted");
    await assert.rejects(acceptPendingFolder(peer(), "dashboard-test-a", acceptBody({ type: "receiveencrypted" }), nodes), (error: Refusal) => error.status === 400 && error.message === "only a folder offered encrypted is accepted receive encrypted");
    assert.deepEqual(writesSent(), []);
  });

  it("a path outside the root, inside another node or holding another folder's versions is refused before anything is written", async () => {
    const refusedWith = (message: string) => (error: Refusal) => error.status === 400 && error.message === message;
    await assert.rejects(acceptPendingFolder(peer(), "dashboard-test-a", acceptBody({ path: "/etc/dashboard-test-a" }), nodes), refusedWith("/etc/dashboard-test-a is outside dashboard-test-peer's root /var/syncthing"));
    await assert.rejects(acceptPendingFolder(peer(), "dashboard-test-a", acceptBody({ path: "/var/syncthing/../dashboard-test-a" }), nodes), refusedWith("/var/syncthing/../dashboard-test-a is outside dashboard-test-peer's root /var/syncthing"));
    await assert.rejects(acceptPendingFolder(peer(), "dashboard-test-a", acceptBody({ path: "/var/syncthing/stick/a" }), nodes), refusedWith("/var/syncthing/stick/a is inside nested-stick's root /var/syncthing/stick"));
    assert.deepEqual(received, [], "the guard needs no Syncthing call");

    await assert.rejects(acceptPendingFolder(peer(), "dashboard-test-a", acceptBody({ path: "/var/syncthing/kept-versions/a" }), nodes), refusedWith("Path: /var/syncthing/kept-versions/a is inside the versions path /var/syncthing/kept-versions of folder Kept, so its files would mix with versions"));
    await assert.rejects(
      acceptPendingFolder(peer(), "dashboard-test-a", acceptBody({ versioning: { ...staggered, fsPath: "/var/syncthing/kept/old" } }), nodes),
      refusedWith("Versions path: /var/syncthing/kept/old is inside folder Kept (/var/syncthing/kept), so its versions would sync as that folder's files"),
    );
    await assert.rejects(
      acceptPendingFolder(peer(), "dashboard-test-a", acceptBody({ versioning: { ...staggered, fsPath: "versions" } }), nodes),
      refusedWith("Versions path: /var/syncthing/dashboard-test-a/versions is inside folder Dashboard Test A (/var/syncthing/dashboard-test-a), so its versions would sync as that folder's files"),
    );
    await assert.rejects(acceptPendingFolder(peer(), "dashboard-test-a", acceptBody({ path: "/var/syncthing/kept" }), nodes), (error: Refusal) => error.status === 409 && error.message === "dashboard-test-peer's folder Kept already uses /var/syncthing/kept");
    assert.deepEqual(writesSent(), []);
  });

  it("a malformed accept, or external versioning, is refused before any request", async () => {
    const refusedWith = (message: string) => (error: Refusal) => error.status === 400 && error.message === message;
    await assert.rejects(acceptPendingFolder(peer(), "dashboard-test-a", { ...acceptBody(), offeredBy: undefined }, nodes), refusedWith("the device whose offer is accepted is missing"));
    await assert.rejects(acceptPendingFolder(peer(), "dashboard-test-a", { ...acceptBody(), path: " " }, nodes), refusedWith("the folder path is missing"));
    await assert.rejects(acceptPendingFolder(peer(), "dashboard-test-a", acceptBody({ type: "mirror" as AcceptFolderBody["type"] }), nodes), refusedWith("Type must be send and receive, send only, receive only, receive encrypted"));
    await assert.rejects(
      acceptPendingFolder(peer(), "dashboard-test-a", acceptBody({ versioning: { type: "external", params: { command: "rm -rf /" }, cleanupIntervalS: 0, fsPath: "" } }), nodes),
      refusedWith("external versioning runs a program on the node, so it is set in the node's own Syncthing configuration, not from the dashboard"),
    );
    await assert.rejects(acceptPendingFolder(peer(), "dashboard-test-a", { ...acceptBody(), label: "x" }, nodes), refusedWith("label is not part of accepting a folder"));
    assert.deepEqual(received, []);
  });

  it("an offer that is not pending, or a folder the node has already, is refused with nothing written", async () => {
    await assert.rejects(acceptPendingFolder(peer(), "elsewhere", acceptBody({ path: "/var/syncthing/elsewhere" }), nodes), (error: Refusal) => error.status === 404 && error.message === "TWONEAA does not offer folder elsewhere to dashboard-test-peer");
    await assert.rejects(ignorePendingFolder(peer(), "dashboard-test-a", { offeredBy: ownId }), (error: Refusal) => error.status === 404);
    await assert.rejects(dismissPendingFolder(peer(), "elsewhere", { offeredBy: offererId }), (error: Refusal) => error.status === 404);
    pending.kept = { offeredBy: { [offererId]: { time: "2026-10-27T09:00:00Z", label: "Kept", receiveEncrypted: false, remoteEncrypted: false } } };
    await assert.rejects(acceptPendingFolder(peer(), "kept", acceptBody({ path: "/var/syncthing/kept2" }), nodes), (error: Refusal) => error.status === 409 && error.message === "dashboard-test-peer already has folder kept; share it with dashboard-test-tw1 from the folder's settings");
    assert.deepEqual(writesSent(), []);
  });

  it("ignore adds to the offering device's ignored folders", async () => {
    const original = wholeConfig();
    const result = await ignorePendingFolder(peer(), "dashboard-test-b", { offeredBy: offererId }, () => new Date("2026-10-27T12:00:00Z"));

    assert.deepEqual(writesSent(), ["PUT /rest/config"]);
    const written = received.find((entry) => entry.method === "PUT")?.body as Record<string, unknown>;
    const { devices: writtenDevices, ...rest } = written;
    const { devices: devicesBefore, ...restBefore } = original;
    assert.deepEqual(rest, restBefore, "every other part of the configuration is handed back as read, secrets included");
    assert.deepEqual(Object.keys(written), Object.keys(original));
    const [own, offerer, other] = writtenDevices as Record<string, unknown>[];
    const [ownBefore, offererBefore, otherBefore] = devicesBefore as Record<string, unknown>[];
    assert.deepEqual(own, ownBefore);
    assert.deepEqual(other, otherBefore, "the other device offering the same folder keeps offering it");
    assert.deepEqual(offerer, { ...offererBefore, ignoredFolders: [...(offererBefore.ignoredFolders as unknown[]), { time: "2026-10-27T12:00:00.000Z", id: "dashboard-test-b", label: "dashboard-test-b" }] });
    assert.equal(result.ignored.alreadyIgnored, false);
    assert.equal(result.ignored.offeredByName, "dashboard-test-tw1");
    assert.deepEqual(result.note, { nodeId: "d7e5", nodeName: "dashboard-test-peer", folderId: "dashboard-test-b", text: "dashboard-test-peer: ignored folder dashboard-test-b offered by dashboard-test-tw1" });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${apiKey}|folder-secret|\\$2a\\$`));
  });

  it("ignoring on an array without the typed id is 400, and an array is never asked before the ID is typed", async () => {
    const refusal = (error: Refusal) => error.status === 400 && error.message === "type the folder ID documents to ignore it on private-array, an array";
    await assert.rejects(ignorePendingFolder(array(), "documents", { offeredBy: offererId }), refusal);
    await assert.rejects(ignorePendingFolder(array(), "documents", { offeredBy: offererId, confirm: "Documents" }), refusal);
    await assert.rejects(ignorePendingFolder(array(), "documents", { offeredBy: offererId, confirm: 1 }), refusal);
    assert.deepEqual(received, [], "an array is never asked before the ID is typed");

    await ignorePendingFolder(array(), "documents", { offeredBy: offererId, confirm: "documents" });
    assert.deepEqual(writesSent(), ["PUT /rest/config"]);
  });

  it("dismissing on an array needs nothing typed: the offer is listed again when next offered", async () => {
    await dismissPendingFolder(array(), "documents", { offeredBy: offererId });
    assert.deepEqual(writesSent(), [`DELETE /rest/cluster/pending/folders?folder=documents&device=${offererId}`]);
  });

  it("a folder the device's offers of are ignored already is answered as such, with nothing written", async () => {
    const offerer = (config.devices as Record<string, unknown>[])[1];
    offerer.ignoredFolders = [{ time: "2026-10-26T08:00:00Z", id: "dashboard-test-b", label: "dashboard-test-b" }];
    const result = await ignorePendingFolder(peer(), "dashboard-test-b", { offeredBy: offererId });

    assert.deepEqual(writesSent(), []);
    assert.equal(result.ignored.alreadyIgnored, true);
    assert.deepEqual(result.note, { nothingWritten: true });
  });

  it("an ignore over a configuration that keeps changing is not written", async () => {
    beforeConfigRead = (read) => {
      config = { ...config, version: 51 + read };
    };
    await assert.rejects(ignorePendingFolder(peer(), "dashboard-test-b", { offeredBy: offererId }), (error: Refusal) => error.status === 409 && error.message === "dashboard-test-peer's configuration changed twice while dashboard-test-b from dashboard-test-tw1 was being ignored; nothing was written, try again");
    assert.deepEqual(writesSent(), []);
  });

  it("dismiss drops only that device's offer", async () => {
    const result = await dismissPendingFolder(peer(), "dashboard-test-b", { offeredBy: offererId });

    assert.deepEqual(writesSent(), [`DELETE /rest/cluster/pending/folders?folder=dashboard-test-b&device=${offererId}`]);
    assert.deepEqual(Object.keys(pending["dashboard-test-b"].offeredBy), [otherId]);
    assert.deepEqual(config, wholeConfig());
    assert.equal(result.dismissed.folderId, "dashboard-test-b");
    assert.equal(result.note.text, "dashboard-test-peer: dismissed folder dashboard-test-b offered by dashboard-test-tw1");
  });

  it("another host's node is answered on that host's dashboard, before any request", async () => {
    const refused = (error: Refusal) => error.status === 409 && error.message === "act on p53's dashboard";
    await assert.rejects(acceptFolderDefaults(remote, "documents", offererId, nodes), refused);
    await assert.rejects(acceptPendingFolder(remote, "documents", acceptBody(), nodes), refused);
    await assert.rejects(ignorePendingFolder(remote, "documents", { offeredBy: offererId }), refused);
    await assert.rejects(dismissPendingFolder(remote, "documents", { offeredBy: offererId }), refused);
    assert.deepEqual(received, []);
  });

  it("the three answers are node writes that enter Activity, and the defaults are read through the same path", async () => {
    const notes: string[] = [];
    const routes = pendingFolderRoutes({ resolve: async (nodeId) => (nodeId === "a3f9" ? array() : peer()), nodeRoots: async () => nodes });
    const handler = requestHandler(routes, { invalidate: () => {}, record: (note) => void notes.push(note.text) });
    const server = createServer((request, response) => void handler(request, response));
    const dashboard: string = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
    try {
      const post = (nodeId: string, folderId: string, answer: string, body: unknown) =>
        fetch(`${dashboard}/api/nodes/${nodeId}/pending/folders/${folderId}/${answer}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const defaults = await fetch(`${dashboard}/api/nodes/a3f9/pending/folders/documents/defaults?offeredBy=${offererId}`);
      assert.equal(defaults.status, 200);
      assert.equal(((await defaults.json()) as { confirmRequired: boolean }).confirmRequired, true);
      received.length = 0;
      assert.equal((await post("a3f9", "documents", "accept", acceptBody({ path: "/mnt/a3f9/pool/Documents", type: "receiveonly", versioning: staggered }))).status, 400);
      const arrayIgnore = await post("a3f9", "documents", "ignore", { offeredBy: offererId });
      assert.equal(arrayIgnore.status, 400);
      assert.equal(((await arrayIgnore.json()) as { error: string }).error, "type the folder ID documents to ignore it on private-array, an array");
      assert.deepEqual(received, [], "an array is never asked before the ID is typed");
      assert.equal((await post("d7e5", "dashboard-test-b", "dismiss", { offeredBy: otherId })).status, 200);
      assert.equal((await post("d7e5", "dashboard-test-b", "ignore", { offeredBy: offererId })).status, 200);
      assert.equal((await post("d7e5", "dashboard-test-a", "accept", acceptBody())).status, 201);
      assert.equal((await post("d7e5", "dashboard-test-a", "ignore", {})).status, 400);
      assert.deepEqual(notes, [
        "dashboard-test-peer: dismissed folder dashboard-test-b offered by dashboard-test-tw2",
        "dashboard-test-peer: ignored folder dashboard-test-b offered by dashboard-test-tw1",
        "dashboard-test-peer: accepted folder Dashboard Test A (dashboard-test-a) from dashboard-test-tw1 at /var/syncthing/dashboard-test-a; send and receive; versioning off",
      ]);
    } finally {
      server.close();
    }
  });
});
