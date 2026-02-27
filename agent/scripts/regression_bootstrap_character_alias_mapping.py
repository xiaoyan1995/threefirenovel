"""Bootstrap regression: accept wrapped/aliased character keys.

Checks:
1) scope=characters accepts payload like {"result":{"角色":[...]}}
2) characters are normalized and persisted
3) bootstrap reports inserted characters > 0
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
        self.calls = 0

    async def chat(self, model: str, messages: list[dict], temperature: float = 0.5, max_tokens: int = 3000):
        _ = (model, messages, temperature, max_tokens)
        self.calls += 1
        payload = {
            "result": {
                "角色": [
                    {
                        "name": "唐煜",
                        "category": "主角",
                        "gender": "男",
                        "age": "25",
                        "identity": "监察局新人",
                        "appearance": "利落短发",
                        "personality": "执拗",
                        "motivation": "洗清家族污名",
                        "backstory": "父亲因旧案失踪",
                        "arc": "从冲动到沉稳",
                        "usage_notes": "推进主线调查",
                    },
                    {
                        "name": "魏锋",
                        "category": "反派",
                        "gender": "男",
                        "age": "36",
                        "identity": "企业安保总监",
                        "appearance": "面色阴沉",
                        "personality": "强势",
                        "motivation": "掩盖非法试验",
                        "backstory": "掌握黑市渠道",
                        "arc": "从掌控到失势",
                        "usage_notes": "制造中前期压力",
                    },
                    {
                        "name": "陆晴",
                        "category": "关键配角",
                        "gender": "女",
                        "age": "27",
                        "identity": "资深调查员",
                        "appearance": "高马尾",
                        "personality": "冷静",
                        "motivation": "阻止系统性腐败",
                        "backstory": "曾是受害者家属",
                        "arc": "从防备到信任",
                        "usage_notes": "提供专业判断",
                    },
                    {
                        "name": "沈霁",
                        "category": "配角",
                        "gender": "女",
                        "age": "31",
                        "identity": "法务审计官",
                        "appearance": "金丝眼镜",
                        "personality": "克制谨慎",
                        "motivation": "补全证据链",
                        "backstory": "曾被高层边缘化",
                        "arc": "从自保到挺身而出",
                        "usage_notes": "中段揭露内幕",
                    },
                    {
                        "name": "乔河",
                        "category": "配角",
                        "gender": "男",
                        "age": "34",
                        "identity": "内勤联络员",
                        "appearance": "神情疲惫",
                        "personality": "谨慎细密",
                        "motivation": "避免证据链断裂",
                        "backstory": "曾参与旧案后勤整理",
                        "arc": "从中立观望到公开作证",
                        "usage_notes": "承接线索与时间线校验",
                    },
                    {
                        "name": "顾南",
                        "category": "功能角色",
                        "gender": "男",
                        "age": "40",
                        "identity": "督察组组长",
                        "appearance": "沉稳寡言",
                        "personality": "务实",
                        "motivation": "稳定系统秩序",
                        "backstory": "长期处理高压案件",
                        "arc": "从观望到支持主角",
                        "usage_notes": "后段提供制度支持",
                    },
                ]
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
        (
            project_id,
            "Bootstrap Character Alias Mapping Regression",
            "都市悬疑",
            "用于角色别名解析回归测试",
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

    result = await bootstrap_project(
        BootstrapRequest(
            project_id=project_id,
            scope="characters",
            chapter_count=12,
            force=True,
            use_bible=False,
            use_profile=False,
        )
    )

    inserted = int((result.inserted or {}).get("characters", 0))
    if inserted < 6:
        raise SystemExit(f"[FAIL] expected >=6 inserted characters, got {inserted} | result={result}")

    db = sqlite3.connect(db_path)
    count = db.execute(
        "SELECT COUNT(*) FROM characters WHERE project_id = ?",
        (project_id,),
    ).fetchone()[0]
    db.close()
    if int(count) < 6:
        raise SystemExit(f"[FAIL] expected >=6 persisted characters, got {count}")

    print("[PASS] bootstrap character alias mapping is healthy")
    print(f"[INFO] project_id={project_id}")
    print(f"[INFO] llm_calls={fake_llm.calls}")
    print(f"[INFO] inserted_characters={inserted}")


if __name__ == "__main__":
    asyncio.run(main())
