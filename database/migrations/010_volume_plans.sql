-- 卷级规划（独立于 outlines，避免污染骨架大纲）
CREATE TABLE IF NOT EXISTS volume_plans (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    volume_index      INTEGER NOT NULL,
    title             TEXT DEFAULT '',
    start_chapter     INTEGER NOT NULL,
    end_chapter       INTEGER NOT NULL,
    goal              TEXT DEFAULT '',
    key_turning_point TEXT DEFAULT '',
    end_hook          TEXT DEFAULT '',
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_volume_plans_project_volume
    ON volume_plans(project_id, volume_index);

CREATE INDEX IF NOT EXISTS idx_volume_plans_project_range
    ON volume_plans(project_id, start_chapter, end_chapter);
