import { describe, expect, it } from "vitest";
// Browser-native module is tested directly, without loading the timeline DOM.
// @ts-expect-error Browser assets are outside the TypeScript source tree.
import { heatmapLevel } from "../web/assets/heatmap.js";

describe("table-relative heatmap levels", () => {
  it("keeps zeros empty and maps hundreds by their table maximum", () => {
    expect([0, 1, 100, 101, 200, 201, 300, 301, 400, 401, 500].map(count => heatmapLevel(count, 500)))
      .toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });
  it("uses an independent maximum for each table", () => {
    expect(heatmapLevel(100, 500)).toBe(1);
    expect(heatmapLevel(100, 100)).toBe(5);
    expect(heatmapLevel(0, 0)).toBe(0);
  });
});
