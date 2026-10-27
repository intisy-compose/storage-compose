import { deviceDisplayName, shortDeviceId } from "../api/deviceText.js";
import { keeperProblem } from "../api/keeperText.js";
import { generalSettingLabels } from "../api/optionsText.js";
import type { AdvancedConfig, AdvancedTarget } from "../api/types.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, defaultReadBackDelaysMs, localNodeInfos, requireLocal, resolveInstance, settingsKeeperOf, writeConfirmed } from "../instanceResolver.js";
import type { AnyRoute, NothingWritten, WriteNote } from "../routes.js";
import { isChangeInPlace, redactConfig } from "../syncthingConfig.js";
import { advancedChangeProblem, guiManagedText } from "./advancedGuards.js";
import { decodedSegment } from "./devices.js";
import { requiresRestart, restartRoutes } from "./nodeRestart.js";
import { type HostNode, refuseTakenPorts } from "./options.js";

type SyncthingObject = Record<string, unknown>;

function asObject(value: unknown): SyncthingObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as SyncthingObject) : {};
}

/** The part of the configuration a path names: `options`, `folders/<id>` or `devices/<id>`; the GUI is refused, as the stack manages it. */
export function advancedTargetOf(segment: string): AdvancedTarget {
  if (segment === "options") return { kind: "options" };
  if (segment === "gui") throw new RequestError(400, guiManagedText);
  const entry = /^(folders|devices)\/([^/]+)$/.exec(segment);
  if (!entry) throw new RequestError(404, `${segment} is not a part of the configuration the advanced editor shows`);
  const id = decodedSegment(entry[2], entry[1] === "folders" ? "folder ID" : "device ID");
  return entry[1] === "folders" ? { kind: "folder", id } : { kind: "device", id };
}

function syncthingPath(target: AdvancedTarget): string {
  if (target.kind === "options") return "/config/options";
  return `/config/${target.kind === "folder" ? "folders" : "devices"}/${encodeURIComponent(target.id)}`;
}

async function listed(instance: LocalInstance, path: string): Promise<SyncthingObject[]> {
  const answer = await callSyncthing(instance, (client) => client.request<unknown>("GET", path));
  return Array.isArray(answer) ? answer.map(asObject) : [];
}

/** The object as the node's Syncthing has it now, secrets included; a folder or device it does not have is 404. */
async function readObject(instance: LocalInstance, target: AdvancedTarget): Promise<SyncthingObject> {
  if (target.kind === "options") return asObject(await callSyncthing(instance, (client) => client.request<unknown>("GET", "/config/options")));
  if (target.kind === "folder") {
    const folder = (await listed(instance, "/config/folders")).find((entry) => entry.id === target.id);
    if (!folder) throw new RequestError(404, `${instance.name} has no folder ${target.id}`);
    return folder;
  }
  const device = (await listed(instance, "/config/devices")).find((entry) => entry.deviceID === target.id);
  if (!device) throw new RequestError(404, `${instance.name} has no device ${shortDeviceId(target.id)}`);
  return device;
}

/** The object as named in a sentence: `these options`, `folder documents`, `device laptop`. */
function objectWords(target: AdvancedTarget, current: SyncthingObject): string {
  if (target.kind === "options") return "these options";
  if (target.kind === "folder") return `folder ${target.id}`;
  return `device ${deviceDisplayName(typeof current.name === "string" ? current.name : "", target.id)}`;
}

const longestValueText = 80;

function valueText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > longestValueText ? `${text.slice(0, longestValueText - 3)}...` : text;
}

/** What an advanced edit changed, in words: `pc: changed folder documents in the advanced editor; maxConflicts 11`. */
export function advancedEditText(nodeName: string, target: AdvancedTarget, current: SyncthingObject, sent: SyncthingObject): string {
  const what = target.kind === "options" ? "options" : objectWords(target, current);
  return [`${nodeName}: changed ${what} in the advanced editor`, ...Object.entries(sent).map(([key, value]) => `${key} ${valueText(value)}`)].join("; ");
}

function shown(config: SyncthingObject, restartRequired: boolean): AdvancedConfig {
  return { config: asObject(redactConfig(config)), restartRequired };
}

export async function readAdvanced(instance: ResolvedInstance, target: AdvancedTarget): Promise<AdvancedConfig> {
  const local = requireLocal(instance);
  const [config, restartRequired] = await Promise.all([readObject(local, target), requiresRestart(local)]);
  return shown(config, restartRequired);
}

/**
 * The object as it now stands.
 * @implNote The change is already written; a node that stops answering now must not turn it into "not saved", so the answer is then the change
 * laid over the object as read before.
 */
async function stateAfter(instance: LocalInstance, target: AdvancedTarget, expected: SyncthingObject): Promise<AdvancedConfig> {
  try {
    return await readAdvanced(instance, target);
  } catch {
    return shown(expected, false);
  }
}

/**
 * The General form's rules for the node's own device: its name is what other devices show, so it is not emptied, and it is not
 * changed where the node's keeper sets it at each start.
 */
async function ownNameProblem(instance: LocalInstance, target: AdvancedTarget, change: SyncthingObject): Promise<string | null> {
  if (target.kind !== "device" || !Object.hasOwn(change, "name")) return null;
  const kept = keeperProblem(settingsKeeperOf(instance), ["name"], (field) => field, () => "deviceName");
  const emptied = typeof change.name === "string" && !change.name.trim() ? `${generalSettingLabels.deviceName} cannot be empty: other devices show it` : null;
  if (!kept && !emptied) return null;
  const ownId = await callSyncthing(instance, (client) => client.myId());
  return ownId === target.id ? (kept ?? emptied) : null;
}

export interface AdvancedEdit {
  answer: AdvancedConfig;
  note: WriteNote | NothingWritten;
}

/**
 * Sends the keys the person changed in the advanced editor, after the checks of the form each key belongs to; a key already so is not sent.
 * @implNote Syncthing answers an unknown key with 200 and ignores it, so a key the object does not have is refused here rather than lost.
 */
export async function editAdvanced(
  instance: ResolvedInstance,
  target: AdvancedTarget,
  change: unknown,
  hostNodes: () => Promise<HostNode[]>,
  readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs,
): Promise<AdvancedEdit> {
  const local = requireLocal(instance);
  const current = await readObject(local, target);
  const problem = advancedChangeProblem(local, target, current, change, objectWords(target, current)) ?? (await ownNameProblem(local, target, change as SyncthingObject));
  if (problem) throw new RequestError(400, problem);
  const valid = change as SyncthingObject;
  if (target.kind === "options" && Array.isArray(valid.listenAddresses)) await refuseTakenPorts(local, valid.listenAddresses as string[], await hostNodes());
  const pending = Object.fromEntries(Object.entries(valid).filter(([key, value]) => !isChangeInPlace(current, { [key]: value })));
  if (Object.keys(pending).length === 0) return { answer: shown(current, await requiresRestart(local)), note: { nothingWritten: true } };
  await writeConfirmed(
    local,
    (client) => client.request("PATCH", syncthingPath(target), pending),
    async () => isChangeInPlace(await readObject(local, target), pending),
    readBackDelaysMs,
  );
  const note: WriteNote = { nodeId: local.nodeId, nodeName: local.name, folderId: target.kind === "folder" ? target.id : null, text: advancedEditText(local.name, target, current, pending) };
  return { answer: await stateAfter(local, target, { ...current, ...pending }), note };
}

export interface AdvancedConfigSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
  /** Every node of this host, whose listen ports a new listen address may not take. */
  hostNodes(): Promise<HostNode[]>;
  /** The waits between read-backs of an edit whose answer was lost; tests shorten them. */
  readBackDelaysMs?: readonly number[];
}

const liveSources: AdvancedConfigSources = { resolve: (nodeId) => resolveInstance(nodeId), hostNodes: () => localNodeInfos() };

/** The advanced editor of a node's options, folders and devices, and the node's restart. */
export function advancedConfigRoutes(sources: AdvancedConfigSources = liveSources): AnyRoute[] {
  const node = (segment: string) => sources.resolve(decodedSegment(segment, "node ID"));
  const pattern = /^\/api\/nodes\/([^/]+)\/advanced\/(.+)$/;
  return [
    {
      method: "GET",
      pattern,
      handle: async ({ response, params: [nodeId, target] }) => {
        const parsed = advancedTargetOf(target);
        sendJson(response, 200, await readAdvanced(await node(nodeId), parsed));
      },
    },
    {
      method: "PATCH",
      pattern,
      write: async ({ request, response, params: [nodeId, target] }) => {
        const parsed = advancedTargetOf(target);
        const edit = await editAdvanced(await node(nodeId), parsed, await readBody(request), sources.hostNodes, sources.readBackDelaysMs);
        sendJson(response, 200, edit.answer);
        return edit.note;
      },
    },
    ...restartRoutes(node),
  ];
}
