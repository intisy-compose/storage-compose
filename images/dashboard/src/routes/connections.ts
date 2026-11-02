import type { ConnectionProfile } from "../api/types.js";
import { ProfileError, formatProfile, parseProfile } from "../connectionProfile.js";
import { RequestError, readBody, sendJson } from "../http.js";
import { type AnyRoute, hostWritePattern } from "../routes.js";
import { setupRepoDirectory } from "../settings.js";
import { readProfile, saveProfile } from "../setupRepo.js";

/** @implNote A body that does not survive being written and read back is refused, so only a profile `parseProfile` accepts is ever committed. */
function validProfile(body: unknown): ConnectionProfile {
  try {
    return parseProfile(formatProfile(body as ConnectionProfile));
  } catch (error) {
    throw new RequestError(400, error instanceof ProfileError ? error.message : "the body is not a connection profile");
  }
}

export function connectionRoutes(repository = setupRepoDirectory): AnyRoute[] {
  return [
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
        await saveProfile(profile, "feat(connections): change the connection profile", repository);
        sendJson(response, 200, await readProfile(repository));
      },
    },
  ];
}
