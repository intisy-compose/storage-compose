import type { ConnectionProfile, PeerTable } from "../api/types.js";
import { ProfileError, formatProfile, parseProfile } from "../connectionProfile.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { collectPeerTable, localPeerTable } from "../peerSources.js";
import { type AnyRoute, hostWritePattern } from "../routes.js";
import { setupRepoDirectory } from "../settings.js";
import { ProfileConflict, pullDataRepo, readProfile, saveProfile } from "../setupRepo.js";

/** @implNote A body that does not survive being written and read back is refused, so only a profile `parseProfile` accepts is ever committed. */
function validProfile(body: unknown): ConnectionProfile {
  try {
    return parseProfile(formatProfile(body as ConnectionProfile));
  } catch (error) {
    throw new RequestError(400, error instanceof ProfileError ? error.message : "the body is not a connection profile");
  }
}

export interface PeerTableReads {
  local: () => Promise<PeerTable>;
  all: () => Promise<PeerTable>;
}

const defaultPeerTableReads: PeerTableReads = { local: () => localPeerTable(), all: () => collectPeerTable() };

export function connectionRoutes(repository = setupRepoDirectory, peerTables = defaultPeerTableReads): AnyRoute[] {
  return [
    {
      method: "GET",
      pattern: /^\/api\/connections\/addresses$/,
      handle: async ({ response, url }) => sendJson(response, 200, await (url.searchParams.get("scope") === "local" ? peerTables.local() : peerTables.all())),
    },
    {
      method: "GET",
      pattern: /^\/api\/connections\/profile$/,
      handle: async ({ response }) => sendJson(response, 200, await readProfile(repository)),
    },
    {
      method: "PUT",
      pattern: hostWritePattern(/^\/api\/connections\/profile$/),
      handle: async ({ request, response }) => {
        const profile = validProfile(await readBody(request));
        await saveProfile(profile, "feat(connections): change the connection profile", repository).catch(async (error) => {
          if (error instanceof ProfileConflict) await pullDataRepo(repository);
          throw error;
        });
        sendJson(response, 200, await readProfile(repository));
      },
    },
  ];
}
