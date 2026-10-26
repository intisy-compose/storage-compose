import assert from "node:assert/strict";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { RequestsResponse } from "../src/api/types.js";
import type { JoinedDevice } from "../src/join.js";
import { type RequestNode, type RequestSources, requestsResponse } from "../src/routes/pending.js";
import { SyncthingClient } from "../src/syncthing.js";

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
