import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { listBlockDevices } from "./blockDevices.js";
import { startEventFeeds } from "./eventFeed.js";
import { RequestError, readBody, sendJson } from "./http.js";
import { type JoinDependencies, JoinError, handleJoin } from "./join.js";
import { joinInstances } from "./joinInstances.js";
import { createJoinListener, dockerDnsResolver } from "./joinListener.js";
import type { ProxySource } from "./proxyProtocol.js";
import { handleRequest, joinRecords } from "./routes.js";
import { joinAllowedUsers, joinGatewayHost, joinPort, joinTag, port, setupRepoDirectory } from "./settings.js";
import { readLayout, recordDevice } from "./setupRepo.js";
import { ownLogin, whois } from "./tailnet.js";

const joinDependencies: JoinDependencies = {
  whois,
  allowedUsers: async () => {
    const owner = await ownLogin().catch(() => null);
    return owner ? [owner, ...joinAllowedUsers] : joinAllowedUsers;
  },
  requiredTag: joinTag,
  instances: () => joinInstances(),
  layout: readLayout,
  records: joinRecords,
  recordInSetup: setupRepoDirectory ? recordDevice : null,
  now: () => new Date(),
};

async function handleJoinRequest(request: IncomingMessage, response: ServerResponse, caller: ProxySource): Promise<void> {
  try {
    const { response: answer, setup } = await handleJoin(joinDependencies, [caller.address], await readBody(request));
    if (setup) console.log(`join: ${setup.message}`);
    sendJson(response, 200, answer);
  } catch (error) {
    if (error instanceof JoinError || error instanceof RequestError) return sendJson(response, error.status, { error: error.message });
    throw error;
  }
}

createServer((request, response) => void handleRequest(request, response)).listen(port, () => console.log(`dashboard listening on ${port}`));

createJoinListener(handleJoinRequest, dockerDnsResolver(joinGatewayHost)).listen(joinPort, () =>
  console.log(`join API listening on ${joinPort}, behind tailscale's PROXY protocol, for ${joinGatewayHost} only`),
);

void listBlockDevices().catch(() => undefined);
startEventFeeds();
