import { deviceSettingLabels } from "../api/deviceText.js";
import { ignoresChangeWords } from "../api/ignorePatterns.js";
import { type DefaultIgnores, type DeviceDefaultKey, type DeviceDefaults, type FolderDefaultKey, type FolderDefaults, type IgnoresChange, type Versioning, deviceDefaultKeys, folderDefaultKeys, folderSettingLabels, folderTypeTexts, pullOrderTexts } from "../api/types.js";
import { versioningWords } from "../api/versioningText.js";
import { folderSettings } from "../folderIndex.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, defaultReadBackDelaysMs, requireLocal, writeConfirmed } from "../instanceResolver.js";
import type { AnyRoute, NothingWritten, WriteNote } from "../routes.js";
import type { SyncthingFolderSettings } from "../syncthing.js";
import { changedFields, deviceChangeProblem, deviceSettings, folderChangeProblem, isChangeInPlace } from "../syncthingConfig.js";
import { arrayAutomationProblem } from "./devices.js";
import { ignoresChangeProblem } from "./folderIgnores.js";

type SyncthingObject = Record<string, unknown>;

function picked<Key extends string, Value extends Record<Key, unknown>>(value: Value, keys: readonly Key[]): Pick<Value, Key> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<Value, Key>;
}

async function syncthingDefaults(instance: LocalInstance, kind: "folder" | "device"): Promise<SyncthingObject> {
  return (await callSyncthing(instance, (client) => client.request<SyncthingObject | null>("GET", `/config/defaults/${kind}`))) ?? {};
}

function folderDefaultsOf(raw: SyncthingObject): FolderDefaults {
  const folder = { ...raw, id: "", label: "", path: "", paused: false, devices: [] } as unknown as SyncthingFolderSettings;
  return picked(folderSettings(folder), folderDefaultKeys);
}

function deviceDefaultsOf(raw: SyncthingObject): DeviceDefaults {
  return picked(deviceSettings(raw), deviceDefaultKeys);
}

export async function readFolderDefaults(instance: LocalInstance): Promise<FolderDefaults> {
  return folderDefaultsOf(await syncthingDefaults(instance, "folder"));
}

export async function readDeviceDefaultSettings(instance: LocalInstance): Promise<DeviceDefaults> {
  return deviceDefaultsOf(await syncthingDefaults(instance, "device"));
}

function isPlainObject(value: unknown): value is SyncthingObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function foreignKey(change: unknown, keys: readonly string[]): string | null {
  return isPlainObject(change) ? (Object.keys(change).find((key) => !keys.includes(key)) ?? null) : null;
}

/** Why the folder defaults change cannot be sent, or null; each value is judged as a folder edit judges it. */
export function folderDefaultsProblem(change: unknown): string | null {
  const foreign = foreignKey(change, folderDefaultKeys);
  return foreign ? `${foreign} is not a new folder default` : folderChangeProblem(change);
}

/** Why the device defaults change cannot be sent to this node, or null; on an array no new device starts as an introducer or accepting folders. */
export function deviceDefaultsProblem(instance: LocalInstance, change: unknown): string | null {
  const foreign = foreignKey(change, deviceDefaultKeys);
  if (foreign) return `${foreign} is not a new device default`;
  return deviceChangeProblem(change) ?? arrayAutomationProblem(instance, change as DeviceDefaults);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function defaultValueWords(key: FolderDefaultKey | DeviceDefaultKey, value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (key === "versioning") return versioningWords(value as Versioning);
  if (key === "type") return folderTypeTexts[value as FolderDefaults["type"]];
  if (key === "order") return pullOrderTexts[value as FolderDefaults["order"]];
  if (key === "minDiskFree") return `${(value as FolderDefaults["minDiskFree"]).value} ${(value as FolderDefaults["minDiskFree"]).unit}`;
  if (key === "rescanIntervalS" || key === "fsWatcherDelayS") return `${value} s`;
  if (key === "maxSendKbps" || key === "maxRecvKbps") return value === 0 ? "unlimited" : `${value} KiB/s`;
  return String(value);
}

function defaultsEditText(nodeName: string, kind: "folder" | "device", change: object): string {
  const labels: Record<string, string> = kind === "folder" ? folderSettingLabels : deviceSettingLabels;
  const words = Object.entries(change).map(([key, value]) => `${lowerFirst(labels[key])} ${defaultValueWords(key as FolderDefaultKey, value)}`);
  return [`${nodeName}: changed the new ${kind} defaults`, ...words].join("; ");
}

export interface DefaultsEdit<Defaults> {
  defaults: Defaults;
  note: WriteNote | NothingWritten;
}

interface DefaultsKind<Defaults extends object> {
  kind: "folder" | "device";
  of(raw: SyncthingObject): Defaults;
  problem(instance: LocalInstance, change: unknown): string | null;
}

const folderKind: DefaultsKind<FolderDefaults> = { kind: "folder", of: folderDefaultsOf, problem: (_instance, change) => folderDefaultsProblem(change) };
const deviceKind: DefaultsKind<DeviceDefaults> = { kind: "device", of: deviceDefaultsOf, problem: deviceDefaultsProblem };

/**
 * Sends the defaults the person changed, and only those the node does not have yet.
 * @implNote Compared in our shape, as Syncthing's versioning carries an `fsType` the change never names.
 */
async function editDefaults<Defaults extends object>(instance: ResolvedInstance, kind: DefaultsKind<Defaults>, change: unknown, readBackDelaysMs: readonly number[]): Promise<DefaultsEdit<Defaults>> {
  const local = requireLocal(instance);
  const problem = kind.problem(local, change);
  if (problem) throw new RequestError(400, problem);
  const read = async () => kind.of(await syncthingDefaults(local, kind.kind));
  const current = await read();
  const pending = changedFields(current, { ...current, ...(change as Partial<Defaults>) });
  if (Object.keys(pending).length === 0) return { defaults: current, note: { nothingWritten: true } };
  await writeConfirmed(
    local,
    (client) => client.request("PATCH", `/config/defaults/${kind.kind}`, pending),
    async () => isChangeInPlace(await read(), pending),
    readBackDelaysMs,
  );
  return { defaults: await read(), note: { nodeId: local.nodeId, nodeName: local.name, folderId: null, text: defaultsEditText(local.name, kind.kind, pending) } };
}

async function syncthingDefaultIgnores(instance: LocalInstance): Promise<string[]> {
  const answer = await callSyncthing(instance, (client) => client.request<{ lines?: string[] | null } | null>("GET", "/config/defaults/ignores"));
  return answer?.lines ?? [];
}

function isSameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/**
 * Replaces the ignore patterns new folders start with, only while the node's are still the ones the form opened with.
 * @implNote Syncthing takes them only whole (`PUT`; its `PATCH` is 405), so a difference from `opened` is a 409 and nothing is written.
 */
export async function saveDefaultIgnores(instance: ResolvedInstance, body: unknown, readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs): Promise<DefaultsEdit<DefaultIgnores>> {
  const local = requireLocal(instance);
  const problem = ignoresChangeProblem(body);
  if (problem) throw new RequestError(400, problem);
  const { lines, opened } = body as IgnoresChange;
  const before = await syncthingDefaultIgnores(local);
  if (!isSameLines(before, opened)) throw new RequestError(409, "the new folder ignore patterns changed on the node since the form opened; nothing was written");
  if (isSameLines(before, lines)) return { defaults: { lines: before }, note: { nothingWritten: true } };
  await writeConfirmed(
    local,
    (client) => client.request("PUT", "/config/defaults/ignores", { lines }),
    async () => isSameLines(await syncthingDefaultIgnores(local), lines),
    readBackDelaysMs,
  );
  const text = [`${local.name}: changed the new folder ignore patterns`, ...ignoresChangeWords(before, lines)].join("; ");
  return { defaults: { lines: await syncthingDefaultIgnores(local) }, note: { nodeId: local.nodeId, nodeName: local.name, folderId: null, text } };
}

/** The routes of a node's defaults; `node` resolves the node ID segment of the path. */
export function nodeDefaultRoutes(node: (segment: string) => Promise<ResolvedInstance>, readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs): AnyRoute[] {
  const local = async (segment: string) => requireLocal(await node(segment));
  return [
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/defaults\/folder$/,
      handle: async ({ response, params: [nodeId] }) => sendJson(response, 200, await readFolderDefaults(await local(nodeId))),
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/defaults\/device$/,
      handle: async ({ response, params: [nodeId] }) => sendJson(response, 200, await readDeviceDefaultSettings(await local(nodeId))),
    },
    {
      method: "GET",
      pattern: /^\/api\/nodes\/([^/]+)\/defaults\/ignores$/,
      handle: async ({ response, params: [nodeId] }) => sendJson(response, 200, { lines: await syncthingDefaultIgnores(await local(nodeId)) } satisfies DefaultIgnores),
    },
    {
      method: "PATCH",
      pattern: /^\/api\/nodes\/([^/]+)\/defaults\/folder$/,
      write: async ({ request, response, params: [nodeId] }) => {
        const edit = await editDefaults(await node(nodeId), folderKind, await readBody(request), readBackDelaysMs);
        sendJson(response, 200, edit.defaults);
        return edit.note;
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/nodes\/([^/]+)\/defaults\/device$/,
      write: async ({ request, response, params: [nodeId] }) => {
        const edit = await editDefaults(await node(nodeId), deviceKind, await readBody(request), readBackDelaysMs);
        sendJson(response, 200, edit.defaults);
        return edit.note;
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/nodes\/([^/]+)\/defaults\/ignores$/,
      write: async ({ request, response, params: [nodeId] }) => {
        const edit = await saveDefaultIgnores(await node(nodeId), await readBody(request), readBackDelaysMs);
        sendJson(response, 200, edit.defaults);
        return edit.note;
      },
    },
  ];
}
