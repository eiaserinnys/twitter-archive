import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonl<T>(path: string): Promise<T[]> {
  const content = await readFile(path, "utf8");
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as T);
}

export async function writeJsonl<T>(path: string, rows: readonly T[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(temporaryPath, content ? `${content}\n` : "", "utf8");
  await rename(temporaryPath, path);
}
