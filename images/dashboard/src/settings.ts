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

/** The names the dashboard answers to: loopback, the tailnet name `up` wrote as STORAGE_HOST, and every DASHBOARD_EXTRA_HOSTS entry (comma separated). */
export function dashboardHostsOf(environment: Record<string, string | undefined>): string[] {
  return ["localhost", "127.0.0.1", "[::1]", ...list(environment.STORAGE_HOST), ...list(environment.DASHBOARD_EXTRA_HOSTS)];
}

export const dashboardHosts = dashboardHostsOf(process.env);
export const statusDirectory = process.env.STATUS_DIRECTORY ?? "/status";
/** DISCOVERY_POLL_SECONDS from config.env: how often the mounter rescans every device; a missing or unusable value takes 300. */
export function discoveryPollSecondsOf(environment: Record<string, string | undefined>): number {
  return positiveNumber(environment.DISCOVERY_POLL_SECONDS, 300);
}

export const discoveryPollSeconds = discoveryPollSecondsOf(process.env);
export const arraysStatusDirectory = `${statusDirectory}/arrays`;
export const registryDirectory = `${statusDirectory}/nodes`;
/** Where the nodes service mounts the drive and folder nodes whose Syncthing it runs, as their registry roots name them. */
export const nodeVolumesDirectory = "/mnt/nodes";
export const joinsFile = `${statusDirectory}/joins.json`;
/** The dashboard's own memory of devices and drives; a cache in the `rebuilt` status volume. */
export const seenDirectory = `${statusDirectory}/seen`;
export const conflictsDirectory = `${statusDirectory}/conflicts`;
export const publicDirectory = new URL("../public/", import.meta.url).pathname;
export const port = Number(process.env.PORT ?? 8080);
/** The join port inside the stack: the gateway forwards /api/join on 443 here with a PROXY protocol header. */
export const joinPort = Number(process.env.JOIN_PORT ?? 8447);
/** The only source the join port reads from: tailscale's serve forwards from the gateway's namespace. */
export const joinGatewayHost = process.env.JOIN_GATEWAY_HOST ?? "gateway";
export const candidateTransports = list(process.env.CANDIDATE_TRANSPORTS ?? "usb");
export const anyArrayLabelPattern = new RegExp(`^([0-9a-f]{4}|${clusterArrayId})-((data|parity)\\d+)$`);
/** A dashboard's address without a trailing slash, so a path can be appended to it. */
export function dashboardBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Other hosts' dashboards, read for their nodes, e.g. https://storage-p53.tailnet.ts.net. */
export const peerDashboards = list(process.env.STORAGE_PEERS).map(dashboardBaseUrl);
/** Where the mounter sends notifications; the dashboard shows it on Settings. */
export const ntfyUrl = process.env.NTFY_URL ?? "";
/** @implNote Only whether a topic is set: the topic itself lets anyone read the notifications. */
export const ntfyTopicSet = Boolean(process.env.NTFY_TOPIC);
/** An HTTP proxy into the tailnet: tailscale runs in userspace, so only it reaches tailnet addresses. */
export const tailnetProxy = process.env.TAILNET_PROXY ?? "";
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

export interface AttentionThresholds {
  offlineHours: number;
  fullPercent: number;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** ATTENTION_OFFLINE_HOURS and ATTENTION_FULL_PERCENT from config.env; a missing or unusable value takes the default. */
export function attentionThresholds(environment: Record<string, string | undefined>): AttentionThresholds {
  return {
    offlineHours: positiveNumber(environment.ATTENTION_OFFLINE_HOURS, 24),
    fullPercent: positiveNumber(environment.ATTENTION_FULL_PERCENT, 90),
  };
}

export const attentionSettings = attentionThresholds(process.env);

/** ACTIVITY_BUFFER from config.env: how many Activity entries each Syncthing instance, array and the dashboard keep. */
export function activityBufferSize(environment: Record<string, string | undefined>): number {
  return Math.max(1, Math.floor(positiveNumber(environment.ACTIVITY_BUFFER, 2000)));
}

export const activitySettings = { bufferSize: activityBufferSize(process.env) };

/** CONFLICT_SWEEP_PAUSE_MS and CONFLICT_RECHECK_HOURS from config.env: the pause between two directory reads of a conflict sweep, and how often every folder's conflict index is checked against its Syncthing. */
export function conflictSweepSettings(environment: Record<string, string | undefined>): { browsePauseMs: number; verifyEveryMs: number } {
  const pause = Number(environment.CONFLICT_SWEEP_PAUSE_MS);
  const browsePauseMs = environment.CONFLICT_SWEEP_PAUSE_MS && Number.isFinite(pause) && pause >= 0 ? Math.floor(pause) : 10;
  return { browsePauseMs, verifyEveryMs: positiveNumber(environment.CONFLICT_RECHECK_HOURS, 24) * 3_600_000 };
}

export const conflictSettings = conflictSweepSettings(process.env);

/** VERSIONS_LIST_MAX_MB from config.env: how much of a folder's versions list, which Syncthing answers whole, the dashboard reads before it refuses to list them. */
export function versionsListMaxBytes(environment: Record<string, string | undefined>): number {
  return Math.round(positiveNumber(environment.VERSIONS_LIST_MAX_MB, 16) * 1_000_000);
}

export const versionsSettings = { listMaxBytes: versionsListMaxBytes(process.env) };

/** EXPLORER_NEED_LIMIT from config.env: above this many outstanding or failed items a folder's list is not placed in the tree. */
export function explorerNeedLimit(environment: Record<string, string | undefined>): number {
  return Math.max(1, Math.floor(positiveNumber(environment.EXPLORER_NEED_LIMIT, 20_000)));
}

export const explorerSettings = { needLimit: explorerNeedLimit(process.env) };

/** SEEN_WRITE_INTERVAL_S from config.env: the devices and drives seen files are rewritten at most this often. */
export function seenWriteIntervalSeconds(environment: Record<string, string | undefined>): number {
  return positiveNumber(environment.SEEN_WRITE_INTERVAL_S, 60);
}
