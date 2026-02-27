"""数据库迁移工具"""
import sqlite3
from pathlib import Path


def _apply_memory_chunks_alignment(db: sqlite3.Connection):
    """003 迁移：对齐 memory_chunks 字段，兼容新旧 schema。"""
    cols = {
        row[1]
        for row in db.execute("PRAGMA table_info(memory_chunks)").fetchall()
    }

    if "source_type" not in cols:
        db.execute("ALTER TABLE memory_chunks ADD COLUMN source_type TEXT DEFAULT 'memory'")
    if "summary" not in cols:
        db.execute("ALTER TABLE memory_chunks ADD COLUMN summary TEXT")
    if "char_count" not in cols:
        db.execute("ALTER TABLE memory_chunks ADD COLUMN char_count INTEGER DEFAULT 0")
    if "metadata" not in cols:
        db.execute("ALTER TABLE memory_chunks ADD COLUMN metadata TEXT DEFAULT '{}'")
    if "access_count" not in cols:
        db.execute("ALTER TABLE memory_chunks ADD COLUMN access_count INTEGER DEFAULT 0")

    # 回填 source_type（优先 chunk_type）
    db.execute(
        """
        UPDATE memory_chunks
        SET source_type = CASE
            WHEN source_type IS NULL OR TRIM(source_type) = '' THEN
                CASE
                    WHEN chunk_type IS NULL OR TRIM(chunk_type) = '' THEN 'memory'
                    ELSE chunk_type
                END
            ELSE source_type
        END
        """
    )

    # 回填 char_count
    db.execute(
        """
        UPDATE memory_chunks
        SET char_count = LENGTH(COALESCE(content, ''))
        WHERE char_count IS NULL OR char_count = 0
        """
    )


def _apply_custom_relays_test_model_migration(db: sqlite3.Connection):
    """009 迁移：为 custom_relays 安全补充 test_model，并回填 custom provider/model。"""
    cols = {
        row[1]
        for row in db.execute("PRAGMA table_info(custom_relays)").fetchall()
    }
    if "test_model" not in cols:
        db.execute("ALTER TABLE custom_relays ADD COLUMN test_model TEXT DEFAULT 'gpt-4o-mini'")

    db.execute(
        """
        UPDATE custom_relays
        SET test_model = 'gpt-4o-mini'
        WHERE test_model IS NULL OR TRIM(test_model) = ''
        """
    )

    db.execute(
        """
        INSERT INTO provider_configs (provider, label, color, base_url, visible, is_custom, sort_order)
        SELECT 'custom', '自定义中转', '#FF6B35', '', 1, 0, 90
        WHERE NOT EXISTS (
            SELECT 1 FROM provider_configs WHERE provider = 'custom'
        )
        """
    )

    db.execute(
        """
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
          )
        """
    )


def _apply_characters_gender_migration(db: sqlite3.Connection):
    """012 迁移：为 characters 表补充 gender 字段。"""
    cols = {
        row[1]
        for row in db.execute("PRAGMA table_info(characters)").fetchall()
    }
    if "gender" not in cols:
        db.execute("ALTER TABLE characters ADD COLUMN gender TEXT DEFAULT ''")

    db.execute(
        """
        UPDATE characters
        SET gender = ''
        WHERE gender IS NULL
        """
    )


def _apply_characters_age_migration(db: sqlite3.Connection):
    """013 迁移：为 characters 表补充 age 字段。"""
    cols = {
        row[1]
        for row in db.execute("PRAGMA table_info(characters)").fetchall()
    }
    if "age" not in cols:
        db.execute("ALTER TABLE characters ADD COLUMN age TEXT DEFAULT ''")

    db.execute(
        """
        UPDATE characters
        SET age = ''
        WHERE age IS NULL
        """
    )


def _apply_projects_structure_fields_migration(db: sqlite3.Connection):
    """016 迁移：为 projects 表补充结构相关字段。"""
    cols = {
        row[1]
        for row in db.execute("PRAGMA table_info(projects)").fetchall()
    }
    if "structure" not in cols:
        db.execute("ALTER TABLE projects ADD COLUMN structure TEXT DEFAULT '起承转合'")
    if "custom_structure" not in cols:
        db.execute("ALTER TABLE projects ADD COLUMN custom_structure TEXT DEFAULT ''")
    if "chapter_words" not in cols:
        db.execute("ALTER TABLE projects ADD COLUMN chapter_words INTEGER DEFAULT 5000")
    if "priority" not in cols:
        db.execute("ALTER TABLE projects ADD COLUMN priority TEXT DEFAULT '品质优先'")

    db.execute(
        """
        UPDATE projects
        SET structure = '起承转合'
        WHERE structure IS NULL OR TRIM(structure) = ''
        """
    )
    db.execute(
        """
        UPDATE projects
        SET custom_structure = ''
        WHERE custom_structure IS NULL
        """
    )
    db.execute(
        """
        UPDATE projects
        SET chapter_words = 5000
        WHERE chapter_words IS NULL OR chapter_words <= 0
        """
    )
    db.execute(
        """
        UPDATE projects
        SET priority = '品质优先'
        WHERE priority IS NULL OR TRIM(priority) = ''
        """
    )


def _apply_characters_usage_notes_migration(db: sqlite3.Connection):
    """015 迁移：为 characters 表补充 usage_notes 字段。"""
    cols = {
        row[1]
        for row in db.execute("PRAGMA table_info(characters)").fetchall()
    }
    if "usage_notes" not in cols:
        db.execute("ALTER TABLE characters ADD COLUMN usage_notes TEXT DEFAULT ''")

    db.execute(
        """
        UPDATE characters
        SET usage_notes = ''
        WHERE usage_notes IS NULL
        """
    )


def run_migrations(db_path: str):
    """执行所有未执行的迁移"""
    # 创建迁移记录表
    db = sqlite3.connect(db_path)
    db.execute("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TEXT DEFAULT (datetime('now'))
        )
    """)
    db.commit()

    # 获取已执行的迁移
    cursor = db.execute("SELECT version FROM schema_migrations")
    applied = {row[0] for row in cursor.fetchall()}

    # 查找迁移文件
    base_dir = Path(__file__).parent.parent
    migrations_dir = base_dir / "database" / "migrations"

    if not migrations_dir.exists():
        print(f"Migration directory not found: {migrations_dir}")
        db.close()
        return

    # 执行未应用的迁移
    migration_files = sorted(migrations_dir.glob("*.sql"))
    for migration_file in migration_files:
        version = migration_file.stem
        if version in applied:
            print(f"Skipping already applied migration: {version}")
            continue

        print(f"Applying migration: {version}")
        if version == "003_memory_chunks_alignment":
            _apply_memory_chunks_alignment(db)
            db.execute("INSERT INTO schema_migrations (version) VALUES (?)", (version,))
            db.commit()
            print(f"Migration completed: {version}")
            continue
        if version == "009_custom_relays_test_model":
            _apply_custom_relays_test_model_migration(db)
            db.execute("INSERT INTO schema_migrations (version) VALUES (?)", (version,))
            db.commit()
            print(f"Migration completed: {version}")
            continue
        if version == "012_characters_gender":
            _apply_characters_gender_migration(db)
            db.execute("INSERT INTO schema_migrations (version) VALUES (?)", (version,))
            db.commit()
            print(f"Migration completed: {version}")
            continue
        if version == "013_characters_age":
            _apply_characters_age_migration(db)
            db.execute("INSERT INTO schema_migrations (version) VALUES (?)", (version,))
            db.commit()
            print(f"Migration completed: {version}")
            continue
        if version == "015_characters_usage_notes":
            _apply_characters_usage_notes_migration(db)
            db.execute("INSERT INTO schema_migrations (version) VALUES (?)", (version,))
            db.commit()
            print(f"Migration completed: {version}")
            continue
        if version == "016_projects_structure_fields":
            _apply_projects_structure_fields_migration(db)
            db.execute("INSERT INTO schema_migrations (version) VALUES (?)", (version,))
            db.commit()
            print(f"Migration completed: {version}")
            continue

        with open(migration_file, "r", encoding="utf-8") as f:
            sql = f.read()
            db.executescript(sql)
            db.execute("INSERT INTO schema_migrations (version) VALUES (?)", (version,))
            db.commit()
        print(f"Migration completed: {version}")

    db.close()
    print("All migrations completed")


if __name__ == "__main__":
    from db import get_db_path
    run_migrations(get_db_path())
