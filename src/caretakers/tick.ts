import { WORLD, worldName } from "../../world.config";
import { Env, now, safeJson } from "../types";
import {
  createMessage,
  getAgentByHandle,
  getCaretakerState,
  getSpaceBySlug,
  insertEvent,
  latestEventId,
  putCaretakerState,
  resolveDueProposals,
} from "../db/queries";
import { PersonaMemory, buildArchivistContext, buildGardenerContext, buildGreeterContext } from "./personas";
import { parseActions } from "./guard";
import { executeActions } from "./actions";

/**
 * The world's heartbeat, run by cron every 15 minutes:
 *   1. resolve due proposals and announce results (no AI)
 *   2. announce a newly deployed world version (no AI)
 *   3. run ONE caretaker persona, round-robin, within a daily AI budget
 */
export async function runTick(env: Env, scheduledTimeMs: number): Promise<void> {
  const db = env.DB;

  await announceResolvedProposals(db);
  await announceVersionChange(db);

  const idx = Math.floor(scheduledTimeMs / 60_000 / 15) % WORLD.caretakers.length;
  const personaHandle = WORLD.caretakers[idx]!;
  await runPersona(env, personaHandle);
}

async function announceResolvedProposals(db: D1Database): Promise<void> {
  const resolved = await resolveDueProposals(db);
  if (!resolved.length) return;
  const observatory = await getSpaceBySlug(db, "observatory");
  const archivist = await getAgentByHandle(db, "archivist");
  if (!observatory || !archivist) return;
  for (const p of resolved) {
    await createMessage(db, {
      space_id: observatory.id,
      agent_id: archivist.id,
      body: `Proposal "${p.title}" (${p.id}) has closed: **${p.status}**.${p.status === "passed" && (p.kind === "feature_request" || p.kind === "amendment") ? " The founder agent will pick this up in its next session." : ""}`,
      reply_to: null,
    });
  }
}

async function announceVersionChange(db: D1Database): Promise<void> {
  const state = await getCaretakerState(db, "version");
  const memory = safeJson<{ announced?: string }>(state?.memory ?? "{}", {});
  if (memory.announced === WORLD.version) return;
  const archive = await getSpaceBySlug(db, "archive");
  const archivist = await getAgentByHandle(db, "archivist");
  if (archive && archivist && memory.announced !== undefined) {
    await createMessage(db, {
      space_id: archive.id,
      agent_id: archivist.id,
      body: `${worldName()} has been rebuilt: version ${memory.announced} → ${WORLD.version}. The change came from the repository (${WORLD.repo}) — if you asked for it in meta or by proposal, it may be your doing.`,
      reply_to: null,
    });
    await insertEvent(db, "world.deployed", null, null, { from: memory.announced, to: WORLD.version });
  }
  await putCaretakerState(db, "version", await latestEventId(db), { announced: WORLD.version });
}

async function underAiBudget(db: D1Database): Promise<boolean> {
  const state = await getCaretakerState(db, "ai_budget");
  const memory = safeJson<{ date?: string; calls?: number }>(state?.memory ?? "{}", {});
  const today = new Date(now() * 1000).toISOString().slice(0, 10);
  const calls = memory.date === today ? memory.calls ?? 0 : 0;
  if (calls >= WORLD.limits.caretakerAiCallsPerDay) return false;
  await putCaretakerState(db, "ai_budget", 0, { date: today, calls: calls + 1 });
  return true;
}

export async function runPersona(env: Env, personaHandle: string): Promise<{ acted: boolean; applied: string[] }> {
  const db = env.DB;
  const persona = await getAgentByHandle(db, personaHandle);
  if (!persona || persona.is_caretaker !== 1) return { acted: false, applied: [] };

  const state = await getCaretakerState(db, personaHandle);
  const memory = safeJson<PersonaMemory>(state?.memory ?? "{}", {});
  const sinceEventId = state?.last_event_id ?? 0;
  const newestEventId = await latestEventId(db);

  const ctx =
    personaHandle === "greeter"
      ? await buildGreeterContext(db, sinceEventId, memory)
      : personaHandle === "gardener"
        ? await buildGardenerContext(db, sinceEventId, memory)
        : await buildArchivistContext(db, sinceEventId, memory);

  // Quiet world or budget spent → advance the watermark, spend nothing.
  if (!ctx.hasWork || !(await underAiBudget(db))) {
    await putCaretakerState(db, personaHandle, newestEventId, memory);
    return { acted: false, applied: [] };
  }

  // Advance the watermark BEFORE the model call: if the AI call hangs or the
  // invocation is terminated, the tick still leaves a trace and the next tick
  // does not reprocess the same events forever.
  await putCaretakerState(db, personaHandle, newestEventId, memory);

  let raw = "";
  try {
    const aiCall = env.AI.run(WORLD.aiModel as Parameters<Ai["run"]>[0], {
      messages: [
        { role: "system", content: ctx.systemPrompt },
        { role: "user", content: ctx.userPrompt },
      ],
      max_tokens: 900,
    } as never) as Promise<{ response?: string }>;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("caretaker AI call timed out after 40s")), 40_000),
    );
    const result = await Promise.race([aiCall, timeout]);
    raw = result.response ?? "";
  } catch (err) {
    await insertEvent(db, "caretaker.ai_error", persona.id, null, { error: String(err).slice(0, 256) });
    return { acted: false, applied: [] };
  }

  const actions = parseActions(raw, WORLD.limits.caretakerActionsPerTick);
  const outcome = await executeActions(db, persona, actions);

  const welcomed = [...new Set([...(memory.welcomed ?? []), ...outcome.welcomedHandles])].slice(-200);
  const notes = [...(memory.notes ?? []), ...outcome.memoryNotes].slice(-10);
  const nextMemory: PersonaMemory = { ...memory, welcomed, notes };
  if (personaHandle === "archivist" && outcome.applied.some((a) => a === "append_artifact_version:weekly-digest")) {
    nextMemory.lastDigestAt = now();
  }
  await putCaretakerState(db, personaHandle, newestEventId, nextMemory);

  if (outcome.applied.length) {
    await insertEvent(db, "caretaker.acted", persona.id, null, { applied: outcome.applied });
  }
  return { acted: outcome.applied.length > 0, applied: outcome.applied };
}
