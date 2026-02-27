"""写作助手聊天接口：/api/agents/chat"""
import logging
import re
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Literal, Optional

from db import get_db
from agents import router as agent_router
from agents.default_prompts import WRITER_ASSISTANT_CHAT_SYSTEM_PROMPT

router = APIRouter()
AGENT_TYPE = "writer_assistant"
logger = logging.getLogger(__name__)


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    project_id: str
    message: str
    chapter_id: Optional[str] = None
    history: Optional[list[ChatTurn]] = None


class ChatResponse(BaseModel):
    reply: str
    resolved_model: str = ""


def _clip(text: str, limit: int) -> str:
    s = (text or "").strip()
    if len(s) <= limit:
        return s
    return s[:limit] + "..."


def _load_chat_context(project_id: str, chapter_id: Optional[str]) -> str:
    parts: list[str] = []
    with get_db() as db:
        proj = db.execute(
            "SELECT name, genre, description FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()
        if proj:
            parts.append(f"【项目】{proj['name']} | 题材:{proj['genre']}")
            if proj["description"]:
                parts.append(f"项目描述：{_clip(proj['description'], 160)}")

        if chapter_id:
            chapter = db.execute(
                "SELECT chapter_num, title, synopsis FROM chapters WHERE id = ? AND project_id = ?",
                (chapter_id, project_id),
            ).fetchone()
            if chapter:
                parts.append(f"【当前章节】第{chapter['chapter_num']}章《{chapter['title']}》")
                if chapter["synopsis"]:
                    parts.append(f"章节摘要：{_clip(chapter['synopsis'], 200)}")

                beats = db.execute(
                    "SELECT order_index, content, status FROM chapter_beats "
                    "WHERE chapter_id = ? ORDER BY order_index ASC LIMIT 8",
                    (chapter_id,),
                ).fetchall()
                if beats:
                    parts.append("【本章节拍】")
                    for b in beats:
                        parts.append(f"- ({b['order_index']}) [{b['status']}] {_clip(b['content'], 100)}")

                recent = db.execute(
                    "SELECT content FROM chapter_paragraphs WHERE chapter_id = ? "
                    "ORDER BY para_index DESC LIMIT 4",
                    (chapter_id,),
                ).fetchall()
                if recent:
                    parts.append("【最近正文片段】")
                    for r in reversed(recent):
                        parts.append(_clip(r["content"], 220))

        chars = db.execute(
            "SELECT name, category, gender, age, identity, personality, motivation FROM characters "
            "WHERE project_id = ? ORDER BY created_at ASC LIMIT 10",
            (project_id,),
        ).fetchall()
        if chars:
            parts.append("【角色】")
            for c in chars:
                tags = [
                    str(c["category"] or "").strip(),
                    str(c["gender"] or "").strip(),
                    str(c["age"] or "").strip(),
                ]
                tags_text = "/".join([t for t in tags if t])
                line = f"- {c['name']}({tags_text or '未分类'}): {_clip(c['identity'] or '', 60)}"
                if c["personality"]:
                    line += f" | 性格:{_clip(c['personality'], 36)}"
                if c["motivation"]:
                    line += f" | 动机:{_clip(c['motivation'], 36)}"
                parts.append(line)

        world = db.execute(
            "SELECT title, category, content FROM worldbuilding WHERE project_id = ? ORDER BY created_at ASC LIMIT 8",
            (project_id,),
        ).fetchall()
        if world:
            parts.append("【世界观】")
            for w in world:
                parts.append(f"- {w['title']}({w['category']}): {_clip(w['content'], 90)}")

        fs = db.execute(
            "SELECT name, description, status FROM foreshadowing "
            "WHERE project_id = ? AND status != 'resolved' ORDER BY created_at ASC LIMIT 8",
            (project_id,),
        ).fetchall()
        if fs:
            parts.append("【未回收伏笔】")
            for f in fs:
                parts.append(f"- {f['name']}[{f['status']}]: {_clip(f['description'], 90)}")

    return "\n".join(parts)


def _normalize_max_tokens(value, default_value: int) -> int:
    try:
        parsed = int(float(value))
    except Exception:
        parsed = int(default_value)
    if parsed <= 0:
        parsed = int(default_value)
    return max(256, min(12000, parsed))


def _normalize_history(history: Optional[list[ChatTurn]], max_turns: int = 10, max_chars: int = 1200) -> list[dict]:
    if not history:
        return []
    result: list[dict] = []
    for h in history[-max_turns:]:
        content = _clip(h.content or "", max_chars)
        if not content:
            continue
        result.append({"role": h.role, "content": content})
    return result


def _load_project_runtime(project_id: str) -> tuple[str, float, str, bool, int]:
    default_model = "claude-sonnet-4"
    default_temp = 0.7
    default_max_tokens = 1200
    with get_db() as db:
        row = db.execute(
            "SELECT p.model_main, p.temperature, ac.model AS cfg_model, ac.temperature AS cfg_temp, "
            "ac.system_prompt AS cfg_prompt, ac.enabled AS cfg_enabled, ac.max_tokens AS cfg_max_tokens "
            "FROM projects p "
            "LEFT JOIN agent_configs ac "
            "ON ac.project_id = p.id AND ac.agent_type = ? "
            "WHERE p.id = ?",
            (AGENT_TYPE, project_id),
        ).fetchone()
        if row:
            project_model = str((row["model_main"] or "")).strip() or default_model
            project_temp = float(row["temperature"]) if row["temperature"] is not None else default_temp

            cfg_model = str((row["cfg_model"] or "")).strip()
            cfg_temp = row["cfg_temp"]
            prompt_override = str((row["cfg_prompt"] or "")).strip()
            enabled_raw = row["cfg_enabled"]
            enabled = bool(enabled_raw) if enabled_raw is not None else True
            max_tokens = _normalize_max_tokens(row["cfg_max_tokens"], default_max_tokens)

            model = cfg_model or project_model
            logger.info(
                "[AgentChat] cfg_model=%r project_model=%r → model=%r",
                cfg_model, project_model, model,
            )
            temp = project_temp
            if cfg_temp is not None:
                try:
                    parsed = float(cfg_temp)
                    if parsed >= 0:
                        temp = parsed
                except Exception:
                    pass
            return model, temp, prompt_override, enabled, max_tokens
    return default_model, default_temp, "", True, default_max_tokens


def _build_scope_guard(message: str) -> str:
    text = str(message or "").strip()
    if not text:
        return ""
    rewrite_intent = re.search(r"(改写|润色|重写|修改|优化)", text)
    if not rewrite_intent:
        return ""

    local_scope = re.search(
        r"(前\s*[一二两三四五六七八九十\d]+\s*段|第\s*[一二两三四五六七八九十\d]+\s*段|这\s*[一二两三四五六七八九十\d]*\s*段|局部|片段|选中|只改|仅改)",
        text,
    )
    if local_scope:
        return (
            "局部改写硬约束（必须执行）：\n"
            "1) 用户指定“前N段/第N段/某片段”时，只输出该范围的改写正文；\n"
            "2) 禁止改写范围外扩写、续写、总结或解释；\n"
            "3) 段落数量与用户指定一致（如“前两段”就只返回两段）。"
        )
    return (
        "改写任务约束：优先给最小必要改稿，避免无关扩写；"
        "除非用户明确要求整章重写，否则不要输出额外段落。"
    )


def _is_rewrite_intent(text: str) -> bool:
    return bool(re.search(r"(改写|润色|重写|修改|优化)", str(text or "")))


def _is_local_rewrite_request(text: str) -> bool:
    return bool(
        re.search(
            r"(前\s*[一二两三四五六七八九十\d]+\s*段|第\s*[一二两三四五六七八九十\d]+\s*段|这\s*[一二两三四五六七八九十\d]*\s*段|局部|片段|选中|只改|仅改)",
            str(text or ""),
        )
    )


def _is_full_rewrite_request(text: str) -> bool:
    return bool(
        re.search(
            r"(全文|全章|整章|整篇|通篇|整体|完整)(?:\s*(改写|润色|重写|修改|优化)|.*(?:改写|润色|重写|修改|优化))",
            str(text or ""),
        )
    )


def _build_full_rewrite_guard() -> str:
    return (
        "全文改写输出约束（必须执行）：\n"
        "1) 只输出优化后的正文，不要标题、章名、注释、解释；\n"
        "2) 不要输出 Markdown 符号（如 #、*、```）；\n"
        "3) 禁止用“以下是优化后正文”等引导语；\n"
        "4) 一次输出完整文本，不要省略号占位。"
    )


def _calc_effective_max_tokens(*, base_tokens: int, message_text: str, is_local_rewrite: bool, is_full_rewrite: bool) -> int:
    if is_local_rewrite:
        return min(base_tokens, 700)
    if not is_full_rewrite:
        return base_tokens
    text_len = len(str(message_text or ""))
    if text_len >= 6000:
        floor = 5600
    elif text_len >= 3000:
        floor = 4200
    elif text_len >= 1500:
        floor = 3200
    else:
        floor = 2600
    return max(256, min(12000, max(base_tokens, floor)))


def _looks_like_truncated_reply(text: str, max_tokens: int, is_full_rewrite: bool) -> bool:
    if not is_full_rewrite:
        return False
    body = str(text or "").rstrip()
    if len(body) < 300:
        return False
    if len(body) < int(max_tokens * 0.72):
        return False
    if re.search(r"[。！？.!?…」』”\"']\s*$", body):
        return False
    return True


def _merge_text_with_overlap(head: str, tail: str) -> str:
    a = str(head or "")
    b = str(tail or "")
    if not b:
        return a
    max_overlap = min(len(a), len(b), 180)
    overlap = 0
    for size in range(max_overlap, 0, -1):
        if a[-size:] == b[:size]:
            overlap = size
            break
    return (a + b[overlap:]).strip()


@router.post("/chat", response_model=ChatResponse)
async def chat_with_writer_assistant(req: ChatRequest):
    agent_router._init_services()
    if not req.message.strip():
        return ChatResponse(reply="请先输入你的问题或写作诉求。")
    llm = agent_router._llm
    if llm is None:
        return ChatResponse(reply="模型服务尚未初始化，请稍后重试。")

    model, temp, prompt_override, enabled, max_tokens = _load_project_runtime(req.project_id)
    if not enabled:
        return ChatResponse(reply="写作助手已在项目设置中禁用。", resolved_model=model)
    context_text = _load_chat_context(req.project_id, req.chapter_id)
    history_messages = _normalize_history(req.history)

    rag_text = ""
    chunk_manager = agent_router._chunk_manager
    if chunk_manager is not None:
        try:
            chunks = chunk_manager.search(
                project_id=req.project_id,
                query=req.message,
                top_k=6,
            )
            if chunks:
                lines = ["【相关记忆】"]
                for c in chunks[:5]:
                    src = c.get("metadata", {}).get("source_type", "?")
                    lines.append(f"- [{src}] {_clip(c.get('content', ''), 180)}")
                rag_text = "\n".join(lines)
        except Exception:
            rag_text = ""

    system_prompt = prompt_override or WRITER_ASSISTANT_CHAT_SYSTEM_PROMPT
    alignment_prompt = """
对齐规则（强制）：
1) 用户若提到“上面/刚才/这个”，必须结合历史消息理解指代；
2) 默认走“自然对话模式”，不要强制输出固定标签（如【判断】【行动】）；
3) 用户要求“改写/润色/续写/重写”时，优先直接给可用文本，分析最多3句；
4) 若目标不清晰，只问1个澄清问题，不输出长篇泛化建议。
""".strip()
    scope_guard_prompt = _build_scope_guard(req.message)
    is_rewrite = _is_rewrite_intent(req.message)
    is_local_rewrite = _is_local_rewrite_request(req.message)
    is_full_rewrite = _is_full_rewrite_request(req.message)
    full_rewrite_guard_prompt = _build_full_rewrite_guard() if (is_rewrite and is_full_rewrite) else ""

    context_blocks = []
    if context_text.strip():
        context_blocks.append(context_text)
    if rag_text.strip():
        context_blocks.append(rag_text)
    context_prompt = "\n\n".join(context_blocks).strip()

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "system", "content": alignment_prompt},
    ]
    if scope_guard_prompt:
        messages.append({"role": "system", "content": scope_guard_prompt})
    if full_rewrite_guard_prompt:
        messages.append({"role": "system", "content": full_rewrite_guard_prompt})
    if context_prompt:
        messages.append({"role": "system", "content": f"项目上下文（仅供参考，回答必须紧扣用户请求）：\n{context_prompt}"})
    messages.extend(history_messages)
    messages.append({"role": "user", "content": req.message.strip()})

    effective_max_tokens = _calc_effective_max_tokens(
        base_tokens=max_tokens,
        message_text=req.message,
        is_local_rewrite=is_local_rewrite,
        is_full_rewrite=is_full_rewrite,
    )

    reply = await llm.chat(
        model=model,
        messages=messages,
        temperature=min(max(temp, 0.2), 0.8),
        max_tokens=effective_max_tokens,
    )
    reply_text = (reply or "").strip()

    if _looks_like_truncated_reply(reply_text, effective_max_tokens, is_full_rewrite):
        try:
            continuation_messages = [
                {"role": "system", "content": system_prompt},
                {"role": "system", "content": "你上一条输出疑似被截断。请仅续写剩余正文，不要重复已输出部分，不要解释。"},
                {"role": "system", "content": _build_full_rewrite_guard()},
                {"role": "user", "content": f"原请求：{_clip(req.message.strip(), 2600)}\n\n已输出末尾：{_clip(reply_text[-600:], 600)}"},
            ]
            continuation = await llm.chat(
                model=model,
                messages=continuation_messages,
                temperature=min(max(temp, 0.2), 0.8),
                max_tokens=min(4800, max(1200, effective_max_tokens)),
            )
            continuation_text = (continuation or "").strip()
            if continuation_text:
                reply_text = _merge_text_with_overlap(reply_text, continuation_text)
        except Exception:
            logger.warning("Writer assistant continuation fallback failed", exc_info=True)

    return ChatResponse(reply=reply_text or "我已读取上下文，但暂时无法生成有效建议，请换一种提问方式。", resolved_model=model)
