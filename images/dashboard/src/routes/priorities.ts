import type { BandsEditBody, LayoutSaveAnswer, LayoutView, PriorityBand, PriorityEditBody, PriorityPreview } from "../api/types.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { callSyncthing, localInstances } from "../instanceResolver.js";
import { checkedLayout, editBands, editFolderPriority, layoutVersion, validBands, validPriority } from "../layoutEdit.js";
import { type ConfiguredFolders, planChanges } from "../layoutPreview.js";
import { cachedOtherHostNodes } from "../nodes.js";
import { type AnyRoute, hostWritePattern } from "../routeTypes.js";
import { setupRepoDirectory } from "../settings.js";
import { LayoutConflict, normaliseRelativePath, parseLayout, pullDataRepo, pullStateOf, readLayoutText, saveLayout } from "../setupRepo.js";

export interface LayoutRouteSources {
  repository: string;
  /** The folder IDs each node's Syncthing has, for the plans a preview diffs. */
  configured: () => Promise<ConfiguredFolders>;
}

/** The layout's text, or 404 while there is none to edit. */
export async function layoutTextOf(repository: string): Promise<string> {
  const text = repository ? await readLayoutText(repository) : null;
  if (text === null) throw new RequestError(404, "this host has no layout in a setup repo to edit");
  return text;
}

export function layoutViewOf(text: string, repository: string): LayoutView {
  const layout = parseLayout(text);
  return {
    version: layoutVersion(text),
    folders: layout.folders.map((folder) => ({ path: folder.relativePath, id: folder.id, priority: folder.priority })),
    nodes: layout.nodes.map((node) => ({ ...node, assigned: [...node.assigned], pins: { ...node.pins }, refused: node.refused ?? null })),
    bands: layout.bands,
    bandsFromLayout: layout.bandsFromLayout,
    problems: layout.problems.map((problem) => ({ nodeId: problem.nodeId, text: problem.text })),
    ...pullStateOf(repository),
  };
}

function priorityOf(body: Partial<PriorityEditBody> | null): number | null {
  if (body?.priority === null) return null;
  return validPriority(body?.priority);
}

export function requireBase(body: { base?: unknown } | null): string {
  if (typeof body?.base !== "string" || !body.base) throw new RequestError(400, "a save names its base, the layout version it was made from");
  return body.base;
}

/** What the edit would do to the folders and to every node's plan, made from the layout on disk. */
export function previewPriority(text: string, body: Partial<PriorityEditBody> | null, configured: ConfiguredFolders): PriorityPreview {
  const edit = editFolderPriority(text, body?.path, priorityOf(body));
  return { path: edit.path, folderId: edit.folderId, boundary: edit.boundary, nodes: planChanges(parseLayout(text), parseLayout(edit.text), configured) };
}

function boundaryRefusal(preview: PriorityPreview): string {
  const verb = preview.boundary === "created" ? "makes" : "removes";
  const nodes = preview.nodes.length ? preview.nodes.map((node) => `${node.nodeName}: ${node.changes.join("; ")}`).join(" | ") : "no node's plan changes";
  return `${preview.path} ${verb} the folder ${preview.folderId} (${nodes}); confirm with the folder ID`;
}

function commitMessage(preview: PriorityPreview, priority: number | null): string {
  if (preview.boundary === "created") return `feat(layout): make ${preview.path} a folder at priority ${priority}`;
  if (preview.boundary === "removed") return `feat(layout): let ${preview.path} inherit its priority again`;
  return priority === null ? `feat(layout): clear the priority of ${preview.path}` : `feat(layout): set the priority of ${preview.path} to ${priority}`;
}

function readsBack(path: string, priority: number | null) {
  return (layout: ReturnType<typeof parseLayout>) => {
    const entry = layout.folders.find((folder) => folder.relativePath === normaliseRelativePath(path));
    if (priority !== null) return entry?.priority === priority;
    return entry === undefined;
  };
}

/**
 * A pull after a rejected push, so the next read shows what the other host pushed.
 * @implNote Answers the refusal either way: the save is undone before the pull.
 */
export async function pullAfterConflict<Result>(repository: string, save: Promise<Result>): Promise<Result> {
  return save.catch(async (error) => {
    if (error instanceof LayoutConflict) await pullDataRepo(repository);
    throw error;
  });
}

async function liveConfigured(): Promise<ConfiguredFolders> {
  const known = new Map<string, Set<string>>();
  for (const node of cachedOtherHostNodes()) known.set(node.id, new Set(node.folders.map((folder) => folder.id)));
  for (const instance of await localInstances()) {
    const folders = await callSyncthing(instance, (client) => client.folders()).catch(() => null);
    if (folders) known.set(instance.nodeId, new Set(folders.map((folder) => folder.id)));
  }
  return (nodeId) => known.get(nodeId) ?? new Set();
}

function bandsWords(bands: PriorityBand[]): string {
  return bands.map((band) => `${band.name} from ${band.from}`).join(", ");
}

const liveSources: LayoutRouteSources = { repository: setupRepoDirectory, configured: liveConfigured };

/**
 * The layout and its priority edits: a preview names the folder boundary and every node's plan change, a save commits and pushes it.
 * @implNote A save that creates or removes a folder boundary needs the folder ID as `confirm` (section 5 item 7): it adds or drops a Syncthing folder on every node.
 */
export function priorityRoutes(sources: LayoutRouteSources = liveSources): AnyRoute[] {
  return [
    {
      method: "GET",
      pattern: /^\/api\/layout$/,
      handle: async ({ response }) => sendJson(response, 200, layoutViewOf(await layoutTextOf(sources.repository), sources.repository)),
    },
    {
      method: "POST",
      pattern: hostWritePattern(/^\/api\/priorities\/preview$/),
      handle: async ({ request, response }) => {
        const body = (await readBody(request)) as Partial<PriorityEditBody> | null;
        sendJson(response, 200, previewPriority(await layoutTextOf(sources.repository), body, await sources.configured()));
      },
    },
    {
      method: "PUT",
      pattern: hostWritePattern(/^\/api\/priorities$/),
      handle: async ({ request, response }) => {
        const body = (await readBody(request)) as Partial<PriorityEditBody> | null;
        const base = requireBase(body);
        const priority = priorityOf(body);
        const preview = previewPriority(await layoutTextOf(sources.repository), body, await sources.configured());
        if (preview.boundary && body?.confirm !== preview.folderId) throw new RequestError(409, boundaryRefusal(preview));
        const edit = (text: string) => {
          const edited = editFolderPriority(text, preview.path, priority);
          return checkedLayout(edited.text, readsBack(preview.path, priority), `${preview.path} at ${priority ?? "its inherited priority"}`);
        };
        const saved = await pullAfterConflict(sources.repository, saveLayout(edit, commitMessage(preview, priority), base, layoutVersion, sources.repository));
        const answer: LayoutSaveAnswer = { saved, layout: layoutViewOf(await layoutTextOf(sources.repository), sources.repository) };
        sendJson(response, 200, answer);
      },
    },
    {
      method: "PUT",
      pattern: hostWritePattern(/^\/api\/layout\/bands$/),
      handle: async ({ request, response }) => {
        const body = (await readBody(request)) as Partial<BandsEditBody> | null;
        const base = requireBase(body);
        const bands = validBands(body?.bands);
        const edit = (text: string) => checkedLayout(editBands(text, bands), (layout) => layout.bandsFromLayout && JSON.stringify(layout.bands) === JSON.stringify(bands), "the bands");
        const saved = await pullAfterConflict(sources.repository, saveLayout(edit, `feat(layout): set the priority bands to ${bandsWords(bands)}`, base, layoutVersion, sources.repository));
        const answer: LayoutSaveAnswer = { saved, layout: layoutViewOf(await layoutTextOf(sources.repository), sources.repository) };
        sendJson(response, 200, answer);
      },
    },
  ];
}
