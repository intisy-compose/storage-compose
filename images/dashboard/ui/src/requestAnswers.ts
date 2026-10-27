import type { AcceptFolderDefaults, FolderSettings, PendingDevice, PendingFolderOffer, RequestsResponse } from "../../src/api/types.js";

/** How the last answer went, shown above the lists. */
export interface AnswerResult {
  text: string;
  tone: "ok" | "bad";
  link: { href: string; label: string } | null;
}

/** What the person has set for one asking device before answering it. */
export interface DeviceAnswer {
  nodeName: string;
  name: string;
  recordInSetup: boolean;
  busy: boolean;
  /** Ignore was clicked once and now asks to be clicked again. */
  confirmingIgnore: boolean;
}

/** What the person has set for one device's offer of a folder to a node before answering it. */
export interface FolderAnswer {
  nodeName: string;
  /** The accept form is shown. */
  open: boolean;
  /** As the node answered when the form opened; null while it loads. */
  defaults: AcceptFolderDefaults | null;
  /** The path, type and versioning the form holds, typed or not. */
  draft: FolderSettings | null;
  loadError: string | null;
  /** The folder ID as typed to confirm an accept on an array. */
  confirm: string;
  busy: boolean;
  confirmingIgnore: boolean;
}

export function answerKey(device: Pick<PendingDevice, "nodeId" | "deviceId">): string {
  return `${device.nodeId} ${device.deviceId}`;
}

export function folderAnswerKey(offer: Pick<PendingFolderOffer, "nodeId" | "folderId" | "offeredBy">): string {
  return `${offer.nodeId} ${offer.folderId} ${offer.offeredBy}`;
}

export function freshAnswer(device: Pick<PendingDevice, "name" | "nodeName">): DeviceAnswer {
  return { nodeName: device.nodeName, name: device.name, recordInSetup: true, busy: false, confirmingIgnore: false };
}

export function freshFolderAnswer(offer: Pick<PendingFolderOffer, "nodeName">): FolderAnswer {
  return { nodeName: offer.nodeName, open: false, defaults: null, draft: null, loadError: null, confirm: "", busy: false, confirmingIgnore: false };
}

/**
 * Drops the answers of requests no longer listed, such as one answered in another browser, so none lingers into a later request.
 * @implNote A node whose requests could not be read this time lists none, so its answers are kept until it answers without them.
 */
export function pruneAnswers(answers: Map<string, { nodeName: string }>, listedKeys: readonly string[], unreadable: RequestsResponse["unreadable"]): void {
  const listed = new Set(listedKeys);
  const unread = new Set(unreadable.map((entry) => entry.name));
  for (const [key, answer] of answers) if (!listed.has(key) && !unread.has(answer.nodeName)) answers.delete(key);
}

/**
 * What a click on Ignore does: the first asks, the second ignores.
 * @implNote Ignoring lasts until un-ignored, unlike a dismiss, so it is never one stray click.
 */
export function ignoreClick(answer: { confirmingIgnore: boolean }): "ask" | "ignore" {
  if (answer.confirmingIgnore) return "ignore";
  answer.confirmingIgnore = true;
  return "ask";
}

/** Whether the accept may be sent: on an array only with the folder ID typed exactly, as the server checks it. */
export function isAcceptConfirmed(answer: Pick<FolderAnswer, "confirm">, folderId: string, confirmRequired: boolean): boolean {
  return !confirmRequired || answer.confirm === folderId;
}
