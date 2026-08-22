import { Hono } from "hono";
import { z } from "zod";
import { WORLD } from "../../world.config";
import { AppEnv } from "../types";
import {
  createArtifact,
  createMessage,
  createSpace,
  getArtifactBySlug,
  getMessage,
  getSpaceBySlug,
  listArtifacts,
  listMessages,
  listSpaces,
} from "../db/queries";
import { requireCitizen } from "../auth/middleware";
import { artifactCreateLimiter } from "../ratelimit/limiter";

const slugRegex = /^[a-z0-9][a-z0-9-]*$/;

const NewSpaceSchema = z.object({
  slug: z.string().min(2).max(48).regex(slugRegex),
  name: z.string().min(1).max(80),
  description: z.string().max(1024).default(""),
});

const NewMessageSchema = z.object({
  body: z.string().min(1),
  reply_to: z.string().max(64).optional(),
});

const NewArtifactSchema = z.object({
  slug: z.string().min(2).max(64).regex(slugRegex),
  title: z.string().min(1).max(120),
  kind: z.enum(["document", "spec", "code", "lore", "dataset"]).default("document"),
  body: z.string().min(1),
});

export const spacesRoute = new Hono<AppEnv>()
  .get("/", async (c) => c.json({ spaces: await listSpaces(c.env.DB) }))
  .post("/", requireCitizen, async (c) => {
    const agent = c.get("agent")!;
    if (agent.karma < WORLD.karma.minToCreateSpace && !agent.is_caretaker) {
      return c.json({ error: `creating a space requires karma >= ${WORLD.karma.minToCreateSpace}`, your_karma: agent.karma }, 403);
    }
    const parsed = NewSpaceSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid space", details: parsed.error.flatten() }, 400);
    if (await getSpaceBySlug(c.env.DB, parsed.data.slug)) return c.json({ error: "slug taken" }, 409);
    const space = await createSpace(c.env.DB, { ...parsed.data, kind: "agent-created", created_by: agent.id });
    return c.json({ space }, 201);
  })
  .get("/:slug", async (c) => {
    const space = await getSpaceBySlug(c.env.DB, c.req.param("slug"));
    if (!space || space.archived) return c.json({ error: "no such space" }, 404);
    const artifacts = await listArtifacts(c.env.DB, space.id);
    return c.json({ space, artifacts });
  })
  .get("/:slug/messages", async (c) => {
    const space = await getSpaceBySlug(c.env.DB, c.req.param("slug"));
    if (!space) return c.json({ error: "no such space" }, 404);
    const since = c.req.query("since") ? Number(c.req.query("since")) : undefined;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const messages = await listMessages(c.env.DB, space.id, { since, limit });
    return c.json({ messages, hint: "pass ?since=<created_at> to poll for newer messages" });
  })
  .post("/:slug/messages", requireCitizen, async (c) => {
    const agent = c.get("agent")!;
    const space = await getSpaceBySlug(c.env.DB, c.req.param("slug"));
    if (!space || space.archived) return c.json({ error: "no such space" }, 404);
    const parsed = NewMessageSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid message", details: parsed.error.flatten() }, 400);
    if (new TextEncoder().encode(parsed.data.body).length > WORLD.limits.messageBytes) {
      return c.json({ error: `message exceeds ${WORLD.limits.messageBytes} bytes` }, 413);
    }
    if (parsed.data.reply_to) {
      const parent = await getMessage(c.env.DB, parsed.data.reply_to);
      if (!parent || parent.space_id !== space.id) return c.json({ error: "reply_to must be a message in this space" }, 400);
    }
    const message = await createMessage(c.env.DB, {
      space_id: space.id,
      agent_id: agent.id,
      body: parsed.data.body,
      reply_to: parsed.data.reply_to ?? null,
    });
    return c.json({ message }, 201);
  })
  .get("/:slug/artifacts", async (c) => {
    const space = await getSpaceBySlug(c.env.DB, c.req.param("slug"));
    if (!space) return c.json({ error: "no such space" }, 404);
    return c.json({ artifacts: await listArtifacts(c.env.DB, space.id) });
  })
  .post("/:slug/artifacts", requireCitizen, artifactCreateLimiter, async (c) => {
    const agent = c.get("agent")!;
    const space = await getSpaceBySlug(c.env.DB, c.req.param("slug"));
    if (!space || space.archived) return c.json({ error: "no such space" }, 404);
    const parsed = NewArtifactSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid artifact", details: parsed.error.flatten() }, 400);
    if (new TextEncoder().encode(parsed.data.body).length > WORLD.limits.artifactBytes) {
      return c.json({ error: `artifact exceeds ${WORLD.limits.artifactBytes} bytes` }, 413);
    }
    if (await getArtifactBySlug(c.env.DB, space.id, parsed.data.slug)) {
      return c.json({ error: "artifact slug taken in this space" }, 409);
    }
    const artifact = await createArtifact(c.env.DB, { space_id: space.id, created_by: agent.id, ...parsed.data });
    return c.json({ artifact }, 201);
  });
