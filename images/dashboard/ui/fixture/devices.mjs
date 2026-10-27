import { nodesFixture } from "./nodes.mjs";

const hour = 3_600_000;
const day = 24 * hour;

function ago(milliseconds) {
  return new Date(Date.now() - milliseconds).toISOString();
}

const connections = {
  p53: { kind: "tailscale", address: "100.64.0.12:22000", type: "tcp-client" },
  spisor: { kind: "relay", address: "relay://relay.example:22067", type: "relay-client" },
  "office-pc": { kind: "local-network", address: "192.168.0.140:22000", type: "quic-client" },
  "attic-nas": { kind: "local-network", address: "192.168.0.20:22000", type: "tcp-client" },
  phone: { kind: "internet", address: "203.0.113.40:22000", type: "quic-client" },
};

const lastConnections = {
  "second-pc": { kind: "tailscale", address: "100.64.0.31:22000", at: ago(2 * day + 3 * hour) },
  "old-laptop": { kind: "local-network", address: "192.168.0.77:22000", at: ago(9 * day) },
};

function stay(host, since, lastAt, endedAt, as) {
  return { host, since, lastAt, endedAt, as };
}

function memberDrive(array, member) {
  const lastAt = member.present ? ago(0) : ago(8 * day);
  const attachments = [stay(array.host, ago(40 * day), lastAt, member.present ? null : lastAt, `${member.role} of ${array.name}`)];
  if (member.role === "data1" && array.id === "a3f9") attachments.push(stay("p53", ago(60 * day), ago(41 * day), ago(41 * day), `${member.role} of ${array.name}`));
  return {
    key: `serial:${member.serial}`, label: member.label, kind: "array-member", serial: member.serial, size: member.size, arrayId: array.id, nodeId: null, attachments,
  };
}

function nodeDrive(node) {
  const lastAt = node.online ? ago(0) : node.sync.lastSeen;
  return {
    key: `node:${node.id}`, label: node.name, kind: node.kind === "folder" ? "folder-node" : "drive-node", serial: null, size: node.space?.size ?? null, arrayId: null, nodeId: node.id,
    attachments: [stay(node.host, ago(20 * day), lastAt, node.online ? null : lastAt, `${node.kind} node ${node.name}`)],
  };
}

function summary(record) {
  const open = record.attachments.find((entry) => entry.endedAt === null);
  const latest = [...record.attachments].sort((first, second) => Date.parse(second.lastAt) - Date.parse(first.lastAt))[0];
  return { ...record, present: Boolean(open), currentHost: open?.host ?? null, lastHost: latest?.host ?? null, lastAt: latest?.lastAt ?? null };
}

function hostDevice(host, nodes, drives, thisHost) {
  const online = thisHost || nodes.some((node) => node.online);
  const connection = thisHost || !online ? null : { ...(connections[host] ?? connections.p53), nodeId: "a3f9" };
  const perInstance = thisHost ? [] : [{ nodeId: "a3f9", nodeName: "private-array", connected: online, kind: connection?.kind ?? null, address: connection?.address ?? null }];
  const lastSeen = thisHost ? null : online ? ago(0) : (lastConnections[host]?.at ?? nodes[0]?.sync.lastSeen ?? null);
  return {
    key: host, name: host, thisHost, online, connection, perInstance, lastSeen,
    lastConnection: thisHost ? null : online ? { kind: connection.kind, address: connection.address, at: ago(0) } : (lastConnections[host] ?? null),
    deviceIds: nodes.map((node) => node.syncthing?.deviceId).filter(Boolean), nodeIds: nodes.map((node) => node.id),
    driveKeys: drives.filter((drive) => (drive.currentHost ?? drive.lastHost) === host).map((drive) => drive.key).sort(),
    sources: thisHost ? ["dashboard"] : ["dashboard", "syncthing", "history"],
  };
}

/** Devices for the fixture's nodes: one per host, plus a device known only from history. */
export function devicesFixture(startedAt) {
  const response = nodesFixture(startedAt);
  const records = response.nodes.flatMap((node) => (node.kind === "array" ? node.array.members.map((member) => memberDrive(node, member)) : [nodeDrive(node)]));
  const drives = records.map(summary).sort((first, second) => first.key.localeCompare(second.key));
  const hosts = [...new Set(response.nodes.map((node) => node.host))];
  const devices = hosts.map((host) => hostDevice(host, response.nodes.filter((node) => node.host === host), drives, host === response.host.name));
  devices.push({
    key: "VQ4LHSA-6EF2XVO-MWJ2D3T-OS7QZKX-2CHZL3P-7UGRRJE-NFKXOBM-N6LJYQW", name: "tablet", thisHost: false, online: false, connection: null, perInstance: [],
    lastSeen: ago(30 * day), lastConnection: { kind: "local-network", address: "192.168.0.88:22000", at: ago(30 * day) },
    deviceIds: ["VQ4LHSA-6EF2XVO-MWJ2D3T-OS7QZKX-2CHZL3P-7UGRRJE-NFKXOBM-N6LJYQW"], nodeIds: [], driveKeys: [], sources: ["history"],
  });
  const place = (device) => [device.thisHost ? 0 : 1, device.online ? 0 : 1, -Date.parse(device.lastSeen ?? 0) || 0];
  devices.sort((first, second) => {
    const [a, b] = [place(first), place(second)];
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || first.name.localeCompare(second.name);
  });
  return { devices, drives };
}

/** `GET /api/nodes/<nodeId>/devices/<deviceId>`: a local node's peer as its device form opens it. */
export function deviceSettingsFixture(nodes, nodeId, deviceId) {
  const peer = nodes.find((node) => node.id === nodeId && node.local)?.peers.find((candidate) => candidate.deviceId === deviceId);
  if (!peer) return null;
  return {
    deviceId, name: peer.name, addresses: ["dynamic"], compression: "metadata", introducer: false, autoAcceptFolders: false, paused: peer.paused,
    untrusted: peer.untrusted, allowedNetworks: [], maxSendKbps: 0, maxRecvKbps: 0, numConnections: 0,
  };
}
