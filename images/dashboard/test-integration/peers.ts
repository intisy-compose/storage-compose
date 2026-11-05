import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { FolderType } from "../src/api/types.js";

const run = promisify(execFile);
const composeFile = fileURLToPath(new URL("../../../../tests/layered/compose.yml", import.meta.url));
const compose = ["compose", "-f", composeFile];
const folderRoot = "/var/syncthing/folders";
const syncthingUser = "1000:1000";
const defaultTimeoutMs = 60_000;

export type PeerName = "stick" | "keeper" | "other";

export interface Peer {
  name: PeerName;
  container: string;
  url: string;
  apiKey: string;
  deviceId: string;
}

export interface Peers {
  stick: Peer;
  keeper: Peer;
  other: Peer;
}

export interface FolderMember {
  peer: Peer;
  type: FolderType;
  ignoreDelete?: boolean;
}

export interface Completion {
  completion: number;
  globalItems: number;
  needItems: number;
  needDeletes: number;
  remoteState?: string;
}

/** One side of `/rest/db/file`; Syncthing sends more fields, which the spike records as they come. */
export interface IndexEntry {
  name: string;
  size: number;
  deleted: boolean;
  ignored?: boolean;
  invalid?: boolean;
  version: string[];
  blocksHash?: string;
  [field: string]: unknown;
}

export interface FileReport {
  global: IndexEntry;
  local: IndexEntry;
  availability: { id: string }[] | null;
  [field: string]: unknown;
}

const peerPorts: Record<PeerName, number> = { stick: 38401, keeper: 38402, other: 38403 };

/** @implNote Every request goes to one of the three loopback ports of `tests/layered/compose.yml`, never anywhere else. */
function peerFor(name: PeerName): Omit<Peer, "deviceId"> {
  return { name, container: `layered-test-${name}`, url: `http://127.0.0.1:${peerPorts[name]}`, apiKey: `layered-test-${name}-key` };
}

export async function request<T>(peer: Pick<Peer, "url" | "apiKey">, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${peer.url}${path}`, {
    method,
    headers: { "X-API-Key": peer.apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} on ${peer.url}: ${response.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function waitUntil(condition: () => Promise<boolean>, what: string, timeoutMs = defaultTimeoutMs): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${what}${lastError ? ` (last error: ${String(lastError)})` : ""}`);
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function deviceIdOf(peer: Omit<Peer, "deviceId">): Promise<string> {
  let deviceId = "";
  await waitUntil(async () => {
    deviceId = (await request<{ myID: string }>(peer, "GET", "/rest/system/status")).myID;
    return Boolean(deviceId);
  }, `the API of ${peer.name}`);
  return deviceId;
}

/** Discovery, relays and NAT off: the peers find each other only by their addresses on the `layered-test` network. */
async function isolate(peer: Peer): Promise<void> {
  await request(peer, "PATCH", "/rest/config/options", {
    globalAnnounceEnabled: false,
    localAnnounceEnabled: false,
    relaysEnabled: false,
    natEnabled: false,
    urAccepted: -1,
    crashReportingEnabled: false,
    autoUpgradeIntervalH: 0,
  });
}

async function introduce(peer: Peer, remote: Peer): Promise<void> {
  await request(peer, "PUT", `/rest/config/devices/${remote.deviceId}`, {
    deviceID: remote.deviceId,
    name: remote.name,
    addresses: [`tcp://${remote.container}:22000`],
  });
}

export async function connectedDevices(peer: Peer): Promise<string[]> {
  const { connections } = await request<{ connections: Record<string, { connected: boolean }> }>(peer, "GET", "/rest/system/connections");
  return Object.entries(connections).filter(([, connection]) => connection.connected).map(([deviceId]) => deviceId);
}

export async function stopPeers(): Promise<void> {
  await docker([...compose, "down", "-v", "--remove-orphans", "--timeout", "5"]);
}

/** Starts the three peers from nothing (a leftover run is removed first) and connects each to both others. */
export async function startPeers(): Promise<Peers> {
  await stopPeers();
  await docker([...compose, "up", "-d"]);
  const names: PeerName[] = ["stick", "keeper", "other"];
  const started = await Promise.all(names.map(async (name) => {
    const peer = peerFor(name);
    return { ...peer, deviceId: await deviceIdOf(peer) };
  }));
  for (const peer of started) await isolate(peer);
  for (const peer of started) {
    for (const remote of started.filter((candidate) => candidate !== peer)) await introduce(peer, remote);
  }
  for (const peer of started) {
    await waitUntil(async () => (await connectedDevices(peer)).length === started.length - 1, `${peer.name} connected to both others`);
  }
  const [stick, keeper, other] = started;
  return { stick, keeper, other };
}

export function folderPath(folder: string): string {
  return `${folderRoot}/${folder}`;
}

/** Shares one folder among the members; watchers are off and the rescan interval long, so only an explicit scan sees a change. */
export async function shareFolder(folder: string, members: FolderMember[]): Promise<void> {
  const devices = members.map((member) => ({ deviceID: member.peer.deviceId }));
  for (const member of members) {
    await request(member.peer, "PUT", `/rest/config/folders/${folder}`, {
      id: folder,
      label: folder,
      path: folderPath(folder),
      type: member.type,
      devices,
      fsWatcherEnabled: false,
      rescanIntervalS: 3600,
      ignoreDelete: member.ignoreDelete ?? false,
    });
  }
  for (const member of members) {
    await waitUntil(async () => (await folderState(member.peer, folder)) === "idle", `${folder} idle on ${member.peer.name}`);
  }
}

export async function setFolderIgnoreDelete(peer: Peer, folder: string, ignoreDelete: boolean): Promise<void> {
  await request(peer, "PATCH", `/rest/config/folders/${folder}`, { ignoreDelete });
}

export async function folderState(peer: Peer, folder: string): Promise<string> {
  return (await request<{ state: string }>(peer, "GET", `/rest/db/status?folder=${encodeURIComponent(folder)}`)).state;
}

export async function scan(peer: Peer, folder: string): Promise<void> {
  await request(peer, "POST", `/rest/db/scan?folder=${encodeURIComponent(folder)}`);
  await waitUntil(async () => (await folderState(peer, folder)) === "idle", `${folder} scanned on ${peer.name}`);
}

export async function completion(peer: Peer, folder: string, remote?: Peer): Promise<Completion> {
  const device = remote ? `&device=${remote.deviceId}` : "";
  return request<Completion>(peer, "GET", `/rest/db/completion?folder=${encodeURIComponent(folder)}${device}`);
}

export async function fileReport(peer: Peer, folder: string, file: string): Promise<FileReport> {
  return request<FileReport>(peer, "GET", `/rest/db/file?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(file)}`);
}

export async function setIgnores(peer: Peer, folder: string, lines: string[]): Promise<void> {
  await request(peer, "POST", `/rest/db/ignores?folder=${encodeURIComponent(folder)}`, { ignore: lines });
}

async function inPeer(peer: Peer, script: string, ...args: string[]): Promise<string> {
  return docker(["exec", "-u", syncthingUser, peer.container, "sh", "-c", script, "sh", ...args]);
}

export async function writeFile(peer: Peer, folder: string, relative: string, content: string): Promise<void> {
  await inPeer(peer, 'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"', `${folderPath(folder)}/${relative}`, content);
}

export async function appendLine(peer: Peer, folder: string, relative: string, line: string): Promise<void> {
  await inPeer(peer, 'printf "%s\\n" "$2" >> "$1"', `${folderPath(folder)}/${relative}`, line);
}

export async function removeFile(peer: Peer, folder: string, relative: string): Promise<void> {
  await inPeer(peer, 'rm "$1"', `${folderPath(folder)}/${relative}`);
}

export async function readFile(peer: Peer, folder: string, relative: string): Promise<string> {
  return inPeer(peer, 'cat "$1"', `${folderPath(folder)}/${relative}`);
}

export async function fileExists(peer: Peer, folder: string, relative: string): Promise<boolean> {
  return (await inPeer(peer, 'if [ -e "$1" ]; then echo yes; else echo no; fi', `${folderPath(folder)}/${relative}`)).trim() === "yes";
}

export async function pauseDevice(peer: Peer, remote: Peer): Promise<void> {
  await request(peer, "PATCH", `/rest/config/devices/${remote.deviceId}`, { paused: true });
}

export async function resumeDevice(peer: Peer, remote: Peer): Promise<void> {
  await request(peer, "PATCH", `/rest/config/devices/${remote.deviceId}`, { paused: false });
  await waitUntil(async () => (await connectedDevices(peer)).includes(remote.deviceId), `${peer.name} reconnected to ${remote.name}`);
}
