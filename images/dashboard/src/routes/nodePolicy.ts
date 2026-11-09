import type { NodePolicyApplyBody, NodePolicyPreview } from "../api/types.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, requireLocal, resolveInstance } from "../instanceResolver.js";
import { type NodePolicyChange, checkedLayout, editNodePolicy, editablePath, layoutVersion, validPriority } from "../layoutEdit.js";
import { planChanges } from "../layoutPreview.js";
import { keepsFolder, nodePlan } from "../nodePlan.js";
import { carriedLayoutPaths } from "../reconcileNode.js";
import type { AnyRoute, WriteNote } from "../routeTypes.js";
import { type LayeredPauses, fileLayeredPauses } from "../layeredPauses.js";
import { layeredPausesFile, setupRepoDirectory } from "../settings.js";
import { type LayoutNode, type SetupLayout, blockedNodeIds, parseLayout, saveLayout } from "../setupRepo.js";
import { decodedSegment } from "./devices.js";
import { layoutTextOf, pullAfterConflict, requireBase } from "./priorities.js";

export interface NodePolicySources {
  repository: string;
  resolve(nodeId: string): Promise<ResolvedInstance>;
  /** The folder IDs the node's Syncthing has. */
  configured(instance: LocalInstance): Promise<Set<string>>;
  /** What the node holds of a folder, as its Syncthing counts it. */
  localSize(instance: LocalInstance, folderId: string): Promise<{ files: number; bytes: number }>;
  /** The folders the layered sync paused, which a person may resume by hand. */
  pauses?: LayeredPauses;
}

/**
 * The node behind a policy edit: one of this host's, listed in the layout.
 * @implNote Another host's node is 409, since the preview and the apply confirmation rest on reads of the node's own Syncthing, which only its host makes.
 */
async function policyTarget(sources: NodePolicySources, nodeSegment: string): Promise<{ instance: LocalInstance; text: string; node: LayoutNode }> {
  const instance = requireLocal(await sources.resolve(decodedSegment(nodeSegment, "node ID")));
  const text = await layoutTextOf(sources.repository);
  const node = parseLayout(text).nodes.find((entry) => entry.id === instance.nodeId);
  if (!node) throw new RequestError(404, `the layout does not list ${instance.name}; admit it in Requests first`);
  return { instance, text, node };
}

/**
 * The node behind a change of `enabled` alone, on any host: the layout lists it, wherever it runs.
 * @implNote Stopping and rejoining read no Syncthing: the node's own host pauses or resumes it on its next round once the commit is pushed.
 */
async function enabledTarget(sources: NodePolicySources, nodeSegment: string): Promise<{ instance: { nodeId: string; name: string }; text: string; node: LayoutNode }> {
  const nodeId = decodedSegment(nodeSegment, "node ID");
  const text = await layoutTextOf(sources.repository);
  const node = parseLayout(text).nodes.find((entry) => entry.id === nodeId);
  if (!node) throw new RequestError(404, `the layout does not list node ${nodeId}; admit it in Requests first`);
  return { instance: { nodeId: node.id, name: node.name }, text, node };
}

/** Whether the change is `enabled` and nothing else, which any host may commit for any node. */
export function isEnabledOnly(change: NodePolicyChange): boolean {
  return Object.keys(change).length === 1 && change.enabled !== undefined;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RequestError(400, "the body is not an object");
  return body as Record<string, unknown>;
}

function validPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new RequestError(400, "assigned must be a list of paths");
  return [...new Set((value as string[]).map(editablePath))];
}

function validPins(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RequestError(400, "pins must map paths to priorities");
  return Object.fromEntries(Object.entries(value).map(([path, priority]) => [editablePath(path), validPriority(priority, `the pin of ${path}`)]));
}

/** The policy fields of a body, `apply` refused: it is turned on alone, with the node's name typed. */
export function policyChange(body: unknown): NodePolicyChange {
  const fields = asObject(body);
  if ("apply" in fields) throw new RequestError(400, "apply is turned on or off on its own, with the node's name typed to turn it on");
  const change: NodePolicyChange = {};
  if (fields.threshold !== undefined) change.threshold = validPriority(fields.threshold, "the threshold");
  if (fields.assigned !== undefined) change.assigned = validPaths(fields.assigned);
  if (fields.pins !== undefined) change.pins = validPins(fields.pins);
  if (fields.enabled !== undefined) {
    if (typeof fields.enabled !== "boolean") throw new RequestError(400, "enabled must be true or false");
    change.enabled = fields.enabled;
  }
  if (!Object.keys(change).length) throw new RequestError(400, "the body changes nothing of the node's policy");
  return change;
}

function changeText(before: LayoutNode, change: NodePolicyChange): string {
  const parts: string[] = [];
  if (change.threshold !== undefined && change.threshold !== before.threshold) parts.push(`threshold ${before.threshold} to ${change.threshold}`);
  if (change.assigned) parts.push(change.assigned.length ? `assigned ${change.assigned.join(", ")}` : "nothing assigned");
  if (change.pins) parts.push(Object.keys(change.pins).length ? `pins ${Object.entries(change.pins).map(([path, value]) => `${path} at ${value}`).join(", ")}` : "no pins");
  if (change.enabled !== undefined && change.enabled !== before.enabled) parts.push(change.enabled ? "enabled" : "disabled");
  return parts.join("; ") || "unchanged";
}

function readsBackPolicy(nodeId: string, change: NodePolicyChange) {
  return (layout: SetupLayout) => {
    const node = layout.nodes.find((entry) => entry.id === nodeId);
    if (!node) return false;
    return (
      (change.threshold === undefined || node.threshold === change.threshold) &&
      (change.assigned === undefined || JSON.stringify(node.assigned) === JSON.stringify(change.assigned)) &&
      (change.pins === undefined || JSON.stringify(Object.entries(node.pins).sort()) === JSON.stringify(Object.entries(change.pins).sort())) &&
      (change.enabled === undefined || node.enabled === change.enabled) &&
      (change.apply === undefined || node.apply === change.apply)
    );
  };
}

async function saveChange(sources: NodePolicySources, target: { instance: { nodeId: string; name: string }; node: LayoutNode }, change: NodePolicyChange, base: string, words: string): Promise<{ saved: Awaited<ReturnType<typeof saveLayout>>; note: WriteNote }> {
  const edit = (text: string) => checkedLayout(editNodePolicy(text, target.node.id, change), readsBackPolicy(target.node.id, change), `${target.node.name}'s policy`);
  const saved = await pullAfterConflict(sources.repository, saveLayout(edit, `feat(layout): ${words} for ${target.node.name}`, base, layoutVersion, sources.repository));
  return { saved, note: { nodeId: target.instance.nodeId, nodeName: target.instance.name, folderId: null, text: `${target.instance.name}: layout policy ${words}; ${saved.message}` } };
}

/**
 * What a new threshold would change on the node: the folders that turn send-only and hand off what it holds there, with their size and keepers.
 * @implNote Made from the node's own Syncthing and the layout with the new threshold, the way the next round would plan it; a folder no keeper
 * keeps is named apart, since nothing of it leaves the node.
 */
export async function previewThreshold(sources: NodePolicySources, instance: LocalInstance, text: string, threshold: number): Promise<NodePolicyPreview> {
  const before = parseLayout(text);
  const after = parseLayout(editNodePolicy(text, instance.nodeId, { threshold }));
  const configured = await sources.configured(instance);
  const carried = carriedLayoutPaths(before, instance.nodeId, configured);
  const handingBefore = new Set((nodePlan(before, instance.nodeId, carried)?.folders ?? []).filter((folder) => folder.handsOff).map((folder) => folder.id));
  const newlyHanding = (nodePlan(after, instance.nodeId, carried)?.folders ?? []).filter((folder) => folder.handsOff && !handingBefore.has(folder.id));
  const blocked = blockedNodeIds(after);
  const handoffs = [];
  for (const folder of newlyHanding) {
    const keepers = after.nodes.filter((node) => node.id !== instance.nodeId && !blocked.has(node.id) && node.enabled && keepsFolder(after, node.id, folder.id)).map((node) => node.name);
    const size = configured.has(folder.id) ? await sources.localSize(instance, folder.id) : { files: 0, bytes: 0 };
    handoffs.push({ folderId: folder.id, label: folder.label, files: size.files, bytes: size.bytes, keepers });
  }
  const kept = handoffs.filter((entry) => entry.keepers.length);
  const changes = planChanges(before, after, (nodeId) => (nodeId === instance.nodeId ? configured : new Set())).find((entry) => entry.nodeId === instance.nodeId)?.changes ?? [];
  return {
    nodeId: instance.nodeId,
    threshold,
    handoffs,
    files: kept.reduce((total, entry) => total + entry.files, 0),
    bytes: kept.reduce((total, entry) => total + entry.bytes, 0),
    changes,
  };
}

function applyBody(body: unknown): NodePolicyApplyBody {
  const fields = asObject(body);
  if (typeof fields.apply !== "boolean") throw new RequestError(400, "apply must be true or false");
  const others = Object.keys(fields).filter((key) => !["apply", "confirm", "base"].includes(key));
  if (others.length) throw new RequestError(400, `apply is turned on or off on its own, not with ${others.join(", ")}`);
  return fields as unknown as NodePolicyApplyBody;
}

/**
 * Turning `apply` on is the one switch that lets a node act on its plan, so it takes the node's name typed exactly, one node per request.
 * @implNote Only an admitted node the layout does not block may act; turning it off needs no name, since it only stops the node writing.
 */
function requireApplyConfirmation(node: LayoutNode, layout: SetupLayout, body: NodePolicyApplyBody): void {
  if (!body.apply) return;
  if (!node.admitted) throw new RequestError(409, `${node.name} is not admitted, so it cannot act on a plan`);
  if (blockedNodeIds(layout).has(node.id)) throw new RequestError(409, `the layout blocks ${node.name}: ${layout.problems.filter((problem) => problem.nodeId === node.id).map((problem) => problem.text).join("; ")}`);
  if (body.confirm !== node.name) throw new RequestError(400, `type the node's name ${node.name} to let it act on its plan`);
}

/**
 * Resumes every folder the layered sync's record names for the node, with its name typed, and forgets each; a folder no longer paused is
 * only forgotten.
 * @implNote The way out for a node that no round resumes any more (it stopped acting on its plan, or the layout blocks or no longer
 * admits it). A node still stopped by its plan is paused again by its next round, which the answer says.
 */
export async function resumeRecordedPauses(sources: NodePolicySources, instance: LocalInstance, confirm: unknown): Promise<{ resumed: string[]; forgotten: string[] }> {
  if (confirm !== instance.name) throw new RequestError(400, `type the node's name ${instance.name} to resume its folders`);
  const pauses = sources.pauses;
  if (!pauses) throw new RequestError(503, "this host keeps no record of the folders it pauses");
  const marks = await pauses.of(instance.nodeId).catch((error) => {
    throw new RequestError(409, `the record of layered pauses cannot be read, so nothing is resumed: ${(error as Error).message}`);
  });
  const resumed: string[] = [];
  const forgotten: string[] = [];
  for (const folderId of marks.keys()) {
    const settings = await callSyncthing(instance, (client) => client.folderSettings(folderId)).catch(() => null);
    if (settings?.paused === true) {
      await callSyncthing(instance, (client) => client.request("PATCH", `/config/folders/${encodeURIComponent(folderId)}`, { paused: false }));
      resumed.push(folderId);
    } else forgotten.push(folderId);
    await pauses.unmark(instance.nodeId, folderId);
  }
  return { resumed, forgotten };
}

const liveSources: NodePolicySources = {
  repository: setupRepoDirectory,
  pauses: fileLayeredPauses(layeredPausesFile),
  resolve: (nodeId) => resolveInstance(nodeId),
  configured: async (instance) => new Set((await callSyncthing(instance, (client) => client.folders())).map((folder) => folder.id)),
  localSize: async (instance, folderId) => {
    const status = await callSyncthing(instance, (client) => client.request<{ localFiles?: number; localBytes?: number }>("GET", `/db/status?folder=${encodeURIComponent(folderId)}`));
    return { files: status.localFiles ?? 0, bytes: status.localBytes ?? 0 };
  },
};

/**
 * A node's layered policy in the layout, edited from its node detail: threshold, assigned, pins and enabled on its own host, apply on its
 * own; `enabled` alone, which stops a node or lets it rejoin, from any host.
 */
export function nodePolicyRoutes(sources: NodePolicySources = liveSources): AnyRoute[] {
  return [
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/policy\/preview$/,
      handle: async ({ response, url, params: [nodeSegment] }) => {
        const target = await policyTarget(sources, nodeSegment);
        const threshold = validPriority(Number(url.searchParams.get("threshold") ?? Number.NaN), "the threshold");
        sendJson(response, 200, await previewThreshold(sources, target.instance, target.text, threshold));
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/nodes\/([^/]+)\/policy$/,
      write: async ({ request, response, params: [nodeSegment] }) => {
        const body = await readBody(request);
        const change = policyChange(body);
        const base = requireBase(body as { base?: unknown });
        const target = isEnabledOnly(change) ? await enabledTarget(sources, nodeSegment) : await policyTarget(sources, nodeSegment);
        const { saved, note } = await saveChange(sources, target, change, base, changeText(target.node, change));
        sendJson(response, 200, { saved });
        return saved.committed ? note : { nothingWritten: true };
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/nodes\/([^/]+)\/layered\/resume$/,
      write: async ({ request, response, params: [nodeSegment] }) => {
        const body = asObject(await readBody(request));
        const instance = requireLocal(await sources.resolve(decodedSegment(nodeSegment, "node ID")));
        const answer = await resumeRecordedPauses(sources, instance, body.confirm);
        sendJson(response, 200, answer);
        const count = answer.resumed.length;
        return count ? { nodeId: instance.nodeId, nodeName: instance.name, folderId: null, text: `${instance.name}: resumed ${count} ${count === 1 ? "folder" : "folders"} the layered sync had paused, by hand` } : { nothingWritten: true };
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/nodes\/([^/]+)\/policy\/apply$/,
      write: async ({ request, response, params: [nodeSegment] }) => {
        const body = applyBody(await readBody(request));
        const base = requireBase(body);
        const target = await policyTarget(sources, nodeSegment);
        requireApplyConfirmation(target.node, parseLayout(target.text), body);
        const words = body.apply ? "turn apply on" : "turn apply off";
        const { saved, note } = await saveChange(sources, target, { apply: body.apply }, base, words);
        sendJson(response, 200, { saved });
        return saved.committed ? note : { nothingWritten: true };
      },
    },
  ];
}
