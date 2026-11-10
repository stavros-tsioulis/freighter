import { describe, expect, it } from "vitest";
import { chartGeometry, nearest, niceMax } from "../app/utils/chart";

describe("chart geometry", () => {
  it("puts time on x and 0..max on y, and draws a hole where there are no readings", () => {
    const g = chartGeometry([{ t: 0, v: 0 }, { t: 10, v: 50 }, { t: 20, v: 100 }, { t: 100, v: 100 }, { t: 110, v: 50 }], 0, 110, 100, 112, 52, 30);
    expect(g.dots[0]).toMatchObject({ x: 2, y: 50 });
    expect(g.dots[2]).toMatchObject({ y: 2 });
    expect(g.line.split("M").length - 1).toBe(2); // two runs
    expect(g.area.split("M").length - 1).toBe(2);
  });
  it("clamps what is off the scale, skips gaps in the data, and ignores points outside the window", () => {
    const g = chartGeometry([{ t: -500, v: 5 }, { t: 5, v: null }, { t: 10, v: 500 }], 0, 20, 100, 100, 50, 30);
    expect(g.dots).toHaveLength(1);
    expect(g.dots[0]!.y).toBe(2);
    expect(chartGeometry([], 0, 1, 1, 10, 10, 1)).toEqual({ line: "", area: "", dots: [] });
  });
  it("finds the point under the pointer", () => {
    const g = chartGeometry([{ t: 0, v: 1 }, { t: 50, v: 2 }, { t: 100, v: 3 }], 0, 100, 4, 104, 20, 1000);
    expect(nearest(g.dots, 60)!.v).toBe(2);
    expect(nearest(g.dots, 1000)!.v).toBe(3);
    expect(nearest([], 5)).toBeUndefined();
  });
  it("picks tidy upper bounds", () => {
    expect([niceMax(0.3), niceMax(1.4, 1), niceMax(3.2, 1), niceMax(7), niceMax(12), niceMax(60)]).toEqual([1, 2, 5, 10, 20, 100].map((x, i) => [1, 2, 5, 10, 20, 100][i]));
  });
});
