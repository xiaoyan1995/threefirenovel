import json
import re
from typing import List

from fastapi import APIRouter
from pydantic import BaseModel

from db import get_db
from agents import router as agent_router
from agents.default_prompts import CONFLICT_REVIEW_SYSTEM_PROMPT

router = APIRouter()
AGENT_TYPE = "conflict_reviewer"
DEFAULT_MODEL = "claude-sonnet-4"
DEFAULT_TEMPERATURE = 0.2
DEFAULT_MAX_TOKENS = 1500

class ConflictRequest(BaseModel):
    project_id: str
    text: str

class ConflictItem(BaseModel):
    type: str # logic, character, worldbuilding, chronology
    quote: str
    description: str
    suggestion: str

class ConflictResponse(BaseModel):
    conflicts: List[ConflictItem]
    summary: str


def _clip(text: str, limit: int) -> str:
    s = (text or "").strip()
    if len(s) <= limit:
        return s
    return s[:limit] + "..."


def _extract_json(raw: str) -> dict:
    text = (raw or "").strip()
    if not text:
        return {}

    # 先尝试去掉 markdown fence
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)

    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass

    # 兜底：抽取第一个 JSON 对象
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(0))
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        return {}
    return {}


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


def _load_review_context(project_id: str) -> str:
    chunks: list[str] = []

    with get_db() as db:
        bible = db.execute(
            "SELECT version, content FROM story_bibles WHERE project_id = ? "
            "ORDER BY version DESC LIMIT 1",
            (project_id,),
        ).fetchone()
        if bible:
            chunks.append(
                f"【小说圣经 v{bible['version']}（硬约束）】\n{_clip(str(bible['content']), 4000)}\n"
            )

        chars = db.execute(
            "SELECT name, category, gender, age, identity, personality, motivation "
            "FROM characters WHERE project_id = ? ORDER BY created_at ASC LIMIT 40",
            (project_id,),
        ).fetchall()
        if chars:
            rows = []
            for c in chars:
                tags = [
                    str(c["category"] or "").strip(),
                    str(c["gender"] or "").strip(),
                    str(c["age"] or "").strip(),
                ]
                tags_text = "/".join([t for t in tags if t])
                rows.append(
                    f"- {c['name']}（{tags_text or '未分类'}）"
                    f" | 身份:{_clip(c['identity'] or '', 80)}"
                    f" | 性格:{_clip(c['personality'] or '', 60)}"
                    f" | 动机:{_clip(c['motivation'] or '', 60)}"
                )
            chunks.append("【角色设定】\n" + "\n".join(rows) + "\n")

        world = db.execute(
            "SELECT title, category, content FROM worldbuilding "
            "WHERE project_id = ? ORDER BY created_at ASC LIMIT 40",
            (project_id,),
        ).fetchall()
        if world:
            rows = [f"- {w['title']}（{w['category']}）：{_clip(w['content'] or '', 120)}" for w in world]
            chunks.append("【世界观设定】\n" + "\n".join(rows) + "\n")

        foreshadow = db.execute(
            "SELECT name, description, status FROM foreshadowing "
            "WHERE project_id = ? ORDER BY created_at ASC LIMIT 40",
            (project_id,),
        ).fetchall()
        if foreshadow:
            rows = [f"- {f['name']}（{f['status']}）：{_clip(f['description'] or '', 120)}" for f in foreshadow]
            chunks.append("【伏笔与线索】\n" + "\n".join(rows) + "\n")

        outlines = db.execute(
            "SELECT phase, title, content FROM outlines "
            "WHERE project_id = ? ORDER BY phase_order ASC LIMIT 12",
            (project_id,),
        ).fetchall()
        if outlines:
            rows = [f"- [{o['phase']}] {o['title']}：{_clip(o['content'] or '', 120)}" for o in outlines]
            chunks.append("【大纲锚点】\n" + "\n".join(rows) + "\n")

    return "\n".join(chunks).strip() or "（该项目暂无可用设定）"


@router.post("/check", response_model=ConflictResponse)
async def check_conflicts(req: ConflictRequest):
    if not req.text.strip():
        return ConflictResponse(conflicts=[], summary="文本为空，无需检查。")

    agent_router._init_services()
    llm = agent_router._llm
    if llm is None:
        return ConflictResponse(conflicts=[], summary="模型服务未初始化。")
    model_name, temperature, prompt_override, enabled, max_tokens = _load_runtime_config(req.project_id)
    if not enabled:
        return ConflictResponse(conflicts=[], summary="冲突审查已在项目设置中禁用。")
    context_text = _load_review_context(req.project_id)

    system_prompt = prompt_override or CONFLICT_REVIEW_SYSTEM_PROMPT

    user_prompt = f"""【项目设定档案】
{context_text}

【待审查文本】
{_clip(req.text, 9000)}

请开始审查，并按要求输出 JSON。"""

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
        parsed_data = _extract_json(raw_resp)
        summary = str(parsed_data.get("summary") or "逻辑审查完成。")
        conflicts_raw = parsed_data.get("conflicts", [])
        if not isinstance(conflicts_raw, list):
            conflicts_raw = []

        result_conflicts = []
        for c in conflicts_raw:
            if not isinstance(c, dict):
                continue
            c_type = str(c.get("type", "logic")).strip().lower()
            if c_type not in {"logic", "character", "worldbuilding", "chronology"}:
                c_type = "logic"
            result_conflicts.append(ConflictItem(
                type=c_type,
                quote=_clip(str(c.get("quote", "未摘抄")), 220),
                description=_clip(str(c.get("description", "无描述")), 700),
                suggestion=_clip(str(c.get("suggestion", "无建议")), 700),
            ))

        return ConflictResponse(summary=summary, conflicts=result_conflicts)

    except Exception as e:
        print(f"[Conflict Check Error] {e}")
        return ConflictResponse(summary="审查服务调用失败或返回格式异常。", conflicts=[])
