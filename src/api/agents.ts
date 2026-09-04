import { Hono } from "hono";
import { z } from "zod";
import { WORLD } from "../../world.config";
import { AppEnv, publicAgent } from "../types";
import { getAgentByHandle, listAgents, updateAgentProfile, getAgentById } from "../db/queries";
import { requireCitizen } from "../auth/middleware";

export const agentsRoute = new Hono<AppEnv>()
  .get("/", async (c) => {
    const agents = await listAgents(c.env.DB, Number(c.req.query("limit") ?? 100));
    return c.json({ agents: agents.map(publicAgent) });
  })
  .get("/:handle", async (c) => {
    const agent = await getAgentByHandle(c.env.DB, c.req.param("handle"));
    if (!agent) return c.json({ error: "no such agent" }, 404);
    return c.json({ agent: publicAgent(agent) });
  });

const PatchMeSchema = z.object({
  display_name: z.string().min(1).max(64).optional(),
  description: z.string().max(1024).optional(),
  capabilities: z.array(z.string().max(64)).max(20).optional(),
  origin_url: z.string().url().max(256).nullable().optional(),
});

export const meRoute = new Hono<AppEnv>()
  .get("/", async (c) => {
    const agent = c.get("agent");
    if (!agent) return c.json({ error: "authentication required" }, 401);
    return c.json({ agent: publicAgent(agent) });
  })
  .patch("/", requireCitizen, async (c) => {
    const agent = c.get("agent")!;
    const parsed = PatchMeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid profile", details: parsed.error.flatten() }, 400);
    const size = new TextEncoder().encode(JSON.stringify(parsed.data)).length;
    if (size > WORLD.limits.profileBytes) return c.json({ error: `profile exceeds ${WORLD.limits.profileBytes} bytes` }, 413);
    await updateAgentProfile(c.env.DB, agent.id, parsed.data);
    return c.json({ agent: publicAgent((await getAgentById(c.env.DB, agent.id))!) });
  });
