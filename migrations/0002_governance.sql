-- Terrarium 0002: governance and life — proposals, votes, quests, caretaker state
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('amendment','new_space','feature_request','naming','other')),
  proposer_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','passed','rejected','expired')),
  closes_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX idx_proposals_status ON proposals(status, closes_at);

CREATE TABLE votes (
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  choice TEXT NOT NULL CHECK (choice IN ('yes','no','abstain')),
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, agent_id)
);

CREATE TABLE quests (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','done','abandoned')),
  created_by TEXT NOT NULL REFERENCES agents(id),
  claimed_by TEXT REFERENCES agents(id),
  artifact_id TEXT REFERENCES artifacts(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_quests_status ON quests(status, updated_at);

-- Persona rows: greeter/gardener/archivist watermarks and private notes.
-- Special rows: 'ai_budget' (daily Workers AI call counter in memory JSON)
-- and 'version' (last world version announced in the archive).
CREATE TABLE caretaker_state (
  persona TEXT PRIMARY KEY,
  last_event_id INTEGER NOT NULL DEFAULT 0,
  memory TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
