export interface TweetUrlEntity {
  url?: string;
  expanded_url?: string;
}

export function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
    nbsp: "\u00a0",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return named[name.toLowerCase()] ?? entity;
  });
}

export function normalizeTweetText(
  expandedText: string,
  urls: TweetUrlEntity[],
  mediaUrls: ReadonlySet<string>,
): string {
  let text = decodeHtmlEntities(expandedText);
  for (const url of urls) {
    if (!url.url) continue;
    text = text.split(url.url).join(mediaUrls.has(url.url) ? "" : (url.expanded_url ?? url.url));
  }
  for (const url of mediaUrls) text = text.split(url).join("");
  return text.trim();
}
