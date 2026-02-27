"""Bootstrap regression: fail fast when character payload is unparseable.

Checks:
1) scope=characters returns HTTP 500 when no valid character can be parsed
2) no characters are persisted for that project
3) request does not trigger repeated outer top-up rounds (chat calls <= 3)
"""
from __future__ import annotations

import asyncio
import os
import sqlite3
import uuid

from fastapi import HTTPException

from agents import router as agent_router
from api.pipeline import BootstrapRequest, bootstrap_project


class FakeLLM:
    def __init__(self):
        self.calls = 0

    async def chat(self, model: str, messages: list[dict], temperature: float = 0.3, max_tokens: int = 1200):
        _ = (model, messages, temperature, max_tokens)
        self.calls += 1
        # Intentionally unparseable output to trigger parse+repair failure.
        return "角色如下：主角A、反派B、配角C。"


def _data_paths() -> tuple[str, str]:
    data_dir = os.environ.get("SANHUOAI_DATA_DIR") or os.path.join(os.environ.get("APPDATA", ""), "sanhuoai")
    db_path = os.path.join(data_dir, "sanhuoai.db")
    return data_dir, db_path


def _ensure_project(db_path: str) -> str:
    project_id = uuid.uuid4().hex
    db = sqlite3.connect(db_path)
    db.execute(
        "INSERT INTO projects (id, name, genre, description, model_main, temperature, word_target) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            project_id,
            "Bootstrap Character Parse Failure Regression",
            "都市悬疑",
            "用于角色解析失败回归测试",
            "fake-model",
            0.55,
            90000,
        ),
    )
    db.commit()
    db.close()
    return project_id


async def main():
    _, db_path = _data_paths()
    if not os.path.exists(db_path):
        raise SystemExit(f"[FAIL] DB not found: {db_path}")

    project_id = _ensure_project(db_path)

    fake_llm = FakeLLM()
    agent_router._workflow = object()
    agent_router._llm = fake_llm
    agent_router._chunk_manager = object()
    agent_router._epa = object()
    agent_router._meta_thinking = object()

    try:
        await bootstrap_project(
            BootstrapRequest(
                project_id=project_id,
                scope="characters",
                chapter_count=12,
                force=True,
                use_bible=False,
                use_profile=False,
            )
        )
    except HTTPException as exc:
        if int(exc.status_code) != 500:
            raise SystemExit(f"[FAIL] expected HTTP 500, got {exc.status_code}: {exc.detail}")
        detail = str(exc.detail or "")
        if ("角色生成失败" not in detail) or ("无法解析" not in detail):
            raise SystemExit(f"[FAIL] unexpected error detail: {detail}")
    else:
        raise SystemExit("[FAIL] expected bootstrap_project to raise HTTPException(500)")

    db = sqlite3.connect(db_path)
    count = db.execute(
        "SELECT COUNT(*) FROM characters WHERE project_id = ?",
        (project_id,),
    ).fetchone()[0]
    db.close()
    if int(count) != 0:
        raise SystemExit(f"[FAIL] expected 0 persisted characters, got {count}")

    if fake_llm.calls > 3:
        raise SystemExit(f"[FAIL] expected <=3 llm calls, got {fake_llm.calls}")

    print("[PASS] bootstrap character parse failure is surfaced and bounded")
    print(f"[INFO] project_id={project_id}")
    print(f"[INFO] llm_calls={fake_llm.calls}")


if __name__ == "__main__":
    asyncio.run(main())
