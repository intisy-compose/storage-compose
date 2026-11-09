/** A made-up setup repo layout, edited in memory by the priority, node policy, band and admission writes; every save answers "pushed". */

const hour = 3_600_000;

function ago(milliseconds) {
  return new Date(Date.now() - milliseconds).toISOString();
}

let revision = 1;
const layout = {
  folders: [
    { path: "Archive", id: "archive", priority: 30 },
    { path: "Documents", id: "documents", priority: 80 },
    { path: "Documents/Virtual Machines", id: "documents-virtual-machines", priority: 0 },
    { path: "Pictures", id: "pictures", priority: 30 },
  ],
  nodes: [
    { id: "a3f9", name: "private-array", device: "array", threshold: 0, assigned: [], pins: {}, access: "open", admitted: true, apply: false, enabled: true, refused: null },
    { id: "e5d0", name: "ventoy-files", device: "ventoy", threshold: 80, assigned: [], pins: { Pictures: 85 }, access: "open", admitted: true, apply: false, enabled: true, refused: null },
    { id: "17aa", name: "finn-pc-disk", device: "pc-disk", threshold: 50, assigned: ["Documents/GitHub"], pins: {}, access: "open", admitted: true, apply: true, enabled: true, refused: null },
  ],
  bands: [{ name: "essential", from: 80 }, { name: "working", from: 50 }, { name: "archive", from: 1 }, { name: "local", from: 0 }],
  bandsFromLayout: false,
};

export function layoutFixture() {
  return { version: `fixture-${revision}`, ...structuredClone(layout), problems: [], pulledAt: ago(60_000), pullProblem: null };
}

function saved(message) {
  revision += 1;
  return { saved: { committed: true, pushed: true, message }, layout: layoutFixture() };
}

function refuse(status, error) {
  return { status, body: { error } };
}

function stale(body) {
  return body.base !== `fixture-${revision}` ? refuse(409, "the layout changed since this page read it; it has been read again, check the change and save again") : null;
}

function folderIdOf(path) {
  return path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** `POST /api/priorities/preview`: a path without an entry is a new folder boundary, which names a change on every admitted node. */
export function priorityPreviewFixture(body) {
  const path = String(body.path ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || ".";
  const existing = layout.folders.find((folder) => folder.path === path);
  const boundary = body.priority === null ? (existing ? "removed" : null) : existing || path === "." ? null : "created";
  const folderId = folderIdOf(path);
  const nodes = boundary === "created" ? layout.nodes.filter((node) => node.admitted).map((node) => ({ nodeId: node.id, nodeName: node.name, changes: [`gains the folder ${path} (${folderId}), send and receive`] })) : [];
  return { path, folderId, boundary, nodes };
}

export function savePriorityFixture(body) {
  const problem = stale(body);
  if (problem) return problem;
  const preview = priorityPreviewFixture(body);
  if (preview.boundary && body.confirm !== preview.folderId) return refuse(409, `${preview.path} makes the folder ${preview.folderId}; confirm with the folder ID`);
  const index = layout.folders.findIndex((folder) => folder.path === preview.path);
  if (body.priority === null) layout.folders.splice(index, 1);
  else if (index >= 0) layout.folders[index].priority = body.priority;
  else layout.folders.push({ path: preview.path, id: preview.folderId, priority: body.priority });
  return { status: 200, body: saved("committed and pushed to the setup repo") };
}

/** `GET /api/nodes/<id>/policy/preview?threshold=`: a raise past 30 hands off Pictures and Archive to the array. */
export function policyPreviewFixture(nodeId, threshold) {
  const node = layout.nodes.find((entry) => entry.id === nodeId);
  if (!node) return null;
  const handoffs = layout.folders.filter((folder) => folder.priority > 0 && folder.priority < threshold && folder.priority >= node.threshold).map((folder) => ({ folderId: folder.id, label: folder.path, files: 1200, bytes: 3.4e9, keepers: ["private-array"] }));
  return { nodeId, threshold, handoffs, files: handoffs.length * 1200, bytes: handoffs.length * 3.4e9, changes: handoffs.map((entry) => `${entry.label} (${entry.folderId}) turns send only`) };
}

export function savePolicyFixture(nodeId, body) {
  const problem = stale(body);
  if (problem) return problem;
  const node = layout.nodes.find((entry) => entry.id === nodeId);
  if (!node) return refuse(404, "the layout does not list this node; admit it in Requests first");
  if ("apply" in body) return refuse(400, "apply is turned on or off on its own, with the node's name typed to turn it on");
  for (const key of ["threshold", "assigned", "pins", "enabled"]) if (body[key] !== undefined) node[key] = body[key];
  return { status: 200, body: saved("committed and pushed to the setup repo") };
}

export function saveApplyFixture(nodeId, body) {
  const problem = stale(body);
  if (problem) return problem;
  const node = layout.nodes.find((entry) => entry.id === nodeId);
  if (!node) return refuse(404, "the layout does not list this node");
  if (body.apply && body.confirm !== node.name) return refuse(400, `type the node's name ${node.name} to let it act on its plan`);
  node.apply = body.apply === true;
  return { status: 200, body: saved("committed and pushed to the setup repo") };
}

export function saveBandsFixture(body) {
  const problem = stale(body);
  if (problem) return problem;
  if (!Array.isArray(body.bands) || !body.bands.some((band) => band.from === 0)) return refuse(400, "one band must start at 0, so every priority has a band");
  layout.bands = [...body.bands].sort((left, right) => right.from - left.from);
  layout.bandsFromLayout = true;
  return { status: 200, body: saved("committed and pushed to the setup repo") };
}

const waiting = [{ nodeId: "b001", name: "stick", source: "registry", host: "finn-pc", threshold: 80, listed: false }];

export function admissionsFixture() {
  return waiting.filter((entry) => !layout.nodes.some((node) => node.id === entry.nodeId));
}

export function saveAdmissionFixture(nodeId, body) {
  const problem = stale(body);
  if (problem) return problem;
  const entry = waiting.find((candidate) => candidate.nodeId === nodeId);
  if (!entry) return refuse(404, `no node ${nodeId} on this host`);
  const accepted = body.answer === "accept";
  if (accepted && !Number.isInteger(body.threshold)) return refuse(400, "an admission names the threshold the node is admitted at");
  layout.nodes.push({ id: nodeId, name: entry.name, device: accepted ? entry.name : "", threshold: accepted ? body.threshold : entry.threshold, assigned: [], pins: {}, access: "open", admitted: accepted, apply: false, enabled: true, refused: accepted ? null : new Date().toISOString() });
  return { status: 200, body: { saved: { committed: true, pushed: true, message: "committed and pushed to the setup repo" } } };
}

/** The layered state of `finn-pc-disk`, which applies its plan: a hand-off of Pictures waiting a day, its executor's last run, a raise for space. */
export function layeredFixture(nodeId) {
  if (nodeId === "17aa")
    return {
      mode: "apply", threshold: 50, effectiveThreshold: 50, drift: [{ folderId: "archive", label: "Archive", field: "type", text: "send only to send and receive", written: false, held: "turning send-receive waits for the space rule" }],
      missing: [], unplanned: [], unknownDevices: [], nodeOnlyIgnores: [], pendingHandoffs: 3, problems: [], failed: null, checkedAt: ago(30_000),
      handoff: {
        writtenAt: ago(30_000), apply: true, entries: 1, waiting: [{ folderId: "pictures", path: "2019/beach.jpg", reason: "keeper-offline", since: ago(30 * hour) }], notes: [],
        space: { state: "raised", threshold: 80, neededBytes: 9e11, availableBytes: 8e11 },
        result: { schema: 1, nodeId: "17aa", contractWrittenAt: ago(60_000), finishedAt: ago(40_000), refused: null, purged: 0, notes: [], trash: [{ trash: "2026-10-20/pictures/old.jpg", folderId: "pictures", path: "old.jpg", reason: "its recorded keeper is not connected" }], results: [{ folderId: "pictures", path: "new.jpg", outcome: "unsynced-at-handed-off-path", reason: "newer than its hand-off" }] },
      },
    };
  if (nodeId === "e5d0")
    return { mode: "report", threshold: 80, effectiveThreshold: 80, drift: [{ folderId: "documents", label: "Documents", field: "ignores", text: "ignores /Virtual Machines", written: false, held: null }], missing: [], unplanned: [], unknownDevices: [], nodeOnlyIgnores: [], pendingHandoffs: null, problems: [], failed: null, checkedAt: ago(30_000), handoff: null };
  return null;
}

/** The Attention entries the layered state above gives, as `layeredWarnings` words them. */
export function layeredWarningsFixture() {
  return [
    { id: "handoff-waiting:17aa:pictures", at: ago(30 * hour), level: "warning", kind: "handoff-waiting", text: "finn-pc-disk: 1 file in Pictures have waited more than 24 hours for a keeper (its keeper is offline); nothing of them leaves the node until one confirms", nodeId: "17aa", folderId: "pictures" },
    { id: "handoff-unsynced:17aa:pictures:new.jpg", at: ago(hour), level: "warning", kind: "handoff-unsynced", text: "finn-pc-disk: new.jpg in Pictures is a new file at a handed-off path; it is on this node only, since the hand-off's ignore line keeps it out of sync; move or rename it to sync it", nodeId: "17aa", folderId: "pictures" },
    { id: "handoff-trash:17aa:2026-10-20/pictures/old.jpg", at: ago(2 * hour), level: "warning", kind: "handoff-trash", text: "finn-pc-disk: the hand-off trash keeps old.jpg of Pictures past its days: its recorded keeper is not connected", nodeId: "17aa", folderId: "pictures" },
    { id: "space-raised:17aa", at: ago(hour), level: "info", kind: "space-raised", text: "finn-pc-disk is short of space: its threshold is raised from 50 to 80 until what it keeps fits with 10% free", nodeId: "17aa", folderId: null },
    { id: "layout-held:17aa:archive:type", at: ago(hour), level: "info", kind: "layout-held", text: "finn-pc-disk, Archive: send only to send and receive is held: turning send-receive waits for the space rule", nodeId: "17aa", folderId: "archive" },
    { id: "layout-drift:e5d0", at: ago(hour), level: "info", kind: "layout-drift", text: "ventoy-files reports 1 change its plan would make; it makes them once apply = true is committed for it", nodeId: "e5d0", folderId: null },
    { id: "setup-unpushed:finn-pc", at: ago(10 * 60_000), level: "warning", kind: "setup-unpushed", text: "the setup repo on finn-pc: this host committed 1a2b3c4 (feat(layout): set the priority of Pictures to 30) but could not push it: offline", nodeId: null, folderId: null },
  ];
}

/** The folder detail's per-node placement of a layout folder, as `folderLayered` gives it. */
export function folderLayeredFixture(folderId) {
  const folder = layout.folders.find((entry) => entry.id === folderId);
  if (!folder) return null;
  return {
    path: folder.path,
    priority: folder.priority,
    nodes: layout.nodes.filter((node) => node.admitted).map((node) => {
      const pin = node.pins[folder.path] ?? null;
      const effective = Math.max(folder.priority, pin ?? 0);
      const isCluster = node.id === "a3f9";
      const kept = isCluster || effective >= node.threshold;
      const why = isCluster ? "keeps everything: it is the cluster" : pin !== null && kept && folder.priority < node.threshold ? `kept both ways: pinned at ${pin}` : kept ? `kept both ways: priority ${folder.priority} is at or above its threshold ${node.threshold}` : `sends only: priority ${folder.priority} is below its threshold ${node.threshold}, so what it holds leaves once a keeper confirms it`;
      return { nodeId: node.id, nodeName: node.name, threshold: node.threshold, type: kept ? "sendreceive" : "sendonly", keptBy: kept ? (pin !== null && folder.priority < node.threshold ? "pin" : "threshold") : null, pinned: pin, why, pending: node.id === "17aa" && !kept ? 1 : null, waiting: node.id === "17aa" && !kept ? 1 : null };
    }),
  };
}

export const handoffCopies = { "17aa": ["pictures"] };

/** How many entries each hand-off copy's list holds. */
export const handoffEntries = { "17aa": { pictures: 1 } };
