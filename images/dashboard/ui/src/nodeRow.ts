import { type NodesResponse, type StorageNode, reachTone } from "./api.js";
import { isDeviceOnly } from "./devicePlacement.js";
import { element, progressBar } from "./dom.js";
import { formatBytes, usedFraction } from "./format.js";
import { actionableWarnings, isArrayAbsent, isOffline, kindChipText, shortSyncState, spaceTone, thresholdChipText } from "./nodeStatus.js";
import { appState, locationFor } from "./state.js";

export function chip(label: string, className = "chip", title?: string): HTMLElement {
  return element("span", { className, title }, label);
}

function remoteChip(node: StorageNode): HTMLElement | null {
  if (node.local) return null;
  if (isOffline(node)) return chip("offline", "chip chip-muted");
  return node.syncthing?.connectionType ? chip(node.syncthing.connectionType) : null;
}

export function reachText(node: StorageNode): string {
  if (isArrayAbsent(node)) return "not connected";
  return isOffline(node) ? "offline" : "online";
}

/** A separate mark, so a node with warnings still shows by its dot whether it can be reached. */
export function warningMark(response: NodesResponse, node: StorageNode): HTMLElement | null {
  const warnings = actionableWarnings(response, node);
  if (warnings.length === 0) return null;
  const tone = warnings.some((warning) => warning.level === "error") ? "bad" : "warn";
  const text = `${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`;
  const title = warnings.map((warning) => warning.text).join("\n");
  return element("span", { className: `warning-mark tone-mark-${tone}`, title, attributes: { role: "img", "aria-label": text } }, `! ${warnings.length}`);
}

/** A Syncthing-only device holds no node anyone described, so it gets neither a kind nor a threshold. */
function nodeChips(node: StorageNode): HTMLElement {
  const described = isDeviceOnly(node) ? [] : [chip(kindChipText(node)), chip(thresholdChipText(node.threshold))];
  return element("span", { className: "node-chips" }, ...described, remoteChip(node));
}

export function nodeRow(response: NodesResponse, node: StorageNode): HTMLElement {
  const state = shortSyncState(node, response);
  const fraction = usedFraction(node.space);
  const spaceTitle = node.space ? `${formatBytes(node.space.used)} of ${formatBytes(node.space.size)} used` : "space unknown";
  const isSelected = appState.selectedNodeId === node.id;
  const row = element(
    "a",
    {
      className: `node-row${isSelected ? " selected" : ""}${isOffline(node) ? " offline" : ""}`,
      attributes: { href: locationFor("nodes", node.id), "data-node": node.id },
    },
    element("span", { className: `dot tone-${reachTone(node)}`, title: reachText(node) }),
    element(
      "span",
      { className: "node-name" },
      element("span", { className: "node-title" }, element("strong", {}, node.name), warningMark(response, node)),
      node.local || node.host === node.name ? null : element("small", {}, `on ${node.host}`),
    ),
    nodeChips(node),
    element(
      "span",
      { className: "node-space", title: spaceTitle },
      progressBar(fraction, spaceTone(node), spaceTitle),
      element("small", {}, fraction === null ? "" : `${Math.round(fraction * 100)}%`),
    ),
    element("span", { className: `node-sync tone-text-${state.tone}` }, state.symbol ? `${state.symbol} ${state.label}` : state.label),
  );
  if (isSelected) row.setAttribute("aria-current", "true");
  return row;
}
