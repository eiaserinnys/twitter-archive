import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/worker/index.js";
import { baseTestEnv, createD1TestDatabase } from "./d1-test-db.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubCache() {
  const entries = new Map<string, Response>();
  const keyUrl = (key: Request | string) => typeof key === "string" ? key : key.url;
  const cache = {
    match: vi.fn(async (key: Request | string) => entries.get(keyUrl(key))?.clone()),
    put: vi.fn(async (key: Request | string, response: Response) => {
      entries.set(keyUrl(key), response.clone());
    }),
  };
  vi.stubGlobal("caches", { default: cache });
  return { cache, entries };
}

function get(path: string, env: ReturnType<typeof baseTestEnv>) {
  return app.fetch(new Request(`https://archive.test${path}`), env);
}

describe("data-version response cache", () => {
  it("overlays the latest last_collected_at on a cached meta body", async () => {
    const { db, sqlite, reads } = createD1TestDatabase();
    const { cache, entries } = stubCache();
    sqlite.prepare("INSERT INTO meta (key, value) VALUES ('data_version', 'v1'), ('last_collected_at', 'first')").run();
    const env = baseTestEnv(db);

    const firstResponse = await get("/api/meta", env);
    expect((await firstResponse.json()).last_collected_at).toBe("first");
    const tweetStatsReads = () => reads.filter(({ query }) => query.includes("COUNT(*) AS total_tweets")).length;
    expect(tweetStatsReads()).toBe(1);
    const storedBody = await [...entries.values()][0].clone().json();
    expect(storedBody).not.toHaveProperty("last_collected_at");

    sqlite.prepare("UPDATE meta SET value = 'second' WHERE key = 'last_collected_at'").run();
    const secondResponse = await get("/api/meta", env);

    expect((await secondResponse.json()).last_collected_at).toBe("second");
    expect(tweetStatsReads()).toBe(1);
    expect(cache.match).toHaveBeenCalledTimes(2);
    expect(secondResponse.headers.get("cache-control")).toBeNull();
  });

  it("recalculates a timeline when its KST date key changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { db, sqlite, reads } = createD1TestDatabase();
    const { entries } = stubCache();
    sqlite.prepare("INSERT INTO meta (key, value) VALUES ('data_version', 'v1')").run();
    const env = baseTestEnv(db);
    const timelineReads = () => reads.filter(({ query }) => query.includes("FROM tweets t")).length;

    await get("/api/timeline", env);
    expect(timelineReads()).toBe(1);
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    await get("/api/timeline", env);

    expect(timelineReads()).toBe(2);
    const keys = [...entries.keys()].map((key) => new URL(key).searchParams.get("d"));
    expect(keys).toEqual(["2026-01-01", "2026-01-02"]);
  });

  it("recalculates when data_version changes", async () => {
    const { db, sqlite, reads } = createD1TestDatabase();
    const { entries } = stubCache();
    sqlite.prepare("INSERT INTO meta (key, value) VALUES ('data_version', 'v1')").run();
    const env = baseTestEnv(db);
    const timelineReads = () => reads.filter(({ query }) => query.includes("FROM tweets t")).length;

    await get("/api/timeline", env);
    expect(timelineReads()).toBe(1);
    sqlite.prepare("UPDATE meta SET value = 'v2' WHERE key = 'data_version'").run();
    await get("/api/timeline", env);

    expect(timelineReads()).toBe(2);
    const versions = [...entries.keys()].map((key) => new URL(key).searchParams.get("v"));
    expect(versions).toEqual(["v1", "v2"]);
  });

  it("uses the Cloudflare deployment version as a cache key component", async () => {
    const { db, sqlite, reads } = createD1TestDatabase();
    const { entries } = stubCache();
    sqlite.prepare("INSERT INTO meta (key, value) VALUES ('data_version', 'v1')").run();
    const firstEnv = baseTestEnv(db, { CF_VERSION_METADATA: { id: "deploy-1" } });
    const secondEnv = baseTestEnv(db, { CF_VERSION_METADATA: { id: "deploy-2" } });
    const timelineReads = () => reads.filter(({ query }) => query.includes("FROM tweets t")).length;

    await get("/api/timeline", firstEnv);
    expect(timelineReads()).toBe(1);
    await get("/api/timeline", secondEnv);

    expect(timelineReads()).toBe(2);
    const versions = [...entries.keys()].map((key) => new URL(key).searchParams.get("cv"));
    expect(versions).toEqual(["deploy-1", "deploy-2"]);
  });
});
