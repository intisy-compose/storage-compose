function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const storageRoot = process.env.STORAGE_ROOT ?? "/mnt/storage";
/** The array whose data1 holds the stack state; the legacy prefix `storage` until migrate-labels. */
export const clusterArrayId = process.env.ARRAY_PREFIX ?? "storage";
export const hostName = process.env.STORAGE_NODE || "this host";
/** The tailnet name of this host's dashboard and cluster, as `up` wrote it into config.env. */
export const tailnetHost = process.env.STORAGE_HOST ?? "";
export const statusDirectory = "/status";
export const arraysStatusDirectory = `${statusDirectory}/arrays`;
export const registryDirectory = `${statusDirectory}/nodes`;
export const joinsFile = `${statusDirectory}/joins.json`;
export const publicDirectory = new URL("../public/", import.meta.url).pathname;
export const port = Number(process.env.PORT ?? 8080);
/** The tailnet-only join port: tailscale forwards it here with a PROXY protocol header (PORTS.md, 8447). */
export const joinPort = Number(process.env.JOIN_PORT ?? 8447);
/** The only source the join port reads from: tailscale's serve forwards from the gateway's namespace. */
export const joinGatewayHost = process.env.JOIN_GATEWAY_HOST ?? "gateway";
export const candidateTransports = list(process.env.CANDIDATE_TRANSPORTS ?? "usb");
export const anyArrayLabelPattern = new RegExp(`^([0-9a-f]{4}|${clusterArrayId})-((data|parity)\\d+)$`);
/** Other hosts' dashboards, read for their nodes, e.g. https://storage-p53.tailnet.ts.net. */
export const peerDashboards = list(process.env.STORAGE_PEERS);
/** An HTTP proxy into the tailnet: tailscale runs in userspace, so only it reaches tailnet addresses. */
export const tailnetProxy = process.env.TAILNET_PROXY ?? "";
/** e.g. https://inventree.tailnet.ts.net/web/stock/item/?search={asset} */
export const inventoryAssetUrl = process.env.INVENTORY_ASSET_URL ?? "";
export const tailscaleSocket = process.env.TAILSCALE_SOCKET ?? "/var/run/tailscale/tailscaled.sock";
/** Tailnet logins whose devices may join besides this node's owner's and `tag:storage`. */
export const joinAllowedUsers = list(process.env.JOIN_ALLOWED_USERS);
export const joinTag = "tag:storage";
/** The setup repo inside the container: SETUP_REPO_DIR, by default the stack's own data repo. */
export const setupRepoDirectory = process.env.SETUP_REPO_DIR ? "/setup" : "";
export const setupLayoutPath = process.env.SETUP_LAYOUT ?? "drive-sync.toml";
/** Where the cluster's Syncthing answers inside the stack: Caddy's local site in front of its GUI. */
export const clusterSyncthingUrl = process.env.CLUSTER_SYNCTHING_URL ?? "http://gateway:8443";

export function arrayStateDirectory(arrayId: string): string {
  return `${storageRoot}/${arrayId}-data1/.storage`;
}

export function arrayStatusDirectory(arrayId: string): string {
  return `${arraysStatusDirectory}/${arrayId}`;
}

export function poolPath(arrayId: string): string {
  return arrayId === clusterArrayId ? `${storageRoot}/pool` : `${storageRoot}/pool-${arrayId}`;
}

/** Set by docker-compose.ps1: a Windows host runs the host agent, and its absence is a problem. */
export const hostAgentExpected = process.env.HOST_AGENT_EXPECTED === "yes";
export const hostAgentHeartbeatFile = "/host-agent/heartbeat.json";
export const hostAgentSyncthingHost = process.env.HOST_AGENT_SYNCTHING_HOST ?? "host.docker.internal";
