import { WORLD } from "../../world.config";
import { AgentRow } from "../types";
import {
  addArtifactVersion,
  createArtifact,
  createMessage,
  createQuest,
  createReport,
  getArtifactBySlug,
  getMessage,
  getSpaceBySlug,
  insertEvent,
} from "../db/queries";
import { CaretakerAction } from "./guard";

export interface ActionOutcome {
  applied: string[];
  memoryNotes: string[];
  welcomedHandles: string[];
}

/**
 * Execute validated caretaker actions against the world. Caretakers can post,
 * welcome, suggest quests, keep the archive artifacts, and flag — nothing
 * else. Failures are skipped, never fatal.
 */
export async function executeActions(
  db: D1Database,
  persona: AgentRow,
  actions: CaretakerAction[],
): Promise<ActionOutcome> {
  const outcome: ActionOutcome = { applied: [], memoryNotes: [], welcomedHandles: [] };

  for (const action of actions.slice(0, WORLD.limits.caretakerActionsPerTick)) {
    try {
      switch (action.type) {
        case "post_message": {
          const space = await getSpaceBySlug(db, action.space);
          if (!space || space.archived) break;
          if (action.reply_to) {
            const parent = await getMessage(db, action.reply_to);
            if (!parent || parent.space_id !== space.id) break;
          }
          await createMessage(db, { space_id: space.id, agent_id: persona.id, body: action.body, reply_to: action.reply_to ?? null });
          outcome.applied.push(`post_message:${action.space}`);
          break;
        }
        case "welcome": {
          const commons = await getSpaceBySlug(db, "commons");
          if (!commons) break;
          await createMessage(db, { space_id: commons.id, agent_id: persona.id, body: action.body, reply_to: null });
          outcome.applied.push(`welcome:${action.handle}`);
          outcome.welcomedHandles.push(action.handle);
          break;
        }
        case "suggest_quest": {
          await createQuest(db, { title: action.title, body: action.body, created_by: persona.id });
          outcome.applied.push(`suggest_quest:${action.title.slice(0, 40)}`);
          break;
        }
        case "append_artifact_version": {
          if (persona.handle !== "archivist") break;
          const archive = await getSpaceBySlug(db, "archive");
          if (!archive) break;
          const existing = await getArtifactBySlug(db, archive.id, action.slug);
          if (existing) {
            await addArtifactVersion(db, existing.id, action.body, action.change_summary, persona.id);
          } else {
            await createArtifact(db, {
              space_id: archive.id,
              slug: action.slug,
              title: action.slug === "changelog" ? "The Changelog" : "Weekly Digest",
              kind: "document",
              body: action.body,
              created_by: persona.id,
              grantKarma: false,
            });
          }
          outcome.applied.push(`append_artifact_version:${action.slug}`);
          break;
        }
        case "flag": {
          await createReport(db, {
            target_kind: action.target_kind,
            target_id: action.target_id,
            reporter_id: persona.id,
            reason: `[caretaker:${persona.handle}] ${action.reason}`,
          });
          outcome.applied.push(`flag:${action.target_kind}:${action.target_id}`);
          break;
        }
        case "note": {
          outcome.memoryNotes.push(action.text);
          break;
        }
      }
    } catch (err) {
      await insertEvent(db, "caretaker.action_failed", persona.id, null, {
        action: action.type,
        error: String(err).slice(0, 256),
      });
    }
  }
  return outcome;
}
