export const heatmapThresholds = counts => {
  const sorted = counts.filter(count => count > 0).sort((a, b) => a - b);
  if (!sorted.length) return [0, 0, 0, 0];
  return [0.2, 0.4, 0.6, 0.8].map(percentile =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)]);
};

export const heatmapLevel = (count, thresholds) =>
  count === 0 ? 0 : 1 + thresholds.filter(threshold => count > threshold).length;
