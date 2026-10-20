import { runCommand } from "./commands.js";
import { anyArrayLabelPattern, candidateTransports } from "./settings.js";
import { type WslDisk, matchingWslDisks, readWslDisks } from "./wslDisks.js";

export interface BlockDevice {
  name: string;
  path: string;
  type: string;
  tran: string | null;
  size: number;
  model: string | null;
  serial: string | null;
  label: string | null;
  ptuuid: string | null;
  ro: boolean;
  mountpoints: (string | null)[];
  children?: BlockDevice[];
}

export interface ReplacementCandidate {
  path: string;
  size: number;
  model: string;
  serial: string;
  transport: string;
}

/** @implNote A container has no udev database, so lsblk reports no labels; blkid reads them off the disk. */
async function probedLabels(): Promise<Map<string, string>> {
  const result = await runCommand("blkid", ["-c", "/dev/null", "-o", "export"]);
  const labels = new Map<string, string>();
  for (const block of result.stdout.split("\n\n")) {
    const fields = new Map(block.split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    const deviceName = fields.get("DEVNAME");
    const label = fields.get("LABEL");
    if (deviceName && label) labels.set(deviceName, label);
  }
  return labels;
}

function applyLabels(device: BlockDevice, labels: Map<string, string>): BlockDevice {
  return {
    ...device,
    label: labels.get(device.path) ?? device.label,
    children: device.children?.map((child) => applyLabels(child, labels)),
  };
}

/** @implNote Without udev lsblk has no GPT id either, and `blkid -o export` leaves whole disks out; `blkid -p` probes one. */
async function withPartitionTableId(device: BlockDevice): Promise<BlockDevice> {
  if (device.type !== "disk") return device;
  const result = await runCommand("blkid", ["-c", "/dev/null", "-p", "-o", "value", "-s", "PTUUID", device.path]);
  return { ...device, ptuuid: result.stdout.trim() || null };
}

/**
 * @implNote Hyper-V's SCSI disks report no transport, so a disk the human partner passed through with
 * `docker-compose.ps1 attach` is marked "wsl", which CANDIDATE_TRANSPORTS can then offer.
 */
function markAttachedWslDisk(device: BlockDevice, wslDisks: WslDisk[]): BlockDevice {
  if (device.type !== "disk") return device;
  const isAttached = matchingWslDisks(wslDisks, device).some((disk) => disk.source === "attach");
  return isAttached ? { ...device, tran: "wsl" } : device;
}

export async function listBlockDevices(): Promise<BlockDevice[]> {
  const result = await runCommand("lsblk", ["-J", "-b", "-o", "NAME,PATH,TYPE,TRAN,SIZE,MODEL,SERIAL,LABEL,PTUUID,RO,MOUNTPOINTS"]);
  if (result.exitCode !== 0) return [];
  const [labels, wslDisks] = await Promise.all([probedLabels(), readWslDisks()]);
  const devices = (JSON.parse(result.stdout) as { blockdevices: BlockDevice[] }).blockdevices.map((device) => applyLabels(device, labels));
  if (wslDisks.length === 0) return devices;
  return (await Promise.all(devices.map(withPartitionTableId))).map((device) => markAttachedWslDisk(device, wslDisks));
}

function withChildren(device: BlockDevice): BlockDevice[] {
  return [device, ...(device.children ?? []).flatMap(withChildren)];
}

function transportOf(device: BlockDevice): string {
  return device.type === "loop" ? "loop" : (device.tran ?? "");
}

function holdsArrayLabel(device: BlockDevice): boolean {
  return withChildren(device).some((part) => part.label !== null && anyArrayLabelPattern.test(part.label));
}

function isMounted(device: BlockDevice): boolean {
  return withChildren(device).some((part) => part.mountpoints.some((mountpoint) => mountpoint !== null));
}

function isOfferedTransport(device: BlockDevice): boolean {
  const isWholeDevice = device.type === "disk" || device.type === "loop";
  return isWholeDevice && candidateTransports.includes(transportOf(device));
}

export function replacementCandidates(devices: BlockDevice[]): ReplacementCandidate[] {
  return devices
    .filter((device) => isOfferedTransport(device) && device.size > 0 && !device.ro && !holdsArrayLabel(device) && !isMounted(device))
    .map((device) => ({
      path: device.path,
      size: device.size,
      model: device.model?.trim() || "unknown model",
      serial: device.serial?.trim() || "no serial",
      transport: transportOf(device),
    }));
}

export function isReplacementCandidate(devices: BlockDevice[], path: string): boolean {
  return replacementCandidates(devices).some((candidate) => candidate.path === path);
}

export function wholeDeviceOf(devices: BlockDevice[], partitionPath: string): BlockDevice | undefined {
  return devices.find((device) => withChildren(device).some((part) => part.path === partitionPath));
}
