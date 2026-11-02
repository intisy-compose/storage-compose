import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProfileError, defaultProfile, formatProfile, nodeLimitsOf, parseProfile, profileOptions, withNodeLimits } from "../src/connectionProfile.js";

describe("connection profile", () => {
  it("an empty file is the default profile", () => {
    assert.deepEqual(parseProfile(""), defaultProfile());
    assert.deepEqual(defaultProfile(), {
      methods: { lan: true, tailnet: true, nat: true },
      discovery: { global: "default" },
      relays: { public: true, bridges: true, bridgePort: 22100 },
      limits: { maxSendKbps: 0, maxRecvKbps: 0, limitLan: false },
      nodeLimits: {},
    });
  });

  it("profileOptions maps lan to localAnnounceEnabled and nat to natEnabled", () => {
    const profile = parseProfile("[methods]\nlan = false\nnat = true\ntailnet = false\n");
    const options = profileOptions(profile, "AB12");
    assert.equal(options.localAnnounceEnabled, false);
    assert.equal(options.natEnabled, true);
    assert.equal("listenAddresses" in options, false);
  });

  it("relaysEnabled is on when only bridges are on", () => {
    const only = (publicRelays: boolean, bridges: boolean) =>
      profileOptions(parseProfile(`[relays]\npublic = ${publicRelays}\nbridges = ${bridges}\n`), "AB12").relaysEnabled;
    assert.equal(only(false, true), true);
    assert.equal(only(true, false), true);
    assert.equal(only(false, false), false);
  });

  it('discovery "" turns global announce off and "default" keeps the default servers', () => {
    const options = (text: string) => profileOptions(parseProfile(text), "AB12");
    assert.equal(options('[discovery]\nglobal = ""\n').globalAnnounceEnabled, false);
    assert.deepEqual(options('[discovery]\nglobal = "default"\n').globalAnnounceServers, ["default"]);
    assert.equal(options('[discovery]\nglobal = "default"\n').globalAnnounceEnabled, true);
    const listed = options('[discovery]\nglobal = ["https://a.example/v2/", "https://b.example/v2/"]\n');
    assert.equal(listed.globalAnnounceEnabled, true);
    assert.deepEqual(listed.globalAnnounceServers, ["https://a.example/v2/", "https://b.example/v2/"]);
  });

  it("a node's limit override wins over the cluster default", () => {
    const profile = parseProfile(
      "[limits]\nmax_send_kbps = 1000\nmax_recv_kbps = 2000\nlimit_lan = true\n\n[limits.node.AB12-CD34]\nmax_send_kbps = 500\n",
    );
    assert.deepEqual(profile.nodeLimits, { "AB12-CD34": { maxSendKbps: 500 } });
    const override = profileOptions(profile, "AB12-CD34");
    assert.equal(override.maxSendKbps, 500);
    assert.equal(override.maxRecvKbps, 2000);
    assert.equal(override.limitBandwidthInLan, true);
    assert.equal(profileOptions(profile, "OTHER").maxSendKbps, 1000);
  });

  it("an unknown key is ignored and a wrong type names the key", () => {
    assert.deepEqual(parseProfile("[methods]\nwifi = true\n[extra]\nx = 1\n"), defaultProfile());
    assert.throws(() => parseProfile('[relays]\nbridge_port = "high"\n'), (error: unknown) => {
      return error instanceof ProfileError && error.message.includes("relays.bridge_port");
    });
    assert.throws(() => parseProfile("[methods]\nlan = 1\n"), /methods\.lan/);
    assert.throws(() => parseProfile("[discovery]\nglobal = 3\n"), /discovery\.global/);
    assert.throws(() => parseProfile("[limits.node.AB12]\nmax_send_kbps = true\n"), /limits\.node\.AB12\.max_send_kbps/);
  });

  it("formatProfile round-trips", () => {
    const profile = parseProfile(
      '[methods]\nnat = false\n[discovery]\nglobal = ["https://a.example/v2/"]\n[relays]\nbridge_port = 22200\n' +
        "[limits]\nmax_recv_kbps = 800\n[limits.node.AB12-CD34]\nmax_send_kbps = 500\nlimit_lan = true\n",
    );
    assert.deepEqual(parseProfile(formatProfile(profile)), profile);
    assert.deepEqual(parseProfile(formatProfile(defaultProfile())), defaultProfile());
    assert.equal(formatProfile(profile).includes("\r"), false);
  });

  it("a per-node limit saves into the profile override", () => {
    const profile = parseProfile("[limits]\nmax_send_kbps = 1000\n");
    const limited = withNodeLimits(profile, "fb98", { maxSendKbps: 200, maxRecvKbps: 0, limitLan: false });
    assert.deepEqual(limited.nodeLimits, { fb98: { maxSendKbps: 200 } }, "only what differs from the cluster default is the override");
    assert.match(formatProfile(limited), /\[limits\.node\.fb98\]\nmax_send_kbps = 200\n/);
    assert.deepEqual(nodeLimitsOf(limited, "fb98"), { maxSendKbps: 200, maxRecvKbps: 0, limitLan: false });
    assert.deepEqual(profile.nodeLimits, {}, "the profile it started from is left as it was");
    const back = withNodeLimits(limited, "fb98", { maxSendKbps: 1000, maxRecvKbps: 0, limitLan: false });
    assert.deepEqual(back.nodeLimits, {}, "a node back on the default has no override left");
    assert.equal(formatProfile(back).includes("limits.node"), false);
  });
});
