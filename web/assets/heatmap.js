export const heatmapLevel = (count, max) => count === 0 ? 0 : Math.min(5, Math.ceil(count / max * 5));
