import { describe, expect, it } from "vitest";
import { ops } from "../src/index.ts";

describe("protocol schemas", () => {
  it("validates app names and applies defaults", () => {
    expect(ops["app.history"].args.parse({ app: "shop" })).toEqual({ app: "shop", limit: 50 });
    expect(ops["app.logs"].args.parse({ app: "shop", service: "web" }).lines).toBe(100);
    for (const bad of ["../x", "Shop", "a b", "", "a--b"]) expect(ops["app.info"].args.safeParse({ app: bad }).success).toBe(false);
  });
  it("bounds arguments", () => {
    expect(ops["app.logs"].args.safeParse({ app: "a", service: "w", lines: 5000 }).success).toBe(false);
    expect(ops["app.control"].args.safeParse({ app: "a", verb: "rm" }).success).toBe(false);
    expect(ops["env.set"].args.safeParse({ app: "a", key: "lower", value: "x" }).success).toBe(false);
    expect(ops["env.set"].args.safeParse({ app: "a", key: "K", value: "x\ny" }).success).toBe(false);
    expect(ops["env.set"].args.safeParse({ app: "a", key: "K", value: "ok" }).success).toBe(true);
  });
});
