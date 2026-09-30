import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("marks only existing article links unresolved and indexes that set", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const migrations = readdirSync(new URL("../migrations/", import.meta.url))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of migrations) {
      if (name === "0005_articles.sql") {
        const insert = sqlite.prepare(`
          INSERT INTO tweets (id, created_at, date_kst, year, month, kind, text, source)
          VALUES (?, ?, '2016-01-01', 2016, 1, 'original', ?, 'archive')
        `);
        insert.run("ordinary", "2016-01-01T00:00:00.000Z", "A synthetic ordinary tweet");
        insert.run("article", "2016-01-02T00:00:00.000Z", "https://x.com/i/article/synthetic");
      }
      sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }

    expect(sqlite.prepare("SELECT id, article_title FROM tweets ORDER BY id").all()).toEqual([
      { id: "article", article_title: null },
      { id: "ordinary", article_title: "" },
    ]);
    const plan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM tweets
      WHERE article_title IS NULL
      ORDER BY created_at, id
      LIMIT 100
    `).all() as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes("tweets_article_unchecked"))).toBe(true);
  } finally {
    sqlite.close();
  }
});
