import { afterEach, describe, expect, it } from "vitest";
import { localCookie, remoteApiUrl } from "../server/utils/remote";

describe("FREIGHTER_API_URL", () => {
  const set = (v: string | undefined) => { if (v === undefined) delete process.env.FREIGHTER_API_URL; else process.env.FREIGHTER_API_URL = v; };
  afterEach(() => set(undefined));

  it("is off when unset or blank, and normalises to an origin", () => {
    expect(remoteApiUrl()).toBeNull();
    set("  ");
    expect(remoteApiUrl()).toBeNull();
    set("https://freighter.example.com/");
    expect(remoteApiUrl()).toBe("https://freighter.example.com");
    set("http://10.0.0.5:3000/some/path");
    expect(remoteApiUrl()).toBe("http://10.0.0.5:3000");
  });
  it("refuses things that are not http(s) URLs", () => {
    set("freighter.example.com");
    expect(() => remoteApiUrl()).toThrow(/not a URL/);
    set("ftp://x.example.com");
    expect(() => remoteApiUrl()).toThrow(/http/);
  });
});

describe("localCookie", () => {
  it("drops Secure and Domain so the cookie works on http://localhost, and keeps the rest", () => {
    expect(localCookie("fr_session=abc; Path=/; Expires=Wed, 11 Nov 2026 10:00:00 GMT; HttpOnly; Secure; SameSite=Strict; Domain=freighter.example.com"))
      .toBe("fr_session=abc; Path=/; Expires=Wed, 11 Nov 2026 10:00:00 GMT; HttpOnly; SameSite=Strict");
  });
});
