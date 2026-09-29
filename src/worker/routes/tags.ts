import { Hono } from "hono";
import type { Env } from "../env.js";
import type { Viewer } from "../auth.js";
import { getTag, toPeriodTag, visibleTags, type TagKind } from "../db/tags.js";
import { randomId } from "../ids.js";
import type { AppContext } from "./helpers.js";
import { invalid, isDate, ownerJsonBody, ownerOnly } from "./helpers.js";

const route = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>();
const tagKinds: TagKind[] = ["career", "game", "video", "book", "other"];

function isTagKind(value: unknown): value is TagKind {
  return typeof value === "string" && tagKinds.includes(value as TagKind);
}

function isTagVisibility(value: unknown): value is "public" | "owner" {
  return value === "public" || value === "owner";
}

function validLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.length <= 40;
}

function validNote(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

route.get("/api/tags", async (context: AppContext) => {
  const tags = await visibleTags(context.env.DB, context.get("viewer"));
  return context.json({ tags });
});

route.post("/api/tags", async (context: AppContext) => {
  const parsed = await ownerJsonBody(context);
  if ("response" in parsed) return parsed.response;
  const body = parsed.body;
  if (!validLabel(body.label) || !isTagKind(body.kind) || !isDate(body.start_date)
    || !(body.end_date === null || isDate(body.end_date)) || !validNote(body.note)
    || !isTagVisibility(body.visibility)) {
    return invalid(context, "Tag fields are invalid.");
  }
  if (body.end_date !== null && body.end_date < body.start_date) {
    return invalid(context, "end_date must not be before start_date.");
  }
  const now = new Date().toISOString();
  const id = randomId("p_");
  await context.env.DB.prepare(`
    INSERT INTO period_tags (id, label, kind, start_date, end_date, note, visibility, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, body.label, body.kind, body.start_date, body.end_date, body.note, body.visibility, now, now).run();
  const tag = await getTag(context.env.DB, id);
  if (!tag) throw new Error("Created period tag was not found.");
  return context.json({ tag: toPeriodTag(tag) }, 201);
});

route.patch("/api/tags/:id", async (context: AppContext) => {
  const parsed = await ownerJsonBody(context);
  if ("response" in parsed) return parsed.response;
  const current = await getTag(context.env.DB, context.req.param("id") ?? "");
  if (!current) return context.json({ error: "not_found" }, 404);
  const body = parsed.body;
  if (("label" in body && !validLabel(body.label))
    || ("kind" in body && !isTagKind(body.kind))
    || ("start_date" in body && !isDate(body.start_date))
    || ("end_date" in body && !(body.end_date === null || isDate(body.end_date)))
    || ("note" in body && !validNote(body.note))
    || ("visibility" in body && !isTagVisibility(body.visibility))) {
    return invalid(context, "Tag fields are invalid.");
  }
  const nextStart = (body.start_date as string | undefined) ?? current.start_date;
  const nextEnd = ("end_date" in body ? body.end_date : current.end_date) as string | null;
  if (nextEnd !== null && nextEnd < nextStart) {
    return invalid(context, "end_date must not be before start_date.");
  }
  const columns: Array<[string, string]> = [
    ["label", "label"],
    ["kind", "kind"],
    ["start_date", "start_date"],
    ["end_date", "end_date"],
    ["note", "note"],
    ["visibility", "visibility"],
  ];
  const updates = columns.filter(([key]) => key in body);
  if (updates.length > 0) {
    const values = updates.map(([key]) => body[key]);
    const setClause = updates.map(([, column]) => `${column} = ?`).join(", ");
    await context.env.DB.prepare(`UPDATE period_tags SET ${setClause}, updated_at = ? WHERE id = ?`)
      .bind(...values, new Date().toISOString(), current.id).run();
  }
  const tag = await getTag(context.env.DB, current.id);
  if (!tag) throw new Error("Updated period tag was not found.");
  return context.json({ tag: toPeriodTag(tag) });
});

route.delete("/api/tags/:id", async (context: AppContext) => {
  const denied = ownerOnly(context);
  if (denied) return denied;
  const result = await context.env.DB.prepare("DELETE FROM period_tags WHERE id = ?")
    .bind(context.req.param("id") ?? "").run();
  if (!result.meta.changes) return context.json({ error: "not_found" }, 404);
  return context.json({ ok: true });
});

export default route;
