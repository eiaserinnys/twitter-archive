import { Hono } from "hono";
import { callJev, type JevConfig } from "../../shared/jev-client.js";
import type { TweetKind } from "../../shared/types.js";
import type { Viewer } from "../auth.js";
import { serializeTweetRows } from "../db/tweets.js";
import { listTopicRows } from "../db/topics.js";
import type { Env } from "../env.js";
import { findCandidates } from "../search/candidates.js";
import { buildJudgeRequest, deriveJudgment, type SearchPeriod } from "../search/judge.js";
import { rankCandidates } from "../search/rank.js";
import { canViewSearchTopic } from "../visibility.js";
import type { AppContext } from "./helpers.js";
import { invalid, isDate } from "./helpers.js";

const route = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>();
const tweetKinds: TweetKind[] = ["original", "reply", "self_reply", "quote"];

interface SearchBody {
  q: string;
  topics?: string[];
  from?: string;
  to?: string;
  kinds?: TweetKind[];
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

async function reserveVisitorSearch(db: Env["DB"], limit: number): Promise<boolean> {
  const key = `search_count:${kstToday()}`;
  await db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, '0')").bind(key).run();
  const updated = await db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = ? AND CAST(value AS INTEGER) < ?")
    .bind(key, limit).run();
  return updated.meta.changes === 1;
}

function reason(topics: Array<{ id: string; score: number }>, labels: Map<string, string>, period: SearchPeriod | null): string {
  const parts = topics.slice(0, 2).map(({ id }) => labels.get(id) ?? id);
  if (period) {
    const fromYear = period.from.slice(0, 4);
    const toYear = period.to.slice(0, 4);
    parts.push(fromYear === toYear ? fromYear : `${fromYear}~${toYear}`);
  }
  return parts.join(", ") || "본문 일치";
}

route.post("/api/search", async (context: AppContext) => {
  const contentType = context.req.header("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return context.json({ error: "json_required" }, 415);
  let body: SearchBody | null;
  try { body = parseSearchBody(await context.req.json()); } catch { body = null; }
  if (!body) return invalid(context, "Search request is invalid.");

  const viewer = context.get("viewer");
  const topicRows = await listTopicRows(context.env.DB);
  const allowedTopics = topicRows.filter((topic) => topic.active && canViewSearchTopic(topic.search_visibility, viewer));
  const allowedIds = new Set(allowedTopics.map((topic) => topic.id));
  if (body.topics?.some((id) => !allowedIds.has(id))) return context.json({ error: "topic_not_allowed" }, 400);
  if (viewer.viewingAs === "visitor"
    && !await reserveVisitorSearch(context.env.DB, Number(context.env.SEARCH_DAILY_LIMIT))) {
    return context.json({ error: "search_limit" }, 429);
  }

  const config: JevConfig = { baseUrl: context.env.TYPESAFE_BASE_URL, apiKey: context.env.TYPESAFE_API_KEY };
  const judgeStart = Date.now();
  const yearRows = await context.env.DB.prepare("SELECT DISTINCT year FROM tweets ORDER BY year")
    .all<{ year: number }>();
  const years = yearRows.results.map((row) => row.year);
  const judgeResult = await callJev(config, buildJudgeRequest(body.q, allowedTopics, years));
  const judged = deriveJudgment(judgeResult.answers, allowedTopics, years);
  const judgeMs = Date.now() - judgeStart;

  const candidateStart = Date.now();
  const from = body.from ?? judged.period?.from;
  const to = body.to ?? judged.period?.to;
  const candidates = await findCandidates(context.env.DB, viewer, {
    q: body.q, judgedTopics: judged.topics.map((topic) => topic.id),
    topics: body.topics, kinds: body.kinds, from, to,
  });
  const candidateMs = Date.now() - candidateStart;

  const rankStart = Date.now();
  const ranked = await rankCandidates(config, body.q, candidates);
  const tweets = await serializeTweetRows(context.env.DB, ranked.map((item) => item.row), viewer);
  const labels = new Map(topicRows.map((topic) => [topic.id, topic.label]));
  const why = reason(judged.topics, labels, body.from && body.to ? { from: body.from, to: body.to } : judged.period);
  const results = ranked.map((item, index) => ({ tweet: tweets[index], score: item.score, why }));
  const rankMs = Date.now() - rankStart;
  return context.json({
    q: body.q,
    judged,
    candidates: candidates.length,
    results,
    stages: [
      { name: "judge", ms: judgeMs },
      { name: "candidates", ms: candidateMs },
      { name: "rank", ms: rankMs },
    ],
  });
});

export default route;
