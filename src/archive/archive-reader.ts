import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, posix, resolve } from "node:path";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";

function archiveMemberName(name: string): string {
  return posix.normalize(name.replaceAll("\\", "/").replace(/^\/+/, "").replace(/^\.\//, ""));
}

function isRequiredScript(name: string): boolean {
  return name === "data/account.js" || name === "data/note-tweet.js" || /^data\/tweets[^/]*\.js$/.test(name);
}

async function listDataScripts(directory: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const entry of await readdir(join(directory, "data"), { withFileTypes: true })) {
    const name = archiveMemberName(`data/${entry.name}`);
    if (entry.isFile() && isRequiredScript(name)) files.set(name, await readFile(join(directory, "data", entry.name)));
  }
  return files;
}

async function extractZipMembers(zipPath: string, shouldRead: (name: string) => boolean): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const unzip = new Unzip((file) => {
      const name = archiveMemberName(file.name);
      if (!shouldRead(name)) return;
      const chunks: Uint8Array[] = [];
      file.ondata = (error, chunk, final) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        chunks.push(chunk);
        if (final) {
          const size = chunks.reduce((total, part) => total + part.byteLength, 0);
          const content = new Uint8Array(size);
          let offset = 0;
          for (const part of chunks) {
            content.set(part, offset);
            offset += part.byteLength;
          }
          files.set(name, content);
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);
    const stream = createReadStream(zipPath);
    stream.on("error", rejectPromise);
    stream.on("end", () => {
      try {
        unzip.push(new Uint8Array(), true);
        resolvePromise();
      } catch (error) {
        rejectPromise(error);
      }
    });
    stream.on("data", (chunk: string | Buffer) => {
      try {
        unzip.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk, false);
      } catch (error) {
        rejectPromise(error);
      }
    });
  });
  return files;
}

export async function readArchiveScripts(archivePath: string): Promise<Map<string, Uint8Array>> {
  const absolutePath = resolve(archivePath);
  if ((await stat(absolutePath)).isDirectory()) return listDataScripts(absolutePath);
  return extractZipMembers(absolutePath, isRequiredScript);
}

export async function readArchiveMember(archivePath: string, memberName: string): Promise<Uint8Array | undefined> {
  const absolutePath = resolve(archivePath);
  const relativeName = archiveMemberName(memberName);
  if ((await stat(absolutePath)).isDirectory()) {
    try {
      return await readFile(join(absolutePath, normalize(relativeName)));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  return (await extractZipMembers(absolutePath, (name) => name === relativeName)).get(relativeName);
}

export async function extractArchiveMembers(archivePath: string, destinations: Map<string, string>): Promise<void> {
  const absolutePath = resolve(archivePath);
  const normalizedDestinations = new Map([...destinations].map(([name, destination]) => [archiveMemberName(name), resolve(destination)]));
  if (normalizedDestinations.size === 0) return;

  if ((await stat(absolutePath)).isDirectory()) {
    for (const [name, destination] of normalizedDestinations) {
      const content = await readArchiveMember(absolutePath, name);
      if (!content) throw new Error(`Archive media file is missing: ${name}`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    return;
  }

  const found = new Set<string>();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let stream: ReturnType<typeof createReadStream>;
    let writes = Promise.resolve();
    let writing = false;
    const unzip = new Unzip((file) => {
      const name = archiveMemberName(file.name);
      const destination = normalizedDestinations.get(name);
      if (!destination) return;
      found.add(name);
      const chunks: Uint8Array[] = [];
      file.ondata = (error, chunk, final) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        chunks.push(chunk);
        if (!final) return;
        const size = chunks.reduce((total, part) => total + part.byteLength, 0);
        const content = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) {
          content.set(part, offset);
          offset += part.byteLength;
        }
        writing = true;
        writes = writes.then(async () => {
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, content);
        });
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);
    stream = createReadStream(absolutePath);
    stream.on("error", rejectPromise);
    stream.on("end", () => {
      try {
        unzip.push(new Uint8Array(), true);
        void writes.then(resolvePromise, rejectPromise);
      } catch (error) {
        rejectPromise(error);
      }
    });
    stream.on("data", (chunk: string | Buffer) => {
      stream.pause();
      try {
        unzip.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk, false);
      } catch (error) {
        rejectPromise(error);
        return;
      }
      const pendingWrites = writes;
      if (!writing) stream.resume();
      else void pendingWrites.then(() => {
        if (writes === pendingWrites) writing = false;
        stream.resume();
      }, rejectPromise);
    });
  });

  const missing = [...normalizedDestinations.keys()].find((name) => !found.has(name));
  if (missing) throw new Error(`Archive media file is missing: ${missing}`);
}
