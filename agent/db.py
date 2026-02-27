"""数据库连接与初始化模块"""
import os
import sys
import sqlite3
from contextlib import contextmanager

_db_path: str | None = None


def get_data_dir() -> str:
    env_path = os.environ.get("SANHUOAI_DATA_DIR")
    if env_path:
        return env_path

    if os.name == "nt":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return os.path.join(appdata, "sanhuoai")

    if sys.platform == "darwin":
        return os.path.join(
            os.path.expanduser("~"),
            "Library",
            "Application Support",
            "sanhuoai",
        )

    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    if xdg_data_home:
        return os.path.join(xdg_data_home, "sanhuoai")

    return os.path.join(os.path.expanduser("~"), ".local", "share", "sanhuoai")


def get_db_path() -> str:
    global _db_path
    if _db_path is None:
        data_dir = get_data_dir()
        _db_path = os.path.join(data_dir, "sanhuoai.db")
    return _db_path


def set_db_path(path: str):
    global _db_path
    _db_path = path


@contextmanager
def get_db_with_path(db_path: str | None = None):
    """获取数据库连接 (context manager)，可指定数据库路径。"""
    db = sqlite3.connect(db_path or get_db_path())
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@contextmanager
def get_db():
    """获取数据库连接 (context manager)"""
    with get_db_with_path() as db:
        yield db


def init_db(schema_path: str | None = None):
    """初始化数据库 (首次运行时自动建表)"""
    if schema_path is None:
        # schema.sql 在项目根目录的 database/ 下
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        schema_path = os.path.join(base, "..", "database", "schema.sql")
        if not os.path.exists(schema_path):
            # fallback: 同级目录
            schema_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")

    db_path = get_db_path()
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)

    db = sqlite3.connect(db_path)
    if os.path.exists(schema_path):
        with open(schema_path, "r", encoding="utf-8") as f:
            db.executescript(f.read())
    db.close()
