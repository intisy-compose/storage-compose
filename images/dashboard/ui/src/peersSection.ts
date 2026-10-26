import { type NodesResponse, type Peer, type RemoteState, type StorageNode, connectionKindText } from "./api.js";
import { element, section } from "./dom.js";
import { formatAge, formatPercent, formatRate, normaliseCompletion } from "./format.js";

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

function peerRow(peer: Peer, displayName: string): HTMLElement {
  const note = remoteStateText[peer.remoteState];
  return element(
    "div",
    { className: "peer-row", title: peer.deviceId },
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
  return node ? node.name : peer.name || peer.deviceId.slice(0, 7);
}

export function peersSection(response: NodesResponse, node: StorageNode): HTMLElement | null {
  if (!node.peers.length) return null;
  return section(
    `Devices (${node.peers.length})`,
    element("div", { className: "peer-list" }, ...node.peers.map((peer) => peerRow(peer, nameOf(response, peer)))),
  );
}
