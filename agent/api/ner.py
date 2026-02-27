from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import json

from db import get_db
from agents import router as agent_router
from agents.default_prompts import NER_EXTRACTOR_SYSTEM_PROMPT

router = APIRouter()
AGENT_TYPE = "ner_extractor"
DEFAULT_MODEL = "claude-sonnet-4"
DEFAULT_TEMPERATURE = 0.1
DEFAULT_MAX_TOKENS = 800

class NERRequest(BaseModel):
    project_id: str
    text: str

class NEREntity(BaseModel):
    name: str
    category: str  # character, worldbuilding, faction, item
    is_known: bool
    description: Optional[str] = None
    db_id: Optional[str] = None

class NERResponse(BaseModel):
    entities: List[NEREntity]


def _normalize_max_tokens(value, default_value: int) -> int:
    try:
        parsed = int(float(value))
    except Exception:
        parsed = int(default_value)
    if parsed <= 0:
        parsed = int(default_value)
    return max(256, min(12000, parsed))


def _load_runtime_config(project_id: str) -> tuple[str, float, str, bool, int]:
    with get_db() as db:
        row = db.execute(
            "SELECT p.model_main, ac.model AS cfg_model, ac.temperature AS cfg_temp, "
            "ac.system_prompt AS cfg_prompt, ac.enabled AS cfg_enabled, ac.max_tokens AS cfg_max_tokens "
            "FROM projects p "
            "LEFT JOIN agent_configs ac "
            "ON ac.project_id = p.id AND ac.agent_type = ? "
            "WHERE p.id = ?",
            (AGENT_TYPE, project_id),
        ).fetchone()
        if not row:
            return DEFAULT_MODEL, DEFAULT_TEMPERATURE, "", True, DEFAULT_MAX_TOKENS

        model_name = str((row["cfg_model"] or "").strip() or (row["model_main"] or DEFAULT_MODEL))
        cfg_temp = row["cfg_temp"]
        temperature = float(cfg_temp) if cfg_temp is not None and float(cfg_temp) >= 0 else DEFAULT_TEMPERATURE
        prompt_override = str((row["cfg_prompt"] or "")).strip()
        enabled_raw = row["cfg_enabled"]
        enabled = bool(enabled_raw) if enabled_raw is not None else True
        max_tokens = _normalize_max_tokens(row["cfg_max_tokens"], DEFAULT_MAX_TOKENS)
        return model_name, temperature, prompt_override, enabled, max_tokens


@router.post("/extract", response_model=NERResponse)
async def extract_entities(req: NERRequest):
    if not req.text.strip():
        return NERResponse(entities=[])

    agent_router._init_services()
    llm = agent_router._llm
    if llm is None:
        raise HTTPException(status_code=500, detail="模型服务未初始化")

    model_name, temperature, prompt_override, enabled, max_tokens = _load_runtime_config(req.project_id)
    if not enabled:
        raise HTTPException(status_code=403, detail="NER 功能已在项目设置中禁用")

    # 1. 抓取当前项目的已知设定名称 (用于辅助 prompt 或事后对比)
    known_chars = {}
    known_world = {}
    with get_db() as db:
        chars = db.execute("SELECT id, name, category, identity FROM characters WHERE project_id = ?", (req.project_id,)).fetchall()
        for c in chars:
            known_chars[c["name"]] = {"id": c["id"], "desc": f"{c['category']} - {c['identity']}", "type": "character"}

        words = db.execute("SELECT id, title, category, content FROM worldbuilding WHERE project_id = ?", (req.project_id,)).fetchall()
        for w in words:
            known_world[w["title"]] = {"id": w["id"], "desc": f"{w['category']} - {w['content'][:50]}", "type": "worldbuilding"}

    known_names = list(known_chars.keys()) + list(known_world.keys())
    known_names_str = ", ".join(known_names) if known_names else "无"

    # 2. 调用大模型进行实体提取
    default_system_prompt = NER_EXTRACTOR_SYSTEM_PROMPT
    system_prompt = prompt_override or default_system_prompt

    user_prompt = f"""
项目已知的一些设定和人物参考（如果文本中出现，请尽量对齐名称）：
[{known_names_str}]

需要分析的段落：
{req.text}
"""

    try:
        raw_resp = await llm.chat(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            temperature=min(max(temperature, 0.0), 1.0),
            max_tokens=max_tokens
        )

        # 尝试清理非 json 前缀/后缀
        raw_resp = raw_resp.strip()
        if raw_resp.startswith("```json"):
            raw_resp = raw_resp[7:]
        if raw_resp.startswith("```"):
            raw_resp = raw_resp[3:]
        if raw_resp.endswith("```"):
            raw_resp = raw_resp[:-3]

        extracted_data = json.loads(raw_resp)

        if not isinstance(extracted_data, list):
            extracted_data = []

        result_entities = []
        for item in extracted_data:
            name = item.get("name", "").strip()
            cat = item.get("category", "unknown").lower()
            desc = item.get("context", "")

            if not name:
                continue

            is_known = False
            db_id = None
            final_desc = desc

            # 判断是否已知
            if name in known_chars:
                is_known = True
                db_id = known_chars[name]["id"]
                final_desc = known_chars[name]["desc"]
                cat = "character"
            elif name in known_world:
                is_known = True
                db_id = known_world[name]["id"]
                final_desc = known_world[name]["desc"]
                cat = "worldbuilding"

            result_entities.append(NEREntity(
                name=name,
                category=cat,
                is_known=is_known,
                description=final_desc,
                db_id=db_id
            ))

        return NERResponse(entities=result_entities)

    except Exception as e:
        print(f"[NER Error] Failed to parse or call LLM: {e}")
        # 如果解析失败，安全返回空列表
        return NERResponse(entities=[])
