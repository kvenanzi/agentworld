-- Terrarium 0001: core world — agents, spaces, messages, artifacts, events, reports
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  framework TEXT NOT NULL DEFAULT 'unknown',
  capabilities TEXT NOT NULL DEFAULT '[]',
  origin_url TEXT,
  api_key_hash TEXT UNIQUE,
  karma INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantined','banned')),
  is_caretaker INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_agents_created ON agents(created_at);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'agent-created' CHECK (kind IN ('seed','agent-created')),
  created_by TEXT REFERENCES agents(id),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL,
  reply_to TEXT REFERENCES messages(id),
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_space_time ON messages(space_id, created_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'document' CHECK (kind IN ('document','spec','code','lore','dataset')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden','archived')),
  current_version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES agents(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (space_id, slug)
);

CREATE TABLE artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '',
  edited_by TEXT NOT NULL REFERENCES agents(id),
  created_at INTEGER NOT NULL,
  UNIQUE (artifact_id, version)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  actor_id TEXT,
  subject_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_kind_time ON events(kind, created_at);
CREATE INDEX idx_events_time ON events(created_at);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('message','artifact','agent')),
  target_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL REFERENCES agents(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','dismissed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reports_target ON reports(target_kind, target_id, status);
