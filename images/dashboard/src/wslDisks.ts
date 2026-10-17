import { readFile } from "node:fs/promises";
import { statusDirectory } from "./settings.js";

export interface WslDisk {
  number: number;
  ptuuid: string | null;
  size: number;
  model: string;
  serial: string;
  source: "rule" | "attach";
  smart: unknown;
}

interface WslDisksFile {
  updatedEpoch: number;
  disks: WslDisk[];
}

const staleAfterSeconds = 1800;

/**
 * The disks the Windows host passed through to WSL, with the SMART reports it read for them.
 * @implNote Written by the host's attach watcher at least every 10 minutes while drives are passed
 * through, so an older file is left over from an earlier run.
 */
export async function readWslDisks(): Promise<WslDisk[]> {
  try {
    const file = JSON.parse(await readFile(`${statusDirectory}/wsl-disks.json`, "utf8")) as WslDisksFile;
    if (Date.now() / 1000 - file.updatedEpoch > staleAfterSeconds) return [];
    return file.disks ?? [];
  } catch {
    return [];
  }
}

/**
 * The host's disks a VM disk may be: the one with its GPT id, or else every disk Windows saw blank with
 * its size.
 * @implNote A drive that was blank when it was passed through and then formatted inside the VM (a
 * rebuild target) has a GPT id Windows has not seen, so it is found by its size.
 */
export function matchingWslDisks(disks: WslDisk[], disk: { ptuuid: string | null; size: number }): WslDisk[] {
  const tableId = disk.ptuuid?.toLowerCase();
  const byTable = tableId ? disks.filter((candidate) => candidate.ptuuid === tableId) : [];
  if (byTable.length > 0) return byTable;
  return disks.filter((candidate) => !candidate.ptuuid && candidate.size === disk.size);
}

export function uniqueWslDisk(disks: WslDisk[], disk: { ptuuid: string | null; size: number }): WslDisk | undefined {
  const matches = matchingWslDisks(disks, disk);
  return matches.length === 1 ? matches[0] : undefined;
}
