import type { JevAnswer, JevRequest } from "../../shared/jev-client.js";
import type { TopicRow } from "../db/topics.js";

export interface SearchPeriod { from: string; to: string }
export interface SearchJudgment {
  topics: Array<{ id: string; score: number }>;
  period: SearchPeriod | null;
}

export function buildJudgeRequest(q: string, topics: TopicRow[], years: number[]): JevRequest {
  const questions: JevRequest["questions"] = {};
  for (const topic of topics) {
    questions[`topic_${topic.id}`] = {
      type: "noul",
      instructions: `이 질의가 찾는 트윗은 ${topic.question}에 관한 이야기인가?`,
      criteria: { true: "그렇다", false: "아니다" },
    };
  }
  questions.period = {
    type: "choice",
    instructions: "이 질의가 가리키는 시기는?",
    criteria: {
      ...Object.fromEntries(years.map((year) => [String(year), `${year}년`])),
      none: "특정한 시기를 가리키지 않는다",
    },
  };
  return { state: `찾는 트윗: ${q}`, questions };
}

export function deriveJudgment(answers: Record<string, JevAnswer>, topics: TopicRow[], years: number[]): SearchJudgment {
  const judgedTopics = topics.flatMap((topic) => {
    const score = answers[`topic_${topic.id}`]?.noul;
    if (typeof score !== "number") throw new Error(`Jev has no topic_${topic.id} score.`);
    return score >= 0.5 ? [{ id: topic.id, score }] : [];
  }).sort((left, right) => right.score - left.score);
  const probabilities = answers.period?.probabilities;
  if (!probabilities) throw new Error("Jev has no period probabilities.");
  if ((probabilities.none ?? 0) >= 0.5) return { topics: judgedTopics, period: null };
  const ranked = years.slice().sort((left, right) =>
    (probabilities[String(right)] ?? 0) - (probabilities[String(left)] ?? 0));
  if (ranked.length === 0) return { topics: judgedTopics, period: null };
  const selected: number[] = [];
  let cumulative = 0;
  for (const year of ranked) {
    selected.push(year);
    cumulative += probabilities[String(year)] ?? 0;
    if (cumulative >= 0.8) break;
  }
  return {
    topics: judgedTopics,
    period: { from: `${Math.min(...selected)}-01-01`, to: `${Math.max(...selected)}-12-31` },
  };
}
