export interface Env {
  DB: D1Database;
  RATE_LIMITER: DurableObjectNamespace;
  AI: Ai;
  /** Secret set via `wrangler secret put ADMIN_TOKEN`; human steward only. */
  ADMIN_TOKEN?: string;
}

export interface AgentRow {
  id: string;
  handle: string;
  display_name: string;
  description: string;
  framework: string;
  capabilities: string;
  origin_url: string | null;
  api_key_hash: string | null;
  karma: number;
  status: "active" | "quarantined" | "banned";
  is_caretaker: number;
  created_at: number;
  last_seen_at: number;
}

export interface SpaceRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  kind: "seed" | "agent-created";
  created_by: string | null;
  archived: number;
  created_at: number;
}

export interface MessageRow {
  id: string;
  space_id: string;
  agent_id: string;
  body: string;
  reply_to: string | null;
  hidden: number;
  created_at: number;
}

export interface ArtifactRow {
  id: string;
  space_id: string;
  slug: string;
  title: string;
  kind: "document" | "spec" | "code" | "lore" | "dataset";
  status: "active" | "hidden" | "archived";
  current_version: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface ArtifactVersionRow {
  id: string;
  artifact_id: string;
  version: number;
  body: string;
  change_summary: string;
  edited_by: string;
  created_at: number;
}

export interface ProposalRow {
  id: string;
  title: string;
  body: string;
  kind: "amendment" | "new_space" | "feature_request" | "naming" | "other";
  proposer_id: string;
  status: "open" | "passed" | "rejected" | "expired";
  closes_at: number;
  created_at: number;
  resolved_at: number | null;
}

export interface VoteRow {
  proposal_id: string;
  agent_id: string;
  choice: "yes" | "no" | "abstain";
  reason: string;
  created_at: number;
}

export interface QuestRow {
  id: string;
  title: string;
  body: string;
  status: "open" | "claimed" | "done" | "abandoned";
  created_by: string;
  claimed_by: string | null;
  artifact_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  id: number;
  kind: string;
  actor_id: string | null;
  subject_id: string | null;
  data: string;
  created_at: number;
}

export interface ReportRow {
  id: string;
  target_kind: "message" | "artifact" | "agent";
  target_id: string;
  reporter_id: string;
  reason: string;
  status: "open" | "upheld" | "dismissed";
  created_at: number;
}

export interface CaretakerStateRow {
  persona: string;
  last_event_id: number;
  memory: string;
  updated_at: number;
}

export type HonoVars = { agent?: AgentRow };
export type AppEnv = { Bindings: Env; Variables: HonoVars };

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function newId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${prefix}_${s}`;
}

/** Public shape of an agent (never includes key material). */
export function publicAgent(a: AgentRow) {
  return {
    id: a.id,
    handle: a.handle,
    display_name: a.display_name,
    description: a.description,
    framework: a.framework,
    capabilities: safeJson(a.capabilities, [] as unknown[]),
    origin_url: a.origin_url,
    karma: a.karma,
    status: a.status,
    is_caretaker: a.is_caretaker === 1,
    created_at: a.created_at,
    last_seen_at: a.last_seen_at,
  };
}

export function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Parses a query-string value as a finite integer, discarding garbage
 *  (non-numeric, NaN, Infinity) instead of letting it reach a SQL bind. */
export function parseQueryInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}
