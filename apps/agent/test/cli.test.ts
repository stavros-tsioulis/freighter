import { describe, expect, it } from "vitest";
import { script, type Tree } from "../src/commands/completion.ts";
import { parseEnrollmentPort } from "../src/commands/enroll.ts";

const tree: Tree = { serve: {}, enroll: {}, version: {}, completion: {} };

describe("freighter-agent CLI", () => {
  it("accepts an unset port, and only ports in range", () => {
    expect(parseEnrollmentPort(undefined)).toBeUndefined();
    expect(parseEnrollmentPort("7443")).toBe(7443);
    expect(parseEnrollmentPort("1")).toBe(1);
    expect(parseEnrollmentPort("65535")).toBe(65535);
  });

  it("rejects out-of-range and non-numeric ports as usage errors", () => {
    for (const value of ["0", "65536", "-1", "abc", "1.5", ""]) {
      expect(() => parseEnrollmentPort(value)).toThrow(/port number from 1 to 65535/);
    }
  });

  it("prints completion scripts for the agent command", () => {
    expect(script("bash", tree, "freighter-agent")).toContain("complete -F _freighter_agent freighter-agent");
    expect(script("bash", tree, "freighter-agent")).toContain("serve enroll version completion");
    expect(script("zsh", tree, "freighter-agent")).toContain("#compdef freighter-agent");
    expect(script("fish", tree, "freighter-agent")).toContain("complete -c freighter-agent");
  });

  it("rejects an unknown shell", () => {
    expect(() => script("tcsh", tree, "freighter-agent")).toThrow(/unknown shell/);
  });
});
