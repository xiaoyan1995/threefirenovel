ALTER TABLE custom_relays ADD COLUMN test_model TEXT DEFAULT 'gpt-4o-mini';

UPDATE custom_relays
SET test_model = 'gpt-4o-mini'
WHERE test_model IS NULL OR TRIM(test_model) = '';

INSERT INTO provider_configs (provider, label, color, base_url, visible, is_custom, sort_order)
SELECT 'custom', '自定义中转', '#FF6B35', '', 1, 0, 90
WHERE NOT EXISTS (
    SELECT 1 FROM provider_configs WHERE provider = 'custom'
);

INSERT INTO model_configs (provider, model_id, model_label, visible, is_custom, sort_order)
SELECT
    'custom',
    COALESCE(NULLIF(TRIM(test_model), ''), 'gpt-4o-mini') AS model_id,
    COALESCE(NULLIF(TRIM(test_model), ''), 'gpt-4o-mini') AS model_label,
    1,
    1,
    0
FROM custom_relays
WHERE COALESCE(NULLIF(TRIM(test_model), ''), 'gpt-4o-mini') <> ''
  AND NOT EXISTS (
      SELECT 1
      FROM model_configs mc
      WHERE mc.provider = 'custom'
        AND mc.model_id = COALESCE(NULLIF(TRIM(custom_relays.test_model), ''), 'gpt-4o-mini')
  );
