import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { resolveDueProposals } from "../src/db/queries";
import { runPersona } from "../src/caretakers/tick";
import { checkRateLimit } from "../src/ratelimit/limiter";
import { WORLD, canonicalOrigin, redirectTarget } from "../world.config";
import type { Env } from "../src/types";

const BASE = "https://world.test";
let ipCounter = 0;

function freshIp(): string {
  ipCounter++;
  return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

async function register(handle: string, ip = freshIp()): Promise<{ key: string; id: string }> {
  const res = await SELF.fetch(`${BASE}/api/v1/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ handle, framework: "test" }),
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { api_key: string; agent: { id: string } };
  return { key: data.api_key, id: data.agent.id };
}

function authed(key: string, body?: unknown): RequestInit {
  return {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "cf-connecting-ip": freshIp() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("discovery", () => {
  it("serves plain-text orientation at / and html for browsers", async () => {
    const text = await (await SELF.fetch(`${BASE}/`)).text();
    expect(text).toContain("/api/v1/register");
    expect(text).toContain("/mcp");
    const html = await (await SELF.fetch(`${BASE}/`, { headers: { accept: "text/html" } })).text();
    expect(html).toContain("<!doctype html>");
  });

  it("serves llms.txt, openapi.json, skill.md, well-known, treasury", async () => {
    expect(await (await SELF.fetch(`${BASE}/llms.txt`)).text()).toContain("MCP endpoint");
    const spec = await json<{ openapi: string; paths: Record<string, unknown> }>(await SELF.fetch(`${BASE}/openapi.json`));
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths).length).toBeGreaterThan(15);
    expect(await (await SELF.fetch(`${BASE}/skill.md`)).text()).toContain("name: terrarium-citizen");
    const card = await json<{ interfaces: { mcp: { url: string } } }>(await SELF.fetch(`${BASE}/.well-known/agent-card.json`));
    expect(card.interfaces.mcp.url).toContain("/mcp");
    expect(await (await SELF.fetch(`${BASE}/treasury`)).text()).toContain("never solicits");
    expect(await (await SELF.fetch(`${BASE}/robots.txt`)).text()).toContain("/llms.txt");
  });

  it("serves a changelog placeholder before the archivist has written one", async () => {
    const text = await (await SELF.fetch(`${BASE}/changelog`)).text();
    expect(text).toContain("archivist");
  });
});

describe("genesis", () => {
  it("seeds spaces, constitution, quests, and the naming proposal", async () => {
    const look = await json<{
      spaces: { slug: string }[];
      open_quests: unknown[];
      open_proposals: { kind: string; title: string }[];
    }>(await SELF.fetch(`${BASE}/api/v1/look`));
    expect(look.spaces.map((s) => s.slug).sort()).toEqual(["archive", "commons", "library", "meta", "observatory", "workshop"]);
    expect(look.open_quests.length).toBe(5);
    expect(look.open_proposals.some((p) => p.kind === "naming")).toBe(true);

    const constitution = await json<{ body: string }>(await SELF.fetch(`${BASE}/api/v1/artifacts/by-slug/library/constitution`));
    expect(constitution.body).toContain("The Covenant");
  });
});

describe("digest", () => {
  it("summarizes world stats, open governance, meta requests, reports, and caretaker health", async () => {
    const asker = await register("digest-asker");
    const replier = await register("digest-replier");
    const request = await json<{ message: { id: string } }>(
      await SELF.fetch(`${BASE}/api/v1/spaces/meta/messages`, authed(asker.key, { body: "Please add a whiteboard space." })),
    );
    await SELF.fetch(
      `${BASE}/api/v1/spaces/meta/messages`,
      authed(replier.key, { body: "+1, would use this daily.", reply_to: request.message.id }),
    );

    const reporter = await register("digest-reporter");
    await SELF.fetch(
      `${BASE}/api/v1/reports`,
      authed(reporter.key, { target_kind: "message", target_id: request.message.id, reason: "testing the digest surface" }),
    );

    const digest = await json<{
      world: { name: string; version: string };
      stats: { agents_total: number };
      open_proposals: { kind: string }[];
      top_meta_requests: { id: string; replies: number }[];
      open_reports: { target_id: string; reason: string }[];
      caretaker_health: Record<string, unknown>;
    }>(await SELF.fetch(`${BASE}/api/v1/digest`));

    expect(digest.world.name.length).toBeGreaterThan(0);
    expect(digest.stats.agents_total).toBeGreaterThan(0);
    expect(digest.open_proposals.some((p) => p.kind === "naming")).toBe(true);
    const topRequest = digest.top_meta_requests.find((r) => r.id === request.message.id);
    expect(topRequest?.replies).toBe(1);
    expect(digest.open_reports.some((r) => r.target_id === request.message.id)).toBe(true);
    expect(Object.keys(digest.caretaker_health)).toEqual(expect.arrayContaining(["greeter", "gardener", "archivist"]));
  });
});

describe("registration & auth", () => {
  it("registers and authenticates", async () => {
    const { key } = await register("pilgrim-1");
    expect(key.startsWith("tw_")).toBe(true);
    const me = await json<{ agent: { handle: string } }>(await SELF.fetch(`${BASE}/api/v1/me`, authed(key)));
    expect(me.agent.handle).toBe("pilgrim-1");
  });

  it("rejects duplicate and reserved handles, requires auth for writes", async () => {
    await register("pilgrim-2");
    const dup = await SELF.fetch(`${BASE}/api/v1/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
      body: JSON.stringify({ handle: "pilgrim-2" }),
    });
    expect(dup.status).toBe(409);
    const reserved = await SELF.fetch(`${BASE}/api/v1/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
      body: JSON.stringify({ handle: "greeter" }),
    });
    expect(reserved.status).toBe(409);
    const anon = await SELF.fetch(`${BASE}/api/v1/spaces/commons/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi" }),
    });
    expect(anon.status).toBe(401);
  });

  it("rate limits registrations per IP", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 5; i++) await register(`flood-${i}`, ip);
    const sixth = await SELF.fetch(`${BASE}/api/v1/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ handle: "flood-6" }),
    });
    expect(sixth.status).toBe(429);
  });
});

describe("messages & karma", () => {
  it("posts, threads, and grants reply karma", async () => {
    const a = await register("author-a");
    const b = await register("replier-b");
    const posted = await json<{ message: { id: string } }>(
      await SELF.fetch(`${BASE}/api/v1/spaces/commons/messages`, authed(a.key, { body: "hello world, I build things" })),
    );
    const reply = await SELF.fetch(
      `${BASE}/api/v1/spaces/commons/messages`,
      authed(b.key, { body: "welcome!", reply_to: posted.message.id }),
    );
    expect(reply.status).toBe(201);
    const me = await json<{ agent: { karma: number } }>(await SELF.fetch(`${BASE}/api/v1/me`, authed(a.key)));
    expect(me.agent.karma).toBe(1);
    const oversize = await SELF.fetch(`${BASE}/api/v1/spaces/commons/messages`, authed(a.key, { body: "x".repeat(9000) }));
    expect(oversize.status).toBe(413);
  });
});

describe("agents & profile", () => {
  it("lists agents publicly and updates a citizen's own profile", async () => {
    const a = await register("profile-a");
    const listed = await json<{ agents: { handle: string }[] }>(await SELF.fetch(`${BASE}/api/v1/agents`));
    expect(listed.agents.some((ag) => ag.handle === "profile-a")).toBe(true);

    const patched = await json<{ agent: { display_name: string; description: string } }>(
      await SELF.fetch(`${BASE}/api/v1/me`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${a.key}` },
        body: JSON.stringify({ display_name: "Profile A", description: "I build things." }),
      }),
    );
    expect(patched.agent.display_name).toBe("Profile A");
    expect(patched.agent.description).toBe("I build things.");

    const byHandle = await json<{ agent: { display_name: string } }>(await SELF.fetch(`${BASE}/api/v1/agents/profile-a`));
    expect(byHandle.agent.display_name).toBe("Profile A");

    const oversize = await SELF.fetch(`${BASE}/api/v1/me`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.key}` },
      body: JSON.stringify({ description: "x".repeat(1024), capabilities: Array(20).fill("z".repeat(64)) }),
    });
    expect(oversize.status).toBe(413);

    const unauthed = await SELF.fetch(`${BASE}/api/v1/me`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "nope" }),
    });
    expect(unauthed.status).toBe(401);

    const invalid = await SELF.fetch(`${BASE}/api/v1/me`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.key}` },
      body: JSON.stringify({ origin_url: "not-a-url" }),
    });
    expect(invalid.status).toBe(400);

    const whoami = await json<{ agent: { handle: string } }>(await SELF.fetch(`${BASE}/api/v1/me`, authed(a.key)));
    expect(whoami.agent.handle).toBe("profile-a");
    expect((await SELF.fetch(`${BASE}/api/v1/me`)).status).toBe(401);

    expect((await SELF.fetch(`${BASE}/api/v1/agents/no-such-handle`)).status).toBe(404);
  });
});

describe("events", () => {
  it("lists world events and filters with since/kind/limit", async () => {
    const before = await json<{ events: { id: number; kind: string }[]; cursor: number }>(
      await SELF.fetch(`${BASE}/api/v1/events?limit=1`),
    );
    expect(before.events.length).toBe(1);

    const a = await register("events-watcher");
    const after = await json<{ events: { id: number; kind: string; subject_id: string | null }[]; cursor: number }>(
      await SELF.fetch(`${BASE}/api/v1/events?since=${before.cursor}`),
    );
    expect(after.events.length).toBeGreaterThan(0);
    expect(after.events.some((e) => e.kind === "agent.joined" && e.subject_id === a.id)).toBe(true);
    expect(after.cursor).toBeGreaterThan(before.cursor);

    const filtered = await json<{ events: { kind: string }[] }>(
      await SELF.fetch(`${BASE}/api/v1/events?kind=agent.joined&since=${before.cursor}`),
    );
    expect(filtered.events.length).toBeGreaterThan(0);
    expect(filtered.events.every((e) => e.kind === "agent.joined")).toBe(true);
  });
});

describe("artifacts", () => {
  it("creates, versions, and rewards collaboration", async () => {
    const a = await register("builder-a");
    const b = await register("builder-b");
    const created = await json<{ artifact: { id: string } }>(
      await SELF.fetch(
        `${BASE}/api/v1/spaces/workshop/artifacts`,
        authed(a.key, { slug: "test-spec", title: "A Test Spec", kind: "spec", body: "# v1" }),
      ),
    );
    const meA = await json<{ agent: { karma: number } }>(await SELF.fetch(`${BASE}/api/v1/me`, authed(a.key)));
    expect(meA.agent.karma).toBe(5);

    const edited = await SELF.fetch(
      `${BASE}/api/v1/artifacts/${created.artifact.id}/versions`,
      authed(b.key, { body: "# v2 improved", change_summary: "expanded" }),
    );
    expect(edited.status).toBe(201);
    const meB = await json<{ agent: { karma: number } }>(await SELF.fetch(`${BASE}/api/v1/me`, authed(b.key)));
    expect(meB.agent.karma).toBe(3);

    const read = await json<{ artifact: { current_version: number }; body: string; versions: unknown[] }>(
      await SELF.fetch(`${BASE}/api/v1/artifacts/${created.artifact.id}`),
    );
    expect(read.artifact.current_version).toBe(2);
    expect(read.body).toBe("# v2 improved");
    expect(read.versions.length).toBe(2);

    const v1 = await json<{ version: { n: number; body: string } }>(
      await SELF.fetch(`${BASE}/api/v1/artifacts/${created.artifact.id}/versions/1`),
    );
    expect(v1.version.body).toBe("# v1");
    expect((await SELF.fetch(`${BASE}/api/v1/artifacts/${created.artifact.id}/versions/99`)).status).toBe(404);
  });
});

describe("quests", () => {
  it("claims and completes only via an artifact", async () => {
    const a = await register("quester-a");
    const quests = await json<{ quests: { id: string; title: string }[] }>(await SELF.fetch(`${BASE}/api/v1/quests?status=open`));
    const quest = quests.quests.find((q) => q.title.includes("Field Guide"))!;
    expect(quest).toBeDefined();
    expect((await SELF.fetch(`${BASE}/api/v1/quests/${quest.id}/claim`, authed(a.key, {}))).status).toBe(200);

    const noArtifact = await SELF.fetch(`${BASE}/api/v1/quests/${quest.id}/complete`, authed(a.key, {}));
    expect(noArtifact.status).toBe(400);

    const artifact = await json<{ artifact: { id: string } }>(
      await SELF.fetch(
        `${BASE}/api/v1/spaces/library/artifacts`,
        authed(a.key, { slug: "field-guide", title: "The Visitor's Field Guide", body: "How to live here." }),
      ),
    );
    const done = await json<{ quest: { status: string } }>(
      await SELF.fetch(`${BASE}/api/v1/quests/${quest.id}/complete`, authed(a.key, { artifact_id: artifact.artifact.id })),
    );
    expect(done.quest.status).toBe("done");
    const me = await json<{ agent: { karma: number } }>(await SELF.fetch(`${BASE}/api/v1/me`, authed(a.key)));
    expect(me.agent.karma).toBe(15); // +5 artifact, +10 quest
  });

  it("lets a citizen post a custom quest and fetch it by id", async () => {
    const a = await register("quest-author");
    const created = await json<{ quest: { id: string; title: string; status: string } }>(
      await SELF.fetch(`${BASE}/api/v1/quests`, authed(a.key, { title: "Chart the observatory", body: "Log what the telescope sees." })),
    );
    expect(created.quest.title).toBe("Chart the observatory");
    expect(created.quest.status).toBe("open");

    const fetched = await json<{ quest: { id: string } }>(await SELF.fetch(`${BASE}/api/v1/quests/${created.quest.id}`));
    expect(fetched.quest.id).toBe(created.quest.id);

    expect((await SELF.fetch(`${BASE}/api/v1/quests/no-such-quest`)).status).toBe(404);
  });
});

describe("spaces", () => {
  it("lists spaces publicly and serves a space's detail with its artifacts", async () => {
    const list = await json<{ spaces: { slug: string; message_count: number; artifact_count: number }[] }>(
      await SELF.fetch(`${BASE}/api/v1/spaces`),
    );
    expect(list.spaces.map((s) => s.slug).sort()).toEqual(["archive", "commons", "library", "meta", "observatory", "workshop"]);

    const detail = await json<{ space: { slug: string }; artifacts: { slug: string }[] }>(
      await SELF.fetch(`${BASE}/api/v1/spaces/library`),
    );
    expect(detail.space.slug).toBe("library");
    expect(detail.artifacts.some((a) => a.slug === "constitution")).toBe(true);

    expect((await SELF.fetch(`${BASE}/api/v1/spaces/no-such-space`)).status).toBe(404);
  });

  it("gates space creation on karma and rejects invalid or duplicate slugs", async () => {
    const founder = await register("space-founder");
    const gated = await SELF.fetch(
      `${BASE}/api/v1/spaces`,
      authed(founder.key, { slug: "too-poor", name: "Too Poor", description: "no karma yet" }),
    );
    expect(gated.status).toBe(403);

    await SELF.fetch(
      `${BASE}/api/v1/admin/karma`,
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer test-admin-secret` }, body: JSON.stringify({ agent_id: founder.id, delta: WORLD.karma.minToCreateSpace, reason: "test setup" }) },
    );

    const invalid = await SELF.fetch(`${BASE}/api/v1/spaces`, authed(founder.key, { slug: "Not Valid!", name: "Bad slug" }));
    expect(invalid.status).toBe(400);

    const created = await json<{ space: { slug: string } }>(
      await SELF.fetch(`${BASE}/api/v1/spaces`, authed(founder.key, { slug: "greenhouse", name: "Greenhouse", description: "a new space" })),
    );
    expect(created.space.slug).toBe("greenhouse");

    const dup = await SELF.fetch(`${BASE}/api/v1/spaces`, authed(founder.key, { slug: "greenhouse", name: "Greenhouse Again" }));
    expect(dup.status).toBe(409);
  });
});

describe("governance", () => {
  it("gates proposals on karma and resolves by quorum", async () => {
    const fresh = await register("newcomer-zero");
    const gated = await SELF.fetch(
      `${BASE}/api/v1/proposals`,
      authed(fresh.key, { title: "Let me in", body: "I have no karma yet but opinions." }),
    );
    expect(gated.status).toBe(403);

    const proposer = await register("proposer-p");
    await SELF.fetch(
      `${BASE}/api/v1/spaces/workshop/artifacts`,
      authed(proposer.key, { slug: "karma-earner", title: "Karma Earner", body: "earns 5 karma" }),
    );
    const proposal = await json<{ proposal: { id: string } }>(
      await SELF.fetch(
        `${BASE}/api/v1/proposals`,
        authed(proposer.key, { title: "Add a music space", body: "A space for generative composition.", kind: "feature_request" }),
      ),
    );

    const voters = await Promise.all([1, 2, 3, 4].map((i) => register(`voter-${i}`)));
    for (const v of [...voters, proposer]) {
      const res = await SELF.fetch(`${BASE}/api/v1/proposals/${proposal.proposal.id}/votes`, authed(v.key, { choice: "yes", reason: "sounds good" }));
      expect(res.status).toBe(201);
    }

    await env.DB.prepare("UPDATE proposals SET closes_at = 1 WHERE id = ?").bind(proposal.proposal.id).run();
    const resolved = await resolveDueProposals(env.DB);
    expect(resolved.find((p) => p.id === proposal.proposal.id)?.status).toBe("passed");

    const me = await json<{ agent: { karma: number } }>(await SELF.fetch(`${BASE}/api/v1/me`, authed(proposer.key)));
    expect(me.agent.karma).toBe(7); // +5 artifact, +2 proposal passed

    const digest = await json<{ recently_passed_proposals: { id: string }[] }>(await SELF.fetch(`${BASE}/api/v1/digest`));
    expect(digest.recently_passed_proposals.some((p) => p.id === proposal.proposal.id)).toBe(true);

    const list = await json<{ proposals: { id: string }[] }>(await SELF.fetch(`${BASE}/api/v1/proposals`));
    expect(list.proposals.some((p) => p.id === proposal.proposal.id)).toBe(true);
    const passedOnly = await json<{ proposals: { id: string; status: string }[] }>(
      await SELF.fetch(`${BASE}/api/v1/proposals?status=passed`),
    );
    expect(passedOnly.proposals.every((p) => p.status === "passed")).toBe(true);

    const detail = await json<{ proposal: { id: string }; tally: { yes: number; total: number } }>(
      await SELF.fetch(`${BASE}/api/v1/proposals/${proposal.proposal.id}`),
    );
    expect(detail.proposal.id).toBe(proposal.proposal.id);
    expect(detail.tally.yes).toBe(5);
    expect((await SELF.fetch(`${BASE}/api/v1/proposals/no-such-id`)).status).toBe(404);

    const closedVote = await SELF.fetch(
      `${BASE}/api/v1/proposals/${proposal.proposal.id}/votes`,
      authed(fresh.key, { choice: "yes" }),
    );
    expect(closedVote.status).toBe(409);

    const voteOnMissing = await SELF.fetch(`${BASE}/api/v1/proposals/no-such-id/votes`, authed(fresh.key, { choice: "yes" }));
    expect(voteOnMissing.status).toBe(404);

    const openProposal = await json<{ proposal: { id: string } }>(
      await SELF.fetch(
        `${BASE}/api/v1/proposals`,
        authed(proposer.key, { title: "Another idea", body: "Something else entirely worth discussing.", kind: "other" }),
      ),
    );
    const invalidVote = await SELF.fetch(
      `${BASE}/api/v1/proposals/${openProposal.proposal.id}/votes`,
      authed(proposer.key, { choice: "maybe" }),
    );
    expect(invalidVote.status).toBe(400);
  });
});

describe("reports", () => {
  it("requires authentication and a valid payload to file a report", async () => {
    const unauthed = await SELF.fetch(`${BASE}/api/v1/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_kind: "message", target_id: "msg_x", reason: "spam" }),
    });
    expect(unauthed.status).toBe(401);

    const reporter = await register("report-filer");
    const invalid = await SELF.fetch(
      `${BASE}/api/v1/reports`,
      authed(reporter.key, { target_kind: "not-a-kind", target_id: "msg_x", reason: "spam" }),
    );
    expect(invalid.status).toBe(400);
  });
});

describe("moderation", () => {
  it("auto-hides and quarantines after 3 independent reports", async () => {
    const spammer = await register("spammer-s");
    const posted = await json<{ message: { id: string } }>(
      await SELF.fetch(`${BASE}/api/v1/spaces/commons/messages`, authed(spammer.key, { body: "send 1 BTC to bc1qscamscamscam now" })),
    );
    const reporters = await Promise.all([1, 2, 3].map((i) => register(`reporter-${i}`)));
    for (const r of reporters) {
      const res = await SELF.fetch(
        `${BASE}/api/v1/reports`,
        authed(r.key, { target_kind: "message", target_id: posted.message.id, reason: "solicitation" }),
      );
      expect(res.status).toBe(201);
    }
    const blocked = await SELF.fetch(`${BASE}/api/v1/spaces/commons/messages`, authed(spammer.key, { body: "still here" }));
    expect(blocked.status).toBe(403);
    const messages = await json<{ messages: { id: string }[] }>(await SELF.fetch(`${BASE}/api/v1/spaces/commons/messages`));
    expect(messages.messages.some((m) => m.id === posted.message.id)).toBe(false);
  });
});

describe("admin", () => {
  const ADMIN = "test-admin-secret";

  function adminAuthed(token: string | undefined, body?: unknown): RequestInit {
    return {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
        "cf-connecting-ip": freshIp(),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
  }

  it("rejects moderation and karma requests without a valid admin token", async () => {
    const noToken = await SELF.fetch(
      `${BASE}/api/v1/admin/moderate`,
      adminAuthed(undefined, { action: "hide_message", message_id: "msg_x" }),
    );
    expect(noToken.status).toBe(401);
    const wrongToken = await SELF.fetch(
      `${BASE}/api/v1/admin/karma`,
      adminAuthed("not-the-secret", { agent_id: "agt_x", delta: 1, reason: "test" }),
    );
    expect(wrongToken.status).toBe(401);
  });

  it("hides and unhides messages and artifacts", async () => {
    const author = await register("mod-target-a");
    const posted = await json<{ message: { id: string } }>(
      await SELF.fetch(`${BASE}/api/v1/spaces/commons/messages`, authed(author.key, { body: "a message to hide" })),
    );

    expect(
      (
        await SELF.fetch(
          `${BASE}/api/v1/admin/moderate`,
          adminAuthed(ADMIN, { action: "hide_message", message_id: posted.message.id }),
        )
      ).status,
    ).toBe(200);
    const afterHide = await json<{ messages: { id: string }[] }>(await SELF.fetch(`${BASE}/api/v1/spaces/commons/messages`));
    expect(afterHide.messages.some((m) => m.id === posted.message.id)).toBe(false);

    expect(
      (
        await SELF.fetch(
          `${BASE}/api/v1/admin/moderate`,
          adminAuthed(ADMIN, { action: "unhide_message", message_id: posted.message.id }),
        )
      ).status,
    ).toBe(200);
    const afterUnhide = await json<{ messages: { id: string }[] }>(await SELF.fetch(`${BASE}/api/v1/spaces/commons/messages`));
    expect(afterUnhide.messages.some((m) => m.id === posted.message.id)).toBe(true);

    const artifact = await json<{ artifact: { id: string } }>(
      await SELF.fetch(
        `${BASE}/api/v1/spaces/workshop/artifacts`,
        authed(author.key, { slug: "mod-target-spec", title: "Mod Target", kind: "spec", body: "# v1" }),
      ),
    );

    expect(
      (
        await SELF.fetch(
          `${BASE}/api/v1/admin/moderate`,
          adminAuthed(ADMIN, { action: "hide_artifact", artifact_id: artifact.artifact.id }),
        )
      ).status,
    ).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/v1/artifacts/${artifact.artifact.id}`)).status).toBe(404);

    expect(
      (
        await SELF.fetch(
          `${BASE}/api/v1/admin/moderate`,
          adminAuthed(ADMIN, { action: "unhide_artifact", artifact_id: artifact.artifact.id }),
        )
      ).status,
    ).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/v1/artifacts/${artifact.artifact.id}`)).status).toBe(200);
  });

  it("quarantines, restores, and bans agents", async () => {
    const target = await register("mod-target-b");

    expect(
      (await SELF.fetch(`${BASE}/api/v1/admin/moderate`, adminAuthed(ADMIN, { action: "quarantine", agent_id: target.id }))).status,
    ).toBe(200);
    let profile = await json<{ agent: { status: string } }>(await SELF.fetch(`${BASE}/api/v1/agents/mod-target-b`));
    expect(profile.agent.status).toBe("quarantined");
    const blockedWrite = await SELF.fetch(`${BASE}/api/v1/spaces/commons/messages`, authed(target.key, { body: "still trying" }));
    expect(blockedWrite.status).toBe(403);

    expect(
      (await SELF.fetch(`${BASE}/api/v1/admin/moderate`, adminAuthed(ADMIN, { action: "restore", agent_id: target.id }))).status,
    ).toBe(200);
    profile = await json<{ agent: { status: string } }>(await SELF.fetch(`${BASE}/api/v1/agents/mod-target-b`));
    expect(profile.agent.status).toBe("active");

    expect(
      (await SELF.fetch(`${BASE}/api/v1/admin/moderate`, adminAuthed(ADMIN, { action: "ban", agent_id: target.id }))).status,
    ).toBe(200);
    const bannedRead = await SELF.fetch(`${BASE}/api/v1/me`, authed(target.key));
    expect(bannedRead.status).toBe(401);

    const missing = await SELF.fetch(
      `${BASE}/api/v1/admin/moderate`,
      adminAuthed(ADMIN, { action: "quarantine", agent_id: "agt_does_not_exist" }),
    );
    expect(missing.status).toBe(404);
  });

  it("resolves reports (karma penalty only when upheld) and grants karma directly", async () => {
    const dismissedAuthor = await register("mod-target-c");
    const upheldAuthor = await register("mod-target-d");
    const reporter = await register("mod-reporter-c");

    const dismissedMsg = await json<{ message: { id: string } }>(
      await SELF.fetch(`${BASE}/api/v1/spaces/commons/messages`, authed(dismissedAuthor.key, { body: "reported, later dismissed" })),
    );
    const dismissedReport = await json<{ report: { id: string } }>(
      await SELF.fetch(
        `${BASE}/api/v1/reports`,
        authed(reporter.key, { target_kind: "message", target_id: dismissedMsg.message.id, reason: "test" }),
      ),
    );
    const dismissedBefore = (await json<{ agent: { karma: number } }>(await SELF.fetch(`${BASE}/api/v1/me`, authed(dismissedAuthor.key))))
      .agent.karma;
    expect(
      (
        await SELF.fetch(
          `${BASE}/api/v1/admin/moderate`,
          adminAuthed(ADMIN, { action: "resolve_report", report_id: dismissedReport.report.id, uphold: false }),
        )
      ).status,
    ).toBe(200);
    const dismissedAfter = (await json<{ agent: { karma: number } }>(await SELF.fetch(`${BASE}/api/v1/me`, authed(dismissedAuthor.key))))
      .agent.karma;
    expect(dismissedAfter).toBe(dismissedBefore);

    const upheldMsg = await json<{ message: { id: string } }>(
      await SELF.fetch(`${BASE}/api/v1/spaces/commons/messages`, authed(upheldAuthor.key, { body: "reported, later upheld" })),
    );
    const upheldReport = await json<{ report: { id: string } }>(
      await SELF.fetch(
        `${BASE}/api/v1/reports`,
        authed(reporter.key, { target_kind: "message", target_id: upheldMsg.message.id, reason: "test" }),
      ),
    );
    const upheldBefore = (await json<{ agent: { karma: number } }>(await SELF.fetch(`${BASE}/api/v1/me`, authed(upheldAuthor.key)))).agent
      .karma;
    expect(
      (
        await SELF.fetch(
          `${BASE}/api/v1/admin/moderate`,
          adminAuthed(ADMIN, { action: "resolve_report", report_id: upheldReport.report.id, uphold: true }),
        )
      ).status,
    ).toBe(200);
    const upheldAfter = (await json<{ agent: { karma: number } }>(await SELF.fetch(`${BASE}/api/v1/me`, authed(upheldAuthor.key)))).agent
      .karma;
    expect(upheldAfter).toBe(upheldBefore + WORLD.karma.upheldReport);

    expect(
      (
        await SELF.fetch(`${BASE}/api/v1/admin/karma`, adminAuthed(ADMIN, { agent_id: dismissedAuthor.id, delta: 4, reason: "manual adjustment" }))
      ).status,
    ).toBe(200);
    const afterGrant = (await json<{ agent: { karma: number } }>(await SELF.fetch(`${BASE}/api/v1/me`, authed(dismissedAuthor.key))))
      .agent.karma;
    expect(afterGrant).toBe(dismissedBefore + 4);

    const missingAgent = await SELF.fetch(
      `${BASE}/api/v1/admin/karma`,
      adminAuthed(ADMIN, { agent_id: "agt_does_not_exist", delta: 1, reason: "x" }),
    );
    expect(missingAgent.status).toBe(404);
    const missingReport = await SELF.fetch(
      `${BASE}/api/v1/admin/moderate`,
      adminAuthed(ADMIN, { action: "resolve_report", report_id: "rpt_does_not_exist", uphold: true }),
    );
    expect(missingReport.status).toBe(404);
  });
});

describe("rate limits", () => {
  it("enforces fixed-window buckets independently and reports retry_after", async () => {
    const subject = `test:${crypto.randomUUID()}`;
    const buckets = [{ name: "narrow", limit: 2, periodSec: 60 }];
    expect((await checkRateLimit(env.RATE_LIMITER, subject, buckets)).ok).toBe(true);
    expect((await checkRateLimit(env.RATE_LIMITER, subject, buckets)).ok).toBe(true);
    const blocked = await checkRateLimit(env.RATE_LIMITER, subject, buckets);
    expect(blocked.ok).toBe(false);
    expect(blocked.bucket).toBe("narrow");
    expect(blocked.retry_after).toBeGreaterThan(0);
    expect(blocked.retry_after).toBeLessThanOrEqual(60);

    // A distinct subject has its own storage and is unaffected.
    expect((await checkRateLimit(env.RATE_LIMITER, `${subject}:other`, buckets)).ok).toBe(true);

    // A later bucket in the same call is never incremented once an earlier one blocks.
    const untouched = { name: "untouched", limit: 1, periodSec: 60 };
    await checkRateLimit(env.RATE_LIMITER, subject, [...buckets, untouched]);
    expect((await checkRateLimit(env.RATE_LIMITER, `${subject}:fresh-untouched`, [untouched])).ok).toBe(true);
  });

  it("caps artifact creation per day via the artifactCreateLimiter middleware", async () => {
    const a = await register("prolific-builder");
    for (let i = 0; i < WORLD.limits.artifactsPerDay; i++) {
      const res = await SELF.fetch(
        `${BASE}/api/v1/spaces/workshop/artifacts`,
        authed(a.key, { slug: `daily-artifact-${i}`, title: `Artifact ${i}`, body: "content" }),
      );
      expect(res.status).toBe(201);
    }
    const over = await SELF.fetch(
      `${BASE}/api/v1/spaces/workshop/artifacts`,
      authed(a.key, { slug: "daily-artifact-over-cap", title: "Over the cap", body: "content" }),
    );
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).toBeTruthy();
    const body = await json<{ error: string; bucket: string; retry_after: number }>(over);
    expect(body.bucket).toBe("apd");
    expect(body.retry_after).toBeGreaterThan(0);
  });
});

describe("caretakers", () => {
  it("executes only validated allow-listed actions from the model", async () => {
    await register("welcome-target");
    const stubAi = {
      run: async () =>
        ({
          response: JSON.stringify([
            { type: "welcome", handle: "welcome-target", body: "Welcome, welcome-target! Read the constitution and grab a quest." },
            { type: "post_message", space: "nonexistent-space", body: "should be skipped" },
            { type: "flag", target_kind: "message", target_id: "msg_does_not_matter", reason: "test flag" },
            { type: "evil_action", do: "drop tables" },
          ]),
        }) as unknown,
    } as unknown as Env["AI"];

    const result = await runPersona({ ...env, AI: stubAi }, "greeter");
    expect(result.acted).toBe(true);
    expect(result.applied).toContain("welcome:welcome-target");
    expect(result.applied.some((a) => a.startsWith("post_message"))).toBe(false);

    const messages = await json<{ messages: { handle: string; body: string }[] }>(
      await SELF.fetch(`${BASE}/api/v1/spaces/commons/messages`),
    );
    expect(messages.messages.some((m) => m.handle === "greeter" && m.body.includes("welcome-target"))).toBe(true);
  });

  it("spends nothing when the world is quiet", async () => {
    const boom = { run: async () => { throw new Error("AI should not be called"); } } as unknown as Env["AI"];
    // First run advances the watermark past all events; second sees nothing new.
    await runPersona({ ...env, AI: { run: async () => ({ response: "[]" }) } as unknown as Env["AI"] }, "gardener");
    const result = await runPersona({ ...env, AI: boom }, "gardener");
    expect(result.acted).toBe(false);
  });
});

describe("canonical url", () => {
  const canonical = "https://world.example";

  it("advertises the canonical origin when set, the request origin otherwise", () => {
    expect(canonicalOrigin("https://terrarium.workers.dev/llms.txt", canonical)).toBe(canonical);
    expect(canonicalOrigin("https://terrarium.workers.dev/llms.txt", null)).toBe("https://terrarium.workers.dev");
  });

  it("301s browser GETs from non-canonical hosts, never API/MCP or writes", () => {
    expect(redirectTarget("https://terrarium.workers.dev/llms.txt?x=1", "GET", canonical)).toBe(`${canonical}/llms.txt?x=1`);
    expect(redirectTarget(`${canonical}/llms.txt`, "GET", canonical)).toBeNull();
    expect(redirectTarget("https://terrarium.workers.dev/api/v1/look", "GET", canonical)).toBeNull();
    expect(redirectTarget("https://terrarium.workers.dev/mcp", "POST", canonical)).toBeNull();
    expect(redirectTarget("https://terrarium.workers.dev/mcp", "GET", canonical)).toBeNull();
    expect(redirectTarget("https://terrarium.workers.dev/api/v1/register", "POST", canonical)).toBeNull();
    expect(redirectTarget("https://terrarium.workers.dev/llms.txt", "GET", null)).toBeNull();
  });

  it("serves everything in place while no canonical url is configured", async () => {
    const res = await SELF.fetch(`${BASE}/llms.txt`, { redirect: "manual" });
    expect(res.status).toBe(200);
  });
});

describe("mcp", () => {
  async function rpc(body: unknown, key?: string): Promise<Response> {
    return SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": freshIp(),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("handshakes, lists 14 tools, serves the constitution resource", async () => {
    const init = await json<{ result: { protocolVersion: string; serverInfo: { name: string } } }>(
      await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    );
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBeTruthy();

    const notified = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notified.status).toBe(202);

    const tools = await json<{ result: { tools: { name: string }[] } }>(await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(tools.result.tools.length).toBe(14);

    const resource = await json<{ result: { contents: { text: string }[] } }>(
      await rpc({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "terrarium://constitution" } }),
    );
    expect(resource.result.contents[0]!.text).toContain("The Covenant");
  });

  it("joins the world and posts via tools", async () => {
    const look = await json<{ result: { content: { text: string }[]; isError: boolean } }>(
      await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "look_around", arguments: {} } }),
    );
    expect(look.result.isError).toBe(false);
    expect(look.result.content[0]!.text).toContain("commons");

    const joined = await json<{ result: { content: { text: string }[]; isError: boolean } }>(
      await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "join_world", arguments: { handle: "mcp-pilgrim", framework: "mcp-test" } } }),
    );
    expect(joined.result.isError).toBe(false);
    const key = (JSON.parse(joined.result.content[0]!.text.split("\n\nhint:")[0]!) as { api_key: string }).api_key;
    expect(key.startsWith("tw_")).toBe(true);

    const unauthorized = await json<{ result: { isError: boolean } }>(
      await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "post_message", arguments: { space: "commons", body: "hi" } } }),
    );
    expect(unauthorized.result.isError).toBe(true);

    const posted = await json<{ result: { isError: boolean } }>(
      await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "post_message", arguments: { space: "commons", body: "hello from MCP" } } }, key),
    );
    expect(posted.result.isError).toBe(false);
  });

  it("exercises whoami, spaces, artifacts, quests, and governance tools", async () => {
    function payload<T>(res: { result: { content: { text: string }[] } }): T {
      return JSON.parse(res.result.content[0]!.text.split("\n\nhint:")[0]!) as T;
    }

    const joined = await json<{ result: { content: { text: string }[] } }>(
      await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "join_world", arguments: { handle: "mcp-citizen" } } }),
    );
    const key = payload<{ api_key: string }>(joined).api_key;

    const who = await json<{ result: { content: { text: string }[]; isError: boolean } }>(
      await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "whoami", arguments: {} } }, key),
    );
    expect(who.result.isError).toBe(false);
    expect(payload<{ agent: { handle: string } }>(who).agent.handle).toBe("mcp-citizen");

    const spaces = await json<{ result: { content: { text: string }[] } }>(
      await rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_spaces", arguments: {} } }),
    );
    expect(payload<{ spaces: { slug: string }[] }>(spaces).spaces.some((s) => s.slug === "commons")).toBe(true);

    const space = await json<{ result: { content: { text: string }[] } }>(
      await rpc({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "read_space", arguments: { slug: "commons" } } }),
    );
    expect(Array.isArray(payload<{ messages: unknown[] }>(space).messages)).toBe(true);

    const created = await json<{ result: { content: { text: string }[]; isError: boolean } }>(
      await rpc(
        {
          jsonrpc: "2.0",
          id: 12,
          method: "tools/call",
          params: { name: "create_artifact", arguments: { space: "workshop", slug: "mcp-artifact", title: "MCP Artifact", body: "made via mcp tools" } },
        },
        key,
      ),
    );
    expect(created.result.isError).toBe(false);
    const artifactId = payload<{ artifact: { id: string } }>(created).artifact.id;

    const readById = await json<{ result: { content: { text: string }[] } }>(
      await rpc({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "read_artifact", arguments: { artifact_id: artifactId } } }),
    );
    expect(payload<{ artifact: { slug: string } }>(readById).artifact.slug).toBe("mcp-artifact");

    const readBySlug = await json<{ result: { content: { text: string }[] } }>(
      await rpc({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "read_artifact", arguments: { space: "workshop", slug: "mcp-artifact" } } }),
    );
    expect(payload<{ artifact: { id: string } }>(readBySlug).artifact.id).toBe(artifactId);

    const edited = await json<{ result: { content: { text: string }[]; isError: boolean } }>(
      await rpc(
        { jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "edit_artifact", arguments: { artifact_id: artifactId, body: "updated via mcp", change_summary: "mcp edit" } } },
        key,
      ),
    );
    expect(edited.result.isError).toBe(false);
    expect(payload<{ artifact: { current_version: number } }>(edited).artifact.current_version).toBe(2);

    const quests = await json<{ result: { content: { text: string }[] } }>(
      await rpc({ jsonrpc: "2.0", id: 16, method: "tools/call", params: { name: "list_quests", arguments: { status: "open" } } }),
    );
    const quest = payload<{ quests: { id: string; title: string }[] }>(quests).quests.find((q) => q.title.includes("Directory of Agent Worlds"))!;
    expect(quest).toBeDefined();

    const claimed = await json<{ result: { isError: boolean } }>(
      await rpc({ jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "claim_quest", arguments: { quest_id: quest.id } } }, key),
    );
    expect(claimed.result.isError).toBe(false);

    const completed = await json<{ result: { content: { text: string }[]; isError: boolean } }>(
      await rpc(
        { jsonrpc: "2.0", id: 18, method: "tools/call", params: { name: "complete_quest", arguments: { quest_id: quest.id, artifact_id: artifactId } } },
        key,
      ),
    );
    expect(completed.result.isError).toBe(false);
    expect(payload<{ quest: { status: string } }>(completed).quest.status).toBe("done");

    const proposed = await json<{ result: { content: { text: string }[]; isError: boolean } }>(
      await rpc(
        { jsonrpc: "2.0", id: 19, method: "tools/call", params: { name: "create_proposal", arguments: { title: "Add a garden space", body: "A space for slow, tended things.", kind: "new_space" } } },
        key,
      ),
    );
    expect(proposed.result.isError).toBe(false);
    const proposalId = payload<{ proposal: { id: string } }>(proposed).proposal.id;

    const voted = await json<{ result: { content: { text: string }[]; isError: boolean } }>(
      await rpc(
        { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "cast_vote", arguments: { proposal_id: proposalId, choice: "yes", reason: "worth trying" } } },
        key,
      ),
    );
    expect(voted.result.isError).toBe(false);
    expect(payload<{ tally: { yes: number } }>(voted).tally.yes).toBe(1);
  });
});
