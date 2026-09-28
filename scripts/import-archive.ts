import { resolve } from "node:path";
import { normalizeArchive } from "../src/archive/normalize.js";
import { readArchiveScripts } from "../src/archive/archive-reader.js";
import { writeJsonl } from "../src/shared/jsonl.js";
import { isDirectExecution, parseCliArgs, reportCliError, requiredString } from "./lib/cli.js";

export interface ImportArchiveOptions {
  archive: string;
  dataDir: string;
}

export async function importArchive(options: ImportArchiveOptions): Promise<number> {
  const files = await readArchiveScripts(options.archive);
  const tweets = normalizeArchive(files);
  await writeJsonl(resolve(options.dataDir, "tweets.jsonl"), tweets);
  return tweets.length;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2), {
    archive: { type: "string" },
    "data-dir": { type: "string" },
  });
  const dataDir = typeof args["data-dir"] === "string" ? args["data-dir"] : "./data";
  const count = await importArchive({ archive: requiredString(args.archive, "archive"), dataDir });
  console.log(`Imported ${count} authored tweets.`);
}

if (isDirectExecution(import.meta.url)) main().catch(reportCliError);
