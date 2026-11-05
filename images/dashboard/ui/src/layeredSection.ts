import { type LayeredState, type StorageNode, resumeStopPauses } from "./api.js";
import { button, element, keyValueList, section } from "./dom.js";
import { requestRefresh, requestRender } from "./renderRequest.js";
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

interface ResumeDraft {
  open: boolean;
  typed: string;
  busy: boolean;
  notice: string | null;
}

const resumeDrafts = new Map<string, ResumeDraft>();

/** What resuming a stop's pauses by hand does, said before the click. */
export function resumeText(name: string, count: number, acting: boolean): string {
  const folders = `${count} ${count === 1 ? "folder" : "folders"}`;
  return acting
    ? `${folders} paused by a stop. They resume by themselves once its space decision lets it pull; resumed by hand while it is still stopped, its next round pauses them again.`
    : `${folders} paused by a stop, and ${name} no longer acts on its plan, so no round resumes them. Type ${name} to resume them.`;
}

async function sendResume(nodeId: string, draft: ResumeDraft): Promise<void> {
  draft.busy = true;
  requestRender();
  const answer = await resumeStopPauses(nodeId, draft.typed);
  draft.busy = false;
  draft.open = false;
  draft.typed = "";
  draft.notice = answer.ok ? `Resumed ${answer.value.resumed.length}, forgot ${answer.value.forgotten.length} no longer paused.` : `Not resumed: ${answer.message}`;
  requestRefresh();
  requestRender();
}

/** @implNote Only on the node's own host, which writes its Syncthing; the node's name is typed, as for apply. */
function resumeBox(node: StorageNode, state: LayeredState): HTMLElement | null {
  const paused = state.pausedByStop ?? [];
  const draft = resumeDrafts.get(node.id) ?? { open: false, typed: "", busy: false, notice: null };
  resumeDrafts.set(node.id, draft);
  if (!paused.length || !node.local) return draft.notice ? element("p", { className: "notice" }, draft.notice) : null;
  const acting = state.mode === "apply" && state.problems.length === 0;
  if (!draft.open) {
    const open = button(`Resume ${paused.length} paused ${paused.length === 1 ? "folder" : "folders"}…`, () => {
      draft.open = true;
      requestRender();
    });
    return element("div", { className: "apply-switch" }, element("p", {}, resumeText(node.name, paused.length, acting)), open, draft.notice ? element("p", { className: "notice" }, draft.notice) : null);
  }
  const typed = element("input", { attributes: { autocomplete: "off", spellcheck: "false", "aria-label": `Type ${node.name} to confirm` } });
  typed.value = draft.typed;
  typed.disabled = draft.busy;
  typed.addEventListener("input", () => {
    draft.typed = typed.value;
    requestRender();
  });
  const go = button("Resume them", () => void sendResume(node.id, draft), "button danger");
  go.disabled = draft.busy || draft.typed !== node.name;
  const cancel = button("Keep them paused", () => {
    draft.open = false;
    draft.typed = "";
    requestRender();
  }, "button ghost");
  return element("div", { className: "apply-switch confirm-box" }, element("p", {}, `${resumeText(node.name, paused.length, acting)} Type ${node.name} to confirm.`), typed, element("div", { className: "form-actions" }, go, cancel));
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
    ...(state.stopped ? ([["Stopped", state.pauseHeld ? `${state.stopped}, but ${state.pauseHeld}: nothing was paused, and nothing is handed off` : `${state.stopped}: its folders are paused and nothing is handed off`]] as [string, string][]) : []),
    ...listRow("Paused by a stop", state.pausedByStop ?? []),
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
    resumeBox(node, state),
    state.drift.length ? element("ul", { className: "layered-drift" }, ...state.drift.map((change) => changeLine(state, change))) : element("p", { className: "muted" }, state.problems.length ? "No plan for this node." : "On its plan."),
  );
}
