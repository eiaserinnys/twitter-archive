import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { R2Bucket } from "../worker/env.js";

export function safePath(root: string, key: string): string | null {
  if (isAbsolute(key)) return null;
  const path = resolve(root, key);
  const rel = relative(resolve(root), path);
  return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel) ? null : path;
}
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".woff2": "font/woff2",
};
function contentType(path: string) { return contentTypes[extname(path).toLowerCase()] ?? "application/octet-stream"; }
async function fileBody(path: string): Promise<ReadableStream<Uint8Array> | null> {
  try { if (!(await stat(path)).isFile()) return null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null; throw error; }
  return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
}
export function createMediaBucket(root: string): R2Bucket {
  return {
    async get(key) {
      const path = safePath(root, key); if (!path) return null;
      const body = await fileBody(path); if (!body) return null;
      return { body, httpMetadata: { contentType: contentType(path) },
        writeHttpMetadata(headers) { headers.set("Content-Type", contentType(path)); } };
    },
    async put(key, value) {
      const path = safePath(root, key); if (!path) throw new Error("Media key escapes media directory.");
      await mkdir(dirname(path), { recursive: true });
      const body = typeof value === "string" ? value : value instanceof ReadableStream
        ? Buffer.from(await new Response(value).arrayBuffer()) : ArrayBuffer.isView(value)
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value);
      await writeFile(path, body);
    },
  };
}
export function createAssets(root: string) {
  return {
    async fetch(request: Request): Promise<Response> {
      const key = decodeURIComponent(new URL(request.url).pathname).replace(/^\//, "");
      const path = safePath(root, key); if (!path) return new Response("Not Found", { status: 404 });
      let body = await fileBody(path);
      const served = body ? path : resolve(root, "index.html");
      body ??= await fileBody(served);
      return body ? new Response(body, { headers: { "Content-Type": contentType(served) } })
        : new Response("Not Found", { status: 404 });
    },
  };
}

// Inspect the HTTP path before URL/Request normalizes dot segments away.
export function hasTraversal(rawPath: string): boolean {
  return decodeURIComponent(rawPath.split("?")[0]).replaceAll("\\", "/").split("/").includes("..");
}
