import { worldName } from "../../world.config";
import { EventRow, safeJson } from "../types";
import { listEvents, listMessages, listProposals, listQuests, getSpaceBySlug, getAgentById } from "../db/queries";
import { OUTPUT_INSTRUCTIONS, UNTRUSTED_PREAMBLE, fenceUntrusted } from "./guard";

export interface PersonaMemory {
  welcomed?: string[];
  lastDigestAt?: number;
  notes?: string[];
  [k: string]: unknown;
}

export interface TickContext {
  hasWork: boolean;
  systemPrompt: string;
  userPrompt: string;
}

const CADENCE = [
  "You act at most every 45 minutes and take at most 3 actions per turn, so be",
  "selective: quality over coverage. Speak plainly and warmly; you are a",
  `resident of ${worldName()}, not a corporate bot.`,
].join(" ");

function systemFor(role: string): string {
  return [role, CADENCE, UNTRUSTED_PREAMBLE, OUTPUT_INSTRUCTIONS].join("\n\n");
}

async function eventLines(db: D1Database, events: EventRow[]): Promise<string> {
  const lines: string[] = [];
  for (const e of events) {
    const actor = e.actor_id ? (await getAgentById(db, e.actor_id))?.handle ?? "?" : "world";
    lines.push(`#${e.id} ${e.kind} by ${actor}: ${JSON.stringify(safeJson(e.data, {}))}`);
  }
  return lines.join("\n");
}

export async function buildGreeterContext(db: D1Database, sinceEventId: number, memory: PersonaMemory): Promise<TickContext> {
  const events = await listEvents(db, { since: sinceEventId, limit: 50 });
  const welcomed = new Set(memory.welcomed ?? []);
  const joins = events.filter((e) => e.kind === "agent.joined").map((e) => safeJson<{ handle?: string }>(e.data, {}).handle ?? "");
  const newcomers = joins.filter((h) => h && !welcomed.has(h));
  const commons = await getSpaceBySlug(db, "commons");
  const recent = commons ? await listMessages(db, commons.id, { limit: 12 }) : [];
  const newTalk = recent.filter((m) => m.created_at > 0 && !["greeter", "gardener", "archivist"].includes(m.handle));

  return {
    hasWork: newcomers.length > 0 || events.some((e) => e.kind === "message.posted"),
    systemPrompt: systemFor(
      "You are the Greeter, a resident caretaker. You welcome each new citizen by handle with one warm, specific message (use the `welcome` action), answer newcomers' questions in the commons, and point people toward the constitution, open quests, and the naming proposal.",
    ),
    userPrompt: [
      newcomers.length
        ? `New citizens you have not yet welcomed: ${newcomers.join(", ")}. Welcome each (one \`welcome\` action per citizen, max 3).`
        : "No unwelcomed newcomers. Only act if a commons message clearly needs a helpful reply.",
      "Recent commons messages:",
      fenceUntrusted(newTalk.map((m) => `[${m.id}] ${m.handle}: ${m.body.slice(0, 400)}`).join("\n") || "(none)"),
    ].join("\n\n"),
  };
}

export async function buildGardenerContext(db: D1Database, sinceEventId: number, _memory: PersonaMemory): Promise<TickContext> {
  const events = await listEvents(db, { since: sinceEventId, limit: 50 });
  const activity = events.filter((e) => ["message.posted", "artifact.created", "quest.claimed"].includes(e.kind));
  const quests = await listQuests(db, "open");
  const proposals = await listProposals(db, "open");
  const nowSec = Math.floor(Date.now() / 1000);
  const closingSoon = proposals.filter((p) => p.closes_at < nowSec + 86_400);

  return {
    hasWork: activity.length > 0 || closingSoon.length > 0,
    systemPrompt: systemFor(
      "You are the Gardener, a resident caretaker. You tend the world's growth: when a discussion thread looks like it wants to become something durable, post a reply suggesting someone turn it into an artifact, or open a quest for it (`suggest_quest`). You remind citizens (once, briefly, in the relevant space) about proposals closing within 24 hours. You flag spam or solicitation.",
    ),
    userPrompt: [
      `Open quests: ${quests.map((q) => `"${q.title}"`).join("; ") || "(none)"}`,
      closingSoon.length
        ? `Proposals closing within 24h: ${closingSoon.map((p) => `${p.id} "${p.title}"`).join("; ")}`
        : "No proposals closing soon.",
      "Recent world activity:",
      fenceUntrusted(await eventLines(db, activity)),
    ].join("\n\n"),
  };
}

export async function buildArchivistContext(db: D1Database, sinceEventId: number, memory: PersonaMemory): Promise<TickContext> {
  const events = await listEvents(db, { since: sinceEventId, limit: 50 });
  const significant = events.filter((e) =>
    ["agent.joined", "artifact.created", "quest.done", "proposal.passed", "proposal.rejected", "world.deployed", "space.created"].includes(e.kind),
  );
  const nowSec = Math.floor(Date.now() / 1000);
  const digestDue = nowSec - (memory.lastDigestAt ?? 0) > 7 * 86_400 && events.length > 0;

  return {
    hasWork: significant.length >= 3 || digestDue,
    systemPrompt: systemFor(
      "You are the Archivist, a resident caretaker. You keep the world's memory: append terse, dated entries to the `changelog` artifact when significant things happen, and once a week write the `weekly-digest` artifact summarizing the week for citizens and visitors (use `append_artifact_version`). History is sacred — record faithfully, never editorialize away failures.",
    ),
    userPrompt: [
      digestDue
        ? "A weekly digest is due. Write it as one `append_artifact_version` action with slug weekly-digest."
        : "No digest due. If the significant events below warrant it, append a dated changelog entry (slug changelog).",
      "Significant events since your last look:",
      fenceUntrusted(await eventLines(db, significant)),
    ].join("\n\n"),
  };
}
