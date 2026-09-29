import { callJev, type JevConfig, type JevRequest } from "../../shared/jev-client.js";
import type { TweetDbRow } from "../serialize.js";

export interface RankedTweet { row: TweetDbRow; score: number }

export function buildRankRequest(q: string, rows: TweetDbRow[], offset: number): JevRequest {
  const questions: JevRequest["questions"] = {};
  rows.forEach((row, index) => {
    const lines = ["다음 트윗이 찾는 트윗인가?", `작성일: ${row.date_kst}`];
    if (row.parent_text) lines.push(`원글: ${row.parent_text}`);
    if (row.quoted_text) lines.push(`인용한 글: ${row.quoted_text}`);
    lines.push(`트윗: ${row.text}`);
    questions[`c${offset + index}`] = {
      type: "noul", instructions: lines.join("\n"), criteria: { true: "그렇다", false: "아니다" },
    };
  });
  return { state: `찾는 트윗: ${q}`, questions };
}

export async function rankCandidates(config: JevConfig, q: string, rows: TweetDbRow[]): Promise<RankedTweet[]> {
  const ranked: Array<RankedTweet & { index: number }> = [];
  let nextOffset = 0;
  const worker = async () => {
    while (nextOffset < rows.length) {
      const offset = nextOffset;
      nextOffset += 40;
      const batch = rows.slice(offset, offset + 40);
      const result = await callJev(config, buildRankRequest(q, batch, offset));
      batch.forEach((row, index) => {
        const score = result.answers[`c${offset + index}`]?.noul;
        if (typeof score !== "number") throw new Error(`Jev has no c${offset + index} score.`);
        if (score >= 0.5) ranked.push({ row, score, index: offset + index });
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, Math.ceil(rows.length / 40)) }, () => worker()));
  return ranked.sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 30).map(({ row, score }) => ({ row, score }));
}
