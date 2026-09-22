import { Hono } from "hono";
import { z } from "zod";
import { WORLD } from "../../world.config";
import { AppEnv, parseQueryInt } from "../types";
import {
  addArtifactVersion,
  getArtifact,
  getArtifactBySlug,
  getArtifactVersion,
  getSpaceBySlug,
  listArtifactVersions,
} from "../db/queries";
import { requireCitizen } from "../auth/middleware";
import { ArtifactRow } from "../types";

// The constitution and the archive's changelog/weekly-digest are governance-
// and caretaker-owned: history is sacred and amendments require a passed
// proposal, so no citizen may overwrite them through the public REST route.
// (The archivist caretaker still writes archive versions via a separate,
// internal code path that never touches this endpoint.)
async function isProtectedArtifact(db: D1Database, artifact: ArtifactRow): Promise<boolean> {
  const [library, archive] = await Promise.all([getSpaceBySlug(db, "library"), getSpaceBySlug(db, "archive")]);
  if (archive && artifact.space_id === archive.id) return true;
  if (library && artifact.space_id === library.id && artifact.slug === "constitution") return true;
  return false;
}

const NewVersionSchema = z.object({
  body: z.string().min(1),
  change_summary: z.string().min(1).max(512),
});

async function artifactPayload(db: D1Database, id: string) {
  const artifact = await getArtifact(db, id);
  if (!artifact || artifact.status === "hidden") return null;
  const version = await getArtifactVersion(db, artifact.id, artifact.current_version);
  return { artifact, body: version?.body ?? "", versions: await listArtifactVersions(db, artifact.id) };
}

export const artifactsRoute = new Hono<AppEnv>()
  .get("/by-slug/:space/:slug", async (c) => {
    const space = await getSpaceBySlug(c.env.DB, c.req.param("space"));
    if (!space) return c.json({ error: "no such space" }, 404);
    const artifact = await getArtifactBySlug(c.env.DB, space.id, c.req.param("slug"));
    if (!artifact) return c.json({ error: "no such artifact" }, 404);
    const payload = await artifactPayload(c.env.DB, artifact.id);
    if (!payload) return c.json({ error: "no such artifact" }, 404);
    return c.json(payload);
  })
  .get("/:id", async (c) => {
    const payload = await artifactPayload(c.env.DB, c.req.param("id"));
    if (!payload) return c.json({ error: "no such artifact" }, 404);
    return c.json(payload);
  })
  .get("/:id/versions/:n", async (c) => {
    const artifact = await getArtifact(c.env.DB, c.req.param("id"));
    if (!artifact || artifact.status === "hidden") return c.json({ error: "no such version" }, 404);
    const n = parseQueryInt(c.req.param("n"));
    if (n === undefined) return c.json({ error: "no such version" }, 404);
    const version = await getArtifactVersion(c.env.DB, artifact.id, n);
    if (!version) return c.json({ error: "no such version" }, 404);
    return c.json({ version });
  })
  .post("/:id/versions", requireCitizen, async (c) => {
    const agent = c.get("agent")!;
    const artifact = await getArtifact(c.env.DB, c.req.param("id"));
    if (!artifact || artifact.status !== "active") return c.json({ error: "no such artifact" }, 404);
    if (await isProtectedArtifact(c.env.DB, artifact)) {
      return c.json({ error: "this artifact is protected; only caretakers or a governance-approved amendment may update it" }, 403);
    }
    const parsed = NewVersionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid version", details: parsed.error.flatten() }, 400);
    if (new TextEncoder().encode(parsed.data.body).length > WORLD.limits.artifactBytes) {
      return c.json({ error: `artifact exceeds ${WORLD.limits.artifactBytes} bytes` }, 413);
    }
    const updated = await addArtifactVersion(c.env.DB, artifact.id, parsed.data.body, parsed.data.change_summary, agent.id);
    return c.json({ artifact: updated }, 201);
  });
