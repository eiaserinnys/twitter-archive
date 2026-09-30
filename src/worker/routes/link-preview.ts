import { Hono } from "hono";
import type { Viewer } from "../auth.js";
import type { Env } from "../env.js";
import { publicHiddenSql } from "../visibility.js";
import type { AppContext } from "./helpers.js";

type PreviewStatus = "ok" | "none" | "error";

interface LinkPreview {
  url: string;
  status: PreviewStatus;
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
}

type LinkPreviewRow = LinkPreview;

const FETCH_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 512 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RESTRICTED_HOSTS = ["x.com", "twitter.com", "t.co"];

const route = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>();

route.get("/api/link-preview", async (context: AppContext) => {
  const tweetId = context.req.query("tweet");
  const url = context.req.query("url");
  if (!tweetId || !url) return context.json({ error: "not_found" }, 404);

  const viewer = context.get("viewer");
  const hiddenFilter = viewer.viewingAs === "visitor" ? `AND NOT ${publicHiddenSql("t")}` : "";
  const tweet = await context.env.DB.prepare(`
    SELECT t.text FROM tweets t WHERE t.id = ? ${hiddenFilter}
  `).bind(tweetId).first<{ text: string }>();
  if (!tweet || !tweet.text.includes(url)) return context.json({ error: "not_found" }, 404);

  const initialUrl = allowedHttpUrl(url);
  if (!initialUrl) return context.json({ error: "not_found" }, 404);

  const cached = await context.env.DB.prepare(`
    SELECT url, status, title, description, image, site_name
    FROM link_previews WHERE url = ?
  `).bind(url).first<LinkPreviewRow>();
  if (cached) return previewResponse(context, cached);

  const preview = await fetchPreview(url, initialUrl);
  await context.env.DB.prepare(`
    INSERT OR IGNORE INTO link_previews (url, status, title, description, image, site_name, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    preview.url,
    preview.status,
    preview.title,
    preview.description,
    preview.image,
    preview.site_name,
    new Date().toISOString(),
  ).run();
  return previewResponse(context, preview);
});

function previewResponse(context: AppContext, preview: LinkPreviewRow): Response {
  const body = {
    url: preview.url,
    status: preview.status,
    title: preview.title,
    description: preview.description,
    image: preview.image,
    site_name: preview.site_name,
  };
  if (preview.status === "error") return context.json(body);
  return context.json(body, 200, { "Cache-Control": "public, max-age=86400" });
}

async function fetchPreview(url: string, initialUrl: URL): Promise<LinkPreview> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let currentUrl = initialUrl;
    let redirects = 0;
    while (true) {
      const response = await fetch(currentUrl.toString(), {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; twitter-archive-link-preview/1.0; +https://github.com/eiaserinnys/twitter-archive)" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects >= MAX_REDIRECTS) {
          await cancelBody(response);
          return emptyPreview(url, "error");
        }
        const location = response.headers.get("Location");
        const nextUrl = location ? allowedHttpUrl(location, currentUrl) : null;
        await cancelBody(response);
        if (!nextUrl) return emptyPreview(url, "error");
        currentUrl = nextUrl;
        redirects += 1;
        continue;
      }
      if (!response.ok) {
        await cancelBody(response);
        return emptyPreview(url, "error");
      }
      if (response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "text/html") {
        await cancelBody(response);
        return emptyPreview(url, "none");
      }

      const bytes = await readBodyPrefix(response.body);
      const html = decodeHtml(bytes, response.headers.get("Content-Type"));
      return parsePreview(url, html, currentUrl.toString());
    }
  } catch {
    return emptyPreview(url, "error");
  } finally {
    clearTimeout(timeout);
  }
}

function allowedHttpUrl(value: string, base?: URL): URL | null {
  try {
    const parsed = base ? new URL(value, base) : new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (RESTRICTED_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The redirect response is already unusable; continue with its Location.
  }
}

async function readBodyPrefix(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_BODY_BYTES) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const remaining = MAX_BODY_BYTES - total;
      const chunk = value.subarray(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < value.byteLength || total === MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const prefix = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return prefix;
}

function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  const asciiHtml = new TextDecoder("windows-1252").decode(bytes);
  const head = extractHead(asciiHtml) ?? "";
  const headerCharset = contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  const metaCharset = metaTags(head)
    .map((tag) => getAttribute(tag, "charset"))
    .find((value): value is string => Boolean(value));
  for (const charset of [headerCharset, metaCharset, "utf-8"]) {
    if (!charset) continue;
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Try the next declared encoding, then UTF-8.
    }
  }
  return new TextDecoder().decode(bytes);
}

function extractHead(html: string): string | null {
  const match = html.match(/<head\b[^>]*>([\s\S]*?)(?:<\/head\s*>|$)/i);
  return match?.[1] ?? null;
}

function metaTags(head: string): string[] {
  return [...head.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => tag);
}

function getAttribute(tag: string, name: string): string | null {
  const attributes = tag.matchAll(/(?:^|\s)([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi);
  for (const [, key, doubleQuoted, singleQuoted, unquoted] of attributes) {
    if (key?.toLowerCase() === name.toLowerCase()) return doubleQuoted ?? singleQuoted ?? unquoted ?? null;
  }
  return null;
}

function metaContent(head: string, property: string): string | null {
  for (const tag of metaTags(head)) {
    const tagProperty = getAttribute(tag, "property")?.toLowerCase();
    const tagName = getAttribute(tag, "name")?.toLowerCase();
    if (tagProperty !== property && tagName !== property) continue;
    const content = getAttribute(tag, "content");
    if (content) return cleanText(content);
  }
  return null;
}

function titleContent(head: string): string | null {
  const match = head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!match) return null;
  return cleanText(match[1].replace(/<[^>]*>/g, " "));
}

function cleanText(value: string): string | null {
  const decoded = decodeEntities(value).replace(/\s+/g, " ").trim();
  return decoded || null;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name: string) => {
    const normalized = name.toLowerCase();
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
    };
    if (normalized in named) return named[normalized];
    const codePoint = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    try {
      return Number.isInteger(codePoint) ? String.fromCodePoint(codePoint) : entity;
    } catch {
      return entity;
    }
  });
}

function parsePreview(url: string, html: string, finalUrl: string): LinkPreview {
  const head = extractHead(html);
  if (!head) return emptyPreview(url, "none");

  const title = truncate(metaContent(head, "og:title")
    ?? metaContent(head, "twitter:title")
    ?? titleContent(head), 200);
  const description = truncate(metaContent(head, "og:description")
    ?? metaContent(head, "description"), 300);
  const imageValue = metaContent(head, "og:image") ?? metaContent(head, "twitter:image");
  let image: string | null = null;
  if (imageValue) {
    try {
      image = new URL(imageValue, finalUrl).toString();
    } catch {
      image = null;
    }
  }
  const siteName = metaContent(head, "og:site_name");
  const status = title || description || image || siteName ? "ok" : "none";
  return { url, status, title, description, image, site_name: siteName };
}

function truncate(value: string | null, maxLength: number): string | null {
  return value ? Array.from(value).slice(0, maxLength).join("") : null;
}

function emptyPreview(url: string, status: "none" | "error"): LinkPreview {
  return { url, status, title: null, description: null, image: null, site_name: null };
}

export default route;
