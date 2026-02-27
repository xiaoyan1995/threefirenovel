ALTER TABLE characters ADD COLUMN usage_notes TEXT DEFAULT '';

UPDATE characters
SET usage_notes = ''
WHERE usage_notes IS NULL;
