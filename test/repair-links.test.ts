import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRepairLinks } from "../scripts/repair-links.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("link repair SQL generation", () => {
  it("updates changed text only, deduplicates lookups, and skips unavailable posts", async () => {
    const root = await mkdtemp(join(tmpdir(), "twitter-archive-repair-links-"));
    temporaryDirectories.push(root);
    const inputPath = join(root, "candidates.json");
    const outputPath = join(root, "repair.sql");
    await writeFile(inputPath, JSON.stringify([{
      success: true,
      results: [
        { id: "1", text: "Old https://t.co/changed", parent_id: null, parent_text: null, quoted_id: null, quoted_text: null },
        { id: "4", text: "Reply", parent_id: "1", parent_text: "Context https://t.co/context", quoted_id: null, quoted_text: null },
        { id: "5", text: null, parent_id: null, parent_text: null, quoted_id: "3", quoted_text: "Deleted https://t.co/deleted" },
        { id: "7", text: "Same https://t.co/same", parent_id: null, parent_text: null, quoted_id: null, quoted_text: null },
      ],
    }]), "utf8");
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = input instanceof URL ? input : new URL(String(input));
      requests.push(url);
      return Response.json({
        data: [
          {
            id: "1",
            text: "Short preview",
            note_tweet: {
              text: "Updated https://t.co/changed",
              entities: { urls: [{ url: "https://t.co/changed", expanded_url: "https://example.test/changed" }] },
            },
            entities: { urls: [] },
          },
          {
            id: "7",
            text: "Same https://t.co/same",
            entities: { urls: [] },
          },
        ],
      });
    };

    const result = await runRepairLinks({
      inputPath,
      outputPath,
      maxUsd: 1,
      bearerToken: "synthetic-token",
      fetchImpl,
    });
    const sql = await readFile(outputPath, "utf8");

    expect(result).toMatchObject({ requestedPosts: 2, updatedRows: 2, unavailablePosts: 1, stoppedForBudget: false });
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get("ids")?.split(",")).toEqual(["1", "3", "7"]);
    expect(sql.match(/UPDATE tweets/g)).toHaveLength(2);
    expect(sql).toContain("SET text = 'Updated https://example.test/changed' WHERE id = '1'");
    expect(sql).toContain("SET parent_text = 'Updated https://example.test/changed' WHERE id = '4'");
    expect(sql).toContain("ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    expect(sql).not.toContain("WHERE id = '5'");
    expect(sql).not.toContain("WHERE id = '7'");
    expect(sql.indexOf("ON CONFLICT")).toBeGreaterThan(sql.lastIndexOf("UPDATE tweets"));
  });

  it("stops before a batch that would exceed the cost cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "twitter-archive-repair-budget-"));
    temporaryDirectories.push(root);
    const inputPath = join(root, "candidates.json");
    const outputPath = join(root, "repair.sql");
    const rows = ["1", "2", "3"].map((id) => ({
      id,
      text: `Post https://t.co/${id}`,
      parent_id: null,
      parent_text: null,
      quoted_id: null,
      quoted_text: null,
    }));
    await writeFile(inputPath, JSON.stringify(rows), "utf8");
    let requestCount = 0;

    const result = await runRepairLinks({
      inputPath,
      outputPath,
      maxUsd: 0.01,
      bearerToken: "synthetic-token",
      fetchImpl: async () => {
        requestCount += 1;
        return Response.json({ data: [] });
      },
    });

    expect(requestCount).toBe(0);
    expect(result).toMatchObject({ requestedPosts: 0, updatedRows: 0, unavailablePosts: 0, stoppedForBudget: true });
    expect(await readFile(outputPath, "utf8")).toContain("data_version");
  });

  it("looks up candidate tweet ids in batches of 100", async () => {
    const root = await mkdtemp(join(tmpdir(), "twitter-archive-repair-batches-"));
    temporaryDirectories.push(root);
    const inputPath = join(root, "candidates.json");
    const outputPath = join(root, "repair.sql");
    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: String(index + 1),
      text: `Post https://t.co/${index + 1}`,
      parent_id: null,
      parent_text: null,
      quoted_id: null,
      quoted_text: null,
    }));
    await writeFile(inputPath, JSON.stringify(rows), "utf8");
    const requests: URL[] = [];

    const result = await runRepairLinks({
      inputPath,
      outputPath,
      maxUsd: 1,
      bearerToken: "synthetic-token",
      fetchImpl: async (input) => {
        requests.push(input instanceof URL ? input : new URL(String(input)));
        return Response.json({ data: [] });
      },
    });

    expect(requests.map((url) => url.searchParams.get("ids")?.split(",").length)).toEqual([100, 1]);
    expect(result).toMatchObject({ requestedPosts: 0, unavailablePosts: 101, stoppedForBudget: false });
  });
});
