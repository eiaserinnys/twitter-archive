import type { Viewer } from "../auth.js";
import type { D1Database } from "../env.js";
import { filterVisibleTags, type TagVisibility } from "../visibility.js";

export type TagKind = "career" | "game" | "video" | "book" | "other";

export interface PeriodTagRow {
  id: string;
  label: string;
  kind: TagKind;
  start_date: string;
  end_date: string | null;
  note: string | null;
  visibility: TagVisibility;
  created_at: string;
  updated_at: string;
}

export type PeriodTag = Omit<PeriodTagRow, "created_at" | "updated_at">;

export async function listTags(db: D1Database): Promise<PeriodTagRow[]> {
  const result = await db.prepare(`
    SELECT id, label, kind, start_date, end_date, note, visibility, created_at, updated_at
    FROM period_tags
    ORDER BY start_date, id
  `).all<PeriodTagRow>();
  return result.results;
}

export async function visibleTags(db: D1Database, viewer: Viewer): Promise<PeriodTag[]> {
  return filterVisibleTags(await listTags(db), viewer).map(toPeriodTag);
}

export async function getTag(db: D1Database, id: string): Promise<PeriodTagRow | null> {
  return db.prepare(`
    SELECT id, label, kind, start_date, end_date, note, visibility, created_at, updated_at
    FROM period_tags WHERE id = ?
  `).bind(id).first<PeriodTagRow>();
}

export function toPeriodTag(tag: PeriodTagRow): PeriodTag {
  return {
    id: tag.id,
    label: tag.label,
    kind: tag.kind,
    start_date: tag.start_date,
    end_date: tag.end_date,
    note: tag.note,
    visibility: tag.visibility,
  };
}
