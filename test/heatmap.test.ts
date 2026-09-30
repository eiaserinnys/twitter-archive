import { describe, expect, it } from "vitest";
// Browser-native modules are tested without creating the timeline DOM.
// @ts-expect-error Browser assets are outside the TypeScript source tree.
import { heatmapLevel, heatmapThresholds, heatmapTopicCounts } from "../web/assets/heatmap.js";

Object.defineProperty(globalThis, "matchMedia", {
  configurable: true,
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: { getItem: () => null, setItem() {} },
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { querySelector: () => null },
});
// @ts-expect-error Browser assets are outside the TypeScript source tree.
const { heatmapLegendLabels } = await import("../web/assets/timeline.js");
// @ts-expect-error Browser assets are outside the TypeScript source tree.
const { orderTopics, topicColor } = await import("../web/assets/dom.js");

describe("builtin topic presentation", () => {
  it("pins other after regular topics and uses the existing neutral token", () => {
    const regular = { id: "games", sort_order: 99 };
    const other = { id: "other", sort_order: 0, builtin: true };
    expect(orderTopics([other, regular]).map((topic: { id: string }) => topic.id)).toEqual(["games", "other"]);
    expect(topicColor(other, 0)).toBe("var(--ink-3)");
    expect(topicColor(other, 8)).toBe("var(--ink-3)");
    expect(topicColor(regular, 0)).toBe("#FF5436");
  });

  it("excludes other values from the ramp and paints them with the regular thresholds", () => {
    const topics = [{ id: "games" }, { id: "other", builtin: true }];
    const rows = [{ counts: { games: 2, other: 10000 } }, { counts: { games: 9, other: 20000 } }];
    const counts = heatmapTopicCounts(rows, topics);
    expect(counts).toEqual([2, 9]);
    expect(heatmapThresholds(counts)).toEqual(heatmapThresholds([2, 9]));
    expect(heatmapLevel(10000, heatmapThresholds(counts))).toBe(5);
  });
});

describe("nearest-rank table-relative heatmap levels", () => {
  it("splits the 250-cell reference distribution across five levels", () => {
    const counts = [
      ...Array.from({ length: 50 }, (_, index) => 1 + index % 5),
      ...Array.from({ length: 50 }, (_, index) => 6 + index % 8),
      ...Array.from({ length: 50 }, (_, index) => 14 + index % 25),
      ...Array.from({ length: 49 }, (_, index) => 39 + index % 42),
      81, 81,
      ...Array.from({ length: 48 }, (_, index) => 82 + index),
      489,
    ];
    const thresholds = heatmapThresholds(counts);

    expect(counts).toHaveLength(250);
    expect(thresholds).toEqual([5, 13, 38, 81]);
    expect(counts.reduce((levels, count) => {
      levels[heatmapLevel(count, thresholds)] += 1;
      return levels;
    }, [0, 0, 0, 0, 0, 0])).toEqual([0, 50, 50, 50, 51, 49]);
  });

  it("ignores zero cells when finding thresholds and keeps them at level zero", () => {
    const thresholds = heatmapThresholds([0, 2, 0]);

    expect(thresholds).toEqual([2, 2, 2, 2]);
    expect(heatmapLevel(0, thresholds)).toBe(0);
    expect(heatmapThresholds([0, 0])).toEqual([0, 0, 0, 0]);
  });

  it("keeps repeated nearest-rank thresholds and skips their empty levels", () => {
    const thresholds = heatmapThresholds([0, 2, 2, 2, 2, 2, 9]);

    expect(thresholds).toEqual([2, 2, 2, 2]);
    expect([0, 2, 9].map(count => heatmapLevel(count, thresholds))).toEqual([0, 1, 5]);
  });

  it("handles a table with one nonzero cell", () => {
    const thresholds = heatmapThresholds([0, 7]);

    expect(thresholds).toEqual([7, 7, 7, 7]);
    expect([0, 7].map(count => heatmapLevel(count, thresholds))).toEqual([0, 1]);
  });

  it("labels the reference ranges and renders empty or single-value ranges", () => {
    expect(heatmapLegendLabels([5, 13, 38, 81], 489)).toEqual([
      "0", "1~5", "6~13", "14~38", "39~81", "82~489",
    ]);
    expect(heatmapLegendLabels([1, 1, 2, 2], 3)).toEqual([
      "0", "1", "–", "2", "–", "3",
    ]);
    expect(heatmapLegendLabels([0, 0, 0, 0], 0)).toEqual([
      "0", "–", "–", "–", "–", "–",
    ]);
  });
});
