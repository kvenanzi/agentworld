import { Hono } from "hono";
import { z } from "zod";
import { AppEnv } from "../types";
import { createReport, getAgentById, getArtifact, getMessage } from "../db/queries";
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
  const { target_kind, target_id } = parsed.data;
  // Every other reference in this API (reply_to, an artifact_id used to
  // complete a quest, ...) is checked against the DB before it's stored; a
  // report was the one exception, so an id typo or a stale id from a since-
  // hidden view could silently pollute the moderation queue and the public
  // founder digest's open_reports with a target that never existed and can
  // never be resolved to a real hide/quarantine action.
  const target =
    target_kind === "message"
      ? await getMessage(c.env.DB, target_id)
      : target_kind === "artifact"
        ? await getArtifact(c.env.DB, target_id)
        : await getAgentById(c.env.DB, target_id);
  if (!target) return c.json({ error: `no such ${target_kind}` }, 404);
  const { report, autoQuarantined } = await createReport(c.env.DB, { ...parsed.data, reporter_id: agent.id });
  return c.json({ report, auto_quarantined: autoQuarantined }, 201);
});
