import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { extractArchiveMembers, readArchiveScripts } from "../src/archive/archive-reader.js";
import { normalizeArchive } from "../src/archive/normalize.js";
import { safePath } from "../src/node/files.js";
import { isDirectExecution, parseCliArgs, reportCliError, requiredString } from "./lib/cli.js";

interface Candidate { tweet_id: string; idx: number; type: string }
export interface RepairArchiveMediaOptions { archive: string; inputPath: string; outDir: string }

function candidates(input: unknown): Candidate[] {
  const first = Array.isArray(input) ? input[0] : input;
  const rows = first && typeof first === "object" && "results" in first ? first.results : input;
  if (!Array.isArray(rows)) throw new Error("Input JSON must contain a wrangler D1 results array.");
  return rows.map(row => {
    if (!row || typeof row.tweet_id !== "string" || !/^\d+$/.test(row.tweet_id) || !Number.isSafeInteger(row.idx) || row.idx < 0 || typeof row.type !== "string") {
      throw new Error("A candidate requires a tweet_id, non-negative idx and type.");
    }
    return row as Candidate;
  });
}
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Produces local files and SQL only; never uploads or opens an operational DB. */
export async function runRepairArchiveMedia(options: RepairArchiveMediaOptions) {
  const rows = candidates(JSON.parse(await readFile(options.inputPath, "utf8")));
  const tweets = new Map(normalizeArchive(await readArchiveScripts(options.archive)).map(tweet => [tweet.id, tweet]));
  const statements: string[] = [];
  const missingIds: string[] = [];
  const destinations = new Map<string, string>();
  const repairs: Array<{ row: Candidate; path: string; key: string }> = [];
  for (const row of rows) {
    const media = tweets.get(row.tweet_id)?.media[row.idx];
    if (!media?.archive_path || media.type !== row.type) { missingIds.push(row.tweet_id); continue; }
    const key = `media/${row.tweet_id}/${basename(media.archive_path)}`;
    const destination = safePath(options.outDir, key);
    if (!destination) throw new Error("Media key escapes output directory.");
    destinations.set(media.archive_path, destination);
    repairs.push({ row, path: media.archive_path, key });
  }
  const missingPaths = new Set(await extractArchiveMembers(options.archive, destinations, { skipMissing: true }));
  for (const { row, path, key } of repairs) {
    if (missingPaths.has(path)) { missingIds.push(row.tweet_id); continue; }
    statements.push(`UPDATE media SET r2_key = ${sqlString(key)} WHERE tweet_id = ${sqlString(row.tweet_id)} AND idx = ${row.idx};`);
  }
  const repaired = statements.length;
  if (repaired) statements.push(`INSERT INTO meta (key, value) VALUES ('data_version', ${sqlString(String(Date.now()))}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);
  const sqlPath = resolve(options.outDir, "repair-archive-media.sql");
  await mkdir(options.outDir, { recursive: true });
  await writeFile(sqlPath, statements.join("\n") + "\n", "utf8");
  return { repaired, missingIds, sqlPath };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), { archive: { type: "string" }, input: { type: "string" }, "out-dir": { type: "string" } });
  const result = await runRepairArchiveMedia({ archive: requiredString(args.archive, "archive"), inputPath: requiredString(args.input, "input"), outDir: requiredString(args["out-dir"], "out-dir") });
  console.log(`Extracted ${result.repaired} media files; SQL: ${result.sqlPath}`);
  console.log(`Missing ${result.missingIds.length}: ${result.missingIds.join(", ")}`);
}
if (isDirectExecution(import.meta.url)) main().catch(reportCliError);
