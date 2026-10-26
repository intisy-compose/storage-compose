import { type NodeEntryState, type PriorityInfo, type StatusPresentation, type TreeEntry, priorityBadgeText, statusPresentation } from "./api.js";
import { element } from "./dom.js";
import { formatBytes, formatDate } from "./format.js";
import { icon } from "./icons.js";
import { appState, explorerLocation } from "./state.js";

export interface RowActions {
  onToggle: (entry: TreeEntry) => void;
  onSelect: (entry: TreeEntry) => void;
}

/** Node IDs and names in the order of the "All nodes" dots, so each node keeps one place in every row. */
export type DotColumns = { nodeId: string; nodeName: string }[];

/** The node list's last contact with a node, the only clue to an unknown state. */
export function lastSeenText(nodeId: string): string | null {
  const lastSeen = appState.data?.nodes.find((node) => node.id === nodeId)?.sync.lastSeen;
  return lastSeen ? `last seen ${formatDate(lastSeen)}` : null;
}

/** One line for a node's state of a row, e.g. "not here yet, offered, not accepted". */
export function stateText(state: NodeEntryState): string {
  const shown = statusPresentation(state);
  const reason = state.status === "unknown" ? unknownReason(state, true) : state.detail;
  return reason && reason !== shown.chip ? `${shown.label}, ${reason}` : shown.label;
}

export function presentationClasses(shown: StatusPresentation): string {
  return `tone-${shown.tone}${shown.italic ? " italic" : ""}${shown.dimmed ? " dimmed" : ""}`;
}

export function statusDot(state: NodeEntryState): HTMLElement {
  const shown = statusPresentation(state);
  return element(
    "span",
    { className: `status-dot ${presentationClasses(shown)}`, title: `${state.nodeName}: ${stateText(state)}`, attributes: { role: "img", "aria-label": `${state.nodeName}: ${stateText(state)}` } },
    state.status === "unknown" ? "?" : null,
  );
}

function unknownReason(state: NodeEntryState, withDetail: boolean): string | null {
  const parts = [lastSeenText(state.nodeId), withDetail ? state.detail : null].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(", ") : null;
}

/**
 * The label, or the chip that already says it, then the reason when it adds something.
 * @implNote A row leaves out why a node is unknown: the page's note says it once for every row.
 */
export function stateParts(state: NodeEntryState, withUnknownDetail = false): HTMLElement[] {
  const shown = statusPresentation(state);
  const reason = state.status === "unknown" ? unknownReason(state, withUnknownDetail) : state.detail;
  const parts = [shown.chip ? element("span", { className: "chip chip-muted" }, shown.chip) : element("strong", {}, shown.label)];
  if (reason && reason !== shown.chip) parts.push(element("small", {}, reason));
  return parts;
}

function dotSlots(entry: TreeEntry, columns: DotColumns): HTMLElement {
  const slots = columns.map((column) => {
    const state = entry.nodes.find((candidate) => candidate.nodeId === column.nodeId);
    return state ? statusDot(state) : element("span", { className: "status-dot empty", title: `${column.nodeName}: does not have it` });
  });
  return element("span", { className: "explorer-dots" }, ...slots);
}

function statusCell(entry: TreeEntry, columns: DotColumns | null): HTMLElement {
  if (columns) return dotSlots(entry, columns);
  const state = entry.nodes[0];
  if (!state) return element("span", { className: "explorer-state tone-muted" }, "?");
  const shown = statusPresentation(state);
  return element("span", { className: `explorer-state ${presentationClasses(shown)}`, title: stateText(state) }, ...stateParts(state));
}

export function priorityCell(info: PriorityInfo, isTopDirectory = false): HTMLElement {
  const text = priorityBadgeText(info, isTopDirectory);
  if (info.setHere === null) return element("span", { className: "explorer-priority inherited", title: text }, String(info.effective));
  const marksChange = isTopDirectory ? info.setHere !== info.inherited : info.overridesParent;
  return element("span", { className: `chip explorer-priority${marksChange ? " overrides" : ""}`, title: text }, text);
}

function chevron(entry: TreeEntry, isExpanded: boolean, actions: RowActions): HTMLElement {
  if (entry.kind !== "directory") return element("span", { className: "explorer-chevron-space" });
  const toggle = element(
    "button",
    { className: `explorer-chevron${isExpanded ? " open" : ""}`, title: isExpanded ? "Fold" : "Show what is inside", attributes: { type: "button", "aria-expanded": String(isExpanded), "aria-label": `${isExpanded ? "Fold" : "Expand"} ${entry.name}` } },
    icon("chevron"),
  );
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    actions.onToggle(entry);
  });
  return toggle;
}

function nameCell(entry: TreeEntry): HTMLElement {
  const label = entry.kind === "directory" ? element("a", { className: "explorer-open", attributes: { href: explorerLocation(null, appState.explorer.node, entry.path) } }, entry.name) : element("span", {}, entry.name);
  label.addEventListener("click", (event) => event.stopPropagation());
  return element(
    "span",
    { className: "explorer-name" },
    icon(entry.kind === "directory" ? "folders" : "file", "icon explorer-icon"),
    label,
    entry.folder ? element("span", { className: "chip chip-link", title: `Syncthing folder ${entry.folder.label}` }, entry.folder.id) : null,
  );
}

function rowPresentation(entry: TreeEntry, isAllNodes: boolean): string {
  const state = entry.nodes[0];
  if (isAllNodes || !state) return "";
  return ` ${presentationClasses(statusPresentation(state))}`;
}

export function isSelectedEntry(entry: TreeEntry): boolean {
  if (appState.selectedFolderId) return entry.folder?.id === appState.selectedFolderId;
  return appState.explorer.selectedPath === entry.path;
}

/** `columns` is set in the "All nodes" view and null in one node's. */
export function explorerRow(entry: TreeEntry, depth: number, actions: RowActions, columns: DotColumns | null): HTMLElement {
  const isAllNodes = columns !== null;
  const isExpanded = appState.explorer.expanded.has(entry.path);
  const row = element(
    "div",
    {
      className: `explorer-row${isSelectedEntry(entry) ? " selected" : ""}${rowPresentation(entry, isAllNodes)}`,
      attributes: { tabindex: "0", "data-path": entry.path, role: "row", "aria-selected": String(isSelectedEntry(entry)) },
      onClick: () => actions.onSelect(entry),
    },
    element("span", { className: "explorer-tree", attributes: { style: `--depth: ${depth}` } }, chevron(entry, isExpanded, actions), nameCell(entry)),
    element("span", { className: "explorer-priority-cell" }, priorityCell(entry.priority)),
    statusCell(entry, columns),
    element("span", { className: "explorer-size" }, entry.kind === "file" ? formatBytes(entry.size) : ""),
    element("span", { className: "explorer-modified" }, entry.modified ? formatDate(entry.modified) : ""),
  );
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target === row) actions.onSelect(entry);
  });
  return row;
}

/** A line inside the tree that is not an entry: loading, an error, or entries left out. */
export function explorerNote(depth: number, ...children: (Node | string | null)[]): HTMLElement {
  return element("div", { className: "explorer-row explorer-note" }, element("span", { className: "explorer-tree", attributes: { style: `--depth: ${depth}` } }, element("span", { className: "explorer-chevron-space" }), ...children));
}
