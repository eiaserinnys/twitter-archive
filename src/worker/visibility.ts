import type { Viewer } from "./auth.js";

export type Visibility = "public" | "owner" | "hidden";
export type TagVisibility = "public" | "owner";

export interface TopicVisibilityRow {
  id: string;
  timeline_visibility: Visibility;
  search_visibility: Visibility;
  active: number;
}

export interface VisibleTagRow {
  visibility: TagVisibility;
}

export interface TopicScoreRow {
  id: string;
  score: number;
  version: string;
  topic_version: string;
  active: number;
  timeline_visibility: Visibility;
}

export interface TimelineCountRow {
  year: number;
  total: number;
  topic_id: string | null;
  topic_count: number;
}

export interface TimelineYear {
  year: number;
  total: number;
  counts: Record<string, number>;
}

export function canViewTimelineTopic(visibility: Visibility, viewer: Viewer): boolean {
  return visibility === "public" || (visibility === "owner" && viewer.viewingAs === "owner");
}

export function canViewSearchTopic(visibility: Visibility, viewer: Viewer): boolean {
  if (viewer.viewingAs === "owner") return visibility !== "hidden";
  return visibility === "public";
}

export function canViewMetaTopic(topic: TopicVisibilityRow, viewer: Viewer): boolean {
  if (!topic.active) return false;
  if (viewer.viewingAs === "owner") return true;
  return topic.timeline_visibility === "public" || topic.search_visibility === "public";
}

export function isTopicFilterAllowed(
  requestedIds: string[],
  topics: TopicVisibilityRow[],
  viewer: Viewer,
): boolean {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  return requestedIds.every((id) => {
    const topic = byId.get(id);
    return Boolean(topic && topic.active && canViewTimelineTopic(topic.timeline_visibility, viewer));
  });
}

export function selectTweetTopicChips(
  rows: TopicScoreRow[],
  viewer: Viewer,
  displayThreshold: number,
): Array<{ id: string; score: number }> {
  return rows
    .filter((row) => row.active && row.score >= displayThreshold && row.version === row.topic_version
      && canViewTimelineTopic(row.timeline_visibility, viewer))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map(({ id, score }) => ({ id, score }));
}

export function filterVisibleTags<T extends VisibleTagRow>(tags: T[], viewer: Viewer): T[] {
  return tags.filter((tag) => tag.visibility === "public" || viewer.viewingAs === "owner");
}

export function shapeTimelineRows(rows: TimelineCountRow[]): TimelineYear[] {
  const years = new Map<number, TimelineYear>();
  for (const row of rows) {
    let year = years.get(row.year);
    if (!year) {
      year = { year: row.year, total: row.total, counts: {} };
      years.set(row.year, year);
    }
    if (row.topic_id && row.topic_count > 0) year.counts[row.topic_id] = row.topic_count;
  }
  return [...years.values()].sort((left, right) => left.year - right.year);
}
