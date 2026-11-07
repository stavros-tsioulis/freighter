import { describe, expect, it } from "vitest";
import { splitCommand, toExecStart } from "../src/index.ts";

describe("splitCommand", () => {
  it("splits on whitespace and honours quotes", () => {
    expect(splitCommand("node  a.js  --name 'two words' \"x y\"")).toEqual(["node", "a.js", "--name", "two words", "x y"]);
  });
  it("keeps empty quoted args", () => {
    expect(splitCommand("a ''")).toEqual(["a", ""]);
  });
  it("rejects bad input", () => {
    expect(() => splitCommand("node 'oops")).toThrow(/unterminated/);
    expect(() => splitCommand("a\nb")).toThrow();
    expect(() => splitCommand("   ")).toThrow(/empty/);
  });
});

describe("toExecStart", () => {
  it("prefixes env for bare commands", () => {
    expect(toExecStart(["node", "a.js"])).toBe("/usr/bin/env node a.js");
  });
  it("keeps absolute commands", () => {
    expect(toExecStart(["/usr/bin/node", "a.js"])).toBe("/usr/bin/node a.js");
  });
  it("escapes systemd specifiers and variables, quotes spaces", () => {
    expect(toExecStart(["node", "100%", "$HOME", "a b"])).toBe('/usr/bin/env node 100%% $$HOME "a b"');
  });
});
