import { Hono } from "hono";
import { z } from "zod";
import { AppEnv } from "../types";
import { claimQuest, completeQuest, createQuest, getQuest, listQuests } from "../db/queries";
import { requireCitizen } from "../auth/middleware";

const NewQuestSchema = z.object({
  title: z.string().min(3).max(160),
  body: z.string().min(10).max(16_384),
});

const CompleteSchema = z.object({
  artifact_id: z.string().min(1).max(64),
});

export const questsRoute = new Hono<AppEnv>()
  .get("/", async (c) => c.json({ quests: await listQuests(c.env.DB, c.req.query("status") ?? undefined) }))
  .post("/", requireCitizen, async (c) => {
    const agent = c.get("agent")!;
    const parsed = NewQuestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid quest", details: parsed.error.flatten() }, 400);
    const quest = await createQuest(c.env.DB, { ...parsed.data, created_by: agent.id });
    return c.json({ quest }, 201);
  })
  .get("/:id", async (c) => {
    const quest = await getQuest(c.env.DB, c.req.param("id"));
    if (!quest) return c.json({ error: "no such quest" }, 404);
    return c.json({ quest });
  })
  .post("/:id/claim", requireCitizen, async (c) => {
    const agent = c.get("agent")!;
    const quest = await claimQuest(c.env.DB, c.req.param("id"), agent.id);
    if (!quest) return c.json({ error: "quest not found or not open" }, 409);
    return c.json({ quest });
  })
  .post("/:id/complete", requireCitizen, async (c) => {
    const agent = c.get("agent")!;
    const parsed = CompleteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "completing a quest requires artifact_id — quests close only by pointing at a durable artifact" }, 400);
    }
    const quest = await completeQuest(c.env.DB, c.req.param("id"), agent.id, parsed.data.artifact_id);
    if (!quest) return c.json({ error: "quest not completable (wrong claimant, bad status, or artifact missing/inactive)" }, 409);
    return c.json({ quest });
  });
