import { describe, expect, it } from "vitest";
import { daysUntil, durationBetween, formatBytes, formatDuration, shortRelease, timeAgo } from "../app/utils/format";
import { sparkline } from "../app/utils/sparkline";

describe("format", () => {
  it("formats bytes", () => {
    expect(formatBytes(null)).toBe("–");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(256 * 1024 * 1024)).toBe("256 MiB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GiB");
  });
  it("formats durations", () => {
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(83_000)).toBe("1m 23s");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    expect(formatDuration(629 * 3_600_000)).toBe("26d 5h");
    expect(formatDuration(-1)).toBe("–");
    expect(formatDuration(null)).toBe("–");
  });
  it("formats relative times", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    expect(timeAgo("2026-11-06T11:59:58Z", now)).toBe("just now");
    expect(timeAgo("2026-11-06T11:58:00Z", now)).toBe("2 minutes ago");
    expect(timeAgo("2026-11-06T11:59:00Z", now)).toBe("1 minute ago");
    expect(timeAgo("2026-11-06T09:00:00Z", now)).toBe("3 hours ago");
    expect(timeAgo("2026-11-03T12:00:00Z", now)).toBe("3 days ago");
    expect(timeAgo("2026-11-09T12:00:00Z", now)).toBe("in 3 days");
    expect(timeAgo(null, now)).toBe("–");
    expect(timeAgo("garbage", now)).toBe("–");
  });
  it("computes days until and durations between", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    expect(daysUntil("2026-11-16T12:00:00Z", now)).toBe(10);
    expect(daysUntil("2026-11-05T12:00:00Z", now)).toBe(-1);
    expect(daysUntil(null, now)).toBeNull();
    expect(durationBetween("2026-11-06T12:00:00Z", "2026-11-06T12:00:05Z")).toBe(5000);
    expect(durationBetween(null, "x")).toBeNull();
    expect(shortRelease("r20261106-134500-2")).toBe("20261106-134500-2");
    expect(shortRelease(null)).toBe("–");
  });
});

describe("sparkline", () => {
  it("returns nothing for empty or all-null input", () => {
    expect(sparkline([], 100, 20).count).toBe(0);
    expect(sparkline([null, null], 100, 20).line).toBe("");
  });
  it("scales into the box with min at the bottom and max at the top", () => {
    const g = sparkline([0, 10], 100, 20, 2);
    expect(g.line).toBe("M2 18L98 2");
    expect(g.area).toBe("M2 18L98 2L98 20L2 20Z");
    expect([g.min, g.max, g.count]).toEqual([0, 10, 2]);
  });
  it("draws a flat series mid-height", () => {
    expect(sparkline([5, 5, 5], 100, 20).line).toBe("M2 10L50 10L98 10");
  });
  it("breaks the line at gaps and skips the area", () => {
    const g = sparkline([1, null, 3, 4], 90, 20, 0);
    expect(g.line.match(/M/g)).toHaveLength(2);
    expect(g.area).toBe("");
    expect(g.count).toBe(3);
  });
  it("renders a lone point as a visible tick", () => {
    expect(sparkline([7], 100, 20).line).toBe("M2 10h0.01");
  });
});

import { validateRepoUrl } from "../app/utils/validation";

describe("validateRepoUrl (client-side hint; the server decides)", () => {
  it("accepts ssh and https remotes", () => {
    for (const u of ["git@github.com:acme/shop.git", "ssh://git@host.example.com:2222/org/repo", "https://gitlab.com/group/repo.git"]) expect(validateRepoUrl(u)).toBe("");
  });
  it("explains everything else", () => {
    for (const u of ["--upload-pack=x", "ext::sh -c id", "file:///etc", "/srv/repo.git", "http://github.com/a/b", "git@host:../x", "a b"]) expect(validateRepoUrl(u)).not.toBe("");
  });
});
