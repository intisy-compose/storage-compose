import { type NodesResponse, type Peer, type RemoteState, type StorageNode, connectionKindText, deviceDisplayName } from "./api.js";
import { element, section } from "./dom.js";
import { formatAge, formatPercent, formatRate, normaliseCompletion } from "./format.js";
import { addDeviceLocation, deviceFormLocation } from "./state.js";

const remoteStateText: Record<RemoteState, string | null> = {
  valid: null,
  unknown: "has not accepted the folders",
  notSharing: "shares no folder with this node",
  paused: "paused",
  unavailable: "completion unavailable: its Syncthing did not answer",
};

function peerTone(peer: Peer): string {
  if (peer.paused) return "muted";
  return peer.connected ? "ok" : "muted";
}

function connectionText(peer: Peer): string {
  if (!peer.connected) return `offline, last seen ${formatAge(peer.lastSeen)}`;
  return [peer.address, peer.connectionType].filter(Boolean).join(", ");
}

function kindChip(peer: Peer): HTMLElement | null {
  if (!peer.connectionKind) return null;
  return element("span", { className: "chip", title: connectionText(peer) }, connectionKindText(peer.connectionKind));
}

function completionText(peer: Peer): string {
  if (peer.remoteState === "notSharing" || peer.remoteState === "unavailable") return "";
  return formatPercent(normaliseCompletion(peer.completion));
}

function completionTone(peer: Peer): string {
  if (peer.remoteState === "unknown") return "warn";
  return peer.completion >= 100 ? "ok" : "accent";
}

/** A local node's row opens the device's form; another host's node is edited on its own dashboard. */
function peerRow(node: StorageNode, peer: Peer, displayName: string): HTMLElement {
  const note = remoteStateText[peer.remoteState];
  const link = node.local ? { className: "peer-row peer-link", title: `Edit ${displayName}`, attributes: { href: deviceFormLocation(node.id, peer.deviceId) } } : null;
  return element(
    link ? "a" : "div",
    link ?? { className: "peer-row", title: peer.deviceId },
    element("span", { className: `dot tone-${peerTone(peer)}`, title: peer.connected ? "connected" : "not connected" }),
    element(
      "span",
      { className: "peer-name" },
      element("span", { className: "peer-title" }, element("strong", {}, displayName), kindChip(peer)),
      element("small", {}, connectionText(peer)),
      note ? element("small", { className: "tone-text-warn" }, note) : null,
    ),
    element("span", { className: "peer-rates" }, peer.connected ? `↓ ${formatRate(peer.inRate)}  ↑ ${formatRate(peer.outRate)}` : ""),
    element("span", { className: `peer-completion tone-text-${completionTone(peer)}` }, completionText(peer)),
  );
}

function nameOf(response: NodesResponse, peer: Peer): string {
  const node = response.nodes.find((candidate) => candidate.syncthing?.deviceId === peer.deviceId);
  return node ? node.name : deviceDisplayName(peer.name, peer.deviceId);
}

function addDeviceLink(node: StorageNode): HTMLElement | null {
  return node.local && node.syncthing ? element("a", { className: "button add-device", attributes: { href: addDeviceLocation(node.id) } }, "Add a device") : null;
}

/** A local node shows the section even without devices, as the way to add its first one. */
export function peersSection(response: NodesResponse, node: StorageNode): HTMLElement | null {
  const addLink = addDeviceLink(node);
  if (!node.peers.length && !addLink) return null;
  return section(
    `Devices (${node.peers.length})`,
    node.peers.length ? element("div", { className: "peer-list" }, ...node.peers.map((peer) => peerRow(node, peer, nameOf(response, peer)))) : null,
    addLink,
  );
}
