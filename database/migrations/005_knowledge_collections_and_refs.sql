-- 知识库：资料集（文件夹）与单文件参考类型扩展

CREATE TABLE IF NOT EXISTS knowledge_collections (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_collections_project_created
    ON knowledge_collections(project_id, created_at DESC);

ALTER TABLE knowledge_sources ADD COLUMN collection_id TEXT REFERENCES knowledge_collections(id) ON DELETE SET NULL;
ALTER TABLE knowledge_sources ADD COLUMN reference_type TEXT DEFAULT 'general';
ALTER TABLE knowledge_sources ADD COLUMN enabled INTEGER DEFAULT 1;

ALTER TABLE knowledge_profiles ADD COLUMN collection_id TEXT REFERENCES knowledge_collections(id) ON DELETE SET NULL;
