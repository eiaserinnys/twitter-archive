import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
    async get(key, options) {
      const path = safePath(root, key); if (!path) return null;
      let info;
      try { info = await stat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null; throw error; }
      if (!info.isFile()) return null;
      const size = info.size;
      const requested = options?.range;
      const offset = requested?.suffix === undefined ? requested?.offset ?? 0 : Math.max(0, size - requested.suffix);
      const length = Math.min(requested?.length ?? size - offset, size - offset);
      if (requested && (offset >= size || length <= 0)) throw new Error("R2 GET failed: (10039) The requested range is not satisfiable");
      const range = requested ? { offset, length } : undefined;
      const body = Readable.toWeb(createReadStream(path, range ? { start: offset, end: offset + length - 1 } : undefined)) as ReadableStream<Uint8Array>;
      return { body, size, range, httpMetadata: { contentType: contentType(path) },
        writeHttpMetadata(headers) { headers.set("Content-Type", contentType(path)); } };
    },
    async put(key, value) {
      const path = safePath(root, key); if (!path) throw new Error("Media key escapes media directory.");
      await mkdir(dirname(path), { recursive: true });
      if (value instanceof ReadableStream) {
        await pipeline(Readable.fromWeb(value as unknown as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(path));
        return;
      }
      const body = typeof value === "string" ? value : ArrayBuffer.isView(value)
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
