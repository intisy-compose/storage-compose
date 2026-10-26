import type { PendingDevice } from "../../src/api/types.js";

/** What the person has set for one asking device before answering it. */
export interface DeviceAnswer {
  name: string;
  recordInSetup: boolean;
  busy: boolean;
  /** Ignore was clicked once and now asks to be clicked again. */
  confirmingIgnore: boolean;
}

export function answerKey(device: Pick<PendingDevice, "nodeId" | "deviceId">): string {
  return `${device.nodeId} ${device.deviceId}`;
}

export function freshAnswer(device: Pick<PendingDevice, "name">): DeviceAnswer {
  return { name: device.name, recordInSetup: true, busy: false, confirmingIgnore: false };
}

/** Drops the answers of devices no longer asking, such as one answered in another browser, so none lingers into a later request. */
export function pruneAnswers(answers: Map<string, DeviceAnswer>, devices: PendingDevice[]): void {
  const asking = new Set(devices.map(answerKey));
  for (const key of answers.keys()) if (!asking.has(key)) answers.delete(key);
}

/**
 * What a click on Ignore does: the first asks, the second ignores.
 * @implNote Ignoring lasts until un-ignored, unlike a dismiss, so it is never one stray click.
 */
export function ignoreClick(answer: DeviceAnswer): "ask" | "ignore" {
  if (answer.confirmingIgnore) return "ignore";
  answer.confirmingIgnore = true;
  return "ask";
}
