import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type JoinDependencies, admitCaller } from "../src/join.js";
import { type StatusResponse, type WhoIsResponse, parseOwnLogin, parseWhoIs } from "../src/tailnet.js";

/** `tailscale whois --json 100.75.76.90` from the storage node, 2026-10-21, trimmed to what is read. */
const pcWhoIs: WhoIsResponse = {
  Node: {
    Name: "win-pc-von-finn.tail5c385a.ts.net.",
    Addresses: ["100.75.76.90/32", "fd7a:115c:a1e0::ca38:4c5c/128"],
  },
  UserProfile: { LoginName: "finn@birich.de" },
};

/** The same node's whois once it carries a tag: tailscale names the shared tagged-devices user. */
const taggedWhoIs: WhoIsResponse = {
  Node: { Name: "stick.tail5c385a.ts.net.", Tags: ["tag:storage"], Addresses: ["100.64.0.6/32"] },
  UserProfile: { LoginName: "tagged-devices" },
};

/** `tailscale status --self --json` of the stack's node: Tags is null when it has none. */
const storageStatus: StatusResponse = {
  Self: { UserID: 7212756888978405, Tags: null },
  User: { "7212756888978405": { LoginName: "finn@birich.de" } },
};

function dependencies(whoIs: WhoIsResponse, allowed: string[]): JoinDependencies {
  return {
    whois: async (address) => (address.startsWith("100.") ? parseWhoIs(whoIs) : null),
    allowedUsers: async () => allowed,
    requiredTag: "tag:storage",
  } as JoinDependencies;
}

describe("the tailnet's answers about a caller", () => {
  it("reads a user's device by its login and drops the trailing dot", () => {
    assert.deepEqual(parseWhoIs(pcWhoIs), {
      loginName: "finn@birich.de",
      tags: [],
      nodeName: "win-pc-von-finn.tail5c385a.ts.net",
      addresses: ["100.75.76.90/32", "fd7a:115c:a1e0::ca38:4c5c/128"],
    });
  });

  it("gives a tagged device no login", () => {
    assert.equal(parseWhoIs(taggedWhoIs)?.loginName, null);
    assert.deepEqual(parseWhoIs(taggedWhoIs)?.tags, ["tag:storage"]);
  });

  it("knows no node in an empty answer", () => {
    assert.equal(parseWhoIs({}), null);
    assert.equal(parseWhoIs(null), null);
  });

  it("names the stack node's owner, with Tags null", () => {
    assert.equal(parseOwnLogin(storageStatus), "finn@birich.de");
  });

  it("names no owner for a tagged stack node", () => {
    assert.equal(parseOwnLogin({ ...storageStatus, Self: { UserID: 7212756888978405, Tags: ["tag:server"] } }), null);
  });

  it("admits the PC whose user owns the stack's node, by its forwarded tailnet address", async () => {
    const caller = await admitCaller(dependencies(pcWhoIs, [parseOwnLogin(storageStatus) as string]), ["100.75.76.90:51234"]);
    assert.equal(caller.loginName, "finn@birich.de");
  });

  it("refuses the loopback address tailscale's TCP forward leaves Caddy with", async () => {
    await assert.rejects(admitCaller(dependencies(pcWhoIs, ["finn@birich.de"]), ["127.0.0.1:43892"]), /not a device of this tailnet/);
  });

  it("admits a tag:storage device when the stack's node is tagged and lists no user", async () => {
    const caller = await admitCaller(dependencies(taggedWhoIs, []), ["100.64.0.6:40000"]);
    assert.deepEqual(caller.tags, ["tag:storage"]);
  });
});
