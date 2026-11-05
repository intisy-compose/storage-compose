import type { HandoffOutcome, HandoffWaitingView, LayeredState, StorageNode, Warning } from "./api/types.js";
import { warning } from "./attention.js";

/** A file that waits this long for a keeper is on Attention (plan task 4.4). */
export const handoffWaitingHours = 24;

const waitingWords: Record<HandoffWaitingView["reason"], string> = {
  "keeper-offline": "its keeper is offline",
  "no-keeper": "no node keeps it",
  "not-confirmed": "no keeper holds this version yet",
  changed: "it changed since it was offered",
  held: "a pin or an assigned path holds it",
};

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function byFolder<Entry extends { folderId: string }>(entries: Entry[]): Map<string, Entry[]> {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) groups.set(entry.folderId, [...(groups.get(entry.folderId) ?? []), entry]);
  return groups;
}

function labelOf(node: StorageNode, folderId: string): string {
  const folder = node.folders.find((entry) => entry.id === folderId);
  return folder?.label || folderId;
}

function waitingWarnings(node: StorageNode, waiting: HandoffWaitingView[], now: number): Warning[] {
  const old = waiting.filter((entry) => now - Date.parse(entry.since) >= handoffWaitingHours * 3_600_000);
  return [...byFolder(old)].map(([folderId, entries]) => {
    const reasons = [...new Set(entries.map((entry) => waitingWords[entry.reason] ?? entry.reason))].join(", ");
    return warning({
      id: `handoff-waiting:${node.id}:${folderId}`,
      level: "warning",
      kind: "handoff-waiting",
      text: `${node.name}: ${plural(entries.length, "file")} in ${labelOf(node, folderId)} have waited more than ${handoffWaitingHours} hours for a keeper (${reasons}); nothing of them leaves the node until one confirms`,
      nodeId: node.id,
      folderId,
      at: entries.map((entry) => entry.since).sort()[0],
    });
  });
}

function isTooLarge(outcome: HandoffOutcome): boolean {
  return outcome.outcome === "refused" && /too large to hash/.test(outcome.reason);
}

const snapshotProblem = /the open-file snapshot[^;)]*/;

function outcomeGroupWarnings(node: StorageNode, outcomes: HandoffOutcome[], kind: "handoff-refused" | "handoff-pending", text: (count: string, label: string, first: HandoffOutcome) => string): Warning[] {
  return [...byFolder(outcomes)].map(([folderId, entries]) =>
    warning({ id: `${kind}:${node.id}:${folderId}`, level: kind === "handoff-refused" ? "warning" : "info", kind, text: text(plural(entries.length, "file"), labelOf(node, folderId), entries[0]), nodeId: node.id, folderId }),
  );
}

/** The executor refusing a contract the dashboard held on purpose (a stop, an unknown space) is no fault: the hold is said by its note. */
function isHeldRefusal(state: LayeredState, refused: string): boolean {
  return state.handoff?.apply === false && refused === "the contract is not in apply mode";
}

function resultWarnings(node: StorageNode, state: LayeredState): Warning[] {
  const result = state.handoff?.result;
  if (!result) return [];
  const warnings: Warning[] = [];
  if (result.refused && state.mode === "apply" && !isHeldRefusal(state, result.refused)) warnings.push(warning({ id: `handoff-refused:${node.id}`, level: "warning", kind: "handoff-refused", text: `${node.name}: the hand-off executor refused the whole contract: ${result.refused}`, nodeId: node.id }));
  const refused = result.results.filter((outcome) => outcome.outcome === "refused" && !isTooLarge(outcome) && !snapshotProblem.test(outcome.reason));
  warnings.push(...outcomeGroupWarnings(node, refused, "handoff-refused", (count, label, first) => `${node.name}: the hand-off of ${count} in ${label} was refused (${first.path}: ${first.reason})`));
  const pending = result.results.filter((outcome) => outcome.outcome === "ignored-not-moved" && !snapshotProblem.test(outcome.reason));
  warnings.push(...outcomeGroupWarnings(node, pending, "handoff-pending", (count, label, first) => `${node.name}: ${count} in ${label} ignored but not moved yet (${first.path}: ${first.reason}); each is retried, and released after 10 tries`));
  for (const outcome of result.results) {
    const label = labelOf(node, outcome.folderId);
    const at = { nodeId: node.id, folderId: outcome.folderId };
    if (outcome.outcome === "unsynced-at-handed-off-path")
      warnings.push(warning({ id: `handoff-unsynced:${node.id}:${outcome.folderId}:${outcome.path}`, level: "warning", kind: "handoff-unsynced", text: `${node.name}: ${outcome.path} in ${label} is a new file at a handed-off path; it is on this node only, since the hand-off's ignore line keeps it out of sync; move or rename it to sync it`, ...at }));
    if (outcome.outcome === "deferred")
      warnings.push(warning({ id: `handoff-deferred:${node.id}:${outcome.folderId}:${outcome.path}`, level: "info", kind: "handoff-deferred", text: `${node.name}: ${outcome.path} in ${label} could not be hashed within the host agent's round; it is hashed again next round`, ...at }));
    if (isTooLarge(outcome))
      warnings.push(warning({ id: `handoff-deferred:${node.id}:${outcome.folderId}:${outcome.path}`, level: "warning", kind: "handoff-deferred", text: `${node.name}: ${outcome.path} in ${label} is too large to hash within the host agent's round, so it is not handed off and stays on the node`, ...at }));
    if (outcome.outcome === "in-trash-unlisted" && outcome.trash)
      warnings.push(warning({ id: `handoff-trash:${node.id}:${outcome.trash}`, level: "error", kind: "handoff-trash", text: `${node.name}: ${outcome.trash} is in the hand-off trash outside its manifest and is never emptied (${outcome.reason}); check it by hand`, ...at }));
  }
  for (const kept of result.trash) {
    const outside = /outside the manifest/.test(kept.reason);
    const text = outside
      ? `${node.name}: ${kept.trash} is in the hand-off trash outside its manifest and is never emptied (${kept.reason}); check it by hand`
      : `${node.name}: the hand-off trash keeps ${kept.path} of ${labelOf(node, kept.folderId)} past its days: ${kept.reason}`;
    warnings.push(warning({ id: `handoff-trash:${node.id}:${kept.trash}`, level: outside ? "error" : "warning", kind: "handoff-trash", text, nodeId: node.id, folderId: kept.folderId }));
  }
  const snapshot = [...result.results.map((outcome) => outcome.reason), ...result.notes].map((text) => snapshotProblem.exec(text)?.[0]).find(Boolean);
  if (snapshot) warnings.push(warning({ id: `handoff-probe:${node.id}`, level: "warning", kind: "handoff-probe", text: `${node.name}: ${snapshot}; no file is moved while whether it is open cannot be told`, nodeId: node.id }));
  for (const note of result.notes.filter((entry) => !snapshotProblem.test(entry))) warnings.push(warning({ id: `handoff-note:${node.id}:${note}`, level: "info", kind: "handoff-note", text: `${node.name}'s hand-off executor: ${note}`, nodeId: node.id }));
  return warnings;
}

function contractWarnings(node: StorageNode, state: LayeredState, now: number): Warning[] {
  const handoff = state.handoff;
  if (!handoff) return [];
  const warnings = waitingWarnings(node, handoff.waiting, now);
  for (const note of handoff.notes) {
    const twice = /two keeper reports/.test(note);
    warnings.push(warning({ id: `handoff-note:${node.id}:${note}`, level: twice ? "warning" : "info", kind: "handoff-note", text: twice ? `${node.name}: ${note}; two hosts may be running the same node` : `${node.name}: ${note}`, nodeId: node.id }));
  }
  return warnings;
}

/** The round's space decision, made in report mode too: a stop pauses the node only once it acts. */
function spaceWarnings(node: StorageNode, state: LayeredState): Warning[] {
  const space = state.space;
  if (space?.state === "stopped") {
    const outcome = state.mode === "apply" ? "its folders are paused and nothing is handed off until it fits with 10% free" : "once it acts, its folders are paused until it fits";
    return [warning({ id: `space-stopped:${node.id}`, level: state.mode === "apply" ? "warning" : "info", kind: "space-stopped", text: `${node.name} does not fit even at its top priority: it needs ${space.neededBytes} bytes and has ${space.availableBytes}; ${outcome}`, nodeId: node.id })];
  }
  if (space?.state === "raised")
    return [warning({ id: `space-raised:${node.id}`, level: "info", kind: "space-raised", text: `${node.name} is short of space: its threshold is raised from ${state.threshold} to ${space.threshold} until what it keeps fits with 10% free`, nodeId: node.id })];
  if (space?.state === "full")
    return [warning({ id: `space-full:${node.id}`, level: "warning", kind: "space-full", text: `${node.name}, the cluster, does not fit with 10% free: it needs ${space.neededBytes} bytes and has ${space.availableBytes}; it confirms no new hand-off until it does, so files wait on the nodes that hand off to it`, nodeId: node.id })];
  return [];
}

function planWarnings(node: StorageNode, state: LayeredState): Warning[] {
  const warnings: Warning[] = [];
  const blocking = state.problems.filter((problem) => !/is not admitted yet$/.test(problem));
  if (blocking.length) warnings.push(warning({ id: `layout-problem:${node.id}`, level: "warning", kind: "layout-problem", text: `${node.name}: the layout leaves it unplanned: ${blocking.join("; ")}`, nodeId: node.id }));
  if (state.failed) warnings.push(warning({ id: `layout-drift:${node.id}:failed`, level: "warning", kind: "layout-drift", text: `${node.name}: the layered sync round: ${state.failed}`, nodeId: node.id }));
  const held = state.drift.filter((change) => !change.written && change.held);
  for (const change of held)
    warnings.push(warning({ id: `layout-held:${node.id}:${change.folderId}:${change.field}`, level: "info", kind: "layout-held", text: `${node.name}, ${change.label}: ${change.text} is held: ${change.held}`, nodeId: node.id, folderId: change.folderId }));
  const open = state.drift.filter((change) => !change.written && !change.held);
  if (open.length && state.mode === "report")
    warnings.push(warning({ id: `layout-drift:${node.id}`, level: "info", kind: "layout-drift", text: `${node.name} reports ${plural(open.length, "change")} its plan would make; it makes them once apply = true is committed for it`, nodeId: node.id }));
  if (open.length && state.mode === "apply")
    warnings.push(warning({ id: `layout-drift:${node.id}`, level: "warning", kind: "layout-drift", text: `${node.name}: ${plural(open.length, "planned change")} not written yet`, nodeId: node.id }));
  return warnings;
}

/**
 * What the layered sync needs a person for on one of this host's nodes: its plan, its hand-off contract and its executor's last run.
 * @implNote A hand-off folder's one needed item (an ignore line whose file left the node, section 4b) is no entry here: nothing reads a
 * folder's need count, so it never shows as a fault.
 */
export function layeredWarnings(node: StorageNode, now = Date.now()): Warning[] {
  const state = node.layered;
  if (!state) return [];
  return [...planWarnings(node, state), ...spaceWarnings(node, state), ...contractWarnings(node, state, now), ...resultWarnings(node, state)];
}

/** The setup repo's pull or push problem, a commit of this host the others do not have yet among them. */
export function setupWarnings(host: string, pullProblem: string | null): Warning[] {
  if (!pullProblem) return [];
  return [warning({ id: `setup-unpushed:${host}`, level: "warning", kind: "setup-unpushed", text: `the setup repo on ${host}: ${pullProblem}`, nodeId: null })];
}
