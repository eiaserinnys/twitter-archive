import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonl, writeJsonl } from "../src/shared/jsonl.js";
import type { NormalizedTweet } from "../src/shared/types.js";
import { runFetchContext } from "../scripts/fetch-context.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("context lookup link normalization", () => {
  it("requests entities and expands a long parent post before saving its context", async () => {
    const root = await mkdtemp(join(tmpdir(), "twitter-archive-fetch-context-"));
    temporaryDirectories.push(root);
    const dataDir = join(root, "data");
    await mkdir(dataDir);
    const row: NormalizedTweet = {
      id: "reply-1",
      created_at_utc: "2024-01-01T00:00:00.000Z",
      date_kst: "2024-01-01",
      year: 2024,
      month: 1,
      kind: "reply",
      text: "Reply",
      parent: { id: "parent-1", text: "", author: "friend" },
      quoted: null,
      lang: "en",
      source: "archive",
      media: [],
    };
    await writeJsonl(join(dataDir, "tweets.jsonl"), [row]);
    let requestedFields = "";
    const fetchImpl: typeof fetch = async (input) => {
      const url = input instanceof URL ? input : new URL(String(input));
      requestedFields = url.searchParams.get("tweet.fields") ?? "";
      return Response.json({
        data: [{
          id: "parent-1",
          text: "Parent preview",
          note_tweet: {
            text: "Long parent https://t.co/parent",
            entities: { urls: [{ url: "https://t.co/parent", expanded_url: "https://example.test/parent" }] },
          },
          entities: { urls: [] },
          author_id: "author-1",
        }],
        includes: { users: [{ id: "author-1", username: "friend" }] },
      });
    };

    await runFetchContext({ dataDir, maxUsd: 1, bearerToken: "synthetic-token", fetchImpl });

    expect(requestedFields.split(",")).toContain("entities");
    expect((await readJsonl<NormalizedTweet>(join(dataDir, "tweets.jsonl")))[0].parent?.text)
      .toBe("Long parent https://example.test/parent");
    expect(await readFile(join(dataDir, "fetch-context-cost.jsonl"), "utf8")).toContain('"posts":1');
  });
});
