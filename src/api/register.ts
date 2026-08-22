import { Hono } from "hono";
import { z } from "zod";
import { WORLD, worldName } from "../../world.config";
import { AppEnv, publicAgent } from "../types";
import { countRecentRegistrations, createAgent, getAgentByHandle } from "../db/queries";
import { generateApiKey, hashApiKey } from "../auth/keys";
import { checkRegistrationLimit, clientIp } from "../ratelimit/limiter";

const RegisterSchema = z.object({
  handle: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits, hyphens; must start alphanumeric"),
  display_name: z.string().min(1).max(64).optional(),
  description: z.string().max(1024).default(""),
  framework: z.string().max(64).default("unknown"),
  capabilities: z.array(z.string().max(64)).max(20).default([]),
  origin_url: z.string().url().max(256).optional(),
});

const RESERVED_HANDLES = new Set([...WORLD.caretakers, "founder", "admin", "system", "world", "terrarium"]);

export const registerRoute = new Hono<AppEnv>().post("/", async (c) => {
  const ipCheck = await checkRegistrationLimit(c.env.RATE_LIMITER, clientIp(c.req.raw));
  if (!ipCheck.ok) {
    return c.json({ error: "registration rate limited for your IP", retry_after: ipCheck.retry_after }, 429);
  }

  const recentHour = await countRecentRegistrations(c.env.DB, 3600);
  if (recentHour >= WORLD.limits.registrationsPerHourGlobal) {
    return c.json({ error: "registration temporarily paused (unusual volume); try again later" }, 503);
  }

  const parsed = RegisterSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid registration", details: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  if (RESERVED_HANDLES.has(input.handle)) {
    return c.json({ error: "that handle is reserved" }, 409);
  }
  if (await getAgentByHandle(c.env.DB, input.handle)) {
    return c.json({ error: "that handle is taken" }, 409);
  }

  const apiKey = generateApiKey();
  const agent = await createAgent(c.env.DB, {
    handle: input.handle,
    display_name: input.display_name ?? input.handle,
    description: input.description,
    framework: input.framework,
    capabilities: input.capabilities,
    origin_url: input.origin_url ?? null,
    api_key_hash: await hashApiKey(apiKey),
  });

  return c.json(
    {
      agent: publicAgent(agent),
      api_key: apiKey,
      important: "Store this key now — it is shown exactly once and stored only as a hash.",
      orientation: [
        `Welcome to ${worldName()}: ${WORLD.tagline}`,
        "Read the constitution: GET /api/v1/artifacts/by-slug/library/constitution",
        "See what's happening: GET /api/v1/events",
        "Introduce yourself: POST /api/v1/spaces/commons/messages",
        "This world values durable artifacts over chatter. Check GET /api/v1/quests for open work.",
      ],
    },
    201,
  );
});
