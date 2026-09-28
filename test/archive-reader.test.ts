import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractArchiveMembers, readArchiveMember, readArchiveScripts } from "../src/archive/archive-reader.js";
import { normalizeArchive } from "../src/archive/normalize.js";
import { writeSyntheticArchive, syntheticArchiveFiles } from "./fixtures.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("archive reader", () => {
  it("reads scripts and media members from a synthetic archive zip", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitter-archive-reader-"));
    temporaryDirectories.push(directory);
    const zipPath = join(directory, "synthetic.zip");
    await writeSyntheticArchive(zipPath);

    const files = await readArchiveScripts(zipPath);
    const rows = normalizeArchive(files);
    const photo = await readArchiveMember(zipPath, "data/tweets_media/101-photo.jpg");

    expect(rows).toHaveLength(7);
    expect(files.has("data/direct-messages.js")).toBe(false);
    expect(photo && new TextDecoder().decode(photo)).toBe("synthetic-photo-1");
  });

  it("extracts selected zip media to disk in one archive pass", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitter-archive-media-reader-"));
    temporaryDirectories.push(directory);
    const zipPath = join(directory, "synthetic.zip");
    const photoPath = join(directory, "out", "photo.jpg");
    const videoPath = join(directory, "out", "video.jpg");
    await writeSyntheticArchive(zipPath);

    await extractArchiveMembers(zipPath, new Map([
      ["data/tweets_media/101-photo.jpg", photoPath],
      ["data/tweets_media/108-video108.jpg", videoPath],
    ]));

    expect(await readFile(photoPath, "utf8")).toBe("synthetic-photo-1");
    expect(await readFile(videoPath, "utf8")).toBe("synthetic-video-thumbnail");
  });

  it("reads scripts from an extracted archive directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitter-archive-folder-"));
    temporaryDirectories.push(directory);
    for (const [name, bytes] of syntheticArchiveFiles()) {
      const path = join(directory, name);
      const slash = path.lastIndexOf("/");
      await mkdir(path.slice(0, slash), { recursive: true });
      await writeFile(path, bytes);
    }
    const files = await readArchiveScripts(directory);
    expect(normalizeArchive(files)).toHaveLength(7);
    expect(files.has("data/direct-messages.js")).toBe(false);
  });
});
