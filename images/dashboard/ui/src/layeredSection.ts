import type { LayeredState, StorageNode } from "./api.js";
import { element, keyValueList, section } from "./dom.js";
import { formatAge, formatBytes } from "./format.js";

type LayeredChange = LayeredState["drift"][number];

function modeText(state: LayeredState): string {
  return state.mode === "apply" ? "applies its plan" : "reports only: the layout has no apply = true for it, so nothing is written";
}

function changeLine(state: LayeredState, change: LayeredChange): HTMLElement {
  const status = change.written ? "changed" : change.held ? `held: ${change.held}` : state.mode === "report" ? "would change" : "not changed yet";
  return element("li", {}, element("strong", {}, change.label), `: ${change.text} `, element("small", { className: change.held ? "tone-text-warn" : "muted" }, `(${status})`));
}

const spaceWords: Record<NonNullable<LayeredState["space"]>["state"], string> = {
  fits: "fits at its threshold with 10% free",
  raised: "short of space: its threshold is raised",
  stopped: "does not fit even at its top priority",
  full: "the cluster does not fit with 10% free: it confirms no new hand-off",
  unknown: "unknown: a folder it keeps has no size yet, so nothing turns send-receive and nothing is handed off",
};

/** The round's space decision; absent while the node's space cannot be read, which holds every type-up and hand-off. */
export function spaceText(space: LayeredState["space"] | undefined): string {
  if (!space) return "not read: nothing turns send-receive and nothing is handed off";
  const amounts = space.state === "unknown" ? "" : ` (needs ${formatBytes(space.neededBytes)}, has ${formatBytes(space.availableBytes)})`;
  return `${spaceWords[space.state]}${amounts}`;
}

function listRow(label: string, values: string[]): [string, string][] {
  return values.length ? [[label, values.join(", ")]] : [];
}

/** How the node stands against its layered plan, as its host's last round found it. */
export function layeredSection(node: StorageNode): HTMLElement | null {
  const state = node.layered;
  if (!state) return null;
  const rows: [string, string][] = [
    ["Mode", modeText(state)],
    ["Threshold", state.effectiveThreshold === state.threshold ? String(state.threshold) : `${state.effectiveThreshold} (committed ${state.threshold})`],
    ["Space", spaceText(state.space)],
    ...(state.stopped ? ([["Stopped", `${state.stopped}: its folders are paused and nothing is handed off`]] as [string, string][]) : []),
    ...listRow("Not on the node", state.missing),
    ...listRow("Outside the plan", state.unplanned),
    ...listRow("Unknown devices", state.unknownDevices),
    ...listRow("Node-only ignore lines", state.nodeOnlyIgnores ?? []),
    ["Checked", formatAge(state.checkedAt)],
  ];
  return section(
    "Layered sync",
    state.problems.length ? element("p", { className: "tone-text-bad" }, state.problems.join("; ")) : null,
    state.failed ? element("p", { className: "tone-text-bad" }, `Last round: ${state.failed}`) : null,
    keyValueList(rows),
    state.drift.length ? element("ul", { className: "layered-drift" }, ...state.drift.map((change) => changeLine(state, change))) : element("p", { className: "muted" }, state.problems.length ? "No plan for this node." : "On its plan."),
  );
}
