import { configSecrets } from "./supportBundle.js";
import type { SyncthingClient } from "./syncthing.js";

const secretsKeptMs = 60_000;
const keptSecrets = new Map<string, { readAt: number; secrets: Promise<string[]> }>();

/**
 * What is never let out of the node: its API key and every password or API key its configuration holds, the GUI's password hash and
 * folder encryption passwords among them; read again after a minute, and not kept when the read failed.
 * @implNote The GUI's plain password is never known to the dashboard: Syncthing keeps only its bcrypt hash, so only the hash is searched for.
 */
export function nodeSecrets(nodeId: string, client: SyncthingClient): Promise<string[]> {
  const key = `${nodeId}\u0000${client.endpoint.url}`;
  const kept = keptSecrets.get(key);
  if (kept && Date.now() - kept.readAt < secretsKeptMs) return kept.secrets;
  const secrets = client.request<unknown>("GET", "/config").then((config) => [...new Set([client.endpoint.apiKey, ...configSecrets(config)].filter(Boolean))]);
  keptSecrets.set(key, { readAt: Date.now(), secrets });
  secrets.catch(() => {
    if (keptSecrets.get(key)?.secrets === secrets) keptSecrets.delete(key);
  });
  return secrets;
}

/** The node's secrets, or at least its API key, which the dashboard always knows, when its configuration cannot be read. */
export function nodeSecretsOrApiKey(nodeId: string, client: SyncthingClient): Promise<string[]> {
  return nodeSecrets(nodeId, client).catch(() => [client.endpoint.apiKey]);
}
