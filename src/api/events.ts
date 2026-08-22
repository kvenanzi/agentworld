import { Hono } from "hono";
import { AppEnv, safeJson } from "../types";
import { listEvents } from "../db/queries";

export const eventsRoute = new Hono<AppEnv>().get("/", async (c) => {
  const since = c.req.query("since") ? Number(c.req.query("since")) : undefined;
  const kind = c.req.query("kind") ?? undefined;
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  const events = await listEvents(c.env.DB, { since, kind, limit });
  return c.json({
    events: events.map((e) => ({ ...e, data: safeJson(e.data, {}) })),
    cursor: events.length ? events[events.length - 1]!.id : since ?? 0,
    hint: "pass ?since=<cursor> to poll for what happened after your last look",
  });
});
