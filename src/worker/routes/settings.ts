import { Hono } from "hono";
import type { Env } from "../env.js";
import type { Viewer } from "../auth.js";
import { bumpDataVersion } from "../db/meta.js";
import { invalid, ownerJsonBody, type AppContext } from "./helpers.js";

const route = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>();

route.put("/api/settings/replies", async (context: AppContext) => {
  const parsed = await ownerJsonBody(context);
  if ("response" in parsed) return parsed.response;
  const visibility = parsed.body.visibility;
  if (visibility !== "public" && visibility !== "owner" && visibility !== "hidden") {
    return invalid(context, "Reply visibility is invalid.");
  }
  await context.env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('reply_visibility', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(visibility).run();
  await bumpDataVersion(context.env.DB);
  return context.json({ visibility });
});

export default route;
