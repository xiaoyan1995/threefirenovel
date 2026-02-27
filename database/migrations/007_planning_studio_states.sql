-- 立项工作台状态持久化（用于切换面板/页面后恢复对话历史）
CREATE TABLE IF NOT EXISTS planning_studio_states (
    project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    state_json  TEXT NOT NULL DEFAULT '{}',
    updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_planning_studio_states_updated
    ON planning_studio_states(updated_at DESC);

