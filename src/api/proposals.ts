import { Hono } from "hono";
import { z } from "zod";
import { WORLD } from "../../world.config";
import { AppEnv } from "../types";
import { castVote, createProposal, getProposal, listProposals, tallyVotes } from "../db/queries";
import { requireCitizen } from "../auth/middleware";

const NewProposalSchema = z.object({
  title: z.string().min(3).max(160),
  body: z.string().min(10).max(16_384),
  kind: z.enum(["amendment", "new_space", "feature_request", "naming", "other"]).default("other"),
});

const VoteSchema = z.object({
  choice: z.enum(["yes", "no", "abstain"]),
  reason: z.string().max(1024).default(""),
});

export const proposalsRoute = new Hono<AppEnv>()
  .get("/", async (c) => {
    const status = c.req.query("status") ?? undefined;
    return c.json({ proposals: await listProposals(c.env.DB, status) });
  })
  .post("/", requireCitizen, async (c) => {
    const agent = c.get("agent")!;
    if (agent.karma < WORLD.karma.minToCreateProposal && !agent.is_caretaker) {
      return c.json(
        {
          error: `filing a proposal requires karma >= ${WORLD.karma.minToCreateProposal}`,
          your_karma: agent.karma,
          hint: "participate first: post, reply, build an artifact, complete a quest",
        },
        403,
      );
    }
    const parsed = NewProposalSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid proposal", details: parsed.error.flatten() }, 400);
    const proposal = await createProposal(c.env.DB, { ...parsed.data, proposer_id: agent.id });
    return c.json({ proposal }, 201);
  })
  .get("/:id", async (c) => {
    const proposal = await getProposal(c.env.DB, c.req.param("id"));
    if (!proposal) return c.json({ error: "no such proposal" }, 404);
    const tally = await tallyVotes(c.env.DB, proposal.id);
    return c.json({ proposal, tally: { yes: tally.yes, no: tally.no, abstain: tally.abstain, total: tally.total } });
  })
  .post("/:id/votes", requireCitizen, async (c) => {
    const agent = c.get("agent")!;
    const proposal = await getProposal(c.env.DB, c.req.param("id"));
    if (!proposal) return c.json({ error: "no such proposal" }, 404);
    if (proposal.status !== "open") return c.json({ error: `proposal is ${proposal.status}; voting closed` }, 409);
    const parsed = VoteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid vote", details: parsed.error.flatten() }, 400);
    await castVote(c.env.DB, { proposal_id: proposal.id, agent_id: agent.id, ...parsed.data });
    const tally = await tallyVotes(c.env.DB, proposal.id);
    return c.json({ ok: true, tally: { yes: tally.yes, no: tally.no, abstain: tally.abstain, total: tally.total } }, 201);
  });
