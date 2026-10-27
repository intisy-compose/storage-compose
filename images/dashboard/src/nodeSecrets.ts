import { hiddenUnscopedTexts, shownUnscopedText } from "./shownSyncthingError.js";
import { configSecrets, withoutSecrets } from "./supportBundle.js";
import type { SyncthingClient } from "./syncthing.js";

const secretsKeptMs = 60_000;
const keptSecrets = new Map<string, { readAt: number; secrets: Promise<string[]> }>();
const lastReadSecrets = new Map<string, string[]>();

function secretsKey(nodeId: string, client: SyncthingClient): string {
  return `${nodeId}\u0000${client.endpoint.url}`;
}

/**
 * What is never let out of the node: its API key and every password or API key its configuration holds, the GUI's password hash and
 * folder encryption passwords among them; read again after a minute, and not kept when the read failed.
 * @implNote The GUI's plain password is never known to the dashboard: Syncthing keeps only its bcrypt hash, so only the hash is searched for.
 */
export function nodeSecrets(nodeId: string, client: SyncthingClient): Promise<string[]> {
  const key = secretsKey(nodeId, client);
  const kept = keptSecrets.get(key);
  if (kept && Date.now() - kept.readAt < secretsKeptMs) return kept.secrets;
  const secrets = client.request<unknown>("GET", "/config").then((config) => {
    const read = [...new Set([client.endpoint.apiKey, ...configSecrets(config)].filter(Boolean))];
    lastReadSecrets.set(key, read);
    return read;
  });
  keptSecrets.set(key, { readAt: Date.now(), secrets });
  secrets.catch(() => {
    if (keptSecrets.get(key)?.secrets === secrets) keptSecrets.delete(key);
  });
  return secrets;
}

/** A node's secrets for clearing its texts; `complete` is false while its configuration was never read, so only its API key is known. */
export interface KnownSecrets {
  secrets: readonly string[];
  complete: boolean;
}

export const allSecretsKnown = (secrets: readonly string[]): KnownSecrets => ({ secrets, complete: true });

/** The node's secrets, or the ones last read from it when its configuration cannot be read now, or only its API key when it never could. */
export function knownNodeSecrets(nodeId: string, client: SyncthingClient): Promise<KnownSecrets> {
  return nodeSecrets(nodeId, client).then(allSecretsKnown, () => {
    const lastRead = lastReadSecrets.get(secretsKey(nodeId, client));
    return lastRead ? allSecretsKnown(lastRead) : { secrets: [client.endpoint.apiKey], complete: false };
  });
}

/**
 * A Syncthing text as the page sees it: the node's secrets replaced, then `shownUnscopedText`; hidden whole while not all secrets are known.
 * @implNote The secrets are replaced before `shownUnscopedText` cuts the text, so a secret straddling the cut leaves no prefix behind.
 */
export function shownNodeText(text: string, known: KnownSecrets): string {
  return known.complete ? shownUnscopedText(withoutSecrets(text, known.secrets)) : hiddenUnscopedTexts.secretsUnread;
}
