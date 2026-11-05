import type { LayeredState, StorageNode } from "./api.js";
import { element, keyValueList, section } from "./dom.js";
import { formatAge } from "./format.js";

type LayeredChange = LayeredState["drift"][number];

function modeText(state: LayeredState): string {
  return state.mode === "apply" ? "applies its plan" : "reports only: the layout has no apply = true for it, so nothing is written";
}

function changeLine(state: LayeredState, change: LayeredChange): HTMLElement {
  const status = change.written ? "changed" : change.held ? `held: ${change.held}` : state.mode === "report" ? "would change" : "not changed yet";
  return element("li", {}, element("strong", {}, change.label), `: ${change.text} `, element("small", { className: change.held ? "tone-text-warn" : "muted" }, `(${status})`));
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
    ...listRow("Not on the node", state.missing),
    ...listRow("Outside the plan", state.unplanned),
    ...listRow("Unknown devices", state.unknownDevices),
    ...listRow("Node-only ignore lines, kept", state.nodeOnlyIgnores ?? []),
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
