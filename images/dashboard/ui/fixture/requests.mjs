const hour = 3_600_000;
const pcDevice = "PCFIXTU-RE2BBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const officeDevice = "OFFICEP-CFIXTUR-ECCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const arrayDevice = "ARRAYFI-XTUREBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
const diskDevice = "DISKFIX-TUREBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";

function ago(milliseconds) {
  return new Date(Date.now() - milliseconds).toISOString();
}

function offer(nodeId, nodeName, folderId, label, offeredBy, offeredByName, hoursAgo) {
  return { nodeId, nodeName, folderId, label, offeredBy, offeredByName, time: ago(hoursAgo * hour), receiveEncrypted: false };
}

const offers = [
  offer("a3f9", "private-array", "documents", "Documents", pcDevice, "finn-pc", 30),
  offer("17aa", "finn-pc-disk", "projects", "Projects", officeDevice, "office-pc", 5),
  offer("2b90", "p53", "pictures", "Pictures", pcDevice, "finn-pc", 2),
];

/** `GET /api/requests`: one offer to the local array, one to a local drive node, one to another host's node. */
export function requestsFixture() {
  return { devices: [], folders: offers, joins: [], unreadable: [] };
}

const roots = { a3f9: "/mnt/storage/pool", "17aa": "D:\\" };
const ownDevices = { a3f9: arrayDevice, "17aa": diskDevice };

function settings(found, path, type, versioning) {
  return {
    id: found.folderId, label: found.label, path, type, paused: false, rescanIntervalS: 3600, fsWatcherEnabled: true, fsWatcherDelayS: 10,
    ignorePerms: false, order: "random", minDiskFree: { value: 1, unit: "%" }, maxConflicts: 10, syncOwnership: false, syncXattrs: false,
    devices: [{ deviceId: ownDevices[found.nodeId], encrypted: false }, { deviceId: found.offeredBy, encrypted: false }],
    versioning,
  };
}

/** `GET /api/nodes/<nodeId>/pending/folders/<folderId>/defaults`: as `acceptFolderDefaults` answers, the array's rule written out by hand. */
export function acceptDefaultsFixture(nodeId, folderId, offeredBy) {
  const found = offers.find((candidate) => candidate.nodeId === nodeId && candidate.folderId === folderId && candidate.offeredBy === offeredBy);
  if (!found || !roots[nodeId]) return null;
  const isArray = nodeId === "a3f9";
  const root = roots[nodeId];
  const path = isArray ? `${root}/${found.label}` : `${root}${found.label}`;
  const versioning = isArray ? { type: "staggered", params: { maxAge: "31536000" }, cleanupIntervalS: 3600, fsPath: "" } : { type: "", params: {}, cleanupIntervalS: 3600, fsPath: "" };
  return { offer: found, settings: settings(found, path, isArray ? "receiveonly" : "sendreceive", versioning), root, confirmRequired: isArray, placementProblem: null };
}
