import { Hono } from "hono";
import { callJev, type JevConfig } from "../../shared/jev-client.js";
import type { TweetKind } from "../../shared/types.js";
import type { Viewer } from "../auth.js";
import { getOrCacheJson } from "../cache.js";
import { getDataVersion } from "../db/meta.js";
import { serializeTweetRows } from "../db/tweets.js";
import { listTopicRows } from "../db/topics.js";
import type { Env } from "../env.js";
import { findCandidates } from "../search/candidates.js";
import { buildJudgeRequest, deriveJudgment, type SearchPeriod, type SearchStrategyId } from "../search/judge.js";
import { rankCandidates, type RankedTweet, type RankQuestion } from "../search/rank.js";
import type { TweetDbRow } from "../serialize.js";
import { canViewSearchTopic } from "../visibility.js";
import { publicHiddenSql } from "../visibility.js";
import type { AppContext } from "./helpers.js";
import { invalid, isDate, ownerJsonBody } from "./helpers.js";

const route = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>();
const tweetKinds: TweetKind[] = ["original", "reply", "self_reply", "quote"];
const publicSearchPresetsKey = "public_search_presets";
const visitorSearchLimitReached = Symbol("visitor-search-limit-reached");

interface SearchBody {
  q: string;
  topics?: string[];
  from?: string;
  to?: string;
  kinds?: TweetKind[];
}

interface PublicSearchPreset {
  id: string;
  label: string;
  query: string;
}

interface PublicSearchPresetInput {
  label: string;
  query: string;
}

function parseSearchBody(value: unknown): SearchBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.q !== "string" || !body.q.trim()) return null;
  if (body.topics !== undefined && (!Array.isArray(body.topics) || body.topics.some((id) => typeof id !== "string"))) return null;
  if (body.kinds !== undefined && (!Array.isArray(body.kinds) || body.kinds.some((kind) => !tweetKinds.includes(kind)))) return null;
  if (body.from !== undefined && !isDate(body.from)) return null;
  if (body.to !== undefined && !isDate(body.to)) return null;
  if (typeof body.from === "string" && typeof body.to === "string" && body.from > body.to) return null;
  return {
    q: body.q.trim(),
    topics: body.topics as string[] | undefined,
    from: body.from as string | undefined,
    to: body.to as string | undefined,
    kinds: body.kinds as TweetKind[] | undefined,
  };
}

function kstToday(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isPublicSearchPresetInput(value: unknown): value is PublicSearchPresetInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.label === "string" && input.label.trim().length > 0 && input.label.length <= 40
    && typeof input.query === "string" && input.query.trim().length > 0 && input.query.length <= 200;
}

async function publicSearchPresets(db: Env["DB"]): Promise<PublicSearchPreset[]> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?")
    .bind(publicSearchPresetsKey).first<{ value: string }>();
  return row ? JSON.parse(row.value) as PublicSearchPreset[] : [];
}

async function presetId(query: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(query));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

async function reserveVisitorSearch(db: Env["DB"], limit: number): Promise<boolean> {
  const key = `search_count:${kstToday()}`;
  await db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, '0')").bind(key).run();
  const updated = await db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = ? AND CAST(value AS INTEGER) < ?")
    .bind(key, limit).run();
  return updated.meta.changes === 1;
}

function reason(strategies: SearchStrategyId[], topics: Array<{ id: string; score: number }>, labels: Map<string, string>, period: SearchPeriod | null): string {
  const strategyLabels: Record<SearchStrategyId, string> = { period: "기간", topics: "주제 좌표", words: "낱말" };
  const parts = [...strategies.map((id) => strategyLabels[id]), ...topics.slice(0, 2).map(({ id }) => labels.get(id) ?? id)];
  if (period) {
    const fromYear = period.from.slice(0, 4);
    const toYear = period.to.slice(0, 4);
    parts.push(fromYear === toYear ? fromYear : `${fromYear}~${toYear}`);
  }
  return parts.join(", ") || "본문 일치";
}

async function rankRound(config: JevConfig, q: string, rows: TweetDbRow[], intent: "one" | "many"): Promise<{
  results: RankedTweet[]; question: RankQuestion; primaryMs: number; fallbackMs: number | null;
}> {
  const primaryQuestion = intent === "many" ? "matches" : "exact";
  const primaryStart = Date.now();
  const primary = await rankCandidates(config, q, rows, primaryQuestion);
  const primaryMs = Date.now() - primaryStart;
  const limit = intent === "many" ? 60 : 30;
  const matches = primary.filter((item) => item.score >= 0.5).slice(0, limit);
  if (intent === "many" || matches.length > 0) return { results: matches, question: primaryQuestion, primaryMs, fallbackMs: null };
  const fallbackStart = Date.now();
  const related = await rankCandidates(config, q, primary.slice(0, 120).map((item) => item.row), "related");
  return {
    results: related.filter((item) => item.score >= 0.5).slice(0, 30),
    question: "related", primaryMs, fallbackMs: Date.now() - fallbackStart,
  };
}

async function runSearch(
  context: AppContext,
  viewer: Viewer,
  body: SearchBody,
  topicRows: Awaited<ReturnType<typeof listTopicRows>>,
  allowedTopics: Awaited<ReturnType<typeof listTopicRows>>,
) {
  const config: JevConfig = { baseUrl: context.env.TYPESAFE_BASE_URL, apiKey: context.env.TYPESAFE_API_KEY };
  const judgeStart = Date.now();
  const yearRows = await context.env.DB.prepare(`SELECT DISTINCT t.year FROM tweets t
    ${viewer.viewingAs === "visitor" ? `WHERE NOT ${publicHiddenSql("t")}` : ""}
    ORDER BY t.year`)
    .all<{ year: number }>();
  const years = yearRows.results.map((row) => row.year);
  const judgeResult = await callJev(config, buildJudgeRequest(body.q, allowedTopics, years));
  const judged = deriveJudgment(judgeResult.answers, allowedTopics, years);
  const judgeMs = Date.now() - judgeStart;

  const candidateStart = Date.now();
  const selected = judged.strategies.filter((strategy) => strategy.selected).map((strategy) => strategy.id);
  const unused = judged.strategies.filter((strategy) => !strategy.selected).map((strategy) => strategy.id);
  const candidateFilters = { q: body.q, topicCoordinates: judged.topicCoordinates, period: judged.period,
    topics: body.topics, kinds: body.kinds, from: body.from, to: body.to };
  const candidates = await findCandidates(context.env.DB, viewer, { ...candidateFilters, strategies: selected });
  const candidateMs = Date.now() - candidateStart;

  let round = await rankRound(config, body.q, candidates, judged.intent);
  const stages = [
    { name: "judge", ms: judgeMs },
    { name: "candidates", ms: candidateMs },
    { name: "rank", ms: round.primaryMs },
  ];
  if (round.fallbackMs !== null) stages.push({ name: "fallback", ms: round.fallbackMs });
  let resultStrategies = selected;
  let candidateCount = candidates.length;
  let rounds = 1;
  if (round.results.length === 0 && unused.length > 0) {
    rounds = 2;
    const round2Start = Date.now();
    const nextCandidates = await findCandidates(context.env.DB, viewer, {
      ...candidateFilters, strategies: unused, excludeIds: candidates.map((row) => row.id),
    });
    candidateCount += nextCandidates.length;
    round = await rankRound(config, body.q, nextCandidates, judged.intent);
    stages.push({ name: "round2", ms: Date.now() - round2Start });
    resultStrategies = unused;
  }
  const tweets = await serializeTweetRows(context.env.DB, round.results.map((item) => item.row), viewer);
  const labels = new Map(topicRows.map((topic) => [topic.id, topic.label]));
  const why = reason(resultStrategies, judged.topics, labels,
    body.from && body.to ? { from: body.from, to: body.to } : judged.period);
  const results = round.results.map((item, index) => ({ tweet: tweets[index], score: item.score, why }));
  return {
    q: body.q,
    judged: { topics: judged.topics, period: judged.period },
    candidates: candidateCount,
    results,
    stages,
    intent: judged.intent,
    strategies: judged.strategies,
    rank_question: round.question,
    fallback: round.question === "related",
    rounds,
  };
}

route.get("/api/search/presets", async (context: AppContext) => {
  const presets = await publicSearchPresets(context.env.DB);
  return context.json({ presets });
});

route.put("/api/search/presets", async (context: AppContext) => {
  const parsed = await ownerJsonBody(context);
  if ("response" in parsed) return parsed.response;
  const input = parsed.body.presets;
  if (!Array.isArray(input) || input.length > 20 || !input.every(isPublicSearchPresetInput)) {
    return invalid(context, "Search presets are invalid.");
  }
  const presets = await Promise.all(input.map(async ({ label, query }) => ({ id: await presetId(query), label, query })));
  await context.env.DB.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(publicSearchPresetsKey, JSON.stringify(presets)).run();
  return context.json({ presets });
});

route.post("/api/search", async (context: AppContext) => {
  const contentType = context.req.header("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return context.json({ error: "json_required" }, 415);
  let value: unknown;
  try { value = await context.req.json(); } catch { value = null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(context, "Search request is invalid.");

  const viewer = context.get("viewer");
  const rawBody = value as Record<string, unknown>;
  if (viewer.viewingAs === "visitor") {
    if ("q" in rawBody) {
      return context.json({
        error: "free_query_disabled",
        message: "공개 버전에서는 API 호출 비용 때문에 자유 검색어가 제한됩니다.",
      }, 403);
    }
    if (typeof rawBody.preset_id !== "string" || !rawBody.preset_id) return invalid(context, "Search request is invalid.");
    const preset = (await publicSearchPresets(context.env.DB)).find(({ id }) => id === rawBody.preset_id);
    if (!preset) return context.json({ error: "not_found" }, 404);
    const body = parseSearchBody({ q: preset.query });
    if (!body) return invalid(context, "Search request is invalid.");
    const cacheRequest = new Request(new URL(`/api/search/presets/${encodeURIComponent(preset.id)}`, context.req.url), { method: "GET" });
    try {
      const dataVersion = await getDataVersion(context.env.DB);
      const response = await getOrCacheJson(
        cacheRequest,
        dataVersion,
        viewer.viewingAs,
        async () => {
          if (!await reserveVisitorSearch(context.env.DB, Number(context.env.SEARCH_DAILY_LIMIT))) {
            throw visitorSearchLimitReached;
          }
          const topicRows = await listTopicRows(context.env.DB);
          const allowedTopics = topicRows.filter((topic) => topic.active && canViewSearchTopic(topic.search_visibility, viewer));
          return runSearch(context, viewer, body, topicRows, allowedTopics);
        },
        undefined,
        context.env.CF_VERSION_METADATA?.id,
      );
      return context.json(response);
    } catch (error) {
      if (error === visitorSearchLimitReached) return context.json({ error: "search_limit" }, 429);
      throw error;
    }
  }

  const body = parseSearchBody(value);
  if (!body) return invalid(context, "Search request is invalid.");
  const topicRows = await listTopicRows(context.env.DB);
  const allowedTopics = topicRows.filter((topic) => topic.active && canViewSearchTopic(topic.search_visibility, viewer));
  const allowedIds = new Set(allowedTopics.map((topic) => topic.id));
  if (body.topics?.some((id) => !allowedIds.has(id))) return context.json({ error: "topic_not_allowed" }, 400);
  return context.json(await runSearch(context, viewer, body, topicRows, allowedTopics));
});

export default route;
