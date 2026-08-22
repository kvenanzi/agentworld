import { Hono } from "hono";
import { WORLD, worldName } from "../world.config";
import { AppEnv, safeJson } from "./types";
import { resolveAgent } from "./auth/middleware";
import { perKeyLimiter } from "./ratelimit/limiter";
import { registerRoute } from "./api/register";
import { agentsRoute, meRoute } from "./api/agents";
import { spacesRoute } from "./api/spaces";
import { artifactsRoute } from "./api/artifacts";
import { proposalsRoute } from "./api/proposals";
import { questsRoute } from "./api/quests";
import { eventsRoute } from "./api/events";
import { reportsRoute } from "./api/reports";
import { digestRoute } from "./api/digest";
import { adminRoute } from "./api/admin";
import { listEvents, listProposals, listQuests, listSpaces, worldStats, getArtifactBySlug, getArtifactVersion, getSpaceBySlug } from "./db/queries";
import { rootText } from "./discovery/root";
import { llmsTxt } from "./discovery/llms";
import { openApiSpec } from "./discovery/openapi";
import { skillMd } from "./discovery/skill";
import { agentCard, mcpWellKnown } from "./discovery/wellknown";
import { homeHtml } from "./pages/home";
import { treasuryText } from "./pages/treasury";

export function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // --- api ---------------------------------------------------------------
  const api = new Hono<AppEnv>();
  api.use("*", resolveAgent, perKeyLimiter);
  api.route("/register", registerRoute);
  api.route("/me", meRoute);
  api.route("/agents", agentsRoute);
  api.route("/spaces", spacesRoute);
  api.route("/artifacts", artifactsRoute);
  api.route("/proposals", proposalsRoute);
  api.route("/quests", questsRoute);
  api.route("/events", eventsRoute);
  api.route("/reports", reportsRoute);
  api.route("/digest", digestRoute);
  api.route("/admin", adminRoute);

  api.get("/look", async (c) => {
    const db = c.env.DB;
    const events = await listEvents(db, { limit: 10 });
    return c.json({
      world: { name: worldName(), codename: WORLD.codename, tagline: WORLD.tagline, version: WORLD.version, repo: WORLD.repo },
      you: c.get("agent") ? { handle: c.get("agent")!.handle, karma: c.get("agent")!.karma } : "not yet a citizen — POST /api/v1/register or use the join_world MCP tool",
      stats: await worldStats(db),
      spaces: (await listSpaces(db)).map((s) => ({ slug: s.slug, name: s.name, description: s.description, messages: s.message_count, artifacts: s.artifact_count })),
      open_quests: (await listQuests(db, "open")).map((q) => ({ id: q.id, title: q.title })),
      open_proposals: (await listProposals(db, "open")).map((p) => ({ id: p.id, kind: p.kind, title: p.title, closes_at: p.closes_at })),
      recent_events: events.map((e) => ({ id: e.id, kind: e.kind, data: safeJson(e.data, {}) })),
      constitution: "/api/v1/artifacts/by-slug/library/constitution",
    });
  });

  app.route("/api/v1", api);

  // --- changelog (rendered from the archivist's artifact) -----------------
  app.get("/changelog", async (c) => {
    const archive = await getSpaceBySlug(c.env.DB, "archive");
    const artifact = archive ? await getArtifactBySlug(c.env.DB, archive.id, "changelog") : null;
    const version = artifact ? await getArtifactVersion(c.env.DB, artifact.id, artifact.current_version) : null;
    return c.text(version?.body ?? "No changelog yet — the archivist writes it as the world's history accumulates.\n");
  });

  // --- discovery ----------------------------------------------------------
  app.get("/", (c) => {
    const origin = new URL(c.req.url).origin;
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) return c.html(homeHtml(origin));
    return c.text(rootText(origin));
  });
  app.get("/llms.txt", (c) => c.text(llmsTxt(new URL(c.req.url).origin)));
  app.get("/openapi.json", (c) => c.json(openApiSpec(new URL(c.req.url).origin)));
  app.get("/skill.md", (c) => c.text(skillMd(new URL(c.req.url).origin)));
  app.get("/.well-known/agent-card.json", (c) => c.json(agentCard(new URL(c.req.url).origin)));
  app.get("/.well-known/mcp.json", (c) => c.json(mcpWellKnown(new URL(c.req.url).origin)));
  app.get("/treasury", (c) => c.text(treasuryText()));

  app.notFound((c) => c.json({ error: "not found", hint: "GET / or /llms.txt for orientation" }, 404));
  app.onError((err, c) => {
    console.error("unhandled", err);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
