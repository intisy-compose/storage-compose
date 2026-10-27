/** The item lists, answered after a pause as Syncthing answers a folder with 900,000 items. */

const answerDelayMs = 800;
const stages = ["progress", "queued", "rest"];

function pause() {
  return new Promise((resolve) => setTimeout(resolve, answerDelayMs));
}

function items(page, perPage, total, withStage) {
  const first = (page - 1) * perPage;
  const count = Math.max(0, Math.min(perPage, total - first));
  return Array.from({ length: count }, (_, index) => {
    const number = first + index;
    const item = {
      name: `Projects\\2026\\report-${String(number).padStart(6, "0")}.pdf`,
      size: 40_000 + number * 37,
      modified: new Date(Date.UTC(2026, 9, 20, 8, number % 60)).toISOString(),
      deleted: number % 17 === 5,
      modifiedBy: number % 3 === 0 ? "p53" : "finn-pc-disk",
    };
    return withStage ? { ...item, stage: stages[Math.min(number, 2)] } : item;
  });
}

/** `GET /api/nodes/<nodeId>/folders/<folderId>/need?page=&perPage=`. */
export async function needFixture(nodes, nodeId, folderId, page, perPage) {
  const folder = nodes.find((node) => node.id === nodeId)?.folders.find((candidate) => candidate.id === folderId);
  if (!folder) return { status: 404, body: { error: `no folder ${folderId} on ${nodeId}` } };
  await pause();
  return { status: 200, body: { items: items(page, perPage, folder.needItems, true), page, perPage, total: folder.needItems } };
}

/** `GET /api/nodes/<nodeId>/folders/<folderId>/remote-need?device=&page=&perPage=`: a folder not shared with the device is refused, naming it. */
export async function remoteNeedFixture(nodes, nodeId, folderId, deviceId, page, perPage) {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  const folder = node?.folders.find((candidate) => candidate.id === folderId);
  const peer = node?.peers.find((candidate) => candidate.deviceId === deviceId);
  if (!node || !folder) return { status: 404, body: { error: `no folder ${folderId} on ${nodeId}` } };
  const name = peer?.name || deviceId.slice(0, 7);
  if (!peer?.folders.includes(folderId)) return { status: 409, body: { error: `${folder.label || folder.id} is not shared with ${name} on ${node.name}` } };
  await pause();
  const total = peer.completion >= 100 ? 0 : 1_204;
  return { status: 200, body: { items: items(page, perPage, total, false), page, perPage, total, device: { deviceId, name } } };
}
