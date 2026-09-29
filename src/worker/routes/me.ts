import { Hono } from "hono";
import type { Env } from "../env.js";
import type { Viewer } from "../auth.js";
import type { AppContext } from "./helpers.js";

const route = new Hono<{ Bindings: Env; Variables: { viewer: Viewer } }>();

route.get("/api/me", (context: AppContext) => {
  const viewer = context.get("viewer");
  return context.json({ owner: viewer.owner, viewing_as: viewer.viewingAs });
});

export default route;
