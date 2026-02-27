import json
import re
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional

from db import get_db
from agents import router as agent_router
from agents.default_prompts import BUTTERFLY_SIMULATOR_SYSTEM_PROMPT

router = APIRouter()
AGENT_TYPE = "butterfly_simulator"
DEFAULT_MODEL = "claude-sonnet-4"
DEFAULT_TEMPERATURE = 0.3
DEFAULT_MAX_TOKENS = 1500

class ButterflyRequest(BaseModel):
    project_id: str
    supposition: str

class ImpactNode(BaseModel):
    chapter_id: str
    chapter_num: Optional[int] = None
    chapter_title: str
    severity: str # high, medium, low
    reason: str
    suggestion: str

class ButterflyResponse(BaseModel):
    impacts: List[ImpactNode]
    summary: str


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
        temperature = DEFAULT_TEMPERATURE
        if cfg_temp is not None:
            try:
                parsed_temp = float(cfg_temp)
                if parsed_temp >= 0:
                    temperature = parsed_temp
            except Exception:
                temperature = DEFAULT_TEMPERATURE
        prompt_override = str((row["cfg_prompt"] or "")).strip()
        enabled_raw = row["cfg_enabled"]
        enabled = bool(enabled_raw) if enabled_raw is not None else True
        max_tokens = _normalize_max_tokens(row["cfg_max_tokens"], DEFAULT_MAX_TOKENS)
        return model_name, temperature, prompt_override, enabled, max_tokens


@router.post("/simulate", response_model=ButterflyResponse)
async def simulate_butterfly_effect(req: ButterflyRequest):
    if not req.supposition.strip():
        raise HTTPException(status_code=400, detail="假设内容不能为空")

    agent_router._init_services()
    llm = agent_router._llm
    if llm is None:
        raise HTTPException(status_code=500, detail="模型服务未初始化")
    model_name, temperature, prompt_override, enabled, max_tokens = _load_runtime_config(req.project_id)
    if not enabled:
        raise HTTPException(status_code=403, detail="蝴蝶效应推演已在项目设置中禁用")

    # 1. 获取所有章节及其摘要 (模拟全局时间轴)
    # 对于短片/网文，通常从大纲序列中读取。如果字数过多应当利用 graph 抽取。在此我们直接取所有章节的 summary 或 title 进行序列化。
    chapter_logs = []
    chapter_num_by_id: dict[str, int] = {}
    chapter_title_by_id: dict[str, str] = {}
    chapter_num_by_title: dict[str, int] = {}

    def _normalize_title(text: str) -> str:
        return re.sub(r"\s+", "", str(text or ""))

    with get_db() as db:
        rows = db.execute(
            "SELECT id, chapter_num, title, synopsis FROM chapters WHERE project_id = ? ORDER BY chapter_num ASC, sort_order ASC",
            (req.project_id,),
        ).fetchall()
        for i, r in enumerate(rows):
            desc = r['synopsis'] if r['synopsis'] else "(未填写摘要)"
            chapter_id = str(r["id"])
            chapter_title = str(r["title"] or "").strip() or "未命名"
            chapter_num_raw = r["chapter_num"]
            try:
                chapter_num = int(chapter_num_raw) if chapter_num_raw is not None else (i + 1)
            except Exception:
                chapter_num = i + 1
            if chapter_num <= 0:
                chapter_num = i + 1

            chapter_logs.append({
                "id": chapter_id,
                "chapter_num": chapter_num,
                "title": chapter_title,
                "overview": desc,
                "order": i + 1
            })
            chapter_num_by_id[chapter_id] = chapter_num
            chapter_title_by_id[chapter_id] = chapter_title
            normalized_title = _normalize_title(chapter_title)
            if normalized_title and normalized_title not in chapter_num_by_title:
                chapter_num_by_title[normalized_title] = chapter_num

    if not chapter_logs:
        return ButterflyResponse(summary="该项目暂无大纲章节可作为因果推演的基础。请先在章节管理中建立脉络。", impacts=[])

    # 序列化为给大模型看的 timeline
    timeline_str = "【当前剧情时间轴】：\n"
    for c in chapter_logs:
        timeline_str += f"- 第{c['chapter_num']}章《{c['title']}》 (ID: {c['id']}): {c['overview']}\n"

    # 2. 调用大模型推演
    default_system_prompt = BUTTERFLY_SIMULATOR_SYSTEM_PROMPT
    system_prompt = prompt_override or default_system_prompt

    user_prompt = f"""
{timeline_str}

-------------------
作者试图在这个时间轴的某个节点强行插入以下【历史修补/剧情变动假设】：
【{req.supposition}】

请推演这只蝴蝶煽动翅膀后，将摧毁以上哪些原定的大纲节点？
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
        
        # 清理
        raw_resp = raw_resp.strip()
        if raw_resp.startswith("```json"):
            raw_resp = raw_resp[7:]
        if raw_resp.startswith("```"):
            raw_resp = raw_resp[3:]
        if raw_resp.endswith("```"):
            raw_resp = raw_resp[:-3]
            
        parsed_data = json.loads(raw_resp)
        
        summary = parsed_data.get("summary", "推演完成。")
        impacts_raw = parsed_data.get("impacts", [])
        
        result_impacts = []
        for imp in impacts_raw:
            chapter_id = str(imp.get("chapter_id", "")).strip()
            chapter_title = str(imp.get("chapter_title", "未知") or "未知").strip()

            chapter_num: Optional[int] = None
            chapter_num_raw = imp.get("chapter_num")
            if chapter_num_raw is not None:
                try:
                    parsed_num = int(chapter_num_raw)
                    if parsed_num > 0:
                        chapter_num = parsed_num
                except Exception:
                    chapter_num = None

            if chapter_num is None and chapter_id:
                mapped_num = chapter_num_by_id.get(chapter_id)
                if isinstance(mapped_num, int) and mapped_num > 0:
                    chapter_num = mapped_num

            if chapter_num is None and chapter_title:
                mapped_num = chapter_num_by_title.get(_normalize_title(chapter_title))
                if isinstance(mapped_num, int) and mapped_num > 0:
                    chapter_num = mapped_num

            if chapter_num is None and chapter_title:
                m = re.search(r"第\s*(\d+)\s*章", chapter_title)
                if m:
                    try:
                        parsed_num = int(m.group(1))
                        if parsed_num > 0:
                            chapter_num = parsed_num
                    except Exception:
                        chapter_num = None

            if chapter_id and chapter_id in chapter_title_by_id:
                # 优先使用数据库标题，避免模型误写标题。
                chapter_title = chapter_title_by_id[chapter_id]

            result_impacts.append(ImpactNode(
                chapter_id=chapter_id,
                chapter_num=chapter_num,
                chapter_title=chapter_title,
                severity=str(imp.get("severity", "medium")),
                reason=str(imp.get("reason", "无")),
                suggestion=str(imp.get("suggestion", "无"))
            ))
            
        return ButterflyResponse(summary=summary, impacts=result_impacts)

    except Exception as e:
        print(f"[Butterfly Check Error]: {e}")
        return ButterflyResponse(summary="因果推演引擎暂时过热，服务不可用。", impacts=[])
