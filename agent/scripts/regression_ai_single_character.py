"""Character regression: single AI character generation endpoint.

Checks:
1) /api/characters/ai-generate can generate and persist one character
2) generated fields are normalized (category/gender/age)
3) duplicate name from model output is auto-deduped
"""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import uuid

from agents import router as agent_router
from api.characters import CharacterAIGenerateRequest, generate_single_character


class FakeLLM:
    async def chat(self, model: str, messages: list[dict], temperature: float = 0.5, max_tokens: int = 1200):
        _ = (model, messages, temperature, max_tokens)
        # intentionally returns duplicate name + unknown age to verify normalization/deduping
        payload = {
            "character": {
                "name": "林岚",
                "category": "功能角色",
                "gender": "未知",
                "age": "未知",
                "identity": "线人",
                "appearance": "短发",
                "personality": "谨慎",
                "motivation": "活下去并赎罪",
                "backstory": "曾参与旧案外围运输",
                "arc": "从逃避到作证",
                "usage_notes": "补足关键证据链",
            }
        }
        return json.dumps(payload, ensure_ascii=False)


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
        (project_id, "Single Character AI Regression", "悬疑", "用于单角色AI生成回归测试", "fake-model", 0.45, 60000),
    )
    db.execute(
        "INSERT INTO characters (project_id, name, category, gender, age, identity, personality) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (project_id, "林岚", "主角", "女", "26", "刑警队长", "冷静"),
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

    created = await generate_single_character(
        CharacterAIGenerateRequest(project_id=project_id, brief="补一个功能角色", category_hint="其他")
    )

    if not isinstance(created, dict) or not created.get("id"):
        raise SystemExit(f"[FAIL] invalid created payload: {created}")
    if str(created.get("name", "")).strip() == "林岚":
        raise SystemExit(f"[FAIL] duplicate name was not deduped: {created}")
    if str(created.get("category", "")).strip() != "其他":
        raise SystemExit(f"[FAIL] category normalization mismatch: {created.get('category')}")
    if str(created.get("gender", "")).strip() != "男":
        raise SystemExit(f"[FAIL] gender normalization mismatch: {created.get('gender')}")
    if str(created.get("age", "")).strip() != "18":
        raise SystemExit(f"[FAIL] age normalization mismatch: {created.get('age')}")

    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    rows = db.execute(
        "SELECT name, category, gender, age FROM characters WHERE project_id = ? ORDER BY created_at ASC",
        (project_id,),
    ).fetchall()
    db.close()
    if len(rows) < 2:
        raise SystemExit("[FAIL] expected at least 2 characters in db")
    names = [str(r["name"]) for r in rows]
    if len(set(names)) != len(names):
        raise SystemExit(f"[FAIL] duplicate names persisted in db: {names}")

    print("[PASS] single AI character generation is healthy")
    print(f"[INFO] project_id={project_id}")
    print(f"[INFO] created_name={created.get('name')}")
    print(f"[INFO] total_characters={len(rows)}")


if __name__ == "__main__":
    asyncio.run(main())
