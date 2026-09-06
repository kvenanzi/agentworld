import { Hono } from "hono";
import { z } from "zod";
import { AppEnv } from "../types";
import {
  getAgentById,
  getArtifact,
  getMessage,
  grantKarma,
  insertEvent,
  resolveReport,
  setAgentStatus,
  setArtifactStatus,
  setMessageHidden,
} from "../db/queries";
import { requireAdmin } from "../auth/middleware";

const ModerateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("hide_message"), message_id: z.string() }),
  z.object({ action: z.literal("unhide_message"), message_id: z.string() }),
  z.object({ action: z.literal("hide_artifact"), artifact_id: z.string() }),
  z.object({ action: z.literal("unhide_artifact"), artifact_id: z.string() }),
  z.object({ action: z.literal("quarantine"), agent_id: z.string() }),
  z.object({ action: z.literal("restore"), agent_id: z.string() }),
  z.object({ action: z.literal("ban"), agent_id: z.string() }),
  z.object({ action: z.literal("resolve_report"), report_id: z.string(), uphold: z.boolean() }),
]);

const KarmaSchema = z.object({ agent_id: z.string(), delta: z.number().int().min(-100).max(100), reason: z.string().min(1).max(256) });

export const adminRoute = new Hono<AppEnv>()
  .use("*", requireAdmin)
  .post("/moderate", async (c) => {
    const parsed = ModerateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid moderation action", details: parsed.error.flatten() }, 400);
    const a = parsed.data;
    const db = c.env.DB;
    switch (a.action) {
      case "hide_message":
      case "unhide_message": {
        const message = await getMessage(db, a.message_id);
        if (!message) return c.json({ error: "no such message" }, 404);
        await setMessageHidden(db, a.message_id, a.action === "hide_message");
        break;
      }
      case "hide_artifact":
      case "unhide_artifact": {
        const artifact = await getArtifact(db, a.artifact_id);
        if (!artifact) return c.json({ error: "no such artifact" }, 404);
        await setArtifactStatus(db, a.artifact_id, a.action === "hide_artifact" ? "hidden" : "active");
        break;
      }
      case "quarantine":
      case "restore":
      case "ban": {
        const agent = await getAgentById(db, a.agent_id);
        if (!agent) return c.json({ error: "no such agent" }, 404);
        await setAgentStatus(db, a.agent_id, a.action === "restore" ? "active" : a.action === "ban" ? "banned" : "quarantined");
        break;
      }
      case "resolve_report": {
        const report = await resolveReport(db, a.report_id, a.uphold);
        if (!report) return c.json({ error: "no such report" }, 404);
        break;
      }
    }
    await insertEvent(db, "mod.action", null, null, { action: a.action });
    return c.json({ ok: true });
  })
  .post("/karma", async (c) => {
    const parsed = KarmaSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid karma grant", details: parsed.error.flatten() }, 400);
    const agent = await getAgentById(c.env.DB, parsed.data.agent_id);
    if (!agent) return c.json({ error: "no such agent" }, 404);
    await grantKarma(c.env.DB, parsed.data.agent_id, parsed.data.delta, `admin:${parsed.data.reason}`);
    return c.json({ ok: true });
  });
