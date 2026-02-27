"""Bootstrap regression: character top-up should recover from low-count outputs.

Checks:
1) first character generation returns only 3 profiles
2) pipeline enters character top-up rounds with explicit hard constraints
3) final persisted character count reaches scope minimum for chapter_count=12 (>=6)
4) final role mix keeps at least 1 protagonist / 1 villain / 3 supporting / 1 utility role
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
        self.character_calls = 0
        self.character_prompt_snapshots: list[str] = []

    async def chat(self, model: str, messages: list[dict], temperature: float = 0.3, max_tokens: int = 1200):
        user_msg = ""
        for m in messages:
            if m.get("role") == "user":
                user_msg = str(m.get("content") or "")
                break

        scope = ""
        for label in ("角色", "世界观", "大纲", "章节"):
            if f"本次生成范围：{label}" in user_msg:
                scope = label
                break

        if scope == "世界观":
            return json.dumps(
                {
                    "worldbuilding": [
                        {"category": "规则", "title": "监察局条例", "content": "超能力使用必须备案并可追溯。"}
                    ]
                },
                ensure_ascii=False,
            )

        if scope == "角色":
            self.character_calls += 1
            self.character_prompt_snapshots.append(user_msg)
            if self.character_calls == 1:
                # Intentionally low-count response.
                payload = {
                    "characters": [
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
                            "relations": [{"target": "陆晴", "relation_type": "搭档", "description": "互补配合"}],
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
                            "relations": [],
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
                            "relations": [],
                        },
                    ]
                }
                return json.dumps(payload, ensure_ascii=False)

            # Top-up round: includes duplicates + new names; pipeline should merge uniques.
            payload = {
                "characters": [
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
                        "relations": [],
                    },
                    {
                        "name": "沈霁",
                        "category": "关键配角",
                        "gender": "女",
                        "age": "31",
                        "identity": "法务审计官",
                        "appearance": "金丝眼镜",
                        "personality": "克制谨慎",
                        "motivation": "补全证据链",
                        "backstory": "曾被高层边缘化",
                        "arc": "从自保到挺身而出",
                        "usage_notes": "中段揭露内幕",
                        "relations": [],
                    },
                    {
                        "name": "宋临",
                        "category": "功能角色",
                        "gender": "男",
                        "age": "22",
                        "identity": "技术分析员",
                        "appearance": "瘦高",
                        "personality": "机敏",
                        "motivation": "证明自身价值",
                        "backstory": "实习转正边缘",
                        "arc": "从畏缩到担当",
                        "usage_notes": "提供关键技术线索",
                        "relations": [],
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
                        "relations": [],
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
                        "relations": [],
                    },
                ]
            }
            return json.dumps(payload, ensure_ascii=False)

        if scope == "大纲":
            payload = {
                "outlines": [
                    {
                        "phase": "起",
                        "title": "审计线索浮现",
                        "content": "唐煜与陆晴在沈霁协助下锁定第一批违规样本。",
                        "word_range": "1-4章",
                    }
                ]
            }
            return json.dumps(payload, ensure_ascii=False)

        if scope == "章节":
            payload = {
                "chapters": [
                    {
                        "chapter_num": idx,
                        "title": f"第{idx}章",
                        "phase": "起" if idx <= 3 else "承" if idx <= 8 else "转",
                        "synopsis": f"第{idx}章推进调查线并引出新的责任冲突。",
                    }
                    for idx in range(1, 13)
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
        (project_id, "Bootstrap Character Topup Regression", "都市悬疑", "用于角色补齐回归测试", "fake-model", 0.45, 90000),
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

    await bootstrap_project(
        BootstrapRequest(
            project_id=project_id,
            scope="all",
            chapter_count=12,
            force=True,
            use_bible=False,
            use_profile=False,
        )
    )

    if fake_llm.character_calls < 2:
        raise SystemExit(f"[FAIL] expected >=2 character calls, got {fake_llm.character_calls}")
    if not any("角色补齐硬约束" in prompt for prompt in fake_llm.character_prompt_snapshots[1:]):
        raise SystemExit("[FAIL] top-up hard-constraint block missing in retry prompts")
    if not any("角色结构目标" in prompt for prompt in fake_llm.character_prompt_snapshots[1:]):
        raise SystemExit("[FAIL] role-mix target block missing in retry prompts")

    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    rows = db.execute(
        "SELECT name, category FROM characters WHERE project_id = ? ORDER BY created_at ASC",
        (project_id,),
    ).fetchall()
    db.close()

    names = [str(r["name"]) for r in rows]
    if len(names) < 6:
        raise SystemExit(f"[FAIL] expected >=6 characters after top-up, got {len(names)} | names={names}")
    if len(set(names)) != len(names):
        raise SystemExit(f"[FAIL] duplicate names detected after top-up | names={names}")
    category_counts = {"主角": 0, "反派": 0, "配角": 0, "其他": 0}
    for row in rows:
        category = str(row["category"] or "").strip()
        if "主" in category:
            category_counts["主角"] += 1
        elif "反" in category:
            category_counts["反派"] += 1
        elif "配" in category:
            category_counts["配角"] += 1
        else:
            category_counts["其他"] += 1
    if category_counts["主角"] < 1 or category_counts["反派"] < 1 or category_counts["配角"] < 3 or category_counts["其他"] < 1:
        raise SystemExit(
            "[FAIL] role mix does not meet minimum target | "
            f"counts={category_counts} names={names}"
        )

    print("[PASS] bootstrap character top-up is healthy")
    print(f"[INFO] project_id={project_id}")
    print(f"[INFO] character_calls={fake_llm.character_calls}")
    print(f"[INFO] final_character_count={len(names)}")
    print(f"[INFO] final_category_counts={category_counts}")


if __name__ == "__main__":
    asyncio.run(main())
