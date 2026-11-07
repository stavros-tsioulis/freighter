import { describe, expect, it } from "vitest";
import { validateBranch, validateRepoUrl, validateSubpath } from "../src/index.ts";

describe("validateRepoUrl", () => {
  it.each([
    "git@github.com:org/repo.git",
    "git@gitlab.example.com:group/sub/repo.git",
    "ssh://git@github.com/org/repo.git",
    "ssh://git@host.example.com:2222/org/repo",
    "https://github.com/org/repo.git",
    "https://gitlab.com/group/repo",
  ])("accepts %s", (u) => expect(validateRepoUrl(u)).toBe(u));

  it.each([
    "", "   ", "-oProxyCommand=evil", "--upload-pack=evil", "ext::sh -c touch /tmp/pwned", "file:///etc", "/srv/repo.git",
    "git://github.com/org/repo.git", "http://github.com/org/repo", "https://github.com/org/repo.git; rm -rf /",
    "git@github.com:org/repo.git\nProxyCommand=x", "https://user:pass@github.com/org/repo", "git@host:../../etc/passwd", "ssh://-oProxyCommand=x/a",
  ])("rejects %j", (u) => expect(() => validateRepoUrl(u)).toThrow());

  it("accepts local repositories only when allowed", () => {
    expect(() => validateRepoUrl("/srv/git/demo.git")).toThrow();
    expect(validateRepoUrl("/srv/git/demo.git", { allowLocal: true })).toBe("/srv/git/demo.git");
    expect(validateRepoUrl("file:///srv/git/demo.git", { allowLocal: true })).toBe("file:///srv/git/demo.git");
    expect(() => validateRepoUrl("/srv/../etc", { allowLocal: true })).toThrow();
  });
});

describe("validateBranch / validateSubpath", () => {
  it("accepts ordinary names", () => {
    for (const b of ["main", "release/1.2", "feature-x_y.z"]) expect(validateBranch(b)).toBe(b);
    expect(validateSubpath("apps/web")).toBe("apps/web");
    expect(validateSubpath("./apps/web/")).toBe("apps/web");
    expect(validateSubpath("")).toBe("");
  });
  it("rejects option-like and traversal values", () => {
    for (const b of ["-x", "a..b", "a b", "a:b", "HEAD~1", "x;y", "", "a/", "a.lock"]) expect(() => validateBranch(b)).toThrow();
    for (const p of ["../x", "/abs", "a/../b", "a b", "a;b"]) expect(() => validateSubpath(p)).toThrow();
  });
});
