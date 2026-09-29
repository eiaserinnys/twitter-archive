import type { JevAnswer, JevRequest } from "../../shared/jev-client.js";
import type { TopicRow } from "../db/topics.js";

export interface SearchPeriod { from: string; to: string }
export type SearchIntent = "one" | "many";
export type SearchStrategyId = "period" | "topics" | "words";
export interface SearchStrategy { id: SearchStrategyId; label: string; score: number; selected: boolean }
export interface SearchJudgment {
  topics: Array<{ id: string; score: number }>;
  topicCoordinates: Array<{ id: string; score: number }>;
  period: SearchPeriod | null;
  intent: SearchIntent;
  strategies: SearchStrategy[];
}

const strategyCatalog = [
  { id: "period", label: "기간", purpose: "질의가 가리키는 시기의 트윗만 후보로 삼는다" },
  { id: "topics", label: "주제 좌표", purpose: "질의와 주제가 비슷한 트윗을 후보로 삼는다" },
  { id: "words", label: "낱말", purpose: "질의에 들어 있는 낱말이나 이름이 그대로 들어간 트윗을 후보로 삼는다" },
] as const;

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
  questions.intent = {
    type: "choice",
    instructions: "이 질의가 원하는 것은?",
    criteria: { one: "기억하는 특정한 트윗 하나", many: "조건에 맞는 여러 트윗" },
  };
  for (const strategy of strategyCatalog) {
    questions[`strategy_${strategy.id}`] = {
      type: "noul",
      instructions: `이 질의로 트윗을 찾을 때 다음 방법이 알맞은가? ${strategy.purpose}`,
      criteria: { true: "그렇다", false: "아니다" },
    };
  }
  return { state: `찾는 트윗: ${q}`, questions };
}

export function chooseStrategies(scores: Record<SearchStrategyId, number>, hasPeriod: boolean): SearchStrategy[] {
  const ordered = strategyCatalog.filter((item) => item.id !== "period" || hasPeriod)
    .map((item) => ({ id: item.id, label: item.label, score: scores[item.id], selected: false }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const top = ordered[0]?.score ?? 0;
  const second = ordered[1]?.score ?? 0;
  const selected: SearchStrategyId[] = top >= 0.70 && top - second >= 0.15
    ? [ordered[0].id]
    : ordered.filter((item) => item.score >= 0.40 && item.score >= top - 0.20).slice(0, 3).map((item) => item.id);
  if (selected.length === 0) selected.push("topics", "words");
  return ordered.map((item) => ({ ...item, selected: selected.includes(item.id) }));
}

export function deriveJudgment(answers: Record<string, JevAnswer>, topics: TopicRow[], years: number[]): SearchJudgment {
  const topicScores = topics.map((topic) => {
    const score = answers[`topic_${topic.id}`]?.noul;
    if (typeof score !== "number") throw new Error(`Jev has no topic_${topic.id} score.`);
    return { id: topic.id, score };
  }).sort((left, right) => right.score - left.score);
  const probabilities = answers.period?.probabilities;
  if (!probabilities) throw new Error("Jev has no period probabilities.");
  let period: SearchPeriod | null = null;
  if ((probabilities.none ?? 0) < 0.5 && years.length > 0) {
    const ranked = years.slice().sort((left, right) =>
      (probabilities[String(right)] ?? 0) - (probabilities[String(left)] ?? 0));
    const selected: number[] = [];
    let cumulative = 0;
    for (const year of ranked) {
      selected.push(year);
      cumulative += probabilities[String(year)] ?? 0;
      if (cumulative >= 0.8) break;
    }
    period = { from: `${Math.min(...selected)}-01-01`, to: `${Math.max(...selected)}-12-31` };
  }
  const intentAnswer = answers.intent;
  if (!intentAnswer || (intentAnswer.choice !== "one" && intentAnswer.choice !== "many" && !intentAnswer.probabilities)) {
    throw new Error("Jev has no intent choice.");
  }
  const intent = intentAnswer.choice ?? ((intentAnswer.probabilities?.many ?? 0) > (intentAnswer.probabilities?.one ?? 0) ? "many" : "one");
  const strategyScores = {} as Record<SearchStrategyId, number>;
  for (const strategy of strategyCatalog) {
    const score = answers[`strategy_${strategy.id}`]?.noul;
    if (typeof score !== "number") throw new Error(`Jev has no strategy_${strategy.id} score.`);
    strategyScores[strategy.id] = score;
  }
  return {
    topics: topicScores.filter(({ score }) => score >= 0.5),
    topicCoordinates: topicScores.filter(({ score }) => score >= 0.3),
    period,
    intent: intent as SearchIntent,
    strategies: chooseStrategies(strategyScores, period !== null),
  };
}
