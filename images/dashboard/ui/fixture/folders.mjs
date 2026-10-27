/** The add and edit forms' reads, as `newFolderDefaults` and the folder detail answer them, for the fixture's local nodes. */

const roots = { a3f9: "/mnt/storage/pool", b71c: "/mnt/b71c/pool", e5d0: "E:\\" };

function settings(node, folder) {
  return {
    id: folder.id, label: folder.label || "", path: folder.path, type: folder.type, paused: false, rescanIntervalS: 3600, fsWatcherEnabled: true, fsWatcherDelayS: 10,
    ignorePerms: false, order: "random", minDiskFree: { value: 1, unit: "%" }, maxConflicts: 10, syncOwnership: false, syncXattrs: false,
    devices: [{ deviceId: node.syncthing.deviceId, encrypted: false }, ...folder.sharedWith.map((peer) => ({ deviceId: peer.deviceId, encrypted: false }))],
    versioning: { type: "", params: {}, cleanupIntervalS: 3600, fsPath: "" },
  };
}

/** `GET /api/nodes/<nodeId>/folder-defaults?under=`: an array asks for the folder ID typed. */
export function folderDefaultsFixture(nodes, nodeId, under) {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  const root = roots[nodeId];
  if (!node?.local || !root) return null;
  const name = under.split("/").filter(Boolean).at(-1) ?? "";
  const separator = root.includes("\\") ? "\\" : "/";
  const path = name ? `${root.replace(/[\\/]+$/, "")}${separator}${under.split("/").filter(Boolean).join(separator)}` : root;
  const id = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "abcde-fghij";
  const folder = { id, label: name, path, type: "sendreceive", sharedWith: [] };
  return { settings: settings(node, folder), ignores: [], root, placementProblem: null, confirmRequired: node.kind === "array" };
}

/** `GET /api/folders/<folderId>`: every copy of the folder, settings only for this host's nodes. */
export function folderDetailFixture(nodes, folderId) {
  const holders = nodes.filter((node) => node.folders.some((folder) => folder.id === folderId));
  if (!holders.length) return null;
  const copies = holders.map((node) => ({ ...node.folders.find((folder) => folder.id === folderId), nodeId: node.id, nodeName: node.name, host: node.host, local: node.local, paused: false }));
  const local = holders.filter((node) => node.local && node.syncthing);
  const detailSettings = Object.fromEntries(local.map((node) => [node.id, settings(node, node.folders.find((folder) => folder.id === folderId))]));
  return { summary: { id: folderId, label: copies[0].label || folderId, priority: null, prioritySource: "none", copies, offers: [] }, settings: detailSettings, treePath: null };
}
