/** The connection profile, the peer table and each local node's options, so the Settings page's Connections cards render without the stack. */
let profile = {
  methods: { lan: true, tailnet: true, nat: true },
  discovery: { global: "default" },
  relays: { public: true, bridges: true, bridgePort: 22100 },
  limits: { maxSendKbps: 0, maxRecvKbps: 0, limitLan: false },
  nodeLimits: { "17aa": { maxSendKbps: 500 } },
};
let pulledAt = new Date().toISOString();

const lan = (address) => ({ kind: "lan", address, category: "Private" });
const tailnet = (address) => ({ kind: "tailnet", address });

export function peerTableFixture() {
  return {
    nodes: [
      { nodeId: "17aa", deviceId: "DEV-17AA", syncPort: 22001, networks: [lan("192.168.0.101")] },
      { nodeId: "2b90", deviceId: "DEV-2B90", syncPort: 22000, networks: [tailnet("100.64.0.12")] },
      { nodeId: "a3f9", deviceId: "DEV-A3F9", syncPort: 22021, networks: [lan("192.168.0.10"), tailnet("100.75.83.74")] },
      { nodeId: "e5d0", deviceId: "DEV-E5D0", syncPort: 22002, networks: [lan("192.168.0.10"), tailnet("100.75.83.74")] },
    ],
    bridges: [{ host: "finn-pc", relayId: "RELAY-FINN", port: 22100, addresses: [lan("192.168.0.10"), tailnet("100.75.83.74")] }],
    builtAt: new Date().toISOString(),
  };
}

export function profileFixture() {
  return { profile, pulledAt, pullProblem: null };
}

/** @implNote Stands in for the server's check: with every relay and the tailnet off, the LAN-only and tailnet-only nodes share nothing. */
function strands(next) {
  return !next.methods.tailnet && !next.relays.public && !next.relays.bridges && (profile.methods.tailnet || profile.relays.public || profile.relays.bridges);
}

export function saveProfileFixture(body) {
  const { confirmUnreachable, ...next } = body;
  if (!confirmUnreachable && strands(next)) return { status: 409, body: { error: "17aa and 2b90 would share no connection method; confirm to save anyway" } };
  profile = next;
  pulledAt = new Date().toISOString();
  return { status: 200, body: profileFixture() };
}

export function nodeOptionsFixture(nodeId) {
  const limits = { ...profile.limits, ...profile.nodeLimits[nodeId] };
  const port = { a3f9: 22021, b71c: 22022, e5d0: 22002, "17aa": 22001 }[nodeId] ?? 22000;
  return {
    options: {
      deviceName: nodeId,
      listenAddresses: [`tcp://0.0.0.0:${port}`, `quic://0.0.0.0:${port}`, "relay://192.168.0.10:22100/?id=RELAY-FINN", "dynamic+https://relays.syncthing.net/endpoint"],
      globalAnnounceEnabled: profile.discovery.global !== "",
      localAnnounceEnabled: profile.methods.lan,
      globalAnnounceServers: profile.discovery.global === "" ? [] : [profile.discovery.global].flat(),
      relaysEnabled: profile.relays.public || profile.relays.bridges,
      natEnabled: profile.methods.nat,
      maxSendKbps: limits.maxSendKbps,
      maxRecvKbps: limits.maxRecvKbps,
      limitBandwidthInLan: limits.limitLan,
      minHomeDiskFree: { value: 1, unit: "%" },
      urAccepted: -1,
      crashReportingEnabled: true,
      reconnectionIntervalS: 60,
      alwaysLocalNets: [],
    },
    gui: { address: "127.0.0.1:8384", useTLS: false, authMode: "static", user: "", managedBy: "stack" },
    keeper: nodeId === "17aa" ? "host-agent" : "nodes-service",
  };
}

export function hostSettingsFixture() {
  return { name: "finn-pc", tailnetName: "finn-pc.example.ts.net", peerDashboards: [], ntfy: { url: "", topicSet: false }, priorityBands: null, setupRepo: true };
}
