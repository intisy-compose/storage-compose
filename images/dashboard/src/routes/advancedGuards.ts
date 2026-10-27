import { deviceSettingLabels } from "../api/deviceText.js";
import { connectionOptionLabels, generalSettingLabels } from "../api/optionsText.js";
import { type AdvancedTarget, type DeviceSettingsChange, type FolderSettingsChange, type FolderType, folderSettingLabels } from "../api/types.js";
import { type LocalInstance } from "../instanceResolver.js";
import { isInsideRoot } from "../pathGuard.js";
import { deviceChangeProblem, folderChangeProblem, isSecretKey, minDiskFreeCheck, optionsChangeProblem } from "../syncthingConfig.js";
import { arrayAutomationProblem } from "./devices.js";
import { typeChangeProblem } from "./nodeFolders.js";

type SyncthingObject = Record<string, unknown>;

export const guiManagedText = "the GUI is managed by the stack, so it is not changed here";

/** @implNote `address` is the GUI's listen address: none of the objects the editor shows has a key of that name. */
const guiKeys = new Set(["gui", "address"]);

const usageReportKeys = new Set(["urAccepted", "urSeen", "urUniqueId"]);
const reportAddressKeys = new Set(["urURL", "crURL", "releasesURL"]);
const folderFormKeys = new Set(["path", "versioning", "devices"]);

function nestedSecretKey(value: unknown): string | null {
  if (Array.isArray(value)) return value.map(nestedSecretKey).find((key) => key !== null) ?? null;
  if (typeof value !== "object" || value === null) return null;
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) return key;
    const nested = nestedSecretKey(entry);
    if (nested) return nested;
  }
  return null;
}

function kindOf(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (value === null) return "null";
  if (typeof value === "number") return "a number";
  if (typeof value === "string") return "text";
  if (typeof value === "boolean") return "true or false";
  return "an object";
}

/** Why a key cannot be sent at all: the GUI's, a secret, one the object does not have, or a value of another kind than Syncthing's. */
function keyProblem(key: string, value: unknown, current: SyncthingObject, what: string): string | null {
  if (guiKeys.has(key)) return guiManagedText;
  const secret = isSecretKey(key) ? key : nestedSecretKey(value);
  if (secret) return `${secret} is a secret, which the dashboard never reads or sends`;
  if (!Object.hasOwn(current, key)) return `${key} is not a setting of ${what}`;
  const expected = kindOf(current[key]);
  return current[key] === null || kindOf(value) === expected ? null : `${key} must be ${expected}, as Syncthing has it`;
}

function picked(change: SyncthingObject, keys: readonly string[]): SyncthingObject {
  return Object.fromEntries(Object.entries(change).filter(([key]) => keys.includes(key)));
}

function auditFileProblem(instance: LocalInstance, path: string): string | null {
  if (!path) return null;
  if (!instance.root) return `auditFile: ${instance.name} has no root, so no file of it is set here`;
  return isInsideRoot(path, instance.root, instance.os) ? null : `auditFile: ${path} is outside ${instance.name}'s root ${instance.root}`;
}

/**
 * @implNote Usage reporting is consent each Syncthing asks for itself and the General form only sends an answer the person gave;
 * the report and release addresses decide where a node sends what it knows.
 */
function optionKeyProblem(instance: LocalInstance, key: string, value: unknown): string | null {
  if (usageReportKeys.has(key)) return "usage reporting is the person's own answer: give it in General's usage reports";
  if (reportAddressKeys.has(key)) return `${key} stays Syncthing's own: where a node sends reports or looks for releases is not changed here`;
  if (key === "auditFile") return auditFileProblem(instance, value as string);
  if (key === "minHomeDiskFree") return minDiskFreeCheck(value, generalSettingLabels.minHomeDiskFree);
  return null;
}

function optionsProblem(instance: LocalInstance, change: SyncthingObject): string | null {
  for (const [key, value] of Object.entries(change)) {
    const problem = optionKeyProblem(instance, key, value);
    if (problem) return problem;
  }
  const connection = picked(change, Object.keys(connectionOptionLabels));
  return Object.keys(connection).length ? optionsChangeProblem(connection, false) : null;
}

function isPlainName(value: unknown): boolean {
  return typeof value === "string" && value !== "" && value !== "." && value !== ".." && !/[/\\]/.test(value);
}

/** @implNote Path, versioning and sharing carry the root, versions-path and typed-ID guards of the folder's own form, so they are changed only there. */
function folderKeyProblem(key: string, value: unknown): string | null {
  if (key === "id") return "the folder ID cannot be changed";
  if (folderFormKeys.has(key)) return `${key} is changed in the folder's own form, which checks it`;
  if (key === "filesystemType") return `${key} stays as Syncthing set it`;
  if (key === "markerName" && !isPlainName(value)) return "markerName must be a name inside the folder, without / or \\ or ..";
  return null;
}

function folderProblem(current: SyncthingObject, change: SyncthingObject): string | null {
  for (const [key, value] of Object.entries(change)) {
    const problem = folderKeyProblem(key, value);
    if (problem) return problem;
  }
  const settings = picked(change, Object.keys(folderSettingLabels)) as FolderSettingsChange;
  if (!Object.keys(settings).length) return null;
  return folderChangeProblem(settings) ?? typeChangeProblem({ id: String(current.id ?? ""), label: String(current.label ?? ""), type: String(current.type ?? "") as FolderType }, settings);
}

function deviceProblem(instance: LocalInstance, change: SyncthingObject): string | null {
  if (Object.hasOwn(change, "deviceID")) return "the device ID cannot be changed";
  const settings = picked(change, Object.keys(deviceSettingLabels)) as DeviceSettingsChange;
  if (!Object.keys(settings).length) return null;
  return deviceChangeProblem(settings) ?? arrayAutomationProblem(instance, settings);
}

function isPlainObject(value: unknown): value is SyncthingObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Why an advanced change cannot be sent as it is, or null: every key is judged by the same check its form uses, so the editor bypasses no guard.
 * @implNote A listen address is also checked against the ports this host's other nodes list, which needs a read and is done by the caller.
 */
export function advancedChangeProblem(instance: LocalInstance, target: AdvancedTarget, current: SyncthingObject, change: unknown, what: string): string | null {
  if (!isPlainObject(change) || Object.keys(change).length === 0) return "nothing to change";
  for (const [key, value] of Object.entries(change)) {
    const problem = keyProblem(key, value, current, what);
    if (problem) return problem;
  }
  if (target.kind === "options") return optionsProblem(instance, change);
  if (target.kind === "folder") return folderProblem(current, change);
  return deviceProblem(instance, change);
}
