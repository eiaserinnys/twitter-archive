import type { R2Bucket, R2Range } from "./env.js";

function parseRange(header: string): R2Range | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = Number(match[1]), end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (!match[1]) return end > 0 ? { suffix: end } : null;
  if (!match[2]) return { offset: start };
  return end >= start ? { offset: start, length: end - start + 1 } : null;
}

export async function mediaResponse(bucket: R2Bucket, key: string, rangeHeader?: string): Promise<Response> {
  const headers = new Headers({ "Accept-Ranges": "bytes" });
  const range = rangeHeader === undefined ? undefined : parseRange(rangeHeader);
  if (range === null) return new Response(null, { status: 416, headers });
  let object;
  try {
    object = key ? await (range ? bucket.get(key, { range }) : bucket.get(key)) : null;
  } catch (error) {
    // R2's invalid-range error; other storage failures keep the normal 500 path.
    if (range && error instanceof Error && error.message.includes("(10039)")) return new Response(null, { status: 416, headers });
    throw error;
  }
  if (!object) return Response.json({ error: "not_found" }, { status: 404, headers });
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (range) {
    const returned = object.range!;
    const offset = returned.offset ?? Math.max(0, object.size! - returned.suffix!);
    const length = returned.length ?? Math.min(object.size!, returned.suffix!);
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
