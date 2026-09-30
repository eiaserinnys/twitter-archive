import { DatabaseSync } from "node:sqlite";
import { execFile, execFileSync } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, type TomlTable } from "smol-toml";
import { safePath } from "../src/node/files.js";
import { extractArchiveMembers } from "../src/archive/archive-reader.js";
import { readJsonl, writeJsonl } from "../src/shared/jsonl.js";
import type { NormalizedTweet } from "../src/shared/types.js";
import { isDirectExecution, parseCliArgs, reportCliError, requiredString, selectedMode } from "./lib/cli.js";

function sqlValue(value: string | number): string {
  return typeof value === "number" ? String(value) : "'" + value.replaceAll("'", "''") + "'";
}

export interface UploadMediaOptions {
  archive: string;
  dataDir: string;
  mode?: "local" | "remote";
  mediaDir?: string;
  sqlite?: string;
  wranglerConfig?: string;
}

export async function uploadMedia(options: UploadMediaOptions): Promise<number> {
  const dataDir = resolve(options.dataDir);
  const tweets = await readJsonl<NormalizedTweet>(resolve(dataDir, "tweets.jsonl"));
  const updates: string[] = [];
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const configPath = resolve(options.wranglerConfig ?? resolve(repoRoot, "wrangler.toml"));
  const config = options.mediaDir ? undefined : parse(await readFile(configPath, "utf8"));
  const bucket = options.mediaDir ? "node" : (config!.r2_buckets as TomlTable[]).find((item) => item.binding === "MEDIA")?.bucket_name;
  if (typeof bucket !== "string" || !bucket) throw new Error("Wrangler config requires a MEDIA bucket.");
  const configArgs = ["--config", configPath];
  const progressPath = resolve(dataDir, "media-upload." + (options.mediaDir ? "node" : options.mode) + "." + bucket + ".jsonl");
  let completed: string[] = [];
  try {
    completed = await readJsonl<string>(progressPath);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const uploadedKeys = new Set(completed);
  const tempDir = resolve(dataDir, ".media-upload");
  const uploads: Array<{ r2Key: string; localPath: string; contentTypeArgs: string[] }> = [];
  const destinations = new Map<string, string>();
  let skipped = 0;
  for (const tweet of tweets) {
    for (const [index, media] of tweet.media.entries()) {
      if (!media.archive_path) continue;
      const filename = basename(media.archive_path);
      const r2Key = "media/" + tweet.id + "/" + filename;
      media.r2_key = r2Key;
      updates.push("UPDATE media SET r2_key = " + sqlValue(r2Key) + " WHERE tweet_id = " + sqlValue(tweet.id) + " AND idx = " + index + ";");
      if (uploadedKeys.has(r2Key)) {
        skipped++;
        continue;
      }
      const localPath = resolve(tempDir, tweet.id + "-" + index + "-" + filename);
      destinations.set(media.archive_path, localPath);
      uploads.push({ r2Key, localPath, contentTypeArgs: media.type === "photo" ? [] : ["--content-type", "video/mp4"] });
    }
  }

  await extractArchiveMembers(options.archive, destinations);
  let next = 0;
  let uploaded = 0;
  const worker = async () => {
    while (next < uploads.length) {
      const { r2Key, localPath, contentTypeArgs } = uploads[next++];
      if (options.mediaDir) {
        const destination = safePath(options.mediaDir, r2Key);
        if (!destination) throw new Error("Media key escapes media directory.");
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(localPath, destination);
      } else await new Promise<void>((resolvePromise, reject) => {
        execFile("npx", [
          "wrangler", "r2", "object", "put", bucket + "/" + r2Key,
          "--file", localPath, "--" + options.mode, ...contentTypeArgs, ...configArgs,
        ], { cwd: repoRoot }, (error, stdout, stderr) => {
          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          if (error) reject(new Error("Media upload failed for " + r2Key));
          else resolvePromise();
        });
      });
      await appendFile(progressPath, JSON.stringify(r2Key) + "\n", "utf8");
      uploaded++;
    }
  };
  // Await every started upload even on failure before returning to the caller.
  const results = await Promise.allSettled(Array.from({ length: 6 }, worker));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  if (updates.length > 0) {
    const sqlPath = resolve(dataDir, "upload-media.sql");
    await writeFile(sqlPath, updates.join("\n") + "\n", "utf8");
    if (options.sqlite) {
      const sqlite = new DatabaseSync(options.sqlite);
      try { sqlite.exec(updates.join("\n")); } finally { sqlite.close(); }
    } else execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--file", sqlPath, "--" + options.mode, ...configArgs], {
      cwd: repoRoot, stdio: "inherit",
    });
  }
  await writeJsonl(resolve(dataDir, "tweets.jsonl"), tweets);
  await rm(tempDir, { recursive: true, force: true });
  console.log("Skipped " + skipped + " previously uploaded media files (건너뜀).");
  return uploaded;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2), {
    archive: { type: "string" },
    "data-dir": { type: "string" },
    local: { type: "boolean" },
    remote: { type: "boolean" },
    "wrangler-config": { type: "string" },
    "media-dir": { type: "string" },
    sqlite: { type: "string" },
  });
  if (Boolean(args["media-dir"]) !== Boolean(args.sqlite)) throw new Error("Use --media-dir and --sqlite together.");
  const count = await uploadMedia({
    archive: requiredString(args.archive, "archive"),
    dataDir: typeof args["data-dir"] === "string" ? args["data-dir"] : "./data",
    mediaDir: typeof args["media-dir"] === "string" ? args["media-dir"] : undefined,
    sqlite: typeof args.sqlite === "string" ? args.sqlite : undefined,
    mode: args["media-dir"] ? undefined : selectedMode(args.local as boolean | undefined, args.remote as boolean | undefined),
    wranglerConfig: typeof args["wrangler-config"] === "string" ? args["wrangler-config"] : undefined,
  });
  console.log("Uploaded " + count + " media files.");
}

if (isDirectExecution(import.meta.url)) main().catch(reportCliError);
