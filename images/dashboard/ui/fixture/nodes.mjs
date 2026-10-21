const terabyte = 1e12;
const hour = 3_600_000;
const day = 24 * hour;

function ago(milliseconds) {
  return new Date(Date.now() - milliseconds).toISOString();
}

function deviceId(seed) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let state = [...seed].reduce((sum, character) => sum * 31 + character.charCodeAt(0), 7) >>> 0;
  const groups = [];
  for (let group = 0; group < 8; group += 1) {
    let text = "";
    for (let index = 0; index < 7; index += 1) {
      state = (state * 1103515245 + 12345) >>> 0;
      text += alphabet[(state >>> 16) % alphabet.length];
    }
    groups.push(text);
  }
  return groups.join("-");
}

function syncthing(seed, overrides = {}) {
  return { deviceId: deviceId(seed), addresses: ["dynamic"], connectionType: "LAN", inRate: 0, outRate: 0, version: "v2.0.10", ...overrides };
}

function member(role, label, size, used, asset, overrides = {}) {
  return {
    role, label, serial: `ZA${label.length}${role.toUpperCase()}${size}`.slice(0, 12), size, used, asset, present: true,
    smart: { state: "ok", detail: "passed", reallocatedSectors: 0, pendingSectors: 0, powerOnHours: 21000 }, temperature: 36,
    condition: "present", detail: "", ...overrides,
  };
}

const commonFolders = [
  { id: "documents", path: "/mnt/storage/pool/Documents", type: "sendreceive", state: "idle", completion: 100 },
  { id: "github", path: "/mnt/storage/pool/GitHub", type: "sendreceive", state: "scanning", completion: 100 },
  { id: "pictures", path: "/mnt/storage/pool/Pictures", type: "sendreceive", state: "idle", completion: 100 },
];

function privateArray() {
  return {
    id: "a3f9", name: "private-array", kind: "array", threshold: 0, assigned: [], local: true, online: true, host: "finn-pc",
    space: { size: 10 * terabyte, used: 7.6 * terabyte },
    sync: { state: "idle", completion: 100, lastSeen: ago(0) },
    array: {
      state: "healthy",
      members: [
        member("data1", "a3f9-data1", 4 * terabyte, 3.68 * terabyte, "SAM-0056", { temperature: 41, smart: { state: "warn", detail: "8 reallocated, 0 pending (accepted as its baseline)", reallocatedSectors: 8, pendingSectors: 0, powerOnHours: 23000 } }),
        member("data2", "a3f9-data2", 4 * terabyte, 2.08 * terabyte, "SAM-0042"),
        member("data3", "a3f9-data3", 2 * terabyte, 1.48 * terabyte, "SAM-0043", { temperature: 35 }),
        member("parity1", "a3f9-parity1", 10 * terabyte, 8 * terabyte, "SAM-0061", { temperature: 38 }),
        member("parity2", "a3f9-parity2", 4 * terabyte, 4 * terabyte, "SAM-0064", { temperature: 40 }),
      ],
      parity: { job: null, lastSync: ago(5 * hour), lastScrub: ago(2 * day) },
      candidates: [],
    },
    syncthing: syncthing("a3f9", { addresses: ["tcp://192.168.0.100:22000", "quic://192.168.0.100:22000"], inRate: 4.2e6, outRate: 3e5 }),
    folders: commonFolders,
  };
}

function backupArray(startedAt) {
  const jobStart = startedAt - 2 * hour;
  const progress = Math.min(99, 45 + (Date.now() - startedAt) / 60_000);
  return {
    id: "b71c", name: "cold-backup", kind: "array", threshold: 20, assigned: ["Archive"], local: true, online: true, host: "finn-pc",
    space: { size: 6 * terabyte, used: 4.1 * terabyte },
    sync: { state: "syncing", completion: 82, lastSeen: ago(0) },
    array: {
      state: "degraded",
      members: [
        member("data1", "b71c-data1", 3 * terabyte, 2.2 * terabyte, "SAM-0071", { temperature: 39 }),
        member("data2", "b71c-data2", 3 * terabyte, null, "SAM-0072", { present: false, smart: null, temperature: null, condition: "missing", detail: "not seen since 2026-10-18" }),
        member("parity1", "b71c-parity1", 4 * terabyte, 3.1 * terabyte, null, { temperature: 37, smart: null }),
      ],
      parity: { job: { kind: "sync", progress, startedAt: new Date(jobStart).toISOString() }, lastSync: ago(3 * day), lastScrub: ago(9 * day) },
      candidates: [
        { path: "/dev/sdf", size: 4 * terabyte, model: "WDC WD40EFRX", serial: "WD-WCC7K1234567", transport: "usb" },
        { path: "/dev/sdg", size: 3 * terabyte, model: "ST3000DM001", serial: "Z1F4ABCD", transport: "usb" },
      ],
    },
    syncthing: syncthing("b71c", { addresses: ["tcp://192.168.0.100:22001"], inRate: 1.1e7, outRate: 2e4 }),
    folders: [
      { id: "archive", path: "/mnt/b71c/pool/Archive", type: "receiveonly", state: "syncing", completion: 82 },
      { id: "pictures", path: "/mnt/b71c/pool/Pictures", type: "receiveonly", state: "idle", completion: 100 },
    ],
  };
}

function simpleNode(id, name, kind, overrides) {
  return {
    id, name, kind, threshold: 50, assigned: [], local: false, online: true, host: name,
    space: { size: 1 * terabyte, used: 0.4 * terabyte },
    sync: { state: "idle", completion: 100, lastSeen: ago(0) },
    syncthing: syncthing(id), folders: commonFolders.slice(0, 2),
    ...overrides,
  };
}

function remoteArray() {
  return simpleNode("c204", "spisor-cluster", "array", {
    host: "spisor", threshold: 0,
    space: { size: 16 * terabyte, used: 3.4 * terabyte },
    sync: { state: "syncing", completion: 97, lastSeen: ago(0) },
    syncthing: syncthing("c204", { connectionType: "relay", addresses: ["relay://relay.example:22067"], inRate: 2e4, outRate: 2.1e6 }),
    array: {
      state: "healthy",
      members: [
        member("data1", "c204-data1", 8 * terabyte, 1.9 * terabyte, null),
        member("data2", "c204-data2", 8 * terabyte, 1.5 * terabyte, null),
        member("parity1", "c204-parity1", 8 * terabyte, 1.9 * terabyte, null),
      ],
      parity: { job: null, lastSync: ago(1 * hour), lastScrub: ago(6 * day) },
      candidates: [],
    },
    folders: commonFolders,
  });
}

function folderDetail(folder) {
  return { label: "", errors: 0, needItems: 0, needBytes: 0, globalBytes: 0, globalFiles: 0, lastScan: ago(hour), lastFile: null, localChanged: 0, sharedWith: [], ...folder };
}

function ownInstance() {
  return {
    uptime: 3 * 86_400, cpuPercent: 0.8, memoryBytes: 90_000_000, inTotal: 4e9, outTotal: 9e9, discoveryErrors: [],
    listeners: [{ address: "tcp://0.0.0.0:22000", error: null }, { address: "quic://0.0.0.0:22000", error: null }],
  };
}

function withNodeDetail(response) {
  return { ...response, nodes: response.nodes.map(withDetail) };
}

function withDetail(node) {
  const instance = node.instance ?? (node.local && node.syncthing ? ownInstance() : null);
  return { ...node, instance, peers: node.peers ?? [], folders: node.folders.map(folderDetail) };
}

export function nodesFixture(startedAt) {
  return withNodeDetail({
    host: { name: "finn-pc" },
    nodes: [
      privateArray(),
      backupArray(startedAt),
      simpleNode("e5d0", "ventoy-files", "folder", {
        local: true, host: "finn-pc", threshold: 80,
        space: { size: 0.256 * terabyte, used: 0.077 * terabyte },
        sync: { state: "syncing", completion: 64, lastSeen: ago(0) },
        syncthing: syncthing("e5d0", { inRate: 6.4e6, outRate: 0 }),
        folders: [{ id: "documents", path: "D:\\files\\Documents", type: "sendreceive", state: "syncing", completion: 64 }],
      }),
      simpleNode("17aa", "finn-pc-disk", "drive", { local: true, host: "finn-pc", space: { size: 2 * terabyte, used: 1.1 * terabyte } }),
      simpleNode("2b90", "p53", "drive", { host: "p53", space: { size: 1 * terabyte, used: 0.35 * terabyte }, syncthing: syncthing("2b90", { addresses: ["tcp://100.64.0.12:22000"] }) }),
      remoteArray(),
      simpleNode("9f31", "second-pc", "drive", {
        host: "second-pc", online: false, space: { size: 2 * terabyte, used: 0.4 * terabyte },
        sync: { state: "offline", completion: 88, lastSeen: ago(2 * day + 3 * hour) },
        syncthing: syncthing("9f31", { connectionType: null, addresses: [] }),
      }),
      simpleNode("44c2", "office-pc", "drive", {
        host: "office-pc", sync: { state: "error", completion: 99, lastSeen: ago(0) },
        syncthing: syncthing("44c2", { connectionType: "relay" }),
        folders: [{ id: "documents", path: "C:\\Users\\office\\Documents", type: "sendreceive", state: "error", completion: 99 }],
      }),
      simpleNode("6d07", "attic-nas", "drive", { host: "attic-nas", threshold: 20, space: { size: 8 * terabyte, used: 7.5 * terabyte } }),
      simpleNode("81fe", "media-stick", "folder", {
        host: "p53", threshold: 90, online: false, space: { size: 0.128 * terabyte, used: 0.02 * terabyte },
        sync: { state: "offline", completion: 100, lastSeen: ago(5 * hour) }, syncthing: syncthing("81fe", { connectionType: null }),
      }),
      simpleNode("0c5b", "old-laptop", "drive", {
        host: "old-laptop", online: false, sync: { state: "offline", completion: 71, lastSeen: ago(9 * day) },
        syncthing: syncthing("0c5b", { connectionType: null, version: "v1.27.12" }),
      }),
      simpleNode("d3e8", "phone", "folder", { host: "phone", threshold: 90, space: { size: 0.5 * terabyte, used: 0.31 * terabyte }, syncthing: syncthing("d3e8", { version: "v1.29.2" }) }),
    ],
    warnings: [
      { level: "error", text: "cold-backup is degraded: data2 (SAM-0072) is missing", nodeId: "b71c" },
      { level: "error", text: "office-pc: 3 files failed to sync (permission denied)", nodeId: "44c2" },
      { level: "warning", text: "private-array: data1 is 92% full and has 8 reallocated sectors", nodeId: "a3f9" },
      { level: "warning", text: "attic-nas is 94% full", nodeId: "6d07" },
      { level: "warning", text: "old-laptop has been offline for 9 days", nodeId: "0c5b" },
    ],
  });
}
