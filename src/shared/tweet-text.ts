export interface TweetUrlEntity {
  url?: string;
  expanded_url?: string;
  media_key?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function tweetTextUrlEntities(tweet: unknown): TweetUrlEntity[] {
  const post = record(tweet);
  if (!post) return [];
  const noteTweet = record(post.note_tweet);
  const usesNoteText = nonEmptyString(noteTweet?.text);
  const entities = record(usesNoteText ? noteTweet?.entities : post.entities);
  return Array.isArray(entities?.urls)
    ? entities.urls.filter((item): item is TweetUrlEntity => Boolean(record(item)))
    : [];
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
