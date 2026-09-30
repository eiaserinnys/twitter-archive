/** Archive exports use bitrate; X API v2 uses bit_rate. */
export function highestBitrateMp4(variants: unknown): string | null {
  if (!Array.isArray(variants)) return null;
  const items = variants.filter((item) => item && item.content_type === "video/mp4" && typeof item.url === "string" && item.url.length > 0);
  return items.sort((left, right) => Number(left.bit_rate ?? left.bitrate ?? 0) - Number(right.bit_rate ?? right.bitrate ?? 0)).at(-1)?.url ?? null;
}
