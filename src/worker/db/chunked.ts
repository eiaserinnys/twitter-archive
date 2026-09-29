const D1_MAX_BIND_VARIABLES = 100;
const MAX_ID_CHUNK_SIZE = 90;

export async function queryIdChunks<T>(
  ids: string[],
  queryChunk: (chunk: string[]) => Promise<T[]>,
  reservedBindVariables = 0,
): Promise<T[]> {
  if (ids.length === 0) return [];

  const chunkSize = Math.min(MAX_ID_CHUNK_SIZE, D1_MAX_BIND_VARIABLES - reservedBindVariables);
  if (chunkSize < 1) throw new Error("D1 statement reserves too many bind variables.");

  const results: T[] = [];
  for (let start = 0; start < ids.length; start += chunkSize) {
    results.push(...await queryChunk(ids.slice(start, start + chunkSize)));
  }
  return results;
}
