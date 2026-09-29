import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runFetchContext } from "../scripts/fetch-context.js";
import { buildPayload, buildState, runScore } from "../scripts/score.js";
import { buildSql } from "../scripts/load-d1.js";
import { readTopicSeed } from "../scripts/lib/topics.js";
import type { NormalizedTweet } from "../src/shared/types.js";

const row: NormalizedTweet = {
  id: "10",
  created_at_utc: "2024-01-01T00:00:00.000Z",
  date_kst: "2024-01-01",
  year: 2024,
  month: 1,
  kind: "self_reply",
  text: "이어 쓴 문장",
  parent: { id: "9", text: "원글 내용", author: "archive-owner" },
  quoted: { id: "8", text: "인용 내용" },
  lang: "ko",
  source: "archive",
  media: [{ type: "photo" }, { type: "video" }],
};

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("scoring input", () => {
  it("builds the exact v5 state format without an author bio", () => {
    expect(buildState(row)).toBe([
      "작성일: 2024-01-01",
      "종류: 자기 트윗에 이어 단 답글",
      "원글: 원글 내용",
      "인용한 글: 인용 내용",
      "트윗: 이어 쓴 문장",
      "첨부: 사진 1개, 영상 1개",
    ].join("\n"));

    const payload = buildPayload(row);
    expect(payload.model).toBe("jev-latest");
    expect(payload.questions.politics).toEqual({
      type: "noul",
      instructions: "이 트윗은 정치, 선거, 정책, 사회 문제에 관한 이야기인가?",
      criteria: { true: "그렇다", false: "아니다" },
    });
    expect(Object.keys(payload.questions)).toHaveLength(13);
  });

  it("uses an instance topic file for scoring and D1 seed SQL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitter-archive-topics-"));
    temporaryDirectories.push(directory);
    const topicsPath = join(directory, "topics.json");
    const topicSeed = {
      description: "Synthetic instance topics",
      version: "instance-v1",
      display_threshold: 0.7,
      search_threshold: 0.5,
      topics: [{ id: "custom", label: "Custom", question: "A synthetic topic" }],
    };
    await writeFile(topicsPath, JSON.stringify(topicSeed));
    const loadedSeed = await readTopicSeed(topicsPath);
    const payload = buildPayload(row, loadedSeed);
    expect(Object.keys(payload.questions)).toEqual(["custom"]);

    const sql = buildSql([row], [{
      id: row.id,
      scores: { custom: 0.8 },
      version: "instance-v1",
      input_tokens: 12,
    }], loadedSeed);
    expect(sql).toContain("'custom'");
    expect(sql).toContain("'instance-v1'");
    expect(sql).not.toContain("'politics'");
  });
});

describe("external-call budgets", () => {
  it("does not request context if the estimated post and author cost exceeds the cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitter-archive-context-"));
    temporaryDirectories.push(directory);
    const reply = { ...row, kind: "reply" as const, parent: { id: "9", text: "", author: "" }, quoted: null };
    await writeFile(join(directory, "tweets.jsonl"), `${JSON.stringify(reply)}\n`);
    const fetchMock = vi.fn();

    const result = await runFetchContext({
      dataDir: directory,
      maxUsd: 0.014,
      bearerToken: "synthetic-token",
      fetchImpl: fetchMock as typeof fetch,
      sleep: async () => undefined,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.requestedPosts).toBe(0);
    expect(result.stoppedForBudget).toBe(true);
  });

  it("dry-run writes only state inputs and sends no Jev request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitter-archive-score-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "tweets.jsonl"), `${JSON.stringify(row)}\n`);
    const fetchMock = vi.fn();

    const result = await runScore({
      dataDir: directory,
      maxUsd: 2,
      dryRun: true,
      baseUrl: "https://jev.test",
      apiKey: "synthetic-key",
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.scored).toBe(0);
    expect(result.dryRunStates).toBe(1);
    const states = await readFile(join(directory, "score-inputs.jsonl"), "utf8");
    expect(JSON.parse(states).state).toBe(buildState(row));
  });

  it("does not send a Jev request when its estimated input cost exceeds the cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitter-archive-score-budget-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "tweets.jsonl"), `${JSON.stringify(row)}\n`);
    const fetchMock = vi.fn();

    const result = await runScore({
      dataDir: directory,
      maxUsd: 0.00001,
      dryRun: false,
      baseUrl: "https://jev.test",
      apiKey: "synthetic-key",
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.scored).toBe(0);
    expect(result.stoppedForBudget).toBe(true);
  });
});
