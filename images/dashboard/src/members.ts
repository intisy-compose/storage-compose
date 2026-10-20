import { readFile } from "node:fs/promises";
import type { ArrayMember, MemberSmart } from "./api/types.js";
import type { ArrayStatus, DriveStatus } from "./arrayStatus.js";
import { type BlockDevice, wholeDeviceOf } from "./blockDevices.js";
import type { MemberDescription } from "./nodeFile.js";
import { inventoryAssetUrl, storageRoot } from "./settings.js";
import { type SmartSummary, smartSummary } from "./smart.js";

/** Mount point to mount source, from the container's own mount table. */
export async function mountSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const table = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  for (const line of table.split("\n").filter(Boolean)) {
    const [before, after] = line.split(" - ");
    const mountPoint = before.split(" ")[4];
    const source = after?.split(" ")[1];
    if (mountPoint && source) sources.set(mountPoint, source);
  }
  return sources;
}

/** Null when either serial is unknown, which is the case for every drive without SMART. */
export function isSerialMismatch(recorded: string | null | undefined, reported: string | null | undefined): boolean | null {
  if (!recorded || !reported) return null;
  return recorded.trim().toUpperCase() !== reported.trim().toUpperCase();
}

export function memberSmart(condition: DriveStatus["condition"], detail: string, summary: SmartSummary | null): MemberSmart | null {
  const counts = {
    reallocatedSectors: summary?.reallocatedSectors ?? null,
    pendingSectors: summary?.pendingSectors ?? null,
    powerOnHours: summary?.powerOnHours ?? null,
  };
  if (condition === "failing") return { state: "fail", detail, ...counts };
  if (!summary) return condition === "present" ? { state: "none", detail: "this drive answers no SMART query", ...counts } : null;
  if (summary.passed === false) return { state: "fail", detail: "SMART health check failed", ...counts };
  const reallocated = summary.reallocatedSectors ?? 0;
  const pending = summary.pendingSectors ?? 0;
  if (reallocated > 0 || pending > 0) return { state: "warn", detail: `${reallocated} reallocated, ${pending} pending (accepted as its baseline)`, ...counts };
  return { state: "ok", detail: "passed", ...counts };
}

export function assetUrl(asset: string | null): string | null {
  return asset && inventoryAssetUrl ? inventoryAssetUrl.replace("{asset}", encodeURIComponent(asset)) : null;
}

function roleOrder(role: string): [number, number] {
  return [role.startsWith("parity") ? 1 : 0, Number(role.replace(/^\D+/, "")) || 0];
}

async function member(
  label: string,
  drive: DriveStatus | undefined,
  description: MemberDescription | undefined,
  sources: Map<string, string>,
  devices: BlockDevice[],
): Promise<ArrayMember> {
  const source = sources.get(`${storageRoot}/${label}`) ?? null;
  const wholeDevice = source ? wholeDeviceOf(devices, source) : undefined;
  const summary = wholeDevice?.type === "disk" ? await smartSummary(wholeDevice) : null;
  const condition = drive?.condition ?? "missing";
  const asset = description?.asset ?? drive?.asset ?? null;
  return {
    role: drive?.role ?? description?.role ?? label.replace(/^[^-]+-/, ""),
    label,
    serial: summary?.serial ?? drive?.serial ?? (description?.serial || null),
    size: drive?.size ?? description?.size ?? null,
    used: drive?.used ?? null,
    asset,
    assetUrl: assetUrl(asset),
    present: condition === "present" || condition === "failing",
    smart: memberSmart(condition, drive?.detail ?? "", summary),
    temperature: summary?.temperatureCelsius ?? null,
    condition,
    detail: drive?.detail ?? (drive ? "" : "named by the array's description, never seen on this host"),
  };
}

export async function arrayMembers(status: ArrayStatus, devices: BlockDevice[], sources: Map<string, string>): Promise<ArrayMember[]> {
  const drives = new Map(status.drives.map((drive) => [drive.label, drive]));
  const described = new Map((status.description?.array?.members ?? []).map((entry) => [entry.label, entry]));
  const labels = [...new Set([...drives.keys(), ...described.keys()])];
  const members = await Promise.all(labels.map((label) => member(label, drives.get(label), described.get(label), sources, devices)));
  return members.sort((left, right) => {
    const [leftKind, leftNumber] = roleOrder(left.role);
    const [rightKind, rightNumber] = roleOrder(right.role);
    return leftKind - rightKind || leftNumber - rightNumber;
  });
}
