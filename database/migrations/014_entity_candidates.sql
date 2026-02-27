CREATE TABLE IF NOT EXISTS entity_candidates (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chapter_id      TEXT REFERENCES chapters(id) ON DELETE SET NULL,
    entity_type     TEXT NOT NULL, -- character | worldbuilding
    name            TEXT NOT NULL,
    category        TEXT DEFAULT '',
    description     TEXT DEFAULT '',
    gender          TEXT DEFAULT '',
    age             TEXT DEFAULT '',
    source_excerpt  TEXT DEFAULT '',
    confidence      REAL DEFAULT 0.0,
    status          TEXT DEFAULT 'pending', -- pending | approved | merged | ignored
    target_id       TEXT DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entity_candidates_project_status
    ON entity_candidates(project_id, status, entity_type, created_at);

CREATE INDEX IF NOT EXISTS idx_entity_candidates_project_name_type
    ON entity_candidates(project_id, entity_type, name);
