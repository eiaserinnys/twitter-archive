import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { uploadMedia } from "../scripts/upload-media.js";
import { loadD1 } from "../scripts/load-d1.js";
import { importArchive } from "../scripts/import-archive.js";
import { writeSyntheticArchive } from "./fixtures.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => Buffer.from("")),
  execFile: vi.fn((_file, _args, _options, callback) => { callback(null, "", ""); }),
}));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.clearAllMocks();
});

it("passes the chosen config and restores media keys after reimport without reuploading", async () => {
  const dir = await mkdtemp(join(tmpdir(), "setup-media-"));
  directories.push(dir);
  const archive = join(dir, "fixture.zip");
  const config = join(dir, "wrangler.test.toml");
  await writeFile(config, '[[r2_buckets]]\nbinding = "MEDIA"\nbucket_name = "test-media"\n');
  await writeSyntheticArchive(archive);
  await importArchive({ archive, dataDir: dir });
  const options = { archive, dataDir: dir, mode: "local" as const, wranglerConfig: config };
  expect(await uploadMedia(options)).toBe(3);
  expect(vi.mocked(execFile).mock.calls).toHaveLength(3);
  for (const call of vi.mocked(execFile).mock.calls) {
    expect(call[1]).toContain("--config");
    expect(call[1]).toContain(config);
    expect(call[1]?.[4]).toMatch(/^test-media\/media\//);
  }
  await importArchive({ archive, dataDir: dir });
  vi.mocked(execFile).mockClear();
  expect(await uploadMedia(options)).toBe(0);
  expect(execFile).not.toHaveBeenCalled();
  expect(await readFile(join(dir, "tweets.jsonl"), "utf8")).toContain("media/101/");
  await loadD1({ dataDir: dir, mode: "local", wranglerConfig: config });
  expect(vi.mocked(execFileSync).mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(["--config", config]));
});
