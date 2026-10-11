import { readFile, readdir, statfs } from "node:fs/promises";
import { type BlockDevice, wholeDeviceOf } from "./blockDevices.js";
import { arrayPrefix, roleLabelPattern, stateDirectory, storageRoot } from "./settings.js";
import { type SmartSummary, smartSummary } from "./smart.js";

export interface DriveRow {
  role: string;
  label: string;
  mounted: boolean;
  sizeBytes: number | null;
  freeBytes: number | null;
  device: string | null;
  model: string | null;
  serial: string | null;
  smart: SmartSummary | null;
}

async function readLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Mount point to mount source, from the container's own mount table. */
async function mountSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const line of await readLines("/proc/self/mountinfo")) {
    const [before, after] = line.split(" - ");
    const mountPoint = before.split(" ")[4];
    const source = after?.split(" ")[1];
    if (mountPoint && source) sources.set(mountPoint, source);
  }
  return sources;
}

async function knownLabels(): Promise<string[]> {
  const remembered = (await readLines(`${stateDirectory}/snapraid.drives`)).map((path) => path.split("/").pop() ?? "");
  const present = await readdir(storageRoot).catch(() => [] as string[]);
  const labels = new Set([...remembered, ...present].filter((label) => roleLabelPattern.test(label)));
  return [...labels].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

async function capacity(path: string): Promise<{ sizeBytes: number; freeBytes: number } | null> {
  try {
    const stats = await statfs(path);
    return { sizeBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}

async function driveRow(label: string, sources: Map<string, string>, devices: BlockDevice[]): Promise<DriveRow> {
  const path = `${storageRoot}/${label}`;
  const source = sources.get(path) ?? null;
  const wholeDevice = source ? wholeDeviceOf(devices, source) : undefined;
  const space = source ? await capacity(path) : null;
  const smart = wholeDevice?.type === "disk" ? await smartSummary(wholeDevice.path) : null;
  return {
    role: label.slice(arrayPrefix.length + 1),
    label,
    mounted: source !== null,
    sizeBytes: space?.sizeBytes ?? null,
    freeBytes: space?.freeBytes ?? null,
    device: wholeDevice?.path ?? source,
    model: smart?.model ?? wholeDevice?.model?.trim() ?? null,
    serial: smart?.serial ?? wholeDevice?.serial?.trim() ?? null,
    smart,
  };
}

export async function driveRows(devices: BlockDevice[]): Promise<DriveRow[]> {
  const sources = await mountSources();
  return Promise.all((await knownLabels()).map((label) => driveRow(label, sources, devices)));
}
