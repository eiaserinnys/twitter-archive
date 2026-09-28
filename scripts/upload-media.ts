import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractArchiveMembers } from "../src/archive/archive-reader.js";
import { readJsonl, writeJsonl } from "../src/shared/jsonl.js";
import type { NormalizedTweet } from "../src/shared/types.js";
import { isDirectExecution, parseCliArgs, reportCliError, requiredString, selectedMode } from "./lib/cli.js";

function sqlValue(value: string | number): string {
  return typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
}

export interface UploadMediaOptions {
  archive: string;
  dataDir: string;
  mode: "local" | "remote";
}

export async function uploadMedia(options: UploadMediaOptions): Promise<number> {
  const dataDir = resolve(options.dataDir);
  const tweets = await readJsonl<NormalizedTweet>(resolve(dataDir, "tweets.jsonl"));
  const updates: string[] = [];
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const tempDir = resolve(dataDir, ".media-upload");
  const uploads: Array<{ tweet: NormalizedTweet; index: number; media: NormalizedTweet["media"][number]; r2Key: string; localPath: string }> = [];
  const destinations = new Map<string, string>();
  let uploaded = 0;

  for (const tweet of tweets) {
    for (const [index, media] of tweet.media.entries()) {
      if (media.r2_key || !media.archive_path) continue;
      const filename = basename(media.archive_path);
      const r2Key = `media/${tweet.id}/${filename}`;
      const localPath = resolve(tempDir, `${tweet.id}-${index}-${filename}`);
      destinations.set(media.archive_path, localPath);
      uploads.push({ tweet, index, media, r2Key, localPath });
    }
  }

  await extractArchiveMembers(options.archive, destinations);
  for (const { tweet, index, media, r2Key, localPath } of uploads) {
    execFileSync("npx", [
      "wrangler", "r2", "object", "put", `twitter-archive-media/${r2Key}`,
      "--file", localPath, `--${options.mode}`,
    ], { cwd: repoRoot, stdio: "inherit" });
    media.r2_key = r2Key;
    updates.push(`UPDATE media SET r2_key = ${sqlValue(r2Key)} WHERE tweet_id = ${sqlValue(tweet.id)} AND idx = ${index};`);
    uploaded += 1;
  }

  if (updates.length > 0) {
    const sqlPath = resolve(dataDir, "upload-media.sql");
    await writeFile(sqlPath, `${updates.join("\n")}\n`, "utf8");
    execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--file", sqlPath, `--${options.mode}`], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
  await writeJsonl(resolve(dataDir, "tweets.jsonl"), tweets);
  await rm(tempDir, { recursive: true, force: true });
  return uploaded;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2), {
    archive: { type: "string" },
    "data-dir": { type: "string" },
    local: { type: "boolean" },
    remote: { type: "boolean" },
  });
  const count = await uploadMedia({
    archive: requiredString(args.archive, "archive"),
    dataDir: typeof args["data-dir"] === "string" ? args["data-dir"] : "./data",
    mode: selectedMode(args.local as boolean | undefined, args.remote as boolean | undefined),
  });
  console.log(`Uploaded ${count} media files.`);
}

if (isDirectExecution(import.meta.url)) main().catch(reportCliError);
