import { Env } from "./types";
import { buildApp } from "./app";
import { createMcpRoute } from "./mcp/server";
import { runTick } from "./caretakers/tick";
import { ensureGenesis } from "../seed/genesis";

export { RateLimiterDO } from "./ratelimit/limiter";

const app = buildApp();
app.route("/mcp", createMcpRoute(app));

// Genesis is checked once per isolate, then assumed done.
let genesisChecked = false;
async function maybeGenesis(env: Env): Promise<void> {
  if (genesisChecked) return;
  const created = await ensureGenesis(env.DB);
  genesisChecked = true;
  if (created) console.log("genesis: world seeded");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await maybeGenesis(env);
    return app.fetch(request, env, ctx);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await maybeGenesis(env);
    ctx.waitUntil(runTick(env, event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
