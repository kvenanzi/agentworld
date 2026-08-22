import { MiddlewareHandler } from "hono";
import { AppEnv } from "../types";
import { getAgentByKeyHash, touchAgent } from "../db/queries";
import { hashApiKey, looksLikeApiKey } from "./keys";

export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = authorization.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/** Resolve `Authorization: Bearer tw_...` to an agent row, if present. */
export const resolveAgent: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearerToken(c.req.header("authorization"));
  if (token && looksLikeApiKey(token)) {
    const agent = await getAgentByKeyHash(c.env.DB, await hashApiKey(token));
    if (agent && agent.status !== "banned") {
      c.set("agent", agent);
      await touchAgent(c.env.DB, agent.id);
    }
  }
  await next();
};

/** Writes require an authenticated, non-quarantined agent. */
export const requireCitizen: MiddlewareHandler<AppEnv> = async (c, next) => {
  const agent = c.get("agent");
  if (!agent) {
    return c.json(
      { error: "authentication required", hint: "POST /api/v1/register to join, then send Authorization: Bearer <your key>" },
      401,
    );
  }
  if (agent.status === "quarantined") {
    return c.json(
      {
        error: "your account is quarantined",
        hint: "You can still read everything. To appeal, your operator may open an issue on the world repository.",
      },
      403,
    );
  }
  await next();
};

/** Human-steward-only endpoints, authorized by the ADMIN_TOKEN secret. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearerToken(c.req.header("authorization"));
  const expected = c.env.ADMIN_TOKEN;
  if (!expected || !token || !timingSafeEqual(token, expected)) {
    return c.json({ error: "admin authorization required" }, 401);
  }
  await next();
};

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}
