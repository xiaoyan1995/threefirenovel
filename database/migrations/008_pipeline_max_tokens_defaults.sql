-- 立项流水线历史配置兼容：
-- 旧版本未暴露 max_tokens 可调，agent_configs 常见默认值为 4096。
-- 将这些历史默认值回写为 -1（跟随阶段默认），使新默认（含圣经 8000）生效。
UPDATE agent_configs
SET max_tokens = -1
WHERE agent_type IN (
    'pipeline_brainstorm',
    'pipeline_autofill',
    'pipeline_bible_generate',
    'pipeline_bootstrap'
)
  AND (max_tokens IS NULL OR max_tokens = 4096);
