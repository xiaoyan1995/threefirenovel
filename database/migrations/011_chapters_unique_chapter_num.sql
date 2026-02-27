-- 章节幂等防重：按 (project_id, chapter_num) 保证唯一
-- 先清理历史重复，再建立唯一索引，避免区间生成重复写入。

DROP TABLE IF EXISTS _chapter_keep_map;
DROP TABLE IF EXISTS _chapter_dup_map;

CREATE TEMP TABLE _chapter_keep_map (
    project_id   TEXT NOT NULL,
    chapter_num  INTEGER NOT NULL,
    keep_id      TEXT NOT NULL,
    PRIMARY KEY (project_id, chapter_num)
);

INSERT INTO _chapter_keep_map (project_id, chapter_num, keep_id)
SELECT
    c.project_id,
    c.chapter_num,
    (
        SELECT c2.id
        FROM chapters c2
        WHERE c2.project_id = c.project_id
          AND c2.chapter_num = c.chapter_num
        ORDER BY
            (
                (SELECT COUNT(1) FROM chapter_paragraphs p WHERE p.chapter_id = c2.id) +
                (SELECT COUNT(1) FROM chapter_beats b WHERE b.chapter_id = c2.id) +
                (SELECT COUNT(1) FROM foreshadowing f WHERE f.plant_chapter_id = c2.id OR f.resolve_chapter_id = c2.id) +
                (SELECT COUNT(1) FROM reviews r WHERE r.chapter_id = c2.id)
            ) DESC,
            CASE WHEN TRIM(COALESCE(c2.synopsis, '')) <> '' THEN 1 ELSE 0 END DESC,
            CASE
                WHEN TRIM(COALESCE(c2.title, '')) = '' THEN 0
                WHEN REPLACE(TRIM(COALESCE(c2.title, '')), ' ', '') IN (
                    ('第' || c2.chapter_num || '章'),
                    ('第' || c2.chapter_num || '章·'),
                    ('第' || c2.chapter_num || '章：'),
                    ('第' || c2.chapter_num || '章:')
                ) THEN 0
                ELSE 1
            END DESC,
            COALESCE(c2.updated_at, '') DESC,
            COALESCE(c2.created_at, '') DESC,
            c2.id DESC
        LIMIT 1
    ) AS keep_id
FROM chapters c
GROUP BY c.project_id, c.chapter_num;

CREATE TEMP TABLE _chapter_dup_map AS
SELECT
    c.id AS duplicate_id,
    km.keep_id AS keep_id
FROM chapters c
JOIN _chapter_keep_map km
  ON km.project_id = c.project_id
 AND km.chapter_num = c.chapter_num
WHERE c.id <> km.keep_id;

-- 先回收关联，避免重复章删除时丢失可复用数据
UPDATE chapter_paragraphs
SET chapter_id = (
    SELECT d.keep_id FROM _chapter_dup_map d WHERE d.duplicate_id = chapter_paragraphs.chapter_id
)
WHERE chapter_id IN (SELECT duplicate_id FROM _chapter_dup_map);

UPDATE chapter_beats
SET chapter_id = (
    SELECT d.keep_id FROM _chapter_dup_map d WHERE d.duplicate_id = chapter_beats.chapter_id
)
WHERE chapter_id IN (SELECT duplicate_id FROM _chapter_dup_map);

UPDATE foreshadowing
SET plant_chapter_id = (
    SELECT d.keep_id FROM _chapter_dup_map d WHERE d.duplicate_id = foreshadowing.plant_chapter_id
)
WHERE plant_chapter_id IN (SELECT duplicate_id FROM _chapter_dup_map);

UPDATE foreshadowing
SET resolve_chapter_id = (
    SELECT d.keep_id FROM _chapter_dup_map d WHERE d.duplicate_id = foreshadowing.resolve_chapter_id
)
WHERE resolve_chapter_id IN (SELECT duplicate_id FROM _chapter_dup_map);

UPDATE reviews
SET chapter_id = (
    SELECT d.keep_id FROM _chapter_dup_map d WHERE d.duplicate_id = reviews.chapter_id
)
WHERE chapter_id IN (SELECT duplicate_id FROM _chapter_dup_map);

DELETE FROM chapters
WHERE id IN (SELECT duplicate_id FROM _chapter_dup_map);

DROP TABLE IF EXISTS _chapter_dup_map;
DROP TABLE IF EXISTS _chapter_keep_map;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chapters_project_chapter_num
    ON chapters(project_id, chapter_num);
