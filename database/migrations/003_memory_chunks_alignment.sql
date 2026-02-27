-- 对齐 memory_chunks 与运行时代码字段
-- 目标：不破坏旧数据，补齐 source_type / summary / char_count / metadata / access_count

ALTER TABLE memory_chunks ADD COLUMN source_type TEXT DEFAULT 'memory';
ALTER TABLE memory_chunks ADD COLUMN summary TEXT;
ALTER TABLE memory_chunks ADD COLUMN char_count INTEGER DEFAULT 0;
ALTER TABLE memory_chunks ADD COLUMN metadata TEXT DEFAULT '{}';
ALTER TABLE memory_chunks ADD COLUMN access_count INTEGER DEFAULT 0;

-- 回填 source_type：优先使用旧 chunk_type 映射
UPDATE memory_chunks
SET source_type = CASE
    WHEN source_type IS NULL OR TRIM(source_type) = '' THEN
        CASE
            WHEN chunk_type IS NULL OR TRIM(chunk_type) = '' THEN 'memory'
            ELSE chunk_type
        END
    ELSE source_type
END;

-- 回填 char_count
UPDATE memory_chunks
SET char_count = LENGTH(COALESCE(content, ''))
WHERE char_count IS NULL OR char_count = 0;
