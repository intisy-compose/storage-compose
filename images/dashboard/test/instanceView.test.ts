import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { type InstanceView, instanceView } from "../src/syncthing.js";

const ownId = "OWNAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const arrayId = "ARRAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const strangerId = "STRAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";

interface Answers {
  completion: Record<string, { completion: number; needBytes: number; remoteState?: string }>;
  pausedDevices: string[];
  folderStatus: Record<string, Record<string, unknown>>;
  failingCompletion: string[];
}

const documentsStatus = { state: "idle", globalBytes: 1000, globalFiles: 10, needBytes: 0, needFiles: 0, errors: 1, pullErrors: 1, receiveOnlyTotalItems: 0 };

function answersFor(overrides: Partial<Answers> = {}): Answers {
  return {
    completion: { [arrayId]: { completion: 0, needBytes: 1000, remoteState: "unknown" }, [strangerId]: { completion: 100, needBytes: 0, remoteState: "valid" } },
    pausedDevices: [],
    folderStatus: { documents: documentsStatus },
    failingCompletion: [],
    ...overrides,
  };
}

function reply(response: import("node:http").ServerResponse, body: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function fakeSyncthing(answers: Answers, calls: string[]): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    calls.push(url.pathname);
    switch (url.pathname) {
      case "/rest/system/status":
        return reply(response, {
          myID: ownId,
          uptime: 3600,
          cpuPercent: 1.5,
          sys: 52_000_000,
          connectionServiceStatus: {
            "tcp://0.0.0.0:22000": { error: null, lanAddresses: ["tcp://0.0.0.0:22000", "tcp://192.168.1.5:22000"], wanAddresses: ["tcp://:22000"] },
            "relay://0.0.0.0": { error: null, lanAddresses: [], wanAddresses: ["relay://203.0.113.9:22067/?id=RELAYID&pingInterval=1m0s"] },
            "quic://0.0.0.0:22000": { error: "listen udp: address already in use", lanAddresses: [], wanAddresses: [] },
          },
          discoveryStatus: { local: { error: null }, "global@https://disco.example/": { error: "no route to host" } },
        });
      case "/rest/system/version":
        return reply(response, { version: "v2.0.0" });
      case "/rest/system/connections":
        return reply(response, {
          total: { inBytesTotal: 5000, outBytesTotal: 7000 },
          connections: {
            [arrayId]: { connected: true, type: "tcp-client", address: "10.0.0.2:22000", clientVersion: "v2.0.0", inBytesTotal: 1, outBytesTotal: 2 },
            [strangerId]: { connected: false, type: "", address: "", clientVersion: "", inBytesTotal: 0, outBytesTotal: 0 },
          },
        });
      case "/rest/config/folders":
        return reply(response, [
          { id: "documents", label: "Documents", path: "F:\\Documents", type: "sendreceive", paused: false, devices: [{ deviceID: ownId }, { deviceID: arrayId }] },
          { id: "private", label: "", path: "F:\\Private", type: "sendonly", paused: false, devices: [{ deviceID: ownId }] },
        ]);
      case "/rest/config/devices":
        return reply(response, [
          { deviceID: ownId, name: "pc", addresses: ["dynamic"] },
          { deviceID: arrayId, name: "storage", addresses: ["dynamic"], paused: answers.pausedDevices.includes(arrayId) },
          { deviceID: strangerId, name: "stranger", addresses: ["dynamic"] },
        ]);
      case "/rest/stats/device":
        return reply(response, { [arrayId]: { lastSeen: "2026-10-21T09:00:00Z" }, [strangerId]: { lastSeen: "1970-01-01T00:00:00Z" } });
      case "/rest/stats/folder":
        return reply(response, { documents: { lastScan: "2026-10-21T08:00:00Z", lastFile: { at: "2026-10-21T07:00:00Z", filename: "a/b.txt", deleted: false } } });
      case "/rest/db/status":
        return reply(response, answers.folderStatus[url.searchParams.get("folder") ?? ""] ?? { state: "idle", globalBytes: 0, needBytes: 0 });
      case "/rest/cluster/pending/folders":
        return reply(response, {
          music: { offeredBy: { [arrayId]: { time: "2026-10-21T09:00:00Z", label: "Music" } } },
          pictures: { offeredBy: { [arrayId]: { time: "2026-10-21T09:00:00Z", label: "Pictures" }, [strangerId]: { time: "2026-10-21T09:00:00Z", label: "Pictures" } } },
        });
      case "/rest/db/completion":
        if (answers.failingCompletion.includes(url.searchParams.get("device") ?? "")) {
          response.statusCode = 500;
          return response.end("database is busy");
        }
        return reply(response, answers.completion[url.searchParams.get("device") ?? ""] ?? { completion: 0, needBytes: 0 });
      default:
        response.statusCode = 404;
        return response.end("not found");
    }
  });
}

describe("instance view", () => {
  let server: Server;
  let endpoint: { url: string; apiKey: string };
  const calls: string[] = [];
  let answers = answersFor();
  let view: InstanceView;

  before(async () => {
    server = fakeSyncthing(answers, calls);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    endpoint = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "key" };
    view = (await instanceView("view-main", endpoint))!;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("a folder with errors keeps its state and counts its failed items", () => {
    const documents = view.folders.find((folder) => folder.id === "documents")!;
    assert.equal(documents.state, "idle");
    assert.equal(documents.errors, 1);
    assert.equal(documents.label, "Documents");
    assert.equal(documents.globalFiles, 10);
    assert.equal(documents.lastScan, "2026-10-21T08:00:00Z");
    assert.equal(documents.lastFile?.filename, "a/b.txt");
    assert.deepEqual(documents.sharedWith, [{ deviceId: arrayId, name: "storage" }]);
  });

  it("reads the folder statistics once per instance, not once per folder", () => {
    assert.equal(calls.filter((path) => path === "/rest/stats/folder").length, 1);
    assert.equal(calls.filter((path) => path === "/rest/db/status").length, 2);
  });

  it("a node waiting for a peer is waiting not idle", () => {
    assert.equal(view.sync.state, "waiting");
    assert.deepEqual(view.sync.waitingFor, [arrayId]);
    assert.equal(view.sync.completion, 0);
  });

  it("the own device has listeners and no connection type", () => {
    assert.equal(view.device.connectionType, null);
    assert.equal(view.device.deviceId, ownId);
    assert.deepEqual(view.instance.listeners, [
      { address: "tcp://0.0.0.0:22000", error: null },
      { address: "relay://0.0.0.0", error: null },
      { address: "quic://0.0.0.0:22000", error: "listen udp: address already in use" },
    ]);
    assert.deepEqual(view.instance.discoveryErrors, ["global@https://disco.example/: no route to host"]);
    assert.equal(view.instance.uptime, 3600);
    assert.equal(view.instance.memoryBytes, 52_000_000);
    assert.equal(view.instance.inTotal, 5000);
    assert.equal(view.instance.outTotal, 7000);
  });

  it("unspecified listen addresses are left out of the device's addresses", () => {
    assert.deepEqual(view.device.addresses, ["tcp://192.168.1.5:22000", "relay://203.0.113.9:22067/?id=RELAYID&pingInterval=1m0s"]);
  });

  it("a node with offers waiting counts them", () => {
    assert.equal(view.offersWaiting, 2);
  });

  it("peers carry completion and remote state", () => {
    const storage = view.peers.find((peer) => peer.deviceId === arrayId)!;
    assert.equal(storage.connected, true);
    assert.equal(storage.connectionType, "tcp-client");
    assert.equal(storage.completion, 0);
    assert.equal(storage.needBytes, 1000);
    assert.equal(storage.remoteState, "unknown");
    assert.deepEqual(storage.folders, ["documents"]);
    const stranger = view.peers.find((peer) => peer.deviceId === strangerId)!;
    assert.equal(stranger.remoteState, "notSharing");
    assert.equal(stranger.lastSeen, null);
  });

  it("a paused peer is paused and does not make the node wait", async () => {
    answers = answersFor({ pausedDevices: [arrayId] });
    const other = fakeSyncthing(answers, []);
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", () => resolve()));
    try {
      const pausedView = (await instanceView("view-paused", { url: `http://127.0.0.1:${(other.address() as AddressInfo).port}`, apiKey: "key" }))!;
      assert.equal(pausedView.peers.find((peer) => peer.deviceId === arrayId)!.remoteState, "paused");
      assert.equal(pausedView.sync.state, "idle");
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("a folder that is only scanning does not hide the wait for a peer", async () => {
    answers = answersFor({ folderStatus: { documents: { ...documentsStatus, state: "scanning" } } });
    const other = fakeSyncthing(answers, []);
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", () => resolve()));
    try {
      const scanning = (await instanceView("view-scanning", { url: `http://127.0.0.1:${(other.address() as AddressInfo).port}`, apiKey: "key" }))!;
      assert.equal(scanning.sync.state, "waiting");
      assert.equal(scanning.sync.completion, 0);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("a node whose peer holds everything is idle", async () => {
    answers = answersFor({ completion: { [arrayId]: { completion: 100, needBytes: 0, remoteState: "valid" } } });
    const other = fakeSyncthing(answers, []);
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", () => resolve()));
    try {
      const settled = (await instanceView("view-settled", { url: `http://127.0.0.1:${(other.address() as AddressInfo).port}`, apiKey: "key" }))!;
      assert.equal(settled.sync.state, "idle");
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("a completion that cannot be read is unavailable and does not make the node wait", async () => {
    answers = answersFor({ failingCompletion: [arrayId] });
    const other = fakeSyncthing(answers, []);
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", () => resolve()));
    try {
      const unreadable = (await instanceView("view-unreadable", { url: `http://127.0.0.1:${(other.address() as AddressInfo).port}`, apiKey: "key" }))!;
      assert.equal(unreadable.peers.find((peer) => peer.deviceId === arrayId)!.remoteState, "unavailable");
      assert.equal(unreadable.sync.state, "idle");
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});
