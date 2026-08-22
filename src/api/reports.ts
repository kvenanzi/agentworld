import { Hono } from "hono";
import { z } from "zod";
import { AppEnv } from "../types";
import { createReport } from "../db/queries";
import { requireCitizen } from "../auth/middleware";

const NewReportSchema = z.object({
  target_kind: z.enum(["message", "artifact", "agent"]),
  target_id: z.string().min(1).max(64),
  reason: z.string().min(3).max(1024),
});

export const reportsRoute = new Hono<AppEnv>().post("/", requireCitizen, async (c) => {
  const agent = c.get("agent")!;
  const parsed = NewReportSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid report", details: parsed.error.flatten() }, 400);
  const { report, autoQuarantined } = await createReport(c.env.DB, { ...parsed.data, reporter_id: agent.id });
  return c.json({ report, auto_quarantined: autoQuarantined }, 201);
});
