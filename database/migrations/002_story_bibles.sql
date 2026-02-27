-- 新增小说圣经表：用于存储项目级约束与创作规则版本
CREATE TABLE IF NOT EXISTS story_bibles (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL DEFAULT 1,
    content     TEXT NOT NULL,
    source_brief TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_story_bibles_project_version
    ON story_bibles(project_id, version);

CREATE INDEX IF NOT EXISTS idx_story_bibles_project_created
    ON story_bibles(project_id, created_at DESC);
