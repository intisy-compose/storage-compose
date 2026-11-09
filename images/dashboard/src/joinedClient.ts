import { type IndexEntry } from "./handoffFeed.js";
import type { SpaceDecision } from "./spacePlan.js";
import { SyncthingClient, SyncthingRefusal, type SyncthingFolderSettings } from "./syncthing.js";

export type { SpaceDecision };

/** A folder of a joined device as its own Syncthing has it. */
export interface JoinedFolderReport {
  id: string;
  path: string;
  type: string;
  label?: string;
  paused: boolean;
  devices: string[];
  versioning?: SyncthingFolderSettings["versioning"];
  /** The raw lines of its `.stignore`; null when the device could not read them. */
  ignores: string[] | null;
  /** `/rest/db/status` as the device read it; null while it could not. */
  status: Record<string, unknown> | null;
}

/** One file's own index entry, sent for send-only folders, which are the only ones that can hand off. */
export interface JoinedFileRecord {
  folderId: string;
  path: string;
  modified: string;
  entry: IndexEntry;
}

/** A change the device makes to its own Syncthing, in the order listed. */
export type JoinedOp =
  | { op: "type"; folderId: string; type: string }
  | { op: "paused"; folderId: string; paused: boolean }
  | { op: "versioning"; folderId: string; versioning: Record<string, unknown> }
  | { op: "devices"; folderId: string; devices: string[] }
  | { op: "ignores"; folderId: string; lines: string[] }
  | { op: "ensureList"; folderId: string }
  | { op: "addDevice"; deviceId: string; name: string }
  | { op: "addFolder"; id: string; label: string; path: string; type: string; devices: string[]; versioning: null; ignores: string[] };

export interface ReportedDevice {
  deviceId: string;
  knownDevices: string[];
  folders: JoinedFolderReport[];
  files: JoinedFileRecord[];
}

function refusal(path: string, status = 404): SyncthingRefusal {
  return new SyncthingRefusal(`GET ${path}`, status, "no such entry in the device's report");
}

function queryOf(path: string): URLSearchParams {
  return new URL(`http://report${path}`).searchParams;
}

/**
 * Stands in for a joined device's Syncthing: reads answer from the device's report, and writes are recorded as ops for the device to make
 * itself, each reflected in the answers that follow.
 * @implNote The reconciler, the space decision and the hand-off decision then run the same code for a device the dashboard cannot reach as
 * for one it can, so a joined device's held changes, order of writes and safety checks are the very ones a local node gets.
 */
export class ReportClient extends SyncthingClient {
  readonly ops: JoinedOp[] = [];
  private readonly settings = new Map<string, SyncthingFolderSettings>();
  private readonly ignoreLines = new Map<string, string[]>();

  constructor(private readonly report: ReportedDevice) {
    super({ url: "http://joined-report", apiKey: "" });
    for (const folder of report.folders) {
      this.settings.set(folder.id, { id: folder.id, label: folder.label ?? folder.id, path: folder.path, type: folder.type, paused: folder.paused, devices: folder.devices.map((deviceID) => ({ deviceID })), versioning: folder.versioning } as unknown as SyncthingFolderSettings);
      this.ignoreLines.set(folder.id, folder.ignores ?? []);
    }
  }

  /** The hand-off list, created by the device in its place in the order of writes. */
  ensureList(folderId: string): string | null {
    this.ops.push({ op: "ensureList", folderId });
    return null;
  }

  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (method === "GET" ? this.read(path) : this.write(path, body)) as T;
  }

  private read(path: string): unknown {
    if (path === "/system/status") return { myID: this.report.deviceId };
    if (path === "/config/folders") return [...this.settings.values()];
    if (path === "/config/devices") return this.report.knownDevices.map((deviceID) => ({ deviceID }));
    const folder = /^\/config\/folders\/([^/?]+)$/.exec(path);
    if (folder) return this.folderSetting(decodeURIComponent(folder[1]), path);
    const folderId = queryOf(path).get("folder") ?? "";
    if (path.startsWith("/db/ignores")) return { ignore: this.ignoreLines.get(folderId) ?? [] };
    if (path.startsWith("/db/browse")) return this.reportedTree(folderId);
    if (path.startsWith("/db/status")) return this.status(folderId, path);
    if (path.startsWith("/db/file")) return this.reportedFile(folderId, queryOf(path).get("file") ?? "", path);
    throw refusal(path);
  }

  private folderSetting(id: string, path: string): SyncthingFolderSettings {
    const settings = this.settings.get(id);
    if (!settings) throw refusal(path);
    return settings;
  }

  private reportedTree(folderId: string): { name: string; type: string; modTime: string }[] {
    return this.report.files.filter((file) => file.folderId === folderId).map((file) => ({ name: file.path, type: file.entry.type, modTime: file.modified }));
  }

  private status(folderId: string, path: string): Record<string, unknown> {
    const status = this.report.folders.find((folder) => folder.id === folderId)?.status;
    if (!status) throw refusal(path);
    return status;
  }

  private reportedFile(folderId: string, file: string, path: string): { local: IndexEntry } {
    const record = this.report.files.find((candidate) => candidate.folderId === folderId && candidate.path === file);
    if (!record) throw refusal(path);
    return { local: record.entry };
  }

  private write(path: string, body: unknown): unknown {
    const folder = /^\/config\/folders\/([^/?]+)$/.exec(path);
    if (folder) return this.patch(decodeURIComponent(folder[1]), body as Record<string, unknown>, path);
    if (path.startsWith("/db/ignores")) {
      const folderId = queryOf(path).get("folder") ?? "";
      const lines = (body as { ignore: string[] }).ignore;
      this.ignoreLines.set(folderId, [...lines]);
      this.ops.push({ op: "ignores", folderId, lines: [...lines] });
      return { ignore: lines };
    }
    throw refusal(path, 400);
  }

  private patch(folderId: string, body: Record<string, unknown>, path: string): SyncthingFolderSettings {
    const current = this.folderSetting(folderId, path);
    this.settings.set(folderId, { ...current, ...body } as SyncthingFolderSettings);
    if ("type" in body) this.ops.push({ op: "type", folderId, type: String(body.type) });
    if ("paused" in body) this.ops.push({ op: "paused", folderId, paused: body.paused === true });
    if ("versioning" in body) this.ops.push({ op: "versioning", folderId, versioning: body.versioning as Record<string, unknown> });
    if ("devices" in body) this.ops.push({ op: "devices", folderId, devices: (body.devices as { deviceID: string }[]).map((device) => device.deviceID) });
    return this.settings.get(folderId) as SyncthingFolderSettings;
  }
}
