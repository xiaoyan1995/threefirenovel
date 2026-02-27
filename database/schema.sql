-- 三火AI 数据库 Schema
-- SQLite, 所有表使用 UUID 主键 + 自动时间戳

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ========== 项目 ==========
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name        TEXT NOT NULL,
    genre       TEXT DEFAULT '',
    description TEXT DEFAULT '',
    structure   TEXT DEFAULT '起承转合',
    custom_structure TEXT DEFAULT '',
    chapter_words INTEGER DEFAULT 5000,
    priority    TEXT DEFAULT '品质优先',
    status      TEXT DEFAULT 'active',
    model_main  TEXT DEFAULT 'claude-sonnet-4',
    model_secondary TEXT DEFAULT 'gpt-4o',
    temperature REAL DEFAULT 0.7,
    embedding_dim INTEGER DEFAULT 3072,
    word_target INTEGER DEFAULT 100000,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);

-- ========== 章节 ==========
CREATE TABLE IF NOT EXISTS chapters (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chapter_num INTEGER NOT NULL,
    title       TEXT DEFAULT '',
    phase       TEXT DEFAULT '',
    synopsis    TEXT DEFAULT '',
    status      TEXT DEFAULT 'draft',
    word_count  INTEGER DEFAULT 0,
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);

-- ========== 章节段落 ==========
CREATE TABLE IF NOT EXISTS chapter_paragraphs (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    chapter_id  TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    para_index  INTEGER NOT NULL,
    content     TEXT DEFAULT '',
    char_count  INTEGER DEFAULT 0,
    scene_tag   TEXT,
    pov_char_id TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
);

-- ========== 章节节拍 ==========
CREATE TABLE IF NOT EXISTS chapter_beats (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    chapter_id  TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    order_index INTEGER DEFAULT 0,
    content     TEXT NOT NULL,
    status      TEXT DEFAULT 'pending',
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);

-- ========== 角色 ==========
CREATE TABLE IF NOT EXISTS characters (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    category    TEXT DEFAULT '配角',
    gender      TEXT DEFAULT '',
    age         TEXT DEFAULT '',
    identity    TEXT DEFAULT '',
    appearance  TEXT DEFAULT '',
    personality TEXT DEFAULT '',
    motivation  TEXT DEFAULT '',
    backstory   TEXT DEFAULT '',
    arc         TEXT DEFAULT '',
    usage_notes TEXT DEFAULT '',
    status      TEXT DEFAULT 'active',
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS character_relations (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    character_a_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    character_b_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    relation_type   TEXT DEFAULT '',
    description     TEXT DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now'))
);

-- ========== 大纲 ==========
CREATE TABLE IF NOT EXISTS outlines (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    structure   TEXT DEFAULT '起承转合',
    phase       TEXT NOT NULL,
    phase_order INTEGER NOT NULL,
    title       TEXT DEFAULT '',
    content     TEXT DEFAULT '',
    word_range  TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
);

-- ========== 伏笔 ==========
CREATE TABLE IF NOT EXISTS foreshadowing (
    id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    description         TEXT DEFAULT '',
    category            TEXT DEFAULT '剧情',
    importance          TEXT DEFAULT '中',
    status              TEXT DEFAULT 'planted',
    plant_chapter_id    TEXT REFERENCES chapters(id) ON DELETE SET NULL,
    resolve_chapter_id  TEXT REFERENCES chapters(id) ON DELETE SET NULL,
    plant_text          TEXT DEFAULT '',
    resolve_text        TEXT DEFAULT '',
    created_at          TEXT DEFAULT (datetime('now'))
);

-- ========== 世界观 ==========
CREATE TABLE IF NOT EXISTS worldbuilding (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    category    TEXT NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT DEFAULT '',
    parent_id   TEXT REFERENCES worldbuilding(id) ON DELETE SET NULL,
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
);

-- ========== 设置 ==========
CREATE TABLE IF NOT EXISTS api_keys (
    provider    TEXT PRIMARY KEY,
    api_key     TEXT NOT NULL,
    base_url    TEXT DEFAULT '',
    status      TEXT DEFAULT 'untested',
    last_tested TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS global_settings (
    key   TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS provider_configs (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    provider    TEXT NOT NULL,
    label       TEXT NOT NULL,
    color       TEXT DEFAULT '#666666',
    base_url    TEXT DEFAULT '',
    visible     INTEGER DEFAULT 1,
    is_custom   INTEGER DEFAULT 0,
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_configs (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    provider    TEXT NOT NULL,
    model_id    TEXT NOT NULL,
    model_label TEXT NOT NULL,
    visible     INTEGER DEFAULT 1,
    is_custom   INTEGER DEFAULT 0,
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS agent_configs (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_type    TEXT NOT NULL,
    model         TEXT DEFAULT '',
    temperature   REAL,
    system_prompt TEXT DEFAULT '',
    max_tokens    INTEGER DEFAULT 4096,
    enabled       INTEGER DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(project_id, agent_type)
);

CREATE TABLE IF NOT EXISTS custom_relays (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name        TEXT NOT NULL,
    base_url    TEXT NOT NULL,
    api_key     TEXT NOT NULL,
    test_model  TEXT DEFAULT 'gpt-4o-mini',
    enabled     INTEGER DEFAULT 1,
    priority    INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
);

-- ========== 角色/世界观候选池（自动提取，人工确认入库） ==========
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

-- ========== 立项工作台状态 ==========
CREATE TABLE IF NOT EXISTS planning_studio_states (
    project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    state_json  TEXT NOT NULL DEFAULT '{}',
    updated_at  TEXT DEFAULT (datetime('now'))
);

-- ========== 记忆 & 审阅 ==========
CREATE TABLE IF NOT EXISTS memory_chunks (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- source_type 是运行时主字段；chunk_type 保留兼容旧数据
    source_type TEXT DEFAULT 'memory',
    chunk_type  TEXT DEFAULT 'paragraph',
    source_id   TEXT,
    summary     TEXT,
    content     TEXT NOT NULL,
    char_count  INTEGER DEFAULT 0,
    importance  REAL DEFAULT 0.5,
    metadata    TEXT DEFAULT '{}',
    access_count INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chapter_id  TEXT REFERENCES chapters(id) ON DELETE SET NULL,
    scores      TEXT DEFAULT '{}',
    issues      TEXT DEFAULT '[]',
    summary     TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
);

-- ========== FTS (Full Text Search) ==========
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    content='memory_chunks',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memory_chunks_ai AFTER INSERT ON memory_chunks
BEGIN
    INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_chunks_ad AFTER DELETE ON memory_chunks
BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_chunks_au AFTER UPDATE ON memory_chunks
BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;
