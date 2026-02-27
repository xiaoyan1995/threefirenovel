"""Bootstrap regression: outline should align with generated character names.

Checks:
1) scope=all with small chapter_count still runs split-by-scope flow
2) character payload supports Chinese field aliases + nested arrays
3) outline generation prompt receives generated character names as context
4) persisted outlines/characters are non-empty and structurally complete
"""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import uuid

from agents import router as agent_router
from api.pipeline import BootstrapRequest, bootstrap_project


class FakeLLM:
    def __init__(self):
        self.scope_order: list[str] = []
        self.character_prompt_snapshots: list[str] = []
        self.outline_prompt_snapshots: list[str] = []

    async def chat(self, model: str, messages: list[dict], temperature: float = 0.3, max_tokens: int = 1200):
        user_msg = ""
        for m in messages:
            if m.get("role") == "user":
                user_msg = str(m.get("content") or "")
                break

        scope = ""
        for label in ("角色", "世界观", "大纲", "章节"):
            marker = f"本次生成范围：{label}"
            if marker in user_msg:
                scope = label
                break
        if scope:
            self.scope_order.append(scope)

        if scope == "角色":
            self.character_prompt_snapshots.append(user_msg)
            payload = {
                "characters": {
                    "profiles": [
                        {
                            "姓名": "林岚",
                            "角色定位": "主角",
                            "性别": "女",
                            "年龄": "26",
                            "身份": "刑警队长",
                            "外貌": "短发，左眉有疤",
                            "性格": "冷静强硬",
                            "动机": "查清父亲旧案",
                            "背景": "从基层一路升任重案组",
                            "弧线": "从单打独斗到学会协作",
                            "使用建议": "推进主线侦查与道德抉择",
                            "关系": [
                                {"对象": "顾沉", "关系": "同盟", "说明": "合作又互相试探"},
                            ],
                        },
                        {
                            "profile": {
                                "name": "顾沉",
                                "category": "配角",
                                "gender": "男",
                                "age": "29",
                                "identity": "法医",
                                "personality": "克制敏锐",
                                "motivation": "证明旧案检材被篡改",
                                "backstory": "曾因误判被停职",
                                "arc": "从谨慎自保转向主动承担",
                                "usage_notes": "提供关键证据与反转触发",
                            }
                        },
                    ]
                }
            }
            return json.dumps(payload, ensure_ascii=False)

        if scope == "世界观":
            payload = {
                "worldbuilding": [
                    {"category": "规则", "title": "证据链闭环", "content": "核心证据必须可回溯来源并可复验。"},
                ]
            }
            return json.dumps(payload, ensure_ascii=False)

        if scope == "大纲":
            self.outline_prompt_snapshots.append(user_msg)
            payload = {
                "outlines": {
                    "items": [
                        {
                            "阶段": "起",
                            "标题": "雨夜旧案重启",
                            "内容": "林岚在雨夜重启旧案调查，与顾沉在停尸房首次正面协作。",
                            "字数范围": "1-6章",
                        }
                    ]
                }
            }
            return json.dumps(payload, ensure_ascii=False)

        if scope == "章节":
            payload = {
                "chapters": [
                    {
                        "chapter_num": idx,
                        "title": f"第{idx}章",
                        "phase": "起" if idx <= 2 else "承" if idx <= 4 else "转",
                        "synopsis": f"第{idx}章推进旧案线索并制造新冲突。",
                    }
                    for idx in range(1, 7)
                ]
            }
            return json.dumps(payload, ensure_ascii=False)

        return "{}"


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
        (project_id, "Bootstrap Alignment Regression", "悬疑", "用于回归测试", "fake-model", 0.4, 60000),
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
    agent_router._workflow = object()  # avoid _init_services overriding test doubles
    agent_router._llm = fake_llm
    agent_router._chunk_manager = object()
    agent_router._epa = object()
    agent_router._meta_thinking = object()

    await bootstrap_project(
        BootstrapRequest(
            project_id=project_id,
            scope="all",
            chapter_count=6,
            force=True,
            use_bible=False,
            use_profile=False,
        )
    )

    if fake_llm.scope_order[:4] != ["世界观", "角色", "大纲", "章节"]:
        raise SystemExit(f"[FAIL] unexpected scope order: {fake_llm.scope_order}")

    if not fake_llm.character_prompt_snapshots:
        raise SystemExit("[FAIL] character prompt not captured")
    character_prompt = fake_llm.character_prompt_snapshots[-1]
    if "【世界观设定】" not in character_prompt or "证据链闭环" not in character_prompt:
        snippet = character_prompt[:700].replace("\n", "\\n")
        raise SystemExit(f"[FAIL] worldbuilding context not injected into character prompt | prompt={snippet}")

    if not fake_llm.outline_prompt_snapshots:
        raise SystemExit("[FAIL] outline prompt not captured")
    outline_prompt = fake_llm.outline_prompt_snapshots[-1]
    if "林岚" not in outline_prompt or "顾沉" not in outline_prompt:
        snippet = outline_prompt[:700].replace("\n", "\\n")
        raise SystemExit(f"[FAIL] generated character names were not injected into outline prompt context | prompt={snippet}")

    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    character_rows = db.execute(
        "SELECT name, category, gender, age, identity, personality, motivation FROM characters WHERE project_id = ? ORDER BY created_at ASC",
        (project_id,),
    ).fetchall()
    outline_rows = db.execute(
        "SELECT title, content FROM outlines WHERE project_id = ? ORDER BY phase_order ASC, created_at ASC",
        (project_id,),
    ).fetchall()
    db.close()

    if len(character_rows) < 2:
        raise SystemExit(f"[FAIL] expected >=2 characters, got {len(character_rows)}")
    names = {str(r["name"]) for r in character_rows}
    if not {"林岚", "顾沉"}.issubset(names):
        raise SystemExit(f"[FAIL] expected 林岚/顾沉 in characters, got {sorted(names)}")
    if not outline_rows:
        raise SystemExit("[FAIL] outlines table is empty")
    outline_blob = "\n".join([f"{r['title']} {r['content']}" for r in outline_rows])
    if "林岚" not in outline_blob or "顾沉" not in outline_blob:
        raise SystemExit("[FAIL] outline content does not include generated character names")

    print("[PASS] bootstrap outline/character alignment is healthy")
    print(f"[INFO] project_id={project_id}")
    print(f"[INFO] scope_order={fake_llm.scope_order}")


if __name__ == "__main__":
    asyncio.run(main())
