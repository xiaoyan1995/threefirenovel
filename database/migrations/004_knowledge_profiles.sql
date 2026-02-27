-- 知识源与规则包（Skill Profile）基础表

CREATE TABLE IF NOT EXISTS knowledge_sources (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    source_type  TEXT DEFAULT 'text',
    content      TEXT NOT NULL,
    metadata     TEXT DEFAULT '{}',
    created_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_project_created
    ON knowledge_sources(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_profiles (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    genre         TEXT DEFAULT '',
    version       INTEGER NOT NULL DEFAULT 1,
    profile_json  TEXT NOT NULL,
    text_summary  TEXT DEFAULT '',
    source_ids    TEXT DEFAULT '[]',
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_profiles_project_name_version
    ON knowledge_profiles(project_id, name, version);

CREATE INDEX IF NOT EXISTS idx_knowledge_profiles_project_created
    ON knowledge_profiles(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_profile_binding (
    project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    profile_id   TEXT REFERENCES knowledge_profiles(id) ON DELETE SET NULL,
    enabled      INTEGER DEFAULT 1,
    updated_at   TEXT DEFAULT (datetime('now'))
);
