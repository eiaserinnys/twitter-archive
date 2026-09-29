import type { Viewer } from "../auth.js";
import type { D1Database } from "../env.js";
import { canViewMetaTopic, type TopicVisibilityRow, type Visibility } from "../visibility.js";

export interface TopicRow extends TopicVisibilityRow {
  label: string;
  question: string;
  version: string;
  sort_order: number;
  timeline_visibility: Visibility;
  search_visibility: Visibility;
}

export interface TopicInfo {
  id: string;
  label: string;
  question?: string;
  timeline_visibility: Visibility;
  search_visibility: Visibility;
  version: string;
  sort_order: number;
  scored?: number;
}

export async function getTopicInfo(db: D1Database, id: string): Promise<TopicInfo | null> {
  const topic = await db.prepare(`
    SELECT tp.id, tp.label, tp.question, tp.timeline_visibility, tp.search_visibility,
      tp.version, tp.sort_order, tp.active,
      (SELECT COUNT(*) FROM scores s WHERE s.topic = tp.id AND s.version = tp.version) AS scored
    FROM topics tp
    WHERE tp.id = ?
  `).bind(id).first<TopicRow & { scored: number }>();
  if (!topic) return null;
  return {
    id: topic.id,
    label: topic.label,
    question: topic.question,
    timeline_visibility: topic.timeline_visibility,
    search_visibility: topic.search_visibility,
    version: topic.version,
    sort_order: topic.sort_order,
    scored: topic.scored,
  };
}

export async function listTopicRows(db: D1Database): Promise<TopicRow[]> {
  const result = await db.prepare(`
    SELECT id, label, question, timeline_visibility, search_visibility, version, sort_order, active
    FROM topics
    ORDER BY sort_order, id
  `).all<TopicRow>();
  return result.results;
}

export async function listTopicInfo(db: D1Database, viewer: Viewer): Promise<TopicInfo[]> {
  const result = await db.prepare(`
    SELECT tp.id, tp.label, tp.question, tp.timeline_visibility, tp.search_visibility,
      tp.version, tp.sort_order, tp.active,
      (SELECT COUNT(*) FROM scores s WHERE s.topic = tp.id AND s.version = tp.version) AS scored
    FROM topics tp
    WHERE tp.active = 1
    ORDER BY tp.sort_order, tp.id
  `).all<TopicRow & { scored: number }>();
  return result.results
    .filter((topic) => canViewMetaTopic(topic, viewer))
    .map((topic) => ({
      id: topic.id,
      label: topic.label,
      ...(viewer.viewingAs === "owner" ? { question: topic.question } : {}),
      timeline_visibility: topic.timeline_visibility,
      search_visibility: topic.search_visibility,
      version: topic.version,
      sort_order: topic.sort_order,
      ...(viewer.viewingAs === "owner" ? { scored: topic.scored } : {}),
    }));
}

export async function getTopic(db: D1Database, id: string): Promise<TopicRow | null> {
  return db.prepare(`
    SELECT id, label, question, timeline_visibility, search_visibility, version, sort_order, active
    FROM topics WHERE id = ?
  `).bind(id).first<TopicRow>();
}
