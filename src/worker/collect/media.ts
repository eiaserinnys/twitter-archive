import type { TweetMedia } from "../../shared/types.js";
import type { Env } from "../env.js";

/** R2 needs a known-length stream. Fetch bodies retain their Content-Length. */
export async function mediaBody(response: Response): Promise<ReadableStream<Uint8Array> | ArrayBuffer> {
  return response.body && response.headers.has("content-length") ? response.body : response.arrayBuffer();
}

export function mediaExtension(media: Pick<TweetMedia, "type">, url: string): string {
  if (media.type !== "photo") return "mp4";
  const format = url.match(/[?&]format=([a-z0-9]+)/i)?.[1]?.toLowerCase();
  const extension = url.split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const name = format ?? extension ?? "jpg";
  return ["jpg", "jpeg", "png", "webp", "gif"].includes(name) ? name : "jpg";
}

export function articleCoverUrl(article: unknown, includedMedia: unknown): string | null {
  if (!article || typeof article !== "object" || !("cover_media" in article) || !Array.isArray(includedMedia)) return null;
  const cover = includedMedia.find(media => media?.media_key === article.cover_media);
  return typeof cover?.url === "string" && cover.url.length > 0 ? cover.url : null;
}

export async function uploadArticleCover(env: Env, id: string, url: string | null, fetchImpl: typeof fetch): Promise<string | null> {
  if (!url) return null;
  const key = `media/${id}/article-cover.${mediaExtension({ type: "photo" }, url)}`;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`Media HTTP ${response.status}`);
    await env.MEDIA.put(key, await mediaBody(response), {
      httpMetadata: { contentType: response.headers.get("content-type") ?? "application/octet-stream" },
    });
    return key;
  } catch (error) {
    console.error(`Could not store article cover ${id}.`, error);
    return null;
  }
}
