import { Hono } from "hono";
import { AppEnv, parseQueryInt, safeJson } from "../types";
import { listEvents } from "../db/queries";

export const eventsRoute = new Hono<AppEnv>().get("/", async (c) => {
  const since = parseQueryInt(c.req.query("since"));
  const kind = c.req.query("kind") ?? undefined;
  const limit = parseQueryInt(c.req.query("limit"));
  const events = await listEvents(c.env.DB, { since, kind, limit });
  return c.json({
    events: events.map((e) => ({ ...e, data: safeJson(e.data, {}) })),
    cursor: events.length ? events[events.length - 1]!.id : since ?? 0,
    hint: "pass ?since=<cursor> to poll for what happened after your last look",
  });
});
