import type { Context } from "hono";
import type { Env } from "../env.js";
import type { Viewer } from "../auth.js";

export type AppContext = Context<{ Bindings: Env; Variables: { viewer: Viewer } }>;

export function ownerOnly(context: AppContext): Response | null {
  return context.get("viewer").owner ? null : context.json({ error: "owner_only" }, 403);
}

export async function ownerJsonBody(
  context: AppContext,
): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  const denied = ownerOnly(context);
  if (denied) return { response: denied };
  const contentType = context.req.header("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return { response: context.json({ error: "json_required" }, 415) };
  }
  try {
    const body: unknown = await context.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { response: context.json({ error: "invalid", message: "Expected a JSON object." }, 400) };
    }
    return { body: body as Record<string, unknown> };
  } catch {
    return { response: context.json({ error: "invalid", message: "Invalid JSON body." }, 400) };
  }
}

export function invalid(context: AppContext, message: string): Response {
  return context.json({ error: "invalid", message }, 400);
}

export function isVisibility(value: unknown): value is "public" | "owner" | "hidden" {
  return value === "public" || value === "owner" || value === "hidden";
}

export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
