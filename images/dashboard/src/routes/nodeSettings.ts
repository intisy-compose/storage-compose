import { generalSettingLabels } from "../api/optionsText.js";
import type { GeneralSettingsChange, NodeOptionsResponse, UsageReportingChoice } from "../api/types.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, defaultReadBackDelaysMs, requireLocal, resolveInstance, writeConfirmed } from "../instanceResolver.js";
import type { AnyRoute, NothingWritten, WriteNote } from "../routes.js";
import { isChangeInPlace, minDiskFreeCheck } from "../syncthingConfig.js";
import { decodedSegment } from "./devices.js";
import { ignoredListRoutes } from "./ignoredLists.js";
import { nodeDefaultRoutes } from "./nodeDefaults.js";
import { nodeOptions } from "./options.js";

type SyncthingObject = Record<string, unknown>;

const usageReportingChoices: readonly UsageReportingChoice[] = ["accepted", "declined"];

type GeneralCheck = (value: unknown, label: string) => string | null;

const generalChecks: Record<keyof GeneralSettingsChange, GeneralCheck> = {
  deviceName: (value, label) => {
    if (typeof value !== "string") return `${label} must be text`;
    return value.trim() ? null : `${label} cannot be empty: other devices show it`;
  },
  minHomeDiskFree: minDiskFreeCheck,
  usageReporting: (value, label) => (usageReportingChoices.includes(value as UsageReportingChoice) ? null : `${label} must be accepted or declined`),
  crashReportingEnabled: (value, label) => (typeof value === "boolean" ? null : `${label} must be on or off`),
};

/** Why a general settings change cannot be sent as it is, or null when it can. */
export function generalChangeProblem(change: unknown): string | null {
  if (typeof change !== "object" || change === null || Array.isArray(change) || Object.keys(change).length === 0) return "nothing to change";
  for (const [key, value] of Object.entries(change)) {
    if (!Object.hasOwn(generalChecks, key)) return `${key} is not a general setting`;
    const field = key as keyof GeneralSettingsChange;
    const problem = generalChecks[field](value, generalSettingLabels[field]);
    if (problem) return problem;
  }
  return null;
}

interface OwnDevice {
  deviceId: string;
  name: string;
}

async function ownDevice(instance: LocalInstance): Promise<OwnDevice> {
  return callSyncthing(instance, async (client) => {
    const [deviceId, devices] = await Promise.all([client.myId(), client.devices()]);
    return { deviceId, name: devices.find((device) => device.deviceID === deviceId)?.name ?? "" };
  });
}

/** Renames the node's own device entry, the name other devices see; null when it already has that name. */
async function renameOwnDevice(instance: LocalInstance, name: string, readBackDelaysMs: readonly number[]): Promise<string | null> {
  const own = await ownDevice(instance);
  if (own.name === name) return null;
  await writeConfirmed(
    instance,
    (client) => client.request("PATCH", `/config/devices/${encodeURIComponent(own.deviceId)}`, { name }),
    async () => (await ownDevice(instance)).name === name,
    readBackDelaysMs,
  );
  return `renamed this node's device from ${own.name || own.deviceId.slice(0, 7)} to ${name}`;
}

async function usageReportVersion(instance: LocalInstance): Promise<number> {
  const status = await callSyncthing(instance, (client) => client.request<SyncthingObject>("GET", "/system/status"));
  const version = status?.urVersionMax;
  if (typeof version !== "number" || version < 1) throw new RequestError(502, `${instance.name}'s Syncthing does not say which usage report version it sends`);
  return version;
}

interface OptionPart {
  options: SyncthingObject;
  words: string;
}

/**
 * Each general option the change names, as the Syncthing options it sets and in words.
 * @implNote Accepting is `urAccepted` and `urSeen` set to the report version this Syncthing sends, as its own GUI does on Accept.
 */
async function optionParts(instance: LocalInstance, change: GeneralSettingsChange): Promise<OptionPart[]> {
  const parts: OptionPart[] = [];
  if (change.minHomeDiskFree) parts.push({ options: { minHomeDiskFree: change.minHomeDiskFree }, words: `keep free ${change.minHomeDiskFree.value} ${change.minHomeDiskFree.unit} on its home disk` });
  if (change.usageReporting === "declined") parts.push({ options: { urAccepted: -1 }, words: "usage reports declined" });
  if (change.usageReporting === "accepted") {
    const version = await usageReportVersion(instance);
    parts.push({ options: { urAccepted: version, urSeen: version }, words: `usage reports accepted (version ${version})` });
  }
  if (change.crashReportingEnabled !== undefined) parts.push({ options: { crashReportingEnabled: change.crashReportingEnabled }, words: `crash reports ${change.crashReportingEnabled ? "on" : "off"}` });
  return parts;
}

async function syncthingOptions(instance: LocalInstance): Promise<SyncthingObject> {
  return (await callSyncthing(instance, (client) => client.request<SyncthingObject | null>("GET", "/config/options"))) ?? {};
}

/** Sends the options of every part the node does not have yet; answers the words of those parts. */
async function writeOptionParts(instance: LocalInstance, parts: OptionPart[], readBackDelaysMs: readonly number[]): Promise<string[]> {
  if (!parts.length) return [];
  const current = await syncthingOptions(instance);
  const pending = parts.filter((part) => !isChangeInPlace(current, part.options));
  if (!pending.length) return [];
  const options = Object.assign({}, ...pending.map((part) => part.options)) as SyncthingObject;
  await writeConfirmed(
    instance,
    (client) => client.request("PATCH", "/config/options", options),
    async () => isChangeInPlace(await syncthingOptions(instance), options),
    readBackDelaysMs,
  );
  return pending.map((part) => part.words);
}

export interface GeneralEdit {
  answer: NodeOptionsResponse;
  note: WriteNote | NothingWritten;
}

/** Sends the general settings the person changed to the node's Syncthing: the name to its own device entry, the rest as options; what is already so is not sent. */
export async function editGeneral(instance: ResolvedInstance, change: unknown, readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs): Promise<GeneralEdit> {
  const local = requireLocal(instance);
  const problem = generalChangeProblem(change);
  if (problem) throw new RequestError(400, problem);
  const valid = change as GeneralSettingsChange;
  const parts = await optionParts(local, valid);
  const renamed = valid.deviceName === undefined ? null : await renameOwnDevice(local, valid.deviceName.trim(), readBackDelaysMs);
  const optionWords = await writeOptionParts(local, parts, readBackDelaysMs);
  const answer = await nodeOptions(local);
  if (!renamed && !optionWords.length) return { answer, note: { nothingWritten: true } };
  const text = [`${local.name}: ${renamed ?? "changed general settings"}`, ...optionWords].join("; ");
  return { answer, note: { nodeId: local.nodeId, nodeName: local.name, folderId: null, text } };
}

export interface NodeSettingsSources {
  resolve(nodeId: string): Promise<ResolvedInstance>;
  /** The waits between read-backs of a write whose answer was lost; tests shorten them. */
  readBackDelaysMs?: readonly number[];
}

const liveSources: NodeSettingsSources = { resolve: (nodeId) => resolveInstance(nodeId) };

/** A node's general settings, its defaults for new folders and devices, and what it ignores. */
export function nodeSettingsRoutes(sources: NodeSettingsSources = liveSources): AnyRoute[] {
  const node = (segment: string) => sources.resolve(decodedSegment(segment, "node ID"));
  return [
    {
      method: "PATCH",
      pattern: /^\/api\/nodes\/([^/]+)\/general$/,
      write: async ({ request, response, params: [nodeId] }) => {
        const edit = await editGeneral(await node(nodeId), await readBody(request), sources.readBackDelaysMs);
        sendJson(response, 200, edit.answer);
        return edit.note;
      },
    },
    ...nodeDefaultRoutes(node, sources.readBackDelaysMs),
    ...ignoredListRoutes(node, sources.readBackDelaysMs),
  ];
}
