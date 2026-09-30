import { describe, expect, it } from "vitest";
import { app } from "../src/worker/index.js";
import { baseTestEnv, createD1TestDatabase, insertTestTweets } from "./d1-test-db.js";

function fixture() {
  const { db, sqlite } = createD1TestDatabase();
  sqlite.exec(`INSERT INTO topics (id, label, question, version, sort_order, active,
    timeline_visibility, search_visibility) VALUES ('games', '게임', '게임인가', 'current', 1, 1, 'public', 'public')`);
  const values = [0, 0.049, 0.05, 0.3, 0.5, 0.95, 1];
  insertTestTweets(sqlite, values.length);
  const insert = sqlite.prepare("INSERT INTO scores (tweet_id, topic, score, version) VALUES (?, 'games', ?, ?)");
  values.forEach((score, index) => insert.run(`tweet-${String(index + 1).padStart(4, '0')}`, score, index % 2 ? 'old' : 'current'));
  return db;
}

describe("topic score histogram", () => {
  it("counts all score versions in twenty buckets, including score 1 in the last", async () => {
    const response = await app.fetch(new Request("https://archive.test/api/topics/games/score-histogram"), baseTestEnv(fixture()));
    expect(response.status).toBe(200);
    const { buckets } = await response.json() as { buckets: number[] };
    expect(buckets).toHaveLength(20);
    expect(buckets.reduce((sum, count) => sum + count, 0)).toBe(7);
    expect(buckets).toEqual([2, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
  });

  it("rejects visitors", async () => {
    const response = await app.fetch(new Request("https://archive.test/api/topics/games/score-histogram"), baseTestEnv(fixture(), { DEV_OWNER: "" }));
    expect(response.status).toBe(403);
  });

  it("returns 404 for a missing topic", async () => {
    const response = await app.fetch(new Request("https://archive.test/api/topics/missing/score-histogram"), baseTestEnv(fixture()));
    expect(response.status).toBe(404);
  });
});
