"""Knowledge/profile pipeline regression check.

Checks the end-to-end path without external LLM dependency:
1) Create collection
2) Import typed knowledge files (with chunk indexing)
3) Extract profile from collection
4) Bind profile and verify active profile
5) Verify bootstrap prompt includes profile block when enabled
6) Disable profile and verify bootstrap prompt excludes profile block
"""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import uuid

from agents import router as agent_router
from api.knowledge import (
    CollectionCreateRequest,
    KnowledgeImportRequest,
    ProfileBindRequest,
    ProfileExtractRequest,
    bind_profile,
    create_collection,
    extract_profile,
    get_active_profile,
    import_knowledge,
)
from api.pipeline import BootstrapRequest, bootstrap_project


class FakeLLM:
    def __init__(self):
        self.calls: list[dict] = []

    async def chat(self, model: str, messages: list[dict], temperature: float = 0.3, max_tokens: int = 1200):
        user_msg = ""
        for m in messages:
            if m.get("role") == "user":
                user_msg = m.get("content", "")
                break
        self.calls.append({"model": model, "user": user_msg, "temperature": temperature, "max_tokens": max_tokens})

        if "提炼可执行“写作规则包”" in user_msg:
            profile = {
                "name": "回归规则包",
                "genre": "推理",
                "writing_principles": ["线索前置", "信息公平", "反转可回溯"],
                "plot_rules": ["每章必须推进案件状态"],
                "character_rules": ["侦探主角必须有明确推理链"],
                "scene_rules": ["关键场景保留可验证细节"],
                "world_rules": ["不允许超自然破案"],
                "prop_rules": ["关键道具必须有来源与去向"],
                "hook_rules": ["章尾保留未解释疑点"],
                "pacing_rules": ["3章内给出首个误导线索"],
                "taboos": ["机械降神"],
                "quality_checklist": ["动机闭环", "证据闭环"],
                "examples": ["示例略"],
            }
            return json.dumps(profile, ensure_ascii=False)

        if "输出 JSON 对象，包含字段" in user_msg:
            payload = {
                "outlines": [{"phase": "起", "title": "迷案开端", "content": "围绕一宗密室案展开", "word_range": "3000-5000"}],
                "characters": [{"name": "沈砚", "category": "主角", "identity": "刑侦顾问", "personality": "冷静克制", "motivation": "找出真相", "arc": "学会信任团队"}],
                "worldbuilding": [{"category": "规则", "title": "证据规则", "content": "证据链必须可验证且闭环"}],
                "chapters": [{"chapter_num": 1, "title": "雨夜密室", "phase": "起", "synopsis": "暴雨夜发生密室命案，主角接手并锁定三名嫌疑人。"}],
            }
            # 前缀噪声 + fenced JSON，用于验证 parse fallback
            return f"模型思考摘要\n```json\n{json.dumps(payload, ensure_ascii=False)}\n```"

        return "{}"


class DummyChunkManager:
    def __init__(self):
        self.count = 0

    def add_chunk(self, **kwargs):
        self.count += 1
        return f"dummy_{self.count}"


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
        (project_id, "Knowledge Regression Project", "推理", "回归测试项目", "fake-model", 0.4, 80000),
    )
    db.commit()
    db.close()
    return project_id


def _assert_tables_exist(db_path: str):
    db = sqlite3.connect(db_path)
    tables = {
        "knowledge_collections",
        "knowledge_sources",
        "knowledge_profiles",
        "project_profile_binding",
    }
    rows = db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    existing = {r[0] for r in rows}
    db.close()
    missing = sorted(t for t in tables if t not in existing)
    if missing:
        raise SystemExit(f"[FAIL] Missing tables: {', '.join(missing)}")


async def main():
    _, db_path = _data_paths()
    if not os.path.exists(db_path):
        raise SystemExit(f"[FAIL] DB not found: {db_path}")

    _assert_tables_exist(db_path)
    project_id = _ensure_project(db_path)

    fake_llm = FakeLLM()
    dummy_cm = DummyChunkManager()
    agent_router._workflow = object()  # prevent _init_services from overriding test doubles
    agent_router._llm = fake_llm
    agent_router._chunk_manager = dummy_cm
    agent_router._epa = object()
    agent_router._meta_thinking = object()

    collection = create_collection(
        CollectionCreateRequest(project_id=project_id, name="推理资料集", description="回归测试资料集")
    )
    collection_id = collection["id"]

    i1 = await import_knowledge(
        KnowledgeImportRequest(
            project_id=project_id,
            title="角色设定样本",
            content="主角擅长微表情观察与证据串联。\n\n必须遵守证据优先。",
            collection_id=collection_id,
            reference_type="character",
        )
    )
    i2 = await import_knowledge(
        KnowledgeImportRequest(
            project_id=project_id,
            title="情节节奏样本",
            content="每章都要给新线索，并回收至少一个旧疑点。\n\n禁止超自然破案。",
            collection_id=collection_id,
            reference_type="plot",
        )
    )

    if i1.chunks_indexed <= 0 or i2.chunks_indexed <= 0 or dummy_cm.count <= 0:
        raise SystemExit("[FAIL] knowledge import did not index chunks")

    profile = await extract_profile(
        ProfileExtractRequest(
            project_id=project_id,
            name="回归规则包",
            genre="推理",
            collection_id=collection_id,
            mode="rules_only",
        )
    )
    profile_id = profile["id"]
    if not profile_id:
        raise SystemExit("[FAIL] extract profile returned empty id")

    bind_profile(ProfileBindRequest(project_id=project_id, profile_id=profile_id, enabled=True))
    active = get_active_profile(project_id=project_id)
    if not active or not active.get("enabled") or active.get("profile_id") != profile_id:
        raise SystemExit("[FAIL] active profile bind failed")

    await bootstrap_project(
        BootstrapRequest(project_id=project_id, scope="all", force=True, use_bible=False, use_profile=True)
    )
    prompt_calls = [c for c in fake_llm.calls if "输出 JSON 对象，包含字段" in c["user"]]
    if not prompt_calls:
        raise SystemExit("[FAIL] bootstrap was not invoked")
    prompt_on = prompt_calls[-1]["user"]
    if "【必须遵守的知识规则包】" not in prompt_on:
        raise SystemExit("[FAIL] enabled profile was not injected into bootstrap prompt")

    bind_profile(ProfileBindRequest(project_id=project_id, profile_id=profile_id, enabled=False))
    await bootstrap_project(
        BootstrapRequest(project_id=project_id, scope="all", force=True, use_bible=False, use_profile=True)
    )
    prompt_calls = [c for c in fake_llm.calls if "输出 JSON 对象，包含字段" in c["user"]]
    prompt_off = prompt_calls[-1]["user"]
    if "【必须遵守的知识规则包】" in prompt_off:
        raise SystemExit("[FAIL] disabled profile still injected into bootstrap prompt")

    print("[PASS] knowledge profile pipeline is healthy")
    print(f"[INFO] project_id={project_id}")
    print(f"[INFO] collection_id={collection_id}")
    print(f"[INFO] profile_id={profile_id}")


if __name__ == "__main__":
    asyncio.run(main())
