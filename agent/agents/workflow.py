"""LangGraph多Agent工作流 - 小说创作编排引擎"""
import json
import logging
import re
import sqlite3
from typing import Optional, TypedDict

from langgraph.graph import END, StateGraph

from agents import prompts
from agents.llm import LLMClient
from agents.default_prompts import (
    CHAPTER_PLAN_JSON_SYSTEM_PROMPT,
    CHAPTER_SELF_CHECK_SYSTEM_PROMPT,
    CHAPTER_SYNOPSIS_SYSTEM_PROMPT,
)
from memory.chunk_manager import ChunkManager
from memory.epa_analyzer import EPAAnalyzer
from memory.meta_thinking import MetaThinking
from db import get_db_with_path

logger = logging.getLogger(__name__)


class NovelState(TypedDict):
    """工作流共享状态"""
    project_id: str
    agent_type: str
    model: str
    temperature: float
    user_message: str
    chapter_id: Optional[str]
    context_chunks: list[dict]
    draft: str
    review_result: dict
    final_output: str
    metadata: dict


PROMPT_MAP = {
    "outline_writer": prompts.OUTLINE_WRITER,
    "character_designer": prompts.CHARACTER_DESIGNER,
    "chapter_writer": prompts.CHAPTER_WRITER,
    "reviewer": prompts.REVIEWER,
    "editor": prompts.EDITOR,
}


def _load_agent_config(db_path: str, project_id: str, agent_type: str) -> dict | None:
    """从agent_configs表加载Agent独立配置"""
    if not db_path:
        return None
    try:
        with get_db_with_path(db_path) as db:
            row = db.execute(
                "SELECT model, temperature, system_prompt, max_tokens, enabled "
                "FROM agent_configs WHERE project_id = ? AND agent_type = ?",
                (project_id, agent_type),
            ).fetchone()
        if row:
            return dict(row)
    except Exception:
        logger.warning(
            "Failed to load agent config: project_id=%s agent_type=%s",
            project_id,
            agent_type,
            exc_info=True,
        )
    return None


def _clip(text: str, limit: int) -> str:
    s = (text or "").strip()
    if len(s) <= limit:
        return s
    return s[:limit] + "..."


def _normalize_foreshadow_action_text(text: str) -> str:
    t = str(text or "").strip()
    if not t:
        return ""
    t = re.sub(r"\s+", " ", t)
    return _clip(t, 260)


def _derive_foreshadow_name(action: str) -> str:
    # 优先取“对象+动作”的短语作为名称，避免整句入标题。
    s = re.sub(r"^[\-\d\.\)\(、\s]+", "", action or "").strip()
    s = re.split(r"[，,。；;：:]", s)[0].strip() if s else ""
    if not s:
        s = "AI建议伏笔"
    return _clip(s, 40)


def _is_resolve_action(action: str) -> bool:
    t = action or ""
    return any(k in t for k in ("回收", "兑现", "揭示", "揭开", "收束", "真相揭晓", "解谜"))


def _auto_sync_foreshadowing_from_plan(state: NovelState) -> None:
    if state.get("agent_type") != "chapter_writer":
        return
    project_id = state.get("project_id")
    chapter_id = state.get("chapter_id")
    db_path = state.get("metadata", {}).get("_db_path", "")
    if not project_id or not chapter_id or not db_path:
        return

    plan = (state.get("review_result", {}) or {}).get("pipeline", {})
    actions = []
    if isinstance(plan, dict):
        raw = plan.get("plan", {})
        if isinstance(raw, dict):
            arr = raw.get("foreshadowing_actions", [])
            if isinstance(arr, list):
                actions = [str(x or "").strip() for x in arr]
    actions = [_normalize_foreshadow_action_text(x) for x in actions if str(x or "").strip()]
    if not actions:
        return

    try:
        with get_db_with_path(db_path) as db:
            for action in actions[:4]:
                if len(action) < 6:
                    continue
                is_resolve = _is_resolve_action(action)
                status = "resolved" if is_resolve else "hinted"
                plant_chapter_id = None if is_resolve else chapter_id
                resolve_chapter_id = chapter_id if is_resolve else None
                plant_text = "" if is_resolve else action
                resolve_text = action if is_resolve else ""
                name = _derive_foreshadow_name(action)

                existed = db.execute(
                    "SELECT id FROM foreshadowing "
                    "WHERE project_id = ? AND description = ? "
                    "AND COALESCE(plant_chapter_id, '') = COALESCE(?, '') "
                    "AND COALESCE(resolve_chapter_id, '') = COALESCE(?, '') "
                    "LIMIT 1",
                    (project_id, action, plant_chapter_id, resolve_chapter_id),
                ).fetchone()
                if existed:
                    continue

                db.execute(
                    "INSERT INTO foreshadowing "
                    "(project_id, name, description, category, importance, status, "
                    "plant_chapter_id, resolve_chapter_id, plant_text, resolve_text) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        project_id,
                        name,
                        action,
                        "AI建议",
                        "中",
                        status,
                        plant_chapter_id,
                        resolve_chapter_id,
                        plant_text,
                        resolve_text,
                    ),
                )
    except Exception:
        logger.warning(
            "Failed to auto-sync foreshadowing actions: project_id=%s chapter_id=%s",
            project_id,
            chapter_id,
            exc_info=True,
        )


def _strip_code_fence(raw: str) -> str:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _parse_json_obj(raw: str, default: dict) -> dict:
    text = _strip_code_fence(raw)
    if not text:
        return default
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        logger.debug("Failed to parse JSON object from model output", exc_info=True)
    return default


def _format_context_chunks(chunks: list[dict], limit: int = 5) -> str:
    if not chunks:
        return ""
    lines = ["【相关记忆检索】"]
    for c in chunks[:limit]:
        source = c.get("metadata", {}).get("source_type", "?")
        lines.append(f"- [{source}] {_clip(c.get('content', ''), 280)}")
    return "\n".join(lines)


def _resolve_write_mode_hint(user_message: str) -> str:
    text = str(user_message or "")
    if "[MODE:FAST]" in text:
        return "fast"
    if "[MODE:QUALITY]" in text:
        return "quality"
    return "quality"


def _is_draft_only_hint(user_message: str) -> bool:
    text = str(user_message or "")
    return "[DRAFT_ONLY]" in text


def _extract_length_hint(user_message: str) -> dict:
    text = str(user_message or "")

    def _pick(pattern: str) -> Optional[int]:
        m = re.search(pattern, text, flags=re.IGNORECASE)
        if not m:
            return None
        try:
            return int(m.group(1))
        except Exception:
            return None

    def _clamp(v: Optional[int], lo: int = 200, hi: int = 30000) -> Optional[int]:
        if v is None:
            return None
        return max(lo, min(hi, int(v)))

    target = _clamp(_pick(r"\[(?:LEN_TARGET|TARGET_CHARS)\s*:\s*(\d{2,6})\]"))
    min_len = _clamp(_pick(r"\[(?:LEN_MIN|MIN_CHARS)\s*:\s*(\d{2,6})\]"))
    max_len = _clamp(_pick(r"\[(?:LEN_MAX|MAX_CHARS)\s*:\s*(\d{2,6})\]"))

    if target is None and min_len is None and max_len is None:
        return {}

    if target is None and min_len is not None and max_len is not None:
        target = int(round((min_len + max_len) / 2))

    if target is not None:
        if min_len is None:
            min_len = max(200, int(round(target * 0.85)))
        if max_len is None:
            max_len = max(min_len + 80, int(round(target * 1.15)))
    else:
        if min_len is None and max_len is not None:
            min_len = max(200, int(round(max_len * 0.6)))
        if max_len is None and min_len is not None:
            max_len = max(min_len + 80, int(round(min_len * 1.4)))

    if min_len is None:
        min_len = 800
    if max_len is None:
        max_len = max(min_len + 80, 1800)
    if min_len > max_len:
        min_len, max_len = max_len, min_len

    return {"target": target, "min": min_len, "max": max_len}


def _strip_write_mode_hint(user_message: str) -> str:
    text = str(user_message or "")
    text = text.replace("[MODE:FAST]", "").replace("[MODE:QUALITY]", "")
    text = text.replace("[DRAFT_ONLY]", "")
    text = re.sub(
        r"\[(?:LEN_TARGET|TARGET_CHARS|LEN_MIN|MIN_CHARS|LEN_MAX|MAX_CHARS)\s*:\s*\d{2,6}\]",
        "",
        text,
        flags=re.IGNORECASE,
    )
    return text.strip()


def _count_visible_chars(text: str) -> int:
    if not text:
        return 0
    return len(re.sub(r"\s+", "", str(text)))


def _truncate_to_max_visible_chars(text: str, max_len: int) -> str:
    raw = str(text or "").strip()
    if not raw or max_len <= 0:
        return raw
    if _count_visible_chars(raw) <= max_len:
        return raw

    visible = 0
    cut_idx = len(raw)
    for idx, ch in enumerate(raw):
        if not ch.isspace():
            visible += 1
        if visible >= max_len:
            cut_idx = idx + 1
            break

    clipped = raw[:cut_idx].rstrip()
    if not clipped:
        return clipped

    # 尽量截断到最近句末，避免硬腰斩语义。
    sentence_end = max(
        clipped.rfind("。"),
        clipped.rfind("！"),
        clipped.rfind("？"),
        clipped.rfind("!"),
        clipped.rfind("?"),
    )
    if sentence_end >= max(0, len(clipped) - 120):
        clipped = clipped[: sentence_end + 1].rstrip()
    return clipped


async def _fit_text_to_length_hint(
    *,
    llm: LLMClient,
    model: str,
    temperature: float,
    max_tokens: int,
    system_prompt: str,
    chapter_snapshot: str,
    user_message: str,
    text: str,
    length_hint: dict,
    write_mode: str = "quality",
) -> str:
    if not length_hint:
        return str(text or "").strip()

    target = int(length_hint.get("target") or 0)
    min_len = int(length_hint.get("min") or 0)
    max_len = int(length_hint.get("max") or 0)

    if min_len <= 0 and max_len <= 0:
        return str(text or "").strip()

    if target <= 0:
        target = min_len if min_len > 0 else max_len
    if min_len <= 0 and max_len > 0:
        min_len = max(200, int(round(max_len * 0.65)))
    if max_len <= 0 and min_len > 0:
        max_len = max(min_len + 80, int(round(min_len * 1.25)))
    if min_len > max_len:
        min_len, max_len = max_len, min_len

    current = str(text or "").strip()
    current_len = _count_visible_chars(current)
    logger.info(
        "[LengthFit] before=%s target=%s range=%s-%s",
        current_len,
        target,
        min_len,
        max_len,
    )

    # 太短：自动续写（最多2轮），尽量补到区间内。
    if current_len < min_len:
        for i in range(2):
            remain = max(120, target - current_len)
            continuation_prompt = f"""
{chapter_snapshot}

【用户请求】
{_clip(user_message, 260)}

【已写正文】
{current}

任务：从“已写正文”结尾自然续写，不要重复前文，不要重启场景，不要总结。
本次请补写约 {remain} 字，使最终总字数落在 {min_len}-{max_len} 字（目标约 {target} 字）。
只输出新增续写正文，不要解释，不要 markdown。
""".strip()
            try:
                addition = await llm.chat(
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": continuation_prompt},
                    ],
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
            except Exception:
                logger.warning("Length top-up generation failed", exc_info=True)
                break
            addition_text = str(addition or "").strip()
            if not addition_text:
                break
            current = f"{current}\n\n{addition_text}".strip() if current else addition_text
            current_len = _count_visible_chars(current)
            logger.info("[LengthFit] topup_round=%s len=%s", i + 1, current_len)
            if current_len >= min_len:
                break

    # 太长：quality/blend 模式避免二次“压缩改写”导致文风被抹平；
    # 仅在超量过大时做轻量截断。fast 模式保留压缩流程以优先命中字数。
    if current_len > max_len and write_mode != "fast":
        soft_overflow = max(180, int(round(max_len * 0.18)))
        if current_len <= max_len + soft_overflow:
            logger.info(
                "[LengthFit] quality_keep_overflow len=%s max=%s soft=%s",
                current_len,
                max_len,
                soft_overflow,
            )
            return current.strip()

        clip_to = max_len + soft_overflow
        current = _truncate_to_max_visible_chars(current, clip_to)
        current_len = _count_visible_chars(current)
        logger.warning(
            "[LengthFit] quality_soft_truncate applied len=%s clip_to=%s max=%s",
            current_len,
            clip_to,
            max_len,
        )

    # fast 模式下太长：先让模型压缩，仍超限则做保底截断。
    if current_len > max_len and write_mode == "fast":
        compress_prompt = f"""
{chapter_snapshot}

【用户请求】
{_clip(user_message, 260)}

请将下方正文压缩改写到 {min_len}-{max_len} 字（目标约 {target} 字）：
- 保留关键剧情节点、节拍顺序和人设一致性；
- 删除重复描写与冗余修饰，不新增剧情分支；
- 只输出改写后的正文，不要解释，不要 markdown。

【待压缩正文】
{current}
""".strip()
        try:
            compressed = await llm.chat(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": compress_prompt},
                ],
                temperature=min(max(temperature, 0.2), 0.8),
                max_tokens=max_tokens,
            )
            compressed_text = str(compressed or "").strip()
            if compressed_text:
                candidate_len = _count_visible_chars(compressed_text)
                logger.info("[LengthFit] compressed_len=%s", candidate_len)
                # 允许轻微浮动，避免过度硬裁。
                if candidate_len <= max_len + max(80, int(round(max_len * 0.08))):
                    current = compressed_text
                    current_len = candidate_len
        except Exception:
            logger.warning("Length compression generation failed", exc_info=True)

    if current_len > max_len and write_mode == "fast":
        current = _truncate_to_max_visible_chars(current, max_len)
        current_len = _count_visible_chars(current)
        logger.warning("[LengthFit] fallback_truncate applied len=%s max=%s", current_len, max_len)

    return current.strip()


def _load_active_profile_block(db: sqlite3.Connection, project_id: str) -> str:
    row = db.execute(
        "SELECT p.name, p.version, p.genre, p.profile_json, p.text_summary "
        "FROM project_profile_binding b "
        "JOIN knowledge_profiles p ON p.id = b.profile_id "
        "WHERE b.project_id = ? AND b.enabled = 1 "
        "ORDER BY p.updated_at DESC LIMIT 1",
        (project_id,),
    ).fetchone()
    if not row:
        return ""
    return (
        "【当前启用规则包】\n"
        f"- 名称：{row['name']} (v{row['version']})\n"
        f"- 题材：{row['genre'] or '未指定'}\n"
        f"- 摘要：{_clip(row['text_summary'] or '', 260)}\n"
        f"- 规则JSON：{_clip(row['profile_json'] or '{}', 1800)}"
    )


def _load_reference_blocks(db: sqlite3.Connection, project_id: str) -> list[str]:
    rows = db.execute(
        "SELECT title, reference_type, content FROM knowledge_sources "
        "WHERE project_id = ? AND enabled = 1 "
        "ORDER BY created_at DESC LIMIT 24",
        (project_id,),
    ).fetchall()
    if not rows:
        return []

    grouped: dict[str, list[sqlite3.Row]] = {
        "character": [],
        "plot": [],
        "scene": [],
        "world": [],
        "item": [],
        "hook": [],
        "general": [],
    }
    for r in rows:
        t = (r["reference_type"] or "general").lower()
        if t not in grouped:
            t = "general"
        grouped[t].append(r)

    title_map = {
        "character": "角色参考",
        "plot": "情节参考",
        "scene": "场景参考",
        "world": "世界观参考",
        "item": "道具参考",
        "hook": "钩子参考",
        "general": "通用参考",
    }
    blocks: list[str] = []
    for key in ("character", "plot", "scene", "world", "item", "hook", "general"):
        items = grouped.get(key) or []
        if not items:
            continue
        lines = [f"【{title_map[key]}】"]
        for r in items[:2]:
            lines.append(f"- {r['title']}：{_clip(r['content'] or '', 180)}")
        blocks.append("\n".join(lines))
    return blocks


def _load_chapter_snapshot(
    db_path: str,
    project_id: str,
    chapter_id: Optional[str],
    *,
    write_mode: str = "quality",
) -> str:
    """加载章节写作快照，不改记忆系统，只做上下文装配"""
    if not db_path or not chapter_id:
        return ""

    try:
        with get_db_with_path(db_path) as db:
            chapter = db.execute(
                "SELECT id, chapter_num, title, synopsis FROM chapters WHERE id = ? AND project_id = ?",
                (chapter_id, project_id),
            ).fetchone()
            if not chapter:
                return ""

            chapter_num = int(chapter["chapter_num"] or 0)
            prev_ch = db.execute(
                "SELECT id, chapter_num, title, synopsis FROM chapters "
                "WHERE project_id = ? AND chapter_num < ? ORDER BY chapter_num DESC LIMIT 1",
                (project_id, chapter_num),
            ).fetchone()
            next_ch = db.execute(
                "SELECT chapter_num, title, synopsis FROM chapters "
                "WHERE project_id = ? AND chapter_num > ? ORDER BY chapter_num ASC LIMIT 1",
                (project_id, chapter_num),
            ).fetchone()
            recent_chains = db.execute(
                "SELECT chapter_num, title, synopsis FROM chapters "
                "WHERE project_id = ? AND chapter_num < ? AND COALESCE(synopsis, '') != '' "
                "ORDER BY chapter_num DESC LIMIT 3",
                (project_id, chapter_num),
            ).fetchall()
            prev_tail_paras = []
            if write_mode != "fast" and prev_ch and prev_ch["id"]:
                prev_tail_paras = db.execute(
                    "SELECT content FROM chapter_paragraphs WHERE chapter_id = ? "
                    "ORDER BY para_index DESC LIMIT 3",
                    (prev_ch["id"],),
                ).fetchall()

            beats = db.execute(
                "SELECT order_index, content, status FROM chapter_beats "
                "WHERE chapter_id = ? ORDER BY order_index ASC LIMIT 10",
                (chapter_id,),
            ).fetchall()
            outlines = db.execute(
                "SELECT phase, title, content FROM outlines "
                "WHERE project_id = ? ORDER BY phase_order ASC LIMIT 8",
                (project_id,),
            ).fetchall()
            characters = db.execute(
                "SELECT name, category, gender, age, identity, personality, motivation FROM characters "
                "WHERE project_id = ? ORDER BY created_at ASC LIMIT 12",
                (project_id,),
            ).fetchall()
            world = db.execute(
                "SELECT title, category, content FROM worldbuilding "
                "WHERE project_id = ? ORDER BY created_at ASC LIMIT 10",
                (project_id,),
            ).fetchall()
            foreshadow = db.execute(
                "SELECT name, description, status FROM foreshadowing "
                "WHERE project_id = ? AND status != 'resolved' ORDER BY created_at ASC LIMIT 10",
                (project_id,),
            ).fetchall()
            recent_paras = db.execute(
                "SELECT content FROM chapter_paragraphs WHERE chapter_id = ? "
                "ORDER BY para_index DESC LIMIT 5",
                (chapter_id,),
            ).fetchall()

            parts: list[str] = []
            parts.append(f"【当前章节】第{chapter_num}章《{chapter['title'] or '未命名'}》")
            if chapter["synopsis"]:
                parts.append(f"当前章节简介：{_clip(chapter['synopsis'], 220)}")

            if prev_ch:
                parts.append(f"上一章：第{prev_ch['chapter_num']}章《{prev_ch['title'] or '未命名'}》")
                if prev_ch["synopsis"]:
                    parts.append(f"上一章摘要：{_clip(prev_ch['synopsis'], 220)}")
            if write_mode != "fast" and recent_chains:
                parts.append("【最近章节摘要链（近3章）】")
                for ch in reversed(recent_chains):
                    parts.append(f"- 第{ch['chapter_num']}章《{ch['title'] or '未命名'}》：{_clip(ch['synopsis'] or '', 200)}")
            if write_mode != "fast" and prev_tail_paras:
                parts.append("【上一章结尾原文（接力锚点）】")
                for p in reversed(prev_tail_paras):
                    parts.append(_clip(p["content"], 260))
            if next_ch:
                parts.append(f"下一章：第{next_ch['chapter_num']}章《{next_ch['title'] or '未命名'}》")
                if next_ch["synopsis"]:
                    parts.append(f"下一章摘要：{_clip(next_ch['synopsis'], 220)}")

            if beats:
                parts.append("【本章节拍】")
                for b in beats:
                    parts.append(f"- ({b['order_index']}) [{b['status']}] {_clip(b['content'], 120)}")

            if outlines:
                parts.append("【大纲锚点】")
                for o in outlines:
                    parts.append(f"- [{o['phase']}] {o['title']}: {_clip(o['content'], 130)}")

            if characters:
                if write_mode != "fast":
                    recent_summary_text = "\n".join([str(ch["synopsis"] or "") for ch in recent_chains])
                    if prev_ch and prev_ch["synopsis"]:
                        recent_summary_text += f"\n{prev_ch['synopsis']}"
                    parts.append("【角色状态追踪（近章）】")
                    for c in characters:
                        name = str(c["name"] or "").strip()
                        if not name:
                            continue
                        tags = [
                            str(c["category"] or "").strip(),
                            str(c["gender"] or "").strip(),
                            str(c["age"] or "").strip(),
                        ]
                        tags_text = "/".join([t for t in tags if t]) or "未分类"
                        active_hint = "近期活跃" if recent_summary_text and name in recent_summary_text else "近期未提及"
                        line = f"- {name}({tags_text}): {active_hint}"
                        if c["motivation"]:
                            line += f" | 动机:{_clip(c['motivation'], 40)}"
                        if c["identity"]:
                            line += f" | 身份:{_clip(c['identity'], 36)}"
                        parts.append(line)
                else:
                    parts.append("【角色设定】")
                    for c in characters:
                        tags = [
                            str(c["category"] or "").strip(),
                            str(c["gender"] or "").strip(),
                            str(c["age"] or "").strip(),
                        ]
                        tags_text = "/".join([t for t in tags if t]) or "未分类"
                        line = f"- {c['name']}({tags_text}): {_clip(c['identity'] or '', 60)}"
                        if c["personality"]:
                            line += f" | 性格:{_clip(c['personality'], 40)}"
                        if c["motivation"]:
                            line += f" | 动机:{_clip(c['motivation'], 40)}"
                        parts.append(line)

            if world:
                parts.append("【世界观】")
                for w in world:
                    parts.append(f"- {w['title']}({w['category']}): {_clip(w['content'], 100)}")

            if foreshadow:
                parts.append("【未回收伏笔】")
                for f in foreshadow:
                    parts.append(f"- {f['name']}[{f['status']}]: {_clip(f['description'], 120)}")

            if recent_paras:
                parts.append("【当前章节最近正文片段】")
                for p in reversed(recent_paras):
                    parts.append(_clip(p["content"], 260))

            profile_block = _load_active_profile_block(db, project_id)
            if profile_block:
                parts.append(profile_block)

            reference_blocks = _load_reference_blocks(db, project_id)
            parts.extend(reference_blocks)

            return "\n".join(parts)
    except Exception:
        logger.warning(
            "Failed to load chapter snapshot: project_id=%s chapter_id=%s",
            project_id,
            chapter_id,
            exc_info=True,
        )
        return ""


async def retrieve_context(state: NovelState) -> NovelState:
    """检索相关上下文记忆"""
    cm: ChunkManager = state["metadata"].get("_chunk_manager")
    if not cm:
        return {**state, "context_chunks": []}

    try:
        results = cm.search(
            project_id=state["project_id"],
            query=state["user_message"],
            top_k=8,
        )
    except Exception:
        logger.warning("Context retrieval failed", exc_info=True)
        results = []
    return {**state, "context_chunks": results}


def _resolve_runtime(state: NovelState, agent_type: str, db_path: str) -> tuple[str, str, float, int]:
    agent_cfg = _load_agent_config(db_path, state["project_id"], agent_type)

    system_prompt = PROMPT_MAP.get(agent_type, prompts.CHAPTER_WRITER)
    if agent_cfg and agent_cfg.get("system_prompt"):
        system_prompt = agent_cfg["system_prompt"]

    model = state.get("model", "claude-sonnet-4")
    if agent_cfg and agent_cfg.get("model"):
        model = agent_cfg["model"]

    temperature = state.get("temperature", 0.7)
    if agent_cfg and agent_cfg.get("temperature") is not None and agent_cfg["temperature"] >= 0:
        temperature = agent_cfg["temperature"]

    raw_max_tokens = (agent_cfg or {}).get("max_tokens")
    try:
        parsed_max_tokens = int(float(raw_max_tokens))
    except Exception:
        parsed_max_tokens = 4096
    if parsed_max_tokens <= 0:
        parsed_max_tokens = 4096
    max_tokens = max(256, min(12000, parsed_max_tokens))
    return system_prompt, model, temperature, max_tokens


async def _build_chapter_plan(
    llm: LLMClient,
    model: str,
    temperature: float,
    max_tokens: int,
    user_message: str,
    chapter_snapshot: str,
    retrieved_context: str,
) -> dict:
    default = {
        "goal": _clip(user_message, 120),
        "chapter_outline": [],
        "continuity_guardrails": [],
        "foreshadowing_actions": [],
    }

    plan_prompt = f"""
你是小说章节规划器。请基于给定信息，输出严格 JSON 对象，字段必须包含：
- goal: 字符串
- chapter_outline: 字符串数组（3-6条）
- continuity_guardrails: 字符串数组（2-5条）
- foreshadowing_actions: 字符串数组（0-4条）

{chapter_snapshot}

{retrieved_context}

用户当前写作请求：
{user_message}

只输出 JSON，不要解释。
""".strip()

    try:
        raw = await llm.chat(
            model=model,
            messages=[
                {"role": "system", "content": CHAPTER_PLAN_JSON_SYSTEM_PROMPT},
                {"role": "user", "content": plan_prompt},
            ],
            temperature=min(max(temperature, 0.1), 0.45),
            max_tokens=min(max_tokens, 1200),
        )
        return _parse_json_obj(raw, default)
    except Exception:
        logger.warning("Chapter plan generation failed", exc_info=True)
        return default


async def _self_check_draft(
    llm: LLMClient,
    model: str,
    max_tokens: int,
    draft: str,
    user_message: str,
    chapter_snapshot: str,
) -> dict:
    default = {
        "pass": True,
        "fatal_issues": [],
        "minor_issues": [],
        "rewrite_instructions": [],
    }

    prompt = f"""
你是小说质量审校器。请审查以下章节正文，并输出严格 JSON 对象：
- pass: 布尔值
- fatal_issues: 字符串数组（严重问题）
- minor_issues: 字符串数组（次要问题）
- rewrite_instructions: 字符串数组（针对正文的具体可执行修订指令）

审查依据：
{chapter_snapshot}

用户目标：
{user_message}

正文：
{draft}

只输出 JSON，不要解释。
""".strip()

    try:
        raw = await llm.chat(
            model=model,
            messages=[
                {"role": "system", "content": CHAPTER_SELF_CHECK_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            max_tokens=max(256, min(max_tokens, 4000)),
        )
        return _parse_json_obj(raw, default)
    except Exception:
        logger.warning("Draft self-check failed", exc_info=True)
        return default


async def _rewrite_draft(
    llm: LLMClient,
    model: str,
    temperature: float,
    max_tokens: int,
    draft: str,
    rewrite_instructions: list[str],
    chapter_snapshot: str,
) -> str:
    if not rewrite_instructions:
        return draft
    prompt = f"""
请按以下修订要求重写正文，保持故事主线不变，但修复问题：
{chr(10).join([f"- {x}" for x in rewrite_instructions])}

上下文约束：
{chapter_snapshot}

原正文：
{draft}

输出要求：
- 仅输出修订后的正文
- 不要解释，不要加标题，不要 markdown
""".strip()
    try:
        rewritten = await llm.chat(
            model=model,
            messages=[
                {"role": "system", "content": prompts.EDITOR},
                {"role": "user", "content": prompt},
            ],
            temperature=min(max(temperature, 0.2), 0.7),
            max_tokens=max_tokens,
        )
        return rewritten or draft
    except Exception:
        logger.warning("Draft rewrite failed", exc_info=True)
        return draft


async def generate_draft(state: NovelState) -> NovelState:
    """Agent生成初稿：chapter_writer走增强流水线，其它Agent走标准路径"""
    llm: LLMClient = state["metadata"]["_llm"]
    agent_type = state["agent_type"]
    db_path = state["metadata"].get("_db_path", "")
    system_prompt, model, temperature, max_tokens = _resolve_runtime(state, agent_type, db_path)

    raw_user_message = state.get("user_message", "")
    draft_only_mode = _is_draft_only_hint(raw_user_message)
    length_hint = _extract_length_hint(raw_user_message)
    context_text = _format_context_chunks(state.get("context_chunks", []))

    if agent_type == "chapter_writer":
        write_mode = _resolve_write_mode_hint(raw_user_message)
        normalized_user_message = _strip_write_mode_hint(raw_user_message) or raw_user_message
        metadata = dict(state.get("metadata", {}))
        metadata["_draft_only_mode"] = bool(draft_only_mode)
        chapter_snapshot = _load_chapter_snapshot(
            db_path,
            state["project_id"],
            state.get("chapter_id"),
            write_mode=write_mode,
        )
        plan: dict = {
            "goal": _clip(normalized_user_message, 120),
            "chapter_outline": [],
            "continuity_guardrails": [],
            "foreshadowing_actions": [],
        }
        plan_text = ""
        if not draft_only_mode:
            plan = await _build_chapter_plan(
                llm=llm,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                user_message=normalized_user_message,
                chapter_snapshot=chapter_snapshot,
                retrieved_context=context_text,
            )

            plan_lines: list[str] = []
            for k in ("chapter_outline", "continuity_guardrails", "foreshadowing_actions"):
                items = plan.get(k, [])
                if isinstance(items, list) and items:
                    plan_lines.append(f"{k}:")
                    plan_lines.extend([f"- {str(i)}" for i in items[:6]])
            plan_text = "\n".join(plan_lines)

        relay_rules = (
            "【章节接力硬约束】\n"
            "1. 必须承接“上一章结尾原文（接力锚点）”，禁止无来源跳场或时间跳变\n"
            "2. 优先消化最近章节摘要链中的未完成事件，不可无故重置人物状态\n"
            "3. 本章只推进本章节拍，不越章提前透支下一章关键冲突"
            if write_mode != "fast"
            else "【极速模式】优先快速推进，允许省略部分上下文细节，但不得违背硬设定。"
        )

        length_rule_lines: list[str] = []
        if length_hint:
            t = length_hint.get("target")
            min_len = int(length_hint.get("min") or 0)
            max_len = int(length_hint.get("max") or 0)
            if t:
                length_rule_lines.append(
                    f"5. 字数控制：本次正文目标约{t}字，允许范围 {min_len}-{max_len} 字"
                )
            else:
                length_rule_lines.append(
                    f"5. 字数控制：本次正文控制在 {min_len}-{max_len} 字范围内"
                )
            length_rule_lines.append("6. 必须尽量命中字数区间，仅允许小幅偏差。")

        requirements = [
            "1. 叙事连续，角色行为符合设定",
            "2. 优先覆盖本章节拍，不要越章推进",
            "3. 保持可读性和画面感",
            "4. 只输出正文，不要解释，不要 markdown",
        ]
        requirements.extend(length_rule_lines)
        requirements_text = "\n".join(requirements)

        draft_user = f"""
{chapter_snapshot}

{context_text}

【写作规划】
目标：{plan.get('goal', _clip(normalized_user_message, 120))}
{plan_text}

【用户请求】
{normalized_user_message}

{relay_rules}

请输出最终章节正文。要求：
{requirements_text}
""".strip()

        draft = await llm.chat(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": draft_user},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
        )

        if draft_only_mode:
            final_text = (draft or "").strip()
            if length_hint and final_text:
                final_text = await _fit_text_to_length_hint(
                    llm=llm,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    system_prompt=system_prompt,
                    chapter_snapshot=chapter_snapshot,
                    user_message=normalized_user_message,
                    text=final_text,
                    length_hint=length_hint,
                    write_mode=write_mode,
                )
            review_result = dict(state.get("review_result", {}))
            review_result["pipeline"] = {
                "plan": plan,
                "self_check": {
                    "pass": True,
                    "fatal_issues": [],
                    "minor_issues": [],
                    "rewrite_instructions": [],
                },
                "rewritten": False,
                "draft_only_mode": True,
            }
            return {
                **state,
                "user_message": normalized_user_message,
                "draft": final_text,
                "final_output": final_text,
                "review_result": review_result,
                "metadata": metadata,
            }

        check = await _self_check_draft(
            llm=llm,
            model=model,
            max_tokens=max_tokens,
            draft=draft,
            user_message=normalized_user_message,
            chapter_snapshot=chapter_snapshot,
        )

        final_text = (draft or "").strip()
        rewritten = False
        if (not bool(check.get("pass", True))) or bool(check.get("fatal_issues")):
            final_text = (await _rewrite_draft(
                llm=llm,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                draft=final_text,
                rewrite_instructions=[str(i) for i in check.get("rewrite_instructions", [])],
                chapter_snapshot=chapter_snapshot,
            )).strip()
            rewritten = True

        if length_hint and final_text:
            final_text = await _fit_text_to_length_hint(
                llm=llm,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                system_prompt=system_prompt,
                chapter_snapshot=chapter_snapshot,
                user_message=normalized_user_message,
                text=final_text,
                length_hint=length_hint,
                write_mode=write_mode,
            )

        review_result = dict(state.get("review_result", {}))
        review_result["pipeline"] = {
            "plan": plan,
            "self_check": check,
            "rewritten": rewritten,
        }
        return {
            **state,
            "user_message": normalized_user_message,
            "draft": final_text,
            "final_output": final_text,
            "review_result": review_result,
            "metadata": metadata,
        }

    normalized_user_message = _strip_write_mode_hint(raw_user_message) or raw_user_message
    metadata = dict(state.get("metadata", {}))
    metadata["_draft_only_mode"] = bool(draft_only_mode)
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"{context_text}\n\n用户请求:\n{normalized_user_message}"},
    ]
    draft = await llm.chat(
        model=model,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    return {**state, "user_message": normalized_user_message, "draft": draft, "metadata": metadata}


async def review_draft(state: NovelState) -> NovelState:
    """审核Agent审核初稿 (支持per-agent配置覆盖)"""
    llm: LLMClient = state["metadata"]["_llm"]
    db_path = state["metadata"].get("_db_path", "")

    reviewer_cfg = _load_agent_config(db_path, state["project_id"], "reviewer")
    system_prompt = prompts.REVIEWER
    if reviewer_cfg and reviewer_cfg.get("system_prompt"):
        system_prompt = reviewer_cfg["system_prompt"]

    model = state.get("model", "claude-sonnet-4")
    if reviewer_cfg and reviewer_cfg.get("model"):
        model = reviewer_cfg["model"]
    temperature = 0.3
    if reviewer_cfg and reviewer_cfg.get("temperature") is not None:
        try:
            parsed_temp = float(reviewer_cfg["temperature"])
            if parsed_temp >= 0:
                temperature = parsed_temp
        except Exception:
            temperature = 0.3
    max_tokens = 1200
    if reviewer_cfg and reviewer_cfg.get("max_tokens") is not None:
        try:
            parsed_max_tokens = int(float(reviewer_cfg["max_tokens"]))
            if parsed_max_tokens > 0:
                max_tokens = parsed_max_tokens
        except Exception:
            max_tokens = 1200
    max_tokens = max(256, min(12000, max_tokens))

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"用户目标:\n{state['user_message']}\n\n请审核以下内容:\n\n{state['draft']}"},
    ]
    review_text = await llm.chat(
        model=model,
        messages=messages,
        temperature=min(max(temperature, 0.0), 1.0),
        max_tokens=max_tokens,
    )

    review_result = dict(state.get("review_result", {}))
    review_result["review"] = review_text
    final_output = state.get("final_output") or state.get("draft", "")
    return {**state, "review_result": review_result, "final_output": final_output}


def _collect_issues(review_result: dict) -> list[dict]:
    pipeline = review_result.get("pipeline", {})
    check = pipeline.get("self_check", {}) if isinstance(pipeline, dict) else {}
    issues: list[dict] = []
    for item in check.get("fatal_issues", []) or []:
        issues.append({"severity": "high", "type": "fatal", "detail": str(item)})
    for item in check.get("minor_issues", []) or []:
        issues.append({"severity": "medium", "type": "minor", "detail": str(item)})
    return issues


def _persist_review_record(state: NovelState) -> None:
    db_path = state.get("metadata", {}).get("_db_path", "")
    if not db_path:
        return

    review_result = state.get("review_result", {}) or {}
    review_text = str(review_result.get("review", "")).strip()
    issues = _collect_issues(review_result)
    if not review_text and not issues:
        return

    try:
        with get_db_with_path(db_path) as db:
            db.execute(
                "INSERT INTO reviews (project_id, chapter_id, scores, issues, summary) VALUES (?, ?, ?, ?, ?)",
                (
                    state["project_id"],
                    state.get("chapter_id"),
                    "{}",
                    json.dumps(issues, ensure_ascii=False),
                    _clip(review_text or "自动审查完成。", 1800),
                ),
            )
    except Exception:
        logger.warning("Failed to persist review record", exc_info=True)


async def _refresh_chapter_synopsis(state: NovelState) -> None:
    if state.get("agent_type") != "chapter_writer":
        return
    chapter_id = state.get("chapter_id")
    if not chapter_id:
        return

    db_path = state.get("metadata", {}).get("_db_path", "")
    llm: LLMClient = state.get("metadata", {}).get("_llm")
    if not db_path or not llm:
        return

    text = state.get("final_output", "").strip()
    if not text:
        return

    try:
        summary = await llm.chat(
            model=state.get("model", "claude-sonnet-4"),
            messages=[
                {"role": "system", "content": CHAPTER_SYNOPSIS_SYSTEM_PROMPT},
                {"role": "user", "content": text[:5000]},
            ],
            temperature=0.2,
            max_tokens=220,
        )
        summary = _clip(summary.strip(), 220)
        if not summary:
            return
        with get_db_with_path(db_path) as db:
            db.execute(
                "UPDATE chapters SET synopsis = ?, updated_at = datetime('now') WHERE id = ?",
                (summary, chapter_id),
            )
    except Exception:
        logger.warning("Failed to refresh chapter synopsis", exc_info=True)


async def store_memory(state: NovelState) -> NovelState:
    """将输出存入记忆系统 + 持久化审阅结果 + 刷新章节摘要"""
    cm: ChunkManager = state["metadata"].get("_chunk_manager")
    epa: EPAAnalyzer = state["metadata"].get("_epa")
    mt: MetaThinking = state["metadata"].get("_meta_thinking")
    draft_only_mode = bool(state.get("metadata", {}).get("_draft_only_mode"))
    content = state.get("final_output") or state.get("draft", "")
    model_name = state.get("model", "claude-sonnet-4")

    if cm and content:
        importance = 0.5
        if epa and not draft_only_mode:
            try:
                epa_scores = await epa.analyze(content, model=model_name)
                importance = epa.compute_importance(epa_scores)
            except Exception:
                logger.warning("EPA analyze failed, fallback to default importance", exc_info=True)

        summary = content[:200]
        if mt and not draft_only_mode:
            try:
                enhanced = await mt.enhance(content, model=model_name)
                summary = enhanced.get("summary", summary)
            except Exception:
                logger.warning("Meta-thinking enhancement failed, fallback to plain summary", exc_info=True)

        try:
            cm.add_chunk(
                project_id=state["project_id"],
                source_type="agent",
                content=content,
                summary=summary,
                importance=importance,
                metadata={"agent_type": state["agent_type"]},
            )
        except Exception as e:
            metadata = dict(state.get("metadata", {}))
            metadata["_memory_store_error"] = str(e)
            state = {**state, "metadata": metadata}

    _persist_review_record(state)
    _auto_sync_foreshadowing_from_plan(state)
    if not draft_only_mode:
        await _refresh_chapter_synopsis(state)
    return state


def should_review(state: NovelState) -> str:
    """决定是否需要审核"""
    if bool(state.get("metadata", {}).get("_draft_only_mode")):
        return "store"
    if state["agent_type"] in ("chapter_writer", "outline_writer"):
        return "review"
    return "store"


def build_workflow() -> StateGraph:
    """构建LangGraph工作流"""
    graph = StateGraph(NovelState)

    graph.add_node("retrieve", retrieve_context)
    graph.add_node("generate", generate_draft)
    graph.add_node("review", review_draft)
    graph.add_node("store", store_memory)

    graph.set_entry_point("retrieve")
    graph.add_edge("retrieve", "generate")
    graph.add_conditional_edges("generate", should_review, {
        "review": "review",
        "store": "store",
    })
    graph.add_edge("review", "store")
    graph.add_edge("store", END)

    return graph.compile()
