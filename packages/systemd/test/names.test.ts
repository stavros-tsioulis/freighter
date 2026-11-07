import { describe, expect, it } from "vitest";
import { assertUnitName, unitName } from "../src/index.ts";

describe("unitName", () => {
  it("builds names", () => {
    expect(unitName({ app: "myapp", service: "web" })).toBe("freighter-myapp--web.service");
    expect(unitName({ app: "myapp", service: "web", instance: "r2" })).toBe("freighter-myapp--web--r2.service");
  });
  it("is unambiguous for hyphenated names", () => {
    expect(unitName({ app: "my-web", service: "x" })).not.toBe(unitName({ app: "my", service: "web-x" }));
  });
  it.each(["../x", "a b", "Web", "a\nb", "", "1a", "a--b", "a-"])("rejects %j", (bad) => {
    expect(() => unitName({ app: bad, service: "web" })).toThrow();
  });
  it("assertUnitName only accepts freighter units", () => {
    expect(() => assertUnitName("sshd.service")).toThrow();
    expect(() => assertUnitName("freighter-a-b.service\n")).toThrow();
  });
});
