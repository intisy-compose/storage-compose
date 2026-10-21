const hour = 3_600_000;

function ago(milliseconds) {
  return new Date(Date.now() - milliseconds).toISOString();
}

function priority(effective, setHere, inherited, inheritedFrom) {
  const source = setHere !== null ? "setup-repo" : inheritedFrom === null ? "default" : "inherited";
  return { effective, setHere, inherited, inheritedFrom, source, overridesParent: setHere !== null && setHere !== inherited };
}

function state(nodeId, status, detail = null) {
  const names = { a3f9: "private-array", e5d0: "ventoy-files" };
  return { nodeId, nodeName: names[nodeId] ?? nodeId, host: "finn-pc", status, detail };
}

function entry(parent, name, kind, fields) {
  return {
    name,
    path: parent ? `${parent}/${name}` : name,
    kind,
    size: kind === "file" ? (fields.size ?? 4096) : null,
    modified: fields.modified ?? ago(5 * hour),
    folder: fields.folder ?? null,
    priority: fields.priority,
    nodes: [state(fields.nodeId, fields.status, fields.detail)],
    availability: fields.availability ?? [],
  };
}

const topDirectory = (nodeId) => [
  entry("", "Archive", "directory", { nodeId, folder: { id: "archive", label: "Archive" }, priority: priority(30, 30, 0, null), status: "below-threshold", detail: "below threshold 50" }),
  entry("", "Documents", "directory", { nodeId, folder: { id: "documents", label: "Documents" }, priority: priority(80, 80, 0, null), status: "syncing", detail: "12 items outstanding below" }),
  entry("", "Pictures", "directory", { nodeId, folder: { id: "pictures", label: "Pictures" }, priority: priority(80, 80, 0, null), status: "failed", detail: "3 items failed below" }),
  entry("", "Videos", "directory", { nodeId, priority: priority(30, 30, 0, null), status: "missing", detail: "offered, not accepted" }),
];

const documents = (nodeId) => [
  entry("Documents", "GitHub", "directory", { nodeId, folder: { id: "github", label: "GitHub" }, priority: priority(80, 80, 80, "Documents"), status: "in-sync" }),
  entry("Documents", "Recipes", "directory", { nodeId, priority: priority(80, null, 80, "Documents"), status: "syncing", detail: "12 items outstanding below" }),
  entry("Documents", "Taxes", "directory", { nodeId, priority: priority(80, null, 80, "Documents"), status: "missing", detail: "not on this node yet" }),
  entry("Documents", "Virtual Machines", "directory", { nodeId, priority: priority(0, 0, 80, "Documents"), status: "below-threshold", detail: "below threshold 50" }),
  entry("Documents", "notes.txt", "file", { nodeId, priority: priority(80, null, 80, "Documents"), status: "in-sync", size: 2048 }),
];

function secondNodeState(first) {
  if (first.status === "in-sync" || first.status === "below-threshold") return state("e5d0", "in-sync");
  return state("e5d0", "missing", "offered, not accepted");
}

/** Every node's state per entry, as `node=all` answers: a3f9 as listed, e5d0 holding only what a3f9 has in sync, and a laptop no dashboard reports. */
function allNodes(entries) {
  return entries.map((row) => ({ ...row, nodes: [...row.nodes, secondNodeState(row.nodes[0])], availability: [{ deviceId: "LAPAAAA-BBBBBBB", name: "laptop" }] }));
}

/** A made-up `GET /api/tree` answer for the top directory and `Documents`; any other path is empty. */
export function treeFixture(nodeId, path) {
  const listed = nodeId === "all" ? "a3f9" : nodeId;
  const rows = path === "" ? topDirectory(listed) : path === "Documents" ? documents(listed) : [];
  const entries = nodeId === "all" ? allNodes(rows) : rows;
  return {
    path,
    view: nodeId,
    priority: path === "Documents" ? priority(80, 80, 0, null) : priority(0, null, 0, null),
    overridesBelow: path === "" ? [{ path: "Archive", priority: 30, parent: 0 }, { path: "Documents", priority: 80, parent: 0 }, { path: "Documents/Virtual Machines", priority: 0, parent: 80 }] : [],
    entries,
    nextPage: null,
    notes: [],
  };
}
