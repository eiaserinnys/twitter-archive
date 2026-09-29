type ViewingAs = "owner" | "visitor";

interface WorkerCache {
  match(request: Request): Promise<Response | null | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function defaultCache(): WorkerCache {
  return (globalThis as unknown as { caches: { default: WorkerCache } }).caches.default;
}

function cacheKey(request: Request, version: string, viewingAs: ViewingAs, date?: string): Request {
  const url = new URL(request.url);
  url.search = "";
  url.searchParams.set("v", version);
  url.searchParams.set("as", viewingAs);
  if (date !== undefined) url.searchParams.set("d", date);
  return new Request(url);
}

export async function getOrCacheJson<T>(
  request: Request,
  dataVersion: string | null,
  viewingAs: ViewingAs,
  calculate: () => Promise<T>,
  date?: string,
): Promise<T> {
  if (dataVersion === null) return calculate();

  const cache = defaultCache();
  const key = cacheKey(request, dataVersion, viewingAs, date);
  const cached = await cache.match(key);
  if (cached) return await cached.json() as T;

  const result = await calculate();
  const response = Response.json(result);
  response.headers.set("Cache-Control", "max-age=86400");
  await cache.put(key, response);
  return result;
}
