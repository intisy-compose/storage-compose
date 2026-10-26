import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type NodeRoot, folderPathProblem, isInsideOtherNode, isInsideRoot, pathUnderRoot } from "../src/pathGuard.js";

const pc: NodeRoot = { nodeId: "fb98", name: "pc", root: "F:\\", os: "windows" };
const nestedOnPc: NodeRoot = { nodeId: "a1b2", name: "stick", root: "F:\\.storage\\stick", os: "windows" };
const peer: NodeRoot = { nodeId: "d7e5", name: "dashboard-test-peer", root: "/var/syncthing/data", os: "linux" };

describe("the folder path guard", () => {
  it("isInsideRoot accepts F:\\\\Documents for root F:\\\\ and f:/Documents, refuses G:\\\\x and F:\\\\..\\\\x", () => {
    assert.equal(isInsideRoot("F:\\Documents", "F:\\", "windows"), true);
    assert.equal(isInsideRoot("f:/Documents", "F:\\", "windows"), true);
    assert.equal(isInsideRoot("G:\\x", "F:\\", "windows"), false);
    assert.equal(isInsideRoot("F:\\..\\x", "F:\\", "windows"), false);
  });

  it("the root itself is inside, either slash and any case on Windows", () => {
    assert.equal(isInsideRoot("F:\\", "F:\\", "windows"), true);
    assert.equal(isInsideRoot("f:/", "F:\\", "windows"), true);
    assert.equal(isInsideRoot("F:\\.storage\\Dashboard-Test", "f:/.storage/dashboard-test", "windows"), true);
    assert.equal(isInsideRoot("/var/syncthing/data", "/var/syncthing/data", "linux"), true);
  });

  it("linux paths are case-sensitive", () => {
    assert.equal(isInsideRoot("/var/syncthing/data/x", "/var/syncthing/data", "linux"), true);
    assert.equal(isInsideRoot("/var/Syncthing/data/x", "/var/syncthing/data", "linux"), false);
    assert.equal(isInsideRoot("/VAR/syncthing/data", "/var/syncthing/data", "linux"), false);
  });

  it("dot-dot segments are resolved before the check", () => {
    assert.equal(isInsideRoot("F:\\Documents\\..\\Music", "F:\\", "windows"), true);
    assert.equal(isInsideRoot("F:\\.storage\\x\\..\\..\\Windows", "F:\\.storage", "windows"), false);
    assert.equal(isInsideRoot("/var/syncthing/data/../../../etc", "/var/syncthing/data", "linux"), false);
    assert.equal(isInsideRoot("/var/syncthing/data/a/../b", "/var/syncthing/data", "linux"), true);
  });

  it("a drive-relative, relative, UNC or home path is refused", () => {
    assert.equal(isInsideRoot("F:foo", "F:\\", "windows"), false);
    assert.equal(isInsideRoot("F:", "F:\\", "windows"), false);
    assert.equal(isInsideRoot("Documents", "F:\\", "windows"), false);
    assert.equal(isInsideRoot("\\\\server\\F$\\x", "F:\\", "windows"), false);
    assert.equal(isInsideRoot("\\\\?\\F:\\x", "F:\\", "windows"), false);
    assert.equal(isInsideRoot("var/syncthing/data/x", "/var/syncthing/data", "linux"), false);
    assert.equal(isInsideRoot("~/x", "/var/syncthing/data", "linux"), false);
  });

  it("a linux backslash is part of a name, not a separator", () => {
    assert.equal(isInsideRoot("/var/syncthing/data\\..\\..", "/var/syncthing/data", "linux"), false);
    assert.equal(isInsideRoot("/var/syncthing/data/a\\..\\..", "/var/syncthing/data", "linux"), true);
  });

  it("a path inside another node's root on this host is refused, and so is one that holds it", () => {
    assert.equal(isInsideOtherNode("F:\\.storage\\stick\\photos", pc, [pc, nestedOnPc]), nestedOnPc);
    assert.equal(isInsideOtherNode("f:/.STORAGE/stick", pc, [pc, nestedOnPc]), nestedOnPc);
    assert.equal(isInsideOtherNode("F:\\Documents", pc, [pc, nestedOnPc]), null);
    assert.match(folderPathProblem("F:\\.storage\\stick\\photos", pc, [pc, nestedOnPc]) ?? "", /inside stick's root/);
    assert.match(folderPathProblem("F:\\.storage", pc, [pc, nestedOnPc]) ?? "", /holds stick's root/);
    assert.equal(folderPathProblem("F:\\.storage\\dashboard-test\\dashboard-test-a", pc, [pc, nestedOnPc]), null);
  });

  it("another system's node or one whose root holds this node's is no nested node", () => {
    const linuxSameText: NodeRoot = { nodeId: "c3d4", name: "container", root: "F:\\Documents", os: "linux" };
    assert.equal(isInsideOtherNode("F:\\Documents\\x", pc, [linuxSameText]), null);
    assert.equal(isInsideOtherNode("F:\\.storage\\stick\\x", nestedOnPc, [pc, nestedOnPc]), null);
    assert.equal(folderPathProblem("F:\\.storage\\stick\\x", nestedOnPc, [pc, nestedOnPc]), null);
  });

  it("the problem names the node and its root, and an empty path is missing", () => {
    assert.equal(folderPathProblem("C:\\Windows", pc, [pc]), "C:\\Windows is outside pc's root F:\\");
    assert.equal(folderPathProblem("/etc", peer, [peer]), "/etc is outside dashboard-test-peer's root /var/syncthing/data");
    assert.equal(folderPathProblem("  ", peer, [peer]), "the folder path is missing");
  });

  it("a path below a root is written with the node's separator", () => {
    assert.equal(pathUnderRoot("F:\\", "Documents/Projects", "windows"), "F:\\Documents\\Projects");
    assert.equal(pathUnderRoot("F:\\.storage\\", "x", "windows"), "F:\\.storage\\x");
    assert.equal(pathUnderRoot("F:\\", "", "windows"), "F:\\");
    assert.equal(pathUnderRoot("/var/syncthing/data", "dashboard-test-a", "linux"), "/var/syncthing/data/dashboard-test-a");
    assert.equal(pathUnderRoot("/", "srv", "linux"), "/srv");
  });
});
