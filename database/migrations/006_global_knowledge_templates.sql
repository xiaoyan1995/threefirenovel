-- 全局知识模板库：用于跨项目复用（手动导入到项目，不自动参与检索）

CREATE TABLE IF NOT EXISTS global_knowledge_templates (
    id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    category     TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_global_knowledge_templates_created
    ON global_knowledge_templates(created_at DESC);

CREATE TABLE IF NOT EXISTS global_knowledge_template_items (
    id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    template_id    TEXT NOT NULL REFERENCES global_knowledge_templates(id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    reference_type TEXT DEFAULT 'general',
    content        TEXT NOT NULL,
    metadata       TEXT DEFAULT '{}',
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_global_knowledge_template_items_template_created
    ON global_knowledge_template_items(template_id, created_at DESC);
