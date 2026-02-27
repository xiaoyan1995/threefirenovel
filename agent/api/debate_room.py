import asyncio
import json
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional

from db import get_db
from agents import router as agent_router
from agents.default_prompts import (
    DEBATE_ROOM_SYSTEM_PROMPT,
    DEBATE_ROOM_ROLE_PROMPTS,
    DEBATE_ROOM_DIRECTOR_SYSTEM_PROMPT,
)

router = APIRouter()
AGENT_TYPE = "debate_room"
DEFAULT_MODEL = "claude-sonnet-4"
DEFAULT_TEMPERATURE = 0.7
DEFAULT_MAX_TOKENS = 600

class DebateRequest(BaseModel):
    project_id: str
    topic: str
    chapter_id: Optional[str] = None


def _normalize_max_tokens(value, default_value: int) -> int:
    try:
        parsed = int(float(value))
    except Exception:
        parsed = int(default_value)
    if parsed <= 0:
        parsed = int(default_value)
    return max(256, min(12000, parsed))


def _load_runtime_config(project_id: str) -> tuple[str, str, float, str, bool, int]:
    with get_db() as db:
        row = db.execute(
            "SELECT p.model_main, p.model_secondary, ac.model AS cfg_model, "
            "ac.temperature AS cfg_temp, ac.system_prompt AS cfg_prompt, ac.enabled AS cfg_enabled, "
            "ac.max_tokens AS cfg_max_tokens "
            "FROM projects p "
            "LEFT JOIN agent_configs ac "
            "ON ac.project_id = p.id AND ac.agent_type = ? "
            "WHERE p.id = ?",
            (AGENT_TYPE, project_id),
        ).fetchone()
        if not row:
            return DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_TEMPERATURE, "", True, DEFAULT_MAX_TOKENS
        cfg_model = str((row["cfg_model"] or "")).strip()
        if cfg_model:
            discuss_model = cfg_model
            director_model = cfg_model
        else:
            discuss_model = str(row["model_main"] or DEFAULT_MODEL)
            director_model = str(row["model_secondary"] or discuss_model)
        cfg_temp = row["cfg_temp"]
        temperature = float(cfg_temp) if cfg_temp is not None and float(cfg_temp) >= 0 else DEFAULT_TEMPERATURE
        prompt_override = str((row["cfg_prompt"] or "")).strip()
        enabled_raw = row["cfg_enabled"]
        enabled = bool(enabled_raw) if enabled_raw is not None else True
        max_tokens = _normalize_max_tokens(row["cfg_max_tokens"], DEFAULT_MAX_TOKENS)
        return discuss_model, director_model, temperature, prompt_override, enabled, max_tokens

async def debate_generator(project_id: str, topic: str):
    agent_router._init_services()
    llm = agent_router._llm
    if llm is None:
        yield f"data: {json.dumps({'event': 'error', 'agent': 'system', 'text': '模型服务未初始化'})}\n\n"
        return
    main_model, secondary_model, temperature, prompt_override, enabled, max_tokens = _load_runtime_config(project_id)
    if not enabled:
        yield f"data: {json.dumps({'event': 'error', 'agent': 'system', 'text': '剧本围读已在项目设置中禁用'})}\n\n"
        return
    role_max_tokens = max(200, min(6000, int(max_tokens * 0.5)))
    director_max_tokens = max(300, min(9000, max_tokens))
    role_base_prompt = prompt_override or DEBATE_ROOM_SYSTEM_PROMPT
    director_base_prompt = prompt_override or DEBATE_ROOM_DIRECTOR_SYSTEM_PROMPT

    # 1. 简要查一下项目背景上下文 (世界观与人物) 给 Prompt
    ctx = ""
    with get_db() as db:
        cnt = db.execute("SELECT COUNT(*) as c FROM characters WHERE project_id = ?", (project_id,)).fetchone()
        if cnt and cnt["c"] > 0:
            ctx += f"当前项目已有 {cnt['c']} 个角色设定。"

    # Helper function to stream a specific agent's response
    async def run_agent(agent_id, name, role_prompt, main_topic):
        # 1. 发送思考状态
        yield f"data: {json.dumps({'event': 'agent_start', 'agent': agent_id, 'name': name})}\n\n"
        await asyncio.sleep(0.5)

        system_msg = (
            f"{role_base_prompt}\n\n"
            f"你当前扮演角色：【{name}】。\n"
            f"{ctx}\n"
            f"角色职责：{role_prompt}\n"
            "输出要求：100-200字；先指出关键问题，再给可执行改法；不说套话。"
        )
        
        try:
            full_reply = ""
            async for chunk in await llm.chat_stream(
                model=main_model,
                messages=[
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": f"本次推演话题：{main_topic}"}
                ],
                temperature=min(max(temperature, 0.0), 1.0),
                max_tokens=role_max_tokens
            ):
                if chunk:
                    full_reply += chunk
                    # Send token chunk
                    yield f"data: {json.dumps({'event': 'token', 'agent': agent_id, 'text': chunk})}\n\n"
            
            # Agent finished
            yield f"data: {json.dumps({'event': 'agent_done', 'agent': agent_id})}\n\n"
            yield full_reply
        except Exception as e:
            yield f"data: {json.dumps({'event': 'error', 'agent': agent_id, 'text': str(e)})}\n\n"
            yield ""

    # Phase 1: 3 Agents parallel or sequential
    # For a better visual effect in UI, we'll do it sequentially but we could do parallel.
    # We will do sequential here to make it easier to read for the user, like a real chat.
    
    yield f"data: {json.dumps({'event': 'system', 'text': '剧本围读会议开始，各 Agent 就位...'})}\n\n"
    await asyncio.sleep(1)

    r1 = ""
    async for chunk in run_agent(
        "reader",
        "挑剔的读者",
        DEBATE_ROOM_ROLE_PROMPTS.get("reader", "聚焦读者体验、雷点与爽点。"),
        topic,
    ):
        if isinstance(chunk, str) and chunk.startswith("data:"):
            yield chunk
        elif chunk and not chunk.startswith("data:"):
            r1 = chunk # Capture final reply

    await asyncio.sleep(1)
            
    r2 = ""
    async for chunk in run_agent(
        "villain",
        "反派主脑",
        DEBATE_ROOM_ROLE_PROMPTS.get("villain", "聚焦反派策略、压迫升级与代价。"),
        topic,
    ):
        if isinstance(chunk, str) and chunk.startswith("data:"):
            yield chunk
        elif chunk and not chunk.startswith("data:"):
            r2 = chunk

    await asyncio.sleep(1)

    r3 = ""
    async for chunk in run_agent(
        "architect",
        "世界观架构师",
        DEBATE_ROOM_ROLE_PROMPTS.get("architect", "聚焦设定一致性、规则边界与伏笔回收。"),
        topic,
    ):
        if isinstance(chunk, str) and chunk.startswith("data:"):
            yield chunk
        elif chunk and not chunk.startswith("data:"):
            r3 = chunk

    await asyncio.sleep(1)

    # Phase 2: Director synthesizes
    yield f"data: {json.dumps({'event': 'agent_start', 'agent': 'director', 'name': '主编导演'})}\n\n"
    await asyncio.sleep(0.5)
    
    dir_sys = (
        f"{director_base_prompt}\n\n"
        f"{ctx}\n"
        "请基于三位意见输出最终【剧情落地方案】。"
    )
    dir_user = f"推演话题：{topic}\n\n读者意见：{r1}\n反派意见：{r2}\n架构师意见：{r3}"

    dir_reply = ""
    try:
        async for chunk in await llm.chat_stream(
            model=secondary_model,
            messages=[
                {"role": "system", "content": dir_sys},
                {"role": "user", "content": dir_user}
            ],
            temperature=min(max(temperature, 0.0), 1.0),
            max_tokens=director_max_tokens
        ):
            if chunk:
                dir_reply += chunk
                yield f"data: {json.dumps({'event': 'token', 'agent': 'director', 'text': chunk})}\n\n"
        
        yield f"data: {json.dumps({'event': 'agent_done', 'agent': 'director'})}\n\n"
    except Exception as e:
         yield f"data: {json.dumps({'event': 'error', 'agent': 'director', 'text': str(e)})}\n\n"

    yield f"data: {json.dumps({'event': 'system', 'text': '围读会议结束'})}\n\n"


@router.post("/start")
async def start_debate(req: DebateRequest):
    return StreamingResponse(
        debate_generator(req.project_id, req.topic),
        media_type="text/event-stream"
    )
