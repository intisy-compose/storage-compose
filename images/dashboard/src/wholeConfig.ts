import { RequestError } from "./http.js";
import { type LocalInstance, callSyncthing, defaultReadBackDelaysMs, writeConfirmed } from "./instanceResolver.js";
import { SyncthingError } from "./syncthing.js";

export type SyncthingConfig = Record<string, unknown>;

/** A number JSON gave us that is not exactly the one Syncthing wrote, as an int64 above 2^53 is not. */
function hasInexactNumber(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && !Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.some(hasInexactNumber);
  return typeof value === "object" && value !== null && Object.values(value).some(hasInexactNumber);
}

async function readWholeConfig(instance: LocalInstance): Promise<SyncthingConfig> {
  const config = await callSyncthing(instance, (client) => client.request<SyncthingConfig>("GET", "/config"));
  if (hasInexactNumber(config)) throw new SyncthingError(`${instance.name}'s configuration holds a number too large to hand back unchanged; nothing was written`);
  return config;
}

const changeAttempts = 2;

/**
 * Replaces the node's whole Syncthing configuration with `change` of it; `change` answers null when the
 * configuration already holds what it would add, and nothing is written then.
 * @implNote Only for what Syncthing has no narrower endpoint for (ignored devices); a device's ignored folders have one,
 * `PATCH /rest/config/devices/<id>`, measured on 2.1.6, though the folder ignore of an offer still writes them here. Its PUT
 * has no version check, so the config is read again just before the PUT: a change in between (Syncthing or another
 * browser) starts once more from the changed config, and a second one is a 409 with `conflict` and nothing written.
 * A lost answer counts as written once a fresh read holds the change, that is once `change` answers null for it.
 */
export async function changeWholeConfig(
  instance: LocalInstance,
  change: (config: SyncthingConfig) => SyncthingConfig | null,
  conflict: string,
  readBackDelaysMs: readonly number[] = defaultReadBackDelaysMs,
): Promise<"written" | "unchanged"> {
  for (let attempt = 0; attempt < changeAttempts; attempt++) {
    const config = await readWholeConfig(instance);
    const updated = change(config);
    if (!updated) return "unchanged";
    if (JSON.stringify(await readWholeConfig(instance)) !== JSON.stringify(config)) continue;
    await writeConfirmed(instance, (client) => client.request("PUT", "/config", updated), async () => change(await readWholeConfig(instance)) === null, readBackDelaysMs);
    return "written";
  }
  throw new RequestError(409, conflict);
}
