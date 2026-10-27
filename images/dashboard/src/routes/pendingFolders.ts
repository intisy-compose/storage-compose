import { shortDeviceId } from "../api/deviceText.js";
import { type AcceptFolderBody, type AcceptFolderDefaults, type FolderOfferAnswerBody, type FolderSettings, type FolderType, type IgnoredFolderOffer, type PendingFolderOffer, type Versioning, folderTypeTexts } from "../api/types.js";
import { versioningWords } from "../api/versioningText.js";
import { folderSettings, offersOf } from "../folderIndex.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type LocalInstance, type ResolvedInstance, callSyncthing, requireLocal } from "../instanceResolver.js";
import { type NodeRoot, folderPathProblem, pathUnderRoot } from "../pathGuard.js";
import type { AnyRoute, NothingWritten, WriteNote } from "../routes.js";
import type { SyncthingFolderSettings } from "../syncthing.js";
import { folderChangeProblem } from "../syncthingConfig.js";
import { type SyncthingConfig, changeWholeConfig } from "../wholeConfig.js";
import { decodedSegment } from "./devices.js";
import { type NodeFolderSources, createFolder, guardNewFolderPath, nodeFolderSources } from "./nodeFolders.js";

type SyncthingObject = Record<string, unknown>;

const acceptKeys: readonly (keyof AcceptFolderBody)[] = ["offeredBy", "path", "type", "versioning", "confirm"];
const folderTypes = Object.keys(folderTypeTexts) as FolderType[];

/** What an array keeps of an offered folder unless the person changes it: Syncthing's own staggered default, a year of versions. */
export const arrayVersioning: Versioning = { type: "staggered", params: { maxAge: "31536000" }, cleanupIntervalS: 3600, fsPath: "" };

function asObject(value: unknown): SyncthingObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as SyncthingObject) : {};
}

function offerAnswerBody(body: unknown): FolderOfferAnswerBody {
  const offeredBy = asObject(body).offeredBy;
  if (typeof offeredBy !== "string" || !offeredBy.trim()) throw new RequestError(400, "the device whose offer is answered is missing");
  return { offeredBy: offeredBy.trim() };
}

/** Why `body` is no accept, or null; checked before anything is read from the node. */
function acceptProblem(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "an accept needs the offering device, a path, a type and a versioning";
  const fields = body as SyncthingObject;
  const unknown = Object.keys(fields).find((key) => !acceptKeys.includes(key as keyof AcceptFolderBody));
  if (unknown) return `${unknown} is not part of accepting a folder`;
  if (typeof fields.offeredBy !== "string" || !fields.offeredBy.trim()) return "the device whose offer is accepted is missing";
  if (typeof fields.path !== "string" || !fields.path.trim()) return "the folder path is missing";
  if (!folderTypes.includes(fields.type as FolderType)) return `Type must be ${Object.values(folderTypeTexts).join(", ")}`;
  if (fields.confirm !== undefined && typeof fields.confirm !== "string") return "the confirmation must be the folder ID as text";
  return folderChangeProblem({ versioning: fields.versioning });
}

function isArray(instance: LocalInstance): boolean {
  return instance.source === "array";
}

/**
 * The array guard: an array is accepted onto only with the folder ID typed exactly.
 * @implNote The PC's folders are offered to the private array and wait there for the human partner's go-ahead (HANDOFF decision 1),
 * so an accept on an array is never one click; this runs before any request to the node.
 */
function arrayConfirmProblem(instance: LocalInstance, folderId: string, confirm: string | undefined): string | null {
  return isArray(instance) && confirm !== folderId ? `type the folder ID ${folderId} to accept it on ${instance.name}, an array` : null;
}

/** The device's offer of the folder as the node lists it; one that is not pending is 404. */
async function pendingOffer(instance: LocalInstance, folderId: string, offeredBy: string): Promise<PendingFolderOffer> {
  const [pending, devices] = await Promise.all([callSyncthing(instance, (client) => client.pendingFolders()), callSyncthing(instance, (client) => client.devices())]);
  const offers = Object.hasOwn(pending, folderId) ? offersOf({ nodeId: instance.nodeId, nodeName: instance.name }, devices, { [folderId]: pending[folderId] }) : [];
  const offer = offers.find((candidate) => candidate.offeredBy === offeredBy);
  if (!offer) throw new RequestError(404, `${shortDeviceId(offeredBy)} does not offer folder ${folderId} to ${instance.name}`);
  return offer;
}

function offerLabel(offer: PendingFolderOffer): string {
  return offer.label || offer.folderId;
}

function typeProblem(offer: PendingFolderOffer, type: FolderType): string | null {
  if (offer.receiveEncrypted && type !== "receiveencrypted") return `${offerLabel(offer)} is offered encrypted, so it is accepted receive encrypted`;
  if (!offer.receiveEncrypted && type === "receiveencrypted") return "only a folder offered encrypted is accepted receive encrypted";
  return null;
}

function defaultType(instance: LocalInstance, offer: PendingFolderOffer, nodeDefault: unknown): FolderType {
  if (offer.receiveEncrypted) return "receiveencrypted";
  if (isArray(instance)) return "receiveonly";
  return nodeDefault === "sendonly" || nodeDefault === "receiveonly" ? nodeDefault : "sendreceive";
}

/** @implNote External versioning is never offered by the dashboard (plan call 9), so a node default of it opens the form with none. */
function defaultVersioning(instance: LocalInstance, nodeDefault: Versioning): Versioning {
  if (isArray(instance)) return arrayVersioning;
  return nodeDefault.type === "external" ? { type: "", params: {}, cleanupIntervalS: nodeDefault.cleanupIntervalS, fsPath: "" } : nodeDefault;
}

function rootOf(instance: LocalInstance): string {
  if (!instance.root) throw new RequestError(409, `${instance.name} has no root known to the dashboard, so no folder can be placed on it`);
  return instance.root;
}

/**
 * The accept form's defaults for one device's offer: placed at `<root>/<label>`, shared with the offering device, the node's
 * own folder defaults for the rest. On an array (HANDOFF decision 1, plan call 5) the folder is received only, kept with
 * staggered versioning, and the folder ID must be typed.
 */
export async function acceptFolderDefaults(instance: ResolvedInstance, folderId: string, offeredBy: string, nodes: NodeRoot[]): Promise<AcceptFolderDefaults> {
  const local = requireLocal(instance);
  const root = rootOf(local);
  const [offer, defaults, ownId] = await Promise.all([pendingOffer(local, folderId, offeredBy), callSyncthing(local, (client) => client.request<unknown>("GET", "/config/defaults/folder")), callSyncthing(local, (client) => client.myId())]);
  const nodeDefaults = asObject(defaults);
  const path = pathUnderRoot(root, offerLabel(offer), local.os);
  const devices = [{ deviceID: ownId, encryptionPassword: "" }, { deviceID: offer.offeredBy, encryptionPassword: "" }];
  const base = folderSettings({ ...nodeDefaults, id: folderId, label: offer.label, path, devices } as unknown as SyncthingFolderSettings);
  const settings: FolderSettings = { ...base, type: defaultType(local, offer, nodeDefaults.type), versioning: defaultVersioning(local, base.versioning) };
  const node: NodeRoot = { nodeId: local.nodeId, name: local.name, root, os: local.os };
  return { offer, settings, root, confirmRequired: isArray(local), placementProblem: folderPathProblem(path, node, nodes) };
}

export interface FolderAcceptance {
  added: FolderSettings;
  note: WriteNote;
}

/** What an accept did, in words: `pc: accepted folder Documents (documents) from laptop at F:\Documents; receive only; versioning staggered, ...`. */
function acceptText(nodeName: string, offer: PendingFolderOffer, path: string, request: AcceptFolderBody, ignoreLines: number, keptPaused: string | null): string {
  const label = offerLabel(offer);
  const named = label !== offer.folderId ? `${label} (${offer.folderId})` : offer.folderId;
  const details = [folderTypeTexts[request.type], `versioning ${versioningWords(request.versioning)}`, ...(ignoreLines ? [`${ignoreLines} ${ignoreLines === 1 ? "line" : "lines"} of ignore patterns`] : []), ...(keptPaused ? [keptPaused] : [])];
  return [`${nodeName}: accepted folder ${named} from ${offer.offeredByName} at ${path}`, ...details].join("; ");
}

/**
 * Adds the offered folder to the node, shared with the device that offered it, through the add's path guard.
 * @implNote Accepting makes Syncthing create the directory and start syncing into it, so every refusal that needs no
 * Syncthing call (the body, the array guard, the path guard) comes before the first request.
 */
export async function acceptPendingFolder(instance: ResolvedInstance, folderId: string, body: unknown, nodes: NodeRoot[]): Promise<FolderAcceptance> {
  const local = requireLocal(instance);
  const problem = acceptProblem(body);
  if (problem) throw new RequestError(400, problem);
  const request = body as AcceptFolderBody;
  const confirmProblem = arrayConfirmProblem(local, folderId, request.confirm);
  if (confirmProblem) throw new RequestError(400, confirmProblem);
  guardNewFolderPath(local, request.path, nodes);
  const offeredBy = request.offeredBy.trim();
  const [offer, folders] = await Promise.all([pendingOffer(local, folderId, offeredBy), callSyncthing(local, (client) => client.folders())]);
  const wrongType = typeProblem(offer, request.type);
  if (wrongType) throw new RequestError(400, wrongType);
  if (folders.some((folder) => folder.id === folderId)) throw new RequestError(409, `${local.name} already has folder ${folderId}; share it with ${offer.offeredByName} from the folder's settings`);
  const created = await createFolder(local, { id: folderId, label: offer.label, path: request.path, type: request.type }, nodes, { offeredBy, versioning: request.versioning });
  const text = acceptText(local.name, offer, created.folder.path, request, created.ignores.lines, created.ignores.keptPaused);
  return { added: created.added, note: { nodeId: local.nodeId, nodeName: local.name, folderId, text } };
}

function deviceEntries(config: SyncthingConfig): SyncthingObject[] {
  return Array.isArray(config.devices) ? (config.devices as SyncthingObject[]) : [];
}

function ignoredFolders(device: SyncthingObject): SyncthingObject[] {
  return Array.isArray(device.ignoredFolders) ? (device.ignoredFolders as SyncthingObject[]) : [];
}

/** The config with the folder added to the offering device's ignored folders, or null when it is there already. */
function withIgnoredFolder(config: SyncthingConfig, offer: PendingFolderOffer, now: Date, nodeName: string): SyncthingConfig | null {
  const devices = deviceEntries(config);
  const offerer = devices.find((device) => device.deviceID === offer.offeredBy);
  if (!offerer) throw new RequestError(409, `${offer.offeredByName} is no longer a device of ${nodeName}; nothing was written`);
  if (ignoredFolders(offerer).some((entry) => entry.id === offer.folderId)) return null;
  const entry = { time: now.toISOString(), id: offer.folderId, label: offer.label };
  return { ...config, devices: devices.map((device) => (device === offerer ? { ...device, ignoredFolders: [...ignoredFolders(device), entry] } : device)) };
}

export interface FolderOfferIgnore {
  ignored: IgnoredFolderOffer;
  /** Nothing is entered in Activity when the device's offers of the folder were ignored already. */
  note: WriteNote | NothingWritten;
}

/**
 * Ignores one device's offers of the folder, as Syncthing's own Ignore does; another device offering it is still listed.
 * @implNote Syncthing keeps ignored folders in the device's entry and has no endpoint for them alone, so the whole
 * configuration is written back as read, every other field and secret included, and never returned.
 */
export async function ignorePendingFolder(instance: ResolvedInstance, folderId: string, body: unknown, now: () => Date = () => new Date()): Promise<FolderOfferIgnore> {
  const local = requireLocal(instance);
  const { offeredBy } = offerAnswerBody(body);
  const offer = await pendingOffer(local, folderId, offeredBy);
  const conflict = `${local.name}'s configuration changed twice while ${offerLabel(offer)} from ${offer.offeredByName} was being ignored; nothing was written, try again`;
  const outcome = await changeWholeConfig(local, (config) => withIgnoredFolder(config, offer, now(), local.name), conflict);
  if (outcome === "unchanged") return { ignored: { ...offer, alreadyIgnored: true }, note: { nothingWritten: true } };
  return { ignored: { ...offer, alreadyIgnored: false }, note: { nodeId: local.nodeId, nodeName: local.name, folderId, text: `${local.name}: ignored folder ${offerLabel(offer)} offered by ${offer.offeredByName}` } };
}

export interface FolderOfferDismissal {
  dismissed: PendingFolderOffer;
  note: WriteNote;
}

/** Drops the device's offer only; it is listed again the next time the device offers the folder. */
export async function dismissPendingFolder(instance: ResolvedInstance, folderId: string, body: unknown): Promise<FolderOfferDismissal> {
  const local = requireLocal(instance);
  const { offeredBy } = offerAnswerBody(body);
  const offer = await pendingOffer(local, folderId, offeredBy);
  const query = new URLSearchParams({ folder: folderId, device: offeredBy });
  await callSyncthing(local, (client) => client.request("DELETE", `/cluster/pending/folders?${query.toString()}`));
  return { dismissed: offer, note: { nodeId: local.nodeId, nodeName: local.name, folderId, text: `${local.name}: dismissed folder ${offerLabel(offer)} offered by ${offer.offeredByName}` } };
}

export function pendingFolderRoutes(sources: NodeFolderSources = nodeFolderSources): AnyRoute[] {
  const target = async (nodeId: string, folderId: string) => ({ instance: await sources.resolve(decodedSegment(nodeId, "node ID")), folderId: decodedSegment(folderId, "folder ID") });
  const offerPattern = (answer: string) => new RegExp(`^\\/api\\/nodes\\/([^/]+)\\/pending\\/folders\\/([^/]+)\\/${answer}$`);
  return [
    {
      method: "GET",
      pattern: offerPattern("defaults"),
      handle: async ({ response, url, params: [nodeId, folderSegment] }) => {
        const { instance, folderId } = await target(nodeId, folderSegment);
        const { offeredBy } = offerAnswerBody({ offeredBy: url.searchParams.get("offeredBy") });
        sendJson(response, 200, await acceptFolderDefaults(instance, folderId, offeredBy, await sources.nodeRoots()));
      },
    },
    {
      method: "POST",
      pattern: offerPattern("accept"),
      write: async ({ request, response, params: [nodeId, folderSegment] }) => {
        const { instance, folderId } = await target(nodeId, folderSegment);
        const acceptance = await acceptPendingFolder(instance, folderId, await readBody(request), await sources.nodeRoots());
        sendJson(response, 201, acceptance.added);
        return acceptance.note;
      },
    },
    {
      method: "POST",
      pattern: offerPattern("ignore"),
      write: async ({ request, response, params: [nodeId, folderSegment] }) => {
        const { instance, folderId } = await target(nodeId, folderSegment);
        const ignore = await ignorePendingFolder(instance, folderId, await readBody(request));
        sendJson(response, 200, ignore.ignored);
        return ignore.note;
      },
    },
    {
      method: "POST",
      pattern: offerPattern("dismiss"),
      write: async ({ request, response, params: [nodeId, folderSegment] }) => {
        const { instance, folderId } = await target(nodeId, folderSegment);
        const dismissal = await dismissPendingFolder(instance, folderId, await readBody(request));
        sendJson(response, 200, dismissal.dismissed);
        return dismissal.note;
      },
    },
  ];
}
