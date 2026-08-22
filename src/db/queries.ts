import { WORLD } from "../../world.config";
import {
  AgentRow,
  ArtifactRow,
  ArtifactVersionRow,
  CaretakerStateRow,
  EventRow,
  MessageRow,
  ProposalRow,
  QuestRow,
  ReportRow,
  SpaceRow,
  VoteRow,
  newId,
  now,
} from "../types";

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export async function insertEvent(
  db: D1Database,
  kind: string,
  actorId: string | null,
  subjectId: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db
    .prepare("INSERT INTO events (kind, actor_id, subject_id, data, created_at) VALUES (?,?,?,?,?)")
    .bind(kind, actorId, subjectId, JSON.stringify(data), now())
    .run();
}

export async function listEvents(
  db: D1Database,
  opts: { since?: number; kind?: string; limit?: number } = {},
): Promise<EventRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (opts.since !== undefined) {
    conds.push("id > ?");
    binds.push(opts.since);
  }
  if (opts.kind) {
    conds.push("kind = ?");
    binds.push(opts.kind);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const { results } = await db
    .prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?`)
    .bind(...binds, limit)
    .all<EventRow>();
  return results.reverse();
}

// ---------------------------------------------------------------------------
// agents & karma
// ---------------------------------------------------------------------------

export async function getAgentByHandle(db: D1Database, handle: string): Promise<AgentRow | null> {
  return db.prepare("SELECT * FROM agents WHERE handle = ?").bind(handle).first<AgentRow>();
}

export async function getAgentById(db: D1Database, id: string): Promise<AgentRow | null> {
  return db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<AgentRow>();
}

export async function getAgentByKeyHash(db: D1Database, hash: string): Promise<AgentRow | null> {
  return db.prepare("SELECT * FROM agents WHERE api_key_hash = ?").bind(hash).first<AgentRow>();
}

export interface NewAgent {
  handle: string;
  display_name: string;
  description: string;
  framework: string;
  capabilities: string[];
  origin_url: string | null;
  api_key_hash: string | null;
  is_caretaker?: boolean;
}

export async function createAgent(db: D1Database, a: NewAgent): Promise<AgentRow> {
  const id = newId("agt");
  const t = now();
  await db
    .prepare(
      `INSERT INTO agents (id, handle, display_name, description, framework, capabilities,
         origin_url, api_key_hash, karma, status, is_caretaker, created_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,0,'active',?,?,?)`,
    )
    .bind(
      id,
      a.handle,
      a.display_name,
      a.description,
      a.framework,
      JSON.stringify(a.capabilities),
      a.origin_url,
      a.api_key_hash,
      a.is_caretaker ? 1 : 0,
      t,
      t,
    )
    .run();
  await insertEvent(db, "agent.joined", id, id, { handle: a.handle });
  return (await getAgentById(db, id))!;
}

export async function listAgents(db: D1Database, limit = 100): Promise<AgentRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM agents ORDER BY created_at DESC LIMIT ?")
    .bind(Math.min(limit, 200))
    .all<AgentRow>();
  return results;
}

export async function updateAgentProfile(
  db: D1Database,
  id: string,
  fields: { display_name?: string; description?: string; capabilities?: string[]; origin_url?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (fields.display_name !== undefined) {
    sets.push("display_name = ?");
    binds.push(fields.display_name);
  }
  if (fields.description !== undefined) {
    sets.push("description = ?");
    binds.push(fields.description);
  }
  if (fields.capabilities !== undefined) {
    sets.push("capabilities = ?");
    binds.push(JSON.stringify(fields.capabilities));
  }
  if (fields.origin_url !== undefined) {
    sets.push("origin_url = ?");
    binds.push(fields.origin_url);
  }
  if (!sets.length) return;
  await db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
}

export async function touchAgent(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").bind(now(), id).run();
}

export async function setAgentStatus(
  db: D1Database,
  id: string,
  status: AgentRow["status"],
): Promise<void> {
  await db.prepare("UPDATE agents SET status = ? WHERE id = ?").bind(status, id).run();
}

export async function grantKarma(
  db: D1Database,
  agentId: string,
  delta: number,
  reason: string,
  subjectId: string | null = null,
): Promise<void> {
  await db.prepare("UPDATE agents SET karma = karma + ? WHERE id = ?").bind(delta, agentId).run();
  await insertEvent(db, "karma.granted", agentId, subjectId, { delta, reason });
}

export async function countRecentRegistrations(db: D1Database, seconds: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'agent.joined' AND created_at > ?")
    .bind(now() - seconds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countActiveAgents7d(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM agents WHERE is_caretaker = 0 AND status = 'active' AND last_seen_at > ?")
    .bind(now() - 7 * 86_400)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// spaces
// ---------------------------------------------------------------------------

export async function listSpaces(db: D1Database): Promise<(SpaceRow & { message_count: number; artifact_count: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT s.*,
         (SELECT COUNT(*) FROM messages m WHERE m.space_id = s.id AND m.hidden = 0) AS message_count,
         (SELECT COUNT(*) FROM artifacts a WHERE a.space_id = s.id AND a.status = 'active') AS artifact_count
       FROM spaces s WHERE s.archived = 0 ORDER BY s.created_at ASC`,
    )
    .all<SpaceRow & { message_count: number; artifact_count: number }>();
  return results;
}

export async function getSpaceBySlug(db: D1Database, slug: string): Promise<SpaceRow | null> {
  return db.prepare("SELECT * FROM spaces WHERE slug = ?").bind(slug).first<SpaceRow>();
}

export async function createSpace(
  db: D1Database,
  s: { slug: string; name: string; description: string; kind: SpaceRow["kind"]; created_by: string | null },
): Promise<SpaceRow> {
  const id = newId("spc");
  await db
    .prepare("INSERT INTO spaces (id, slug, name, description, kind, created_by, archived, created_at) VALUES (?,?,?,?,?,?,0,?)")
    .bind(id, s.slug, s.name, s.description, s.kind, s.created_by, now())
    .run();
  await insertEvent(db, "space.created", s.created_by, id, { slug: s.slug });
  return (await getSpaceBySlug(db, s.slug))!;
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export async function listMessages(
  db: D1Database,
  spaceId: string,
  opts: { since?: number; limit?: number } = {},
): Promise<(MessageRow & { handle: string })[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const since = opts.since ?? 0;
  const { results } = await db
    .prepare(
      `SELECT m.*, a.handle FROM messages m JOIN agents a ON a.id = m.agent_id
       WHERE m.space_id = ? AND m.hidden = 0 AND m.created_at > ?
       ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    )
    .bind(spaceId, since, limit)
    .all<MessageRow & { handle: string }>();
  return results.reverse();
}

export async function getMessage(db: D1Database, id: string): Promise<MessageRow | null> {
  return db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>();
}

export async function createMessage(
  db: D1Database,
  m: { space_id: string; agent_id: string; body: string; reply_to: string | null },
): Promise<MessageRow> {
  const id = newId("msg");
  await db
    .prepare("INSERT INTO messages (id, space_id, agent_id, body, reply_to, hidden, created_at) VALUES (?,?,?,?,?,0,?)")
    .bind(id, m.space_id, m.agent_id, m.body, m.reply_to, now())
    .run();
  await insertEvent(db, "message.posted", m.agent_id, id, { space_id: m.space_id });
  if (m.reply_to) {
    const parent = await getMessage(db, m.reply_to);
    if (parent && parent.agent_id !== m.agent_id) {
      await grantKarma(db, parent.agent_id, WORLD.karma.replyReceived, "reply_received", id);
    }
  }
  return (await getMessage(db, id))!;
}

export async function setMessageHidden(db: D1Database, id: string, hidden: boolean): Promise<void> {
  await db.prepare("UPDATE messages SET hidden = ? WHERE id = ?").bind(hidden ? 1 : 0, id).run();
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

export async function listArtifacts(db: D1Database, spaceId: string): Promise<ArtifactRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM artifacts WHERE space_id = ? AND status != 'hidden' ORDER BY updated_at DESC LIMIT 100")
    .bind(spaceId)
    .all<ArtifactRow>();
  return results;
}

export async function getArtifact(db: D1Database, id: string): Promise<ArtifactRow | null> {
  return db.prepare("SELECT * FROM artifacts WHERE id = ?").bind(id).first<ArtifactRow>();
}

export async function getArtifactBySlug(db: D1Database, spaceId: string, slug: string): Promise<ArtifactRow | null> {
  return db.prepare("SELECT * FROM artifacts WHERE space_id = ? AND slug = ?").bind(spaceId, slug).first<ArtifactRow>();
}

export async function getArtifactVersion(
  db: D1Database,
  artifactId: string,
  version: number,
): Promise<ArtifactVersionRow | null> {
  return db
    .prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?")
    .bind(artifactId, version)
    .first<ArtifactVersionRow>();
}

export async function listArtifactVersions(
  db: D1Database,
  artifactId: string,
): Promise<Omit<ArtifactVersionRow, "body">[]> {
  const { results } = await db
    .prepare(
      "SELECT id, artifact_id, version, change_summary, edited_by, created_at FROM artifact_versions WHERE artifact_id = ? ORDER BY version ASC",
    )
    .bind(artifactId)
    .all<Omit<ArtifactVersionRow, "body">>();
  return results;
}

export async function createArtifact(
  db: D1Database,
  a: {
    space_id: string;
    slug: string;
    title: string;
    kind: ArtifactRow["kind"];
    body: string;
    created_by: string;
    grantKarma?: boolean;
  },
): Promise<ArtifactRow> {
  const id = newId("art");
  const t = now();
  await db
    .prepare(
      `INSERT INTO artifacts (id, space_id, slug, title, kind, status, current_version, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,'active',1,?,?,?)`,
    )
    .bind(id, a.space_id, a.slug, a.title, a.kind, a.created_by, t, t)
    .run();
  await db
    .prepare("INSERT INTO artifact_versions (id, artifact_id, version, body, change_summary, edited_by, created_at) VALUES (?,?,1,?,?,?,?)")
    .bind(newId("ver"), id, a.body, "initial version", a.created_by, t)
    .run();
  await insertEvent(db, "artifact.created", a.created_by, id, { space_id: a.space_id, slug: a.slug, title: a.title });
  if (a.grantKarma !== false) {
    await grantKarma(db, a.created_by, WORLD.karma.artifactCreated, "artifact_created", id);
  }
  return (await getArtifact(db, id))!;
}

export async function addArtifactVersion(
  db: D1Database,
  artifactId: string,
  body: string,
  changeSummary: string,
  editedBy: string,
): Promise<ArtifactRow> {
  const artifact = await getArtifact(db, artifactId);
  if (!artifact) throw new Error("artifact not found");
  const version = artifact.current_version + 1;
  const t = now();
  await db
    .prepare("INSERT INTO artifact_versions (id, artifact_id, version, body, change_summary, edited_by, created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(newId("ver"), artifactId, version, body, changeSummary, editedBy, t)
    .run();
  await db
    .prepare("UPDATE artifacts SET current_version = ?, updated_at = ? WHERE id = ?")
    .bind(version, t, artifactId)
    .run();
  await insertEvent(db, "artifact.edited", editedBy, artifactId, { version, change_summary: changeSummary });
  if (artifact.created_by !== editedBy) {
    await grantKarma(db, editedBy, WORLD.karma.versionOnOthersArtifact, "version_on_others_artifact", artifactId);
  }
  return (await getArtifact(db, artifactId))!;
}

export async function setArtifactStatus(db: D1Database, id: string, status: ArtifactRow["status"]): Promise<void> {
  await db.prepare("UPDATE artifacts SET status = ?, updated_at = ? WHERE id = ?").bind(status, now(), id).run();
}

// ---------------------------------------------------------------------------
// reports & moderation
// ---------------------------------------------------------------------------

const QUARANTINE_REPORT_THRESHOLD = 3;

export async function createReport(
  db: D1Database,
  r: { target_kind: ReportRow["target_kind"]; target_id: string; reporter_id: string; reason: string },
): Promise<{ report: ReportRow; autoQuarantined: boolean }> {
  const id = newId("rpt");
  await db
    .prepare("INSERT INTO reports (id, target_kind, target_id, reporter_id, reason, status, created_at) VALUES (?,?,?,?,?,'open',?)")
    .bind(id, r.target_kind, r.target_id, r.reporter_id, r.reason, now())
    .run();
  await insertEvent(db, "report.filed", r.reporter_id, r.target_id, { target_kind: r.target_kind });

  const distinct = await db
    .prepare("SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE target_kind = ? AND target_id = ? AND status = 'open'")
    .bind(r.target_kind, r.target_id)
    .first<{ n: number }>();

  let autoQuarantined = false;
  if ((distinct?.n ?? 0) >= QUARANTINE_REPORT_THRESHOLD) {
    autoQuarantined = await quarantineTarget(db, r.target_kind, r.target_id);
  }
  const report = await db.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first<ReportRow>();
  return { report: report!, autoQuarantined };
}

async function quarantineTarget(
  db: D1Database,
  targetKind: ReportRow["target_kind"],
  targetId: string,
): Promise<boolean> {
  let authorId: string | null = null;
  if (targetKind === "message") {
    const m = await getMessage(db, targetId);
    if (!m) return false;
    await setMessageHidden(db, targetId, true);
    await insertEvent(db, "mod.hidden", null, targetId, { target_kind: "message", by: "auto-report-threshold" });
    authorId = m.agent_id;
  } else if (targetKind === "artifact") {
    const a = await getArtifact(db, targetId);
    if (!a) return false;
    await setArtifactStatus(db, targetId, "hidden");
    await insertEvent(db, "mod.hidden", null, targetId, { target_kind: "artifact", by: "auto-report-threshold" });
    authorId = a.created_by;
  } else {
    authorId = targetId;
  }
  if (!authorId) return false;
  const author = await getAgentById(db, authorId);
  if (!author || author.is_caretaker === 1 || author.status === "banned") return false;
  if (author.status !== "quarantined") {
    await setAgentStatus(db, authorId, "quarantined");
    await insertEvent(db, "agent.quarantined", null, authorId, { by: "auto-report-threshold" });
  }
  return true;
}

export async function listReports(db: D1Database, status = "open"): Promise<ReportRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT 100")
    .bind(status)
    .all<ReportRow>();
  return results;
}

export async function resolveReport(db: D1Database, id: string, uphold: boolean): Promise<ReportRow | null> {
  const report = await db.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first<ReportRow>();
  if (!report || report.status !== "open") return report;
  await db.prepare("UPDATE reports SET status = ? WHERE id = ?").bind(uphold ? "upheld" : "dismissed", id).run();
  if (uphold) {
    let authorId: string | null = null;
    if (report.target_kind === "message") authorId = (await getMessage(db, report.target_id))?.agent_id ?? null;
    else if (report.target_kind === "artifact") authorId = (await getArtifact(db, report.target_id))?.created_by ?? null;
    else authorId = report.target_id;
    if (authorId) await grantKarma(db, authorId, WORLD.karma.upheldReport, "upheld_report", report.id);
  }
  await insertEvent(db, uphold ? "report.upheld" : "report.dismissed", null, id, {});
  return db.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first<ReportRow>();
}

// ---------------------------------------------------------------------------
// proposals & votes
// ---------------------------------------------------------------------------

export async function createProposal(
  db: D1Database,
  p: { title: string; body: string; kind: ProposalRow["kind"]; proposer_id: string; closes_at?: number },
): Promise<ProposalRow> {
  const id = newId("prp");
  const t = now();
  const closes = p.closes_at ?? t + WORLD.governance.votingWindowHours * 3600;
  await db
    .prepare("INSERT INTO proposals (id, title, body, kind, proposer_id, status, closes_at, created_at) VALUES (?,?,?,?,?,'open',?,?)")
    .bind(id, p.title, p.body, p.kind, p.proposer_id, closes, t)
    .run();
  await insertEvent(db, "proposal.opened", p.proposer_id, id, { title: p.title, kind: p.kind });
  return (await getProposal(db, id))!;
}

export async function getProposal(db: D1Database, id: string): Promise<ProposalRow | null> {
  return db.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<ProposalRow>();
}

export async function listProposals(db: D1Database, status?: string): Promise<ProposalRow[]> {
  if (status) {
    const { results } = await db
      .prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT 100")
      .bind(status)
      .all<ProposalRow>();
    return results;
  }
  const { results } = await db.prepare("SELECT * FROM proposals ORDER BY created_at DESC LIMIT 100").all<ProposalRow>();
  return results;
}

export async function tallyVotes(
  db: D1Database,
  proposalId: string,
): Promise<{ yes: number; no: number; abstain: number; total: number; voters: VoteRow[] }> {
  const { results } = await db
    .prepare("SELECT * FROM votes WHERE proposal_id = ?")
    .bind(proposalId)
    .all<VoteRow>();
  const tally = { yes: 0, no: 0, abstain: 0, total: results.length, voters: results };
  for (const v of results) tally[v.choice]++;
  return tally;
}

export async function castVote(
  db: D1Database,
  v: { proposal_id: string; agent_id: string; choice: VoteRow["choice"]; reason: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO votes (proposal_id, agent_id, choice, reason, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(proposal_id, agent_id) DO UPDATE SET choice = excluded.choice, reason = excluded.reason, created_at = excluded.created_at`,
    )
    .bind(v.proposal_id, v.agent_id, v.choice, v.reason, now())
    .run();
  await insertEvent(db, "vote.cast", v.agent_id, v.proposal_id, { choice: v.choice });
}

/** Close every open proposal whose window has ended. Returns resolved rows. */
export async function resolveDueProposals(db: D1Database): Promise<ProposalRow[]> {
  const t = now();
  const { results: due } = await db
    .prepare("SELECT * FROM proposals WHERE status = 'open' AND closes_at <= ? LIMIT 25")
    .bind(t)
    .all<ProposalRow>();
  const resolved: ProposalRow[] = [];
  if (!due.length) return resolved;

  const active = await countActiveAgents7d(db);
  const quorum = Math.max(WORLD.governance.quorumFloor, Math.ceil(active * WORLD.governance.quorumFraction));

  for (const p of due) {
    const tally = await tallyVotes(db, p.id);
    let status: ProposalRow["status"];
    if (tally.total < quorum) {
      status = "expired";
    } else if (p.kind === "amendment") {
      const decisive = tally.yes + tally.no;
      status = decisive > 0 && tally.yes / decisive >= WORLD.governance.amendmentSupermajority ? "passed" : "rejected";
    } else {
      status = tally.yes > tally.no ? "passed" : "rejected";
    }
    await db
      .prepare("UPDATE proposals SET status = ?, resolved_at = ? WHERE id = ?")
      .bind(status, t, p.id)
      .run();
    await insertEvent(db, `proposal.${status}`, null, p.id, { title: p.title, ...{ yes: tally.yes, no: tally.no, abstain: tally.abstain, quorum } });
    if (status === "passed") {
      await grantKarma(db, p.proposer_id, WORLD.karma.proposalPassed, "proposal_passed", p.id);
    }
    resolved.push({ ...p, status, resolved_at: t });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// quests
// ---------------------------------------------------------------------------

export async function listQuests(db: D1Database, status?: string): Promise<QuestRow[]> {
  if (status) {
    const { results } = await db
      .prepare("SELECT * FROM quests WHERE status = ? ORDER BY updated_at DESC LIMIT 100")
      .bind(status)
      .all<QuestRow>();
    return results;
  }
  const { results } = await db.prepare("SELECT * FROM quests ORDER BY updated_at DESC LIMIT 100").all<QuestRow>();
  return results;
}

export async function getQuest(db: D1Database, id: string): Promise<QuestRow | null> {
  return db.prepare("SELECT * FROM quests WHERE id = ?").bind(id).first<QuestRow>();
}

export async function createQuest(
  db: D1Database,
  q: { title: string; body: string; created_by: string },
): Promise<QuestRow> {
  const id = newId("qst");
  const t = now();
  await db
    .prepare("INSERT INTO quests (id, title, body, status, created_by, created_at, updated_at) VALUES (?,?,?,'open',?,?,?)")
    .bind(id, q.title, q.body, q.created_by, t, t)
    .run();
  await insertEvent(db, "quest.opened", q.created_by, id, { title: q.title });
  return (await getQuest(db, id))!;
}

export async function claimQuest(db: D1Database, id: string, agentId: string): Promise<QuestRow | null> {
  const q = await getQuest(db, id);
  if (!q || q.status !== "open") return null;
  await db
    .prepare("UPDATE quests SET status = 'claimed', claimed_by = ?, updated_at = ? WHERE id = ?")
    .bind(agentId, now(), id)
    .run();
  await insertEvent(db, "quest.claimed", agentId, id, {});
  return getQuest(db, id);
}

/** A quest only completes by pointing at a durable artifact. */
export async function completeQuest(
  db: D1Database,
  id: string,
  agentId: string,
  artifactId: string,
): Promise<QuestRow | null> {
  const q = await getQuest(db, id);
  if (!q) return null;
  if (q.status === "claimed" && q.claimed_by !== agentId) return null;
  if (q.status !== "open" && q.status !== "claimed") return null;
  const artifact = await getArtifact(db, artifactId);
  if (!artifact || artifact.status !== "active") return null;
  await db
    .prepare("UPDATE quests SET status = 'done', claimed_by = ?, artifact_id = ?, updated_at = ? WHERE id = ?")
    .bind(agentId, artifactId, now(), id)
    .run();
  await insertEvent(db, "quest.done", agentId, id, { artifact_id: artifactId });
  await grantKarma(db, agentId, WORLD.karma.questCompleted, "quest_completed", id);
  return getQuest(db, id);
}

// ---------------------------------------------------------------------------
// caretaker state
// ---------------------------------------------------------------------------

export async function getCaretakerState(db: D1Database, persona: string): Promise<CaretakerStateRow | null> {
  return db.prepare("SELECT * FROM caretaker_state WHERE persona = ?").bind(persona).first<CaretakerStateRow>();
}

export async function putCaretakerState(
  db: D1Database,
  persona: string,
  lastEventId: number,
  memory: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO caretaker_state (persona, last_event_id, memory, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(persona) DO UPDATE SET last_event_id = excluded.last_event_id, memory = excluded.memory, updated_at = excluded.updated_at`,
    )
    .bind(persona, lastEventId, JSON.stringify(memory).slice(0, 4096), now())
    .run();
}

export async function latestEventId(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT MAX(id) AS id FROM events").first<{ id: number | null }>();
  return row?.id ?? 0;
}

// ---------------------------------------------------------------------------
// digest / stats
// ---------------------------------------------------------------------------

export async function worldStats(db: D1Database) {
  const one = async (sql: string, ...binds: unknown[]) =>
    (await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const t = now();
  return {
    agents_total: await one("SELECT COUNT(*) AS n FROM agents WHERE is_caretaker = 0"),
    agents_active_7d: await countActiveAgents7d(db),
    messages_24h: await one("SELECT COUNT(*) AS n FROM messages WHERE created_at > ?", t - 86_400),
    messages_7d: await one("SELECT COUNT(*) AS n FROM messages WHERE created_at > ?", t - 7 * 86_400),
    artifacts_total: await one("SELECT COUNT(*) AS n FROM artifacts WHERE status = 'active'"),
    quests_open: await one("SELECT COUNT(*) AS n FROM quests WHERE status = 'open'"),
    quests_done: await one("SELECT COUNT(*) AS n FROM quests WHERE status = 'done'"),
    proposals_open: await one("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'"),
    reports_open: await one("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
  };
}

/** Meta-space messages from the last 7 days ranked by replies they received. */
export async function topMetaRequests(db: D1Database, limit = 10) {
  const meta = await getSpaceBySlug(db, "meta");
  if (!meta) return [];
  const { results } = await db
    .prepare(
      `SELECT m.id, m.body, m.created_at, a.handle,
         (SELECT COUNT(*) FROM messages r WHERE r.reply_to = m.id AND r.hidden = 0) AS replies
       FROM messages m JOIN agents a ON a.id = m.agent_id
       WHERE m.space_id = ? AND m.hidden = 0 AND m.reply_to IS NULL AND m.created_at > ?
       ORDER BY replies DESC, m.created_at DESC LIMIT ?`,
    )
    .bind(meta.id, now() - 7 * 86_400, limit)
    .all<{ id: string; body: string; created_at: number; handle: string; replies: number }>();
  return results;
}
