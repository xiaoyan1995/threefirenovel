"""项目 CRUD + 导入导出 API"""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any, Literal, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from db import get_db
from agents import router as agent_router

router = APIRouter()


class ProjectCreate(BaseModel):
    name: str
    genre: str = ""
    description: str = ""
    structure: str = "起承转合"
    custom_structure: str = ""
    chapter_words: int = 5000
    priority: str = "品质优先"
    model_main: str = "claude-sonnet-4"
    model_secondary: str = "gpt-4o"
    temperature: float = 0.7
    embedding_dim: int = 3072
    word_target: int = 100000


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    genre: Optional[str] = None
    description: Optional[str] = None
    structure: Optional[str] = None
    custom_structure: Optional[str] = None
    chapter_words: Optional[int] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    model_main: Optional[str] = None
    model_secondary: Optional[str] = None
    temperature: Optional[float] = None
    embedding_dim: Optional[int] = None
    word_target: Optional[int] = None


class GenerateFromChaptersRequest(BaseModel):
    scope: Literal["all", "characters", "worldbuilding", "outline"] = "all"
    force: bool = False


def _clip(text: str, limit: int) -> str:
    s = (text or "").strip()
    if len(s) <= limit:
        return s
    return s[:limit] + "..."


def _safe_filename(name: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|]+', "_", str(name or "").strip())
    cleaned = re.sub(r"\s+", "_", cleaned)
    cleaned = cleaned.strip("._")
    return cleaned or "project"


def _decode_text_bytes(raw: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "gb18030", "gbk", "big5"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("latin-1", errors="ignore")


def _table_exists(db, table_name: str) -> bool:
    row = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
        (table_name,),
    ).fetchone()
    return bool(row)


def _paragraphs_to_text(paragraphs: list[dict]) -> str:
    lines = [str(p.get("content", "")).strip() for p in paragraphs if str(p.get("content", "")).strip()]
    return "\n\n".join(lines).strip()


def _split_paragraphs(raw_text: str) -> list[str]:
    text = str(raw_text or "").replace("\r\n", "\n").strip()
    if not text:
        return []
    parts = [p.strip() for p in re.split(r"\n\s*\n+", text) if p.strip()]
    return parts


def _load_project_bundle(project_id: str) -> dict[str, Any]:
    with get_db() as db:
        project = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not project:
            raise HTTPException(404, "项目不存在")

        chapters = [dict(r) for r in db.execute(
            "SELECT * FROM chapters WHERE project_id = ? ORDER BY chapter_num ASC, sort_order ASC",
            (project_id,),
        ).fetchall()]
        for ch in chapters:
            chapter_id = str(ch["id"])
            ch["paragraphs"] = [dict(r) for r in db.execute(
                "SELECT para_index, content, scene_tag, pov_char_id "
                "FROM chapter_paragraphs WHERE chapter_id = ? ORDER BY para_index ASC",
                (chapter_id,),
            ).fetchall()]
            ch["beats"] = [dict(r) for r in db.execute(
                "SELECT order_index, content, status FROM chapter_beats "
                "WHERE chapter_id = ? ORDER BY order_index ASC",
                (chapter_id,),
            ).fetchall()]

        characters = [dict(r) for r in db.execute(
            "SELECT * FROM characters WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC",
            (project_id,),
        ).fetchall()]
        relations = [dict(r) for r in db.execute(
            "SELECT cr.* FROM character_relations cr "
            "JOIN characters ca ON ca.id = cr.character_a_id "
            "JOIN characters cb ON cb.id = cr.character_b_id "
            "WHERE ca.project_id = ? AND cb.project_id = ? "
            "ORDER BY cr.created_at ASC",
            (project_id, project_id),
        ).fetchall()]

        outlines = [dict(r) for r in db.execute(
            "SELECT * FROM outlines WHERE project_id = ? ORDER BY phase_order ASC, created_at ASC",
            (project_id,),
        ).fetchall()]
        worldbuilding = [dict(r) for r in db.execute(
            "SELECT * FROM worldbuilding WHERE project_id = ? ORDER BY category ASC, sort_order ASC, created_at ASC",
            (project_id,),
        ).fetchall()]
        foreshadowing = [dict(r) for r in db.execute(
            "SELECT * FROM foreshadowing WHERE project_id = ? ORDER BY created_at ASC",
            (project_id,),
        ).fetchall()]
        reviews = [dict(r) for r in db.execute(
            "SELECT * FROM reviews WHERE project_id = ? ORDER BY created_at DESC LIMIT 80",
            (project_id,),
        ).fetchall()]
        entity_candidates = [dict(r) for r in db.execute(
            "SELECT * FROM entity_candidates WHERE project_id = ? ORDER BY created_at DESC LIMIT 300",
            (project_id,),
        ).fetchall()] if _table_exists(db, "entity_candidates") else []

        planning_state = None
        if _table_exists(db, "planning_studio_states"):
            planning_state_row = db.execute(
                "SELECT state_json, updated_at FROM planning_studio_states WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            planning_state = dict(planning_state_row) if planning_state_row else None

        volume_plans = []
        if _table_exists(db, "volume_plans"):
            volume_plans = [dict(r) for r in db.execute(
                "SELECT * FROM volume_plans WHERE project_id = ? ORDER BY volume_index ASC",
                (project_id,),
            ).fetchall()]

        knowledge = {}
        if _table_exists(db, "knowledge_collections") and _table_exists(db, "knowledge_sources"):
            knowledge["collections"] = [dict(r) for r in db.execute(
                "SELECT * FROM knowledge_collections WHERE project_id = ? ORDER BY created_at ASC",
                (project_id,),
            ).fetchall()]
            knowledge["sources"] = [dict(r) for r in db.execute(
                "SELECT * FROM knowledge_sources WHERE project_id = ? ORDER BY created_at ASC",
                (project_id,),
            ).fetchall()]
            if _table_exists(db, "knowledge_profiles"):
                knowledge["profiles"] = [dict(r) for r in db.execute(
                    "SELECT * FROM knowledge_profiles WHERE project_id = ? ORDER BY created_at ASC",
                    (project_id,),
                ).fetchall()]
            if _table_exists(db, "project_profile_binding"):
                bind = db.execute(
                    "SELECT * FROM project_profile_binding WHERE project_id = ?",
                    (project_id,),
                ).fetchone()
                knowledge["profile_binding"] = dict(bind) if bind else None

        return {
            "type": "sanhuoai_project_export",
            "version": 1,
            "exported_at": datetime.now().isoformat(timespec="seconds"),
            "project": dict(project),
            "chapters": chapters,
            "characters": characters,
            "character_relations": relations,
            "outlines": outlines,
            "worldbuilding": worldbuilding,
            "foreshadowing": foreshadowing,
            "reviews": reviews,
            "entity_candidates": entity_candidates,
            "planning_state": planning_state,
            "volume_plans": volume_plans,
            "knowledge": knowledge,
        }


def _build_novel_text(bundle: dict[str, Any], markdown: bool = False) -> str:
    chapters = list(bundle.get("chapters", []) or [])
    project = dict(bundle.get("project", {}) or {})
    title = str(project.get("name", "")).strip() or "未命名项目"

    lines: list[str] = []
    if markdown:
        lines.append(f"# {title}")
        lines.append("")
    else:
        lines.append(title)
        lines.append("")

    for ch in chapters:
        chapter_num = int(ch.get("chapter_num") or 0)
        chapter_title = str(ch.get("title", "")).strip() or f"第{chapter_num}章"
        if markdown:
            lines.append(f"## 第{chapter_num}章 {chapter_title}")
        else:
            lines.append(f"第{chapter_num}章 {chapter_title}")
        lines.append("")
        paragraphs = list(ch.get("paragraphs", []) or [])
        chapter_text = _paragraphs_to_text(paragraphs)
        if not chapter_text:
            chapter_text = str(ch.get("synopsis", "")).strip()
        if chapter_text:
            lines.append(chapter_text)
            lines.append("")
    return "\n".join(lines).strip()


def _parse_plain_text_to_chapters(raw_text: str) -> list[dict[str, Any]]:
    text = str(raw_text or "").replace("\r\n", "\n").strip()
    if not text:
        return []

    heading_re = re.compile(r"^\s*第\s*([0-9一二两三四五六七八九十百千〇零]+)\s*章[：:\s\-—]*(.*)$")
    chapters: list[dict[str, Any]] = []
    cur_title = ""
    cur_lines: list[str] = []

    for line in text.split("\n"):
        m = heading_re.match(line.strip())
        if m:
            if cur_lines:
                chapters.append({
                    "title": cur_title or f"第{len(chapters) + 1}章",
                    "content": "\n".join(cur_lines).strip(),
                })
                cur_lines = []
            heading_tail = str(m.group(2) or "").strip()
            cur_title = heading_tail or f"第{len(chapters) + 1}章"
            continue
        cur_lines.append(line)

    if cur_lines:
        chapters.append({
            "title": cur_title or f"第{len(chapters) + 1}章",
            "content": "\n".join(cur_lines).strip(),
        })

    if not chapters:
        chapters = [{"title": "第1章", "content": text}]
    return chapters


def _rebuild_import_memory(project_id: str, chapter_texts: list[tuple[str, str]]) -> None:
    # 导入后补一层基础记忆，提升“直接续写”的上下文可用性。
    try:
        agent_router._init_services()
        chunk_manager = agent_router._chunk_manager
        if chunk_manager is None:
            return
        for chapter_id, chapter_text in chapter_texts:
            content = str(chapter_text or "").strip()
            if not content:
                continue
            clipped = content[:3500]
            chunk_manager.add_chunk(
                project_id=project_id,
                source_type="import",
                source_id=chapter_id,
                content=clipped,
                summary=_clip(content, 220),
                importance=0.65,
                metadata={"source": "project_import", "chapter_id": chapter_id},
            )
    except Exception:
        # 导入主流程不因记忆失败而中断
        return


def _insert_project_from_bundle(bundle: dict[str, Any], override_name: str = "") -> dict[str, Any]:
    imported_counts = {
        "chapters": 0,
        "characters": 0,
        "relations": 0,
        "outlines": 0,
        "worldbuilding": 0,
        "foreshadowing": 0,
    }
    chapter_id_map: dict[str, str] = {}
    character_id_map: dict[str, str] = {}
    chapter_texts_for_memory: list[tuple[str, str]] = []

    project_data = dict(bundle.get("project", {}) or {})
    chapters = list(bundle.get("chapters", []) or [])
    characters = list(bundle.get("characters", []) or [])
    relations = list(bundle.get("character_relations", []) or [])
    outlines = list(bundle.get("outlines", []) or [])
    world_items = list(bundle.get("worldbuilding", []) or [])
    foreshadowing = list(bundle.get("foreshadowing", []) or [])

    with get_db() as db:
        project_name = str(override_name or "").strip() or str(project_data.get("name", "")).strip() or "导入项目"
        project_name = _clip(project_name, 80)
        project_row = db.execute(
            "INSERT INTO projects (name, genre, description, structure, custom_structure, chapter_words, priority, "
            "model_main, model_secondary, temperature, embedding_dim, word_target) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *",
            (
                project_name,
                str(project_data.get("genre", "") or ""),
                str(project_data.get("description", "") or ""),
                str(project_data.get("structure", "起承转合") or "起承转合"),
                str(project_data.get("custom_structure", "") or ""),
                int(project_data.get("chapter_words", 5000) or 5000),
                str(project_data.get("priority", "品质优先") or "品质优先"),
                str(project_data.get("model_main", "claude-sonnet-4") or "claude-sonnet-4"),
                str(project_data.get("model_secondary", "gpt-4o") or "gpt-4o"),
                float(project_data.get("temperature", 0.7) or 0.7),
                int(project_data.get("embedding_dim", 3072) or 3072),
                int(project_data.get("word_target", 100000) or 100000),
            ),
        ).fetchone()
        project_id = str(project_row["id"])

        used_nums: set[int] = set()
        for idx, ch in enumerate(chapters, start=1):
            old_chapter_id = str(ch.get("id", "")).strip()
            chapter_num = int(ch.get("chapter_num") or idx)
            while chapter_num in used_nums:
                chapter_num += 1
            used_nums.add(chapter_num)
            title = str(ch.get("title", "")).strip() or f"第{chapter_num}章"
            synopsis = str(ch.get("synopsis", "") or "").strip()
            phase = str(ch.get("phase", "") or "")
            status = str(ch.get("status", "draft") or "draft")
            sort_order = int(ch.get("sort_order", chapter_num) or chapter_num)

            inserted = db.execute(
                "INSERT INTO chapters (project_id, chapter_num, title, phase, synopsis, status, sort_order) "
                "VALUES (?,?,?,?,?,?,?) RETURNING id",
                (project_id, chapter_num, title, phase, synopsis, status, sort_order),
            ).fetchone()
            new_chapter_id = str(inserted["id"])
            if old_chapter_id:
                chapter_id_map[old_chapter_id] = new_chapter_id

            paragraphs = list(ch.get("paragraphs", []) or [])
            paragraph_texts: list[str] = []
            if paragraphs:
                for p_idx, p in enumerate(paragraphs):
                    content = str((p or {}).get("content", "")).strip()
                    if not content:
                        continue
                    para_index = int((p or {}).get("para_index", p_idx) or p_idx)
                    paragraph_texts.append(content)
                    db.execute(
                        "INSERT INTO chapter_paragraphs (chapter_id, para_index, content, char_count, scene_tag, pov_char_id) "
                        "VALUES (?,?,?,?,?,?)",
                        (
                            new_chapter_id,
                            para_index,
                            content,
                            len(content),
                            str((p or {}).get("scene_tag", "") or "") or None,
                            str((p or {}).get("pov_char_id", "") or "") or None,
                        ),
                    )
            else:
                plain_text = str(ch.get("content", "") or "").strip()
                split_paras = _split_paragraphs(plain_text)
                for p_idx, para in enumerate(split_paras):
                    paragraph_texts.append(para)
                    db.execute(
                        "INSERT INTO chapter_paragraphs (chapter_id, para_index, content, char_count) VALUES (?,?,?,?)",
                        (new_chapter_id, p_idx, para, len(para)),
                    )

            full_chapter_text = "\n\n".join(paragraph_texts).strip()
            chapter_word_count = len(full_chapter_text)
            db.execute("UPDATE chapters SET word_count = ? WHERE id = ?", (chapter_word_count, new_chapter_id))
            chapter_texts_for_memory.append((new_chapter_id, full_chapter_text))

            beats = list(ch.get("beats", []) or [])
            for b_idx, beat in enumerate(beats):
                beat_content = str((beat or {}).get("content", "")).strip()
                if not beat_content:
                    continue
                db.execute(
                    "INSERT INTO chapter_beats (chapter_id, order_index, content, status) VALUES (?,?,?,?)",
                    (
                        new_chapter_id,
                        int((beat or {}).get("order_index", b_idx + 1) or (b_idx + 1)),
                        beat_content,
                        str((beat or {}).get("status", "pending") or "pending"),
                    ),
                )
            imported_counts["chapters"] += 1

        for o in outlines:
            db.execute(
                "INSERT INTO outlines (project_id, structure, phase, phase_order, title, content, word_range) "
                "VALUES (?,?,?,?,?,?,?)",
                (
                    project_id,
                    str(o.get("structure", project_data.get("structure", "起承转合")) or "起承转合"),
                    str(o.get("phase", "") or ""),
                    int(o.get("phase_order", imported_counts["outlines"]) or imported_counts["outlines"]),
                    str(o.get("title", "") or ""),
                    str(o.get("content", "") or ""),
                    str(o.get("word_range", "") or ""),
                ),
            )
            imported_counts["outlines"] += 1

        for w_idx, w in enumerate(world_items):
            db.execute(
                "INSERT INTO worldbuilding (project_id, category, title, content, sort_order) VALUES (?,?,?,?,?)",
                (
                    project_id,
                    str(w.get("category", "其他") or "其他"),
                    str(w.get("title", "") or f"设定{w_idx + 1}"),
                    str(w.get("content", "") or ""),
                    int(w.get("sort_order", w_idx) or w_idx),
                ),
            )
            imported_counts["worldbuilding"] += 1

        for c_idx, c in enumerate(characters):
            inserted = db.execute(
                "INSERT INTO characters (project_id, name, category, gender, age, identity, appearance, personality, motivation, backstory, arc, usage_notes, sort_order, status) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
                (
                    project_id,
                    str(c.get("name", "") or f"角色{c_idx + 1}"),
                    str(c.get("category", "配角") or "配角"),
                    str(c.get("gender", "") or ""),
                    str(c.get("age", "") or ""),
                    str(c.get("identity", "") or ""),
                    str(c.get("appearance", "") or ""),
                    str(c.get("personality", "") or ""),
                    str(c.get("motivation", "") or ""),
                    str(c.get("backstory", "") or ""),
                    str(c.get("arc", "") or ""),
                    str(c.get("usage_notes", "") or ""),
                    int(c.get("sort_order", c_idx) or c_idx),
                    str(c.get("status", "active") or "active"),
                ),
            ).fetchone()
            old_id = str(c.get("id", "")).strip()
            if old_id:
                character_id_map[old_id] = str(inserted["id"])
            imported_counts["characters"] += 1

        for rel in relations:
            old_a = str(rel.get("character_a_id", "")).strip()
            old_b = str(rel.get("character_b_id", "")).strip()
            new_a = character_id_map.get(old_a, "")
            new_b = character_id_map.get(old_b, "")
            if not new_a or not new_b or new_a == new_b:
                continue
            db.execute(
                "INSERT INTO character_relations (character_a_id, character_b_id, relation_type, description) VALUES (?,?,?,?)",
                (
                    new_a,
                    new_b,
                    str(rel.get("relation_type", "") or ""),
                    str(rel.get("description", "") or ""),
                ),
            )
            imported_counts["relations"] += 1

        for fs in foreshadowing:
            old_plant = str(fs.get("plant_chapter_id", "")).strip()
            old_resolve = str(fs.get("resolve_chapter_id", "")).strip()
            db.execute(
                "INSERT INTO foreshadowing (project_id, name, description, category, importance, status, "
                "plant_chapter_id, resolve_chapter_id, plant_text, resolve_text) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    project_id,
                    str(fs.get("name", "") or "未命名伏笔"),
                    str(fs.get("description", "") or ""),
                    str(fs.get("category", "剧情") or "剧情"),
                    str(fs.get("importance", "中") or "中"),
                    str(fs.get("status", "planted") or "planted"),
                    chapter_id_map.get(old_plant) if old_plant else None,
                    chapter_id_map.get(old_resolve) if old_resolve else None,
                    str(fs.get("plant_text", "") or ""),
                    str(fs.get("resolve_text", "") or ""),
                ),
            )
            imported_counts["foreshadowing"] += 1

    _rebuild_import_memory(project_id, chapter_texts_for_memory)
    return {
        "project_id": project_id,
        "project_name": str(project_name),
        "imported": imported_counts,
        "mode": "bundle",
    }


def _insert_plain_text_as_project(raw_text: str, project_name: str = "") -> dict[str, Any]:
    text = str(raw_text or "").replace("\r\n", "\n").strip()
    if not text:
        raise HTTPException(400, "文本内容为空")

    parsed_chapters = _parse_plain_text_to_chapters(text)
    if not parsed_chapters:
        raise HTTPException(400, "无法从文本中解析章节")

    imported_counts = {"chapters": 0}
    chapter_texts_for_memory: list[tuple[str, str]] = []

    with get_db() as db:
        inferred_name = _clip(project_name or "导入旧书项目", 80)
        project_row = db.execute(
            "INSERT INTO projects (name, genre, description, structure, custom_structure, chapter_words, priority, model_main, model_secondary, temperature, embedding_dim, word_target) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *",
            (
                inferred_name,
                "",
                _clip(text, 200),
                "起承转合",
                "",
                5000,
                "品质优先",
                "claude-sonnet-4",
                "gpt-4o",
                0.7,
                3072,
                100000,
            ),
        ).fetchone()
        project_id = str(project_row["id"])

        for idx, item in enumerate(parsed_chapters, start=1):
            title = str(item.get("title", "")).strip() or f"第{idx}章"
            body_text = str(item.get("content", "")).strip()
            synopsis = _clip(body_text, 220)
            inserted_ch = db.execute(
                "INSERT INTO chapters (project_id, chapter_num, title, synopsis, phase, status, sort_order) "
                "VALUES (?,?,?,?,?,?,?) RETURNING id",
                (project_id, idx, title, synopsis, "", "draft", idx),
            ).fetchone()
            chapter_id = str(inserted_ch["id"])
            paragraphs = _split_paragraphs(body_text)
            for p_idx, para in enumerate(paragraphs):
                db.execute(
                    "INSERT INTO chapter_paragraphs (chapter_id, para_index, content, char_count) VALUES (?,?,?,?)",
                    (chapter_id, p_idx, para, len(para)),
                )
            db.execute("UPDATE chapters SET word_count = ? WHERE id = ?", (len(body_text), chapter_id))
            chapter_texts_for_memory.append((chapter_id, body_text))
            imported_counts["chapters"] += 1

    _rebuild_import_memory(project_id, chapter_texts_for_memory)
    return {
        "project_id": project_id,
        "project_name": inferred_name,
        "imported": imported_counts,
        "mode": "plain_text",
    }


async def _auto_bootstrap_plain_import(project_id: str) -> dict[str, Any]:
    """
    对“纯文本旧书导入”做一次自动补全：
    1) 基于已导入章节正文抽取并落库角色/世界观；
    2) 对仍缺失的板块再补跑 bootstrap（优先补大纲）。
    - 任意 scope 失败不阻断导入主流程
    """
    def _planning_counts(pid: str) -> dict[str, int]:
        with get_db() as db:
            outline_row = db.execute(
                "SELECT COUNT(*) AS c FROM outlines WHERE project_id = ?",
                (pid,),
            ).fetchone()
            character_row = db.execute(
                "SELECT COUNT(*) AS c FROM characters WHERE project_id = ?",
                (pid,),
            ).fetchone()
            world_row = db.execute(
                "SELECT COUNT(*) AS c FROM worldbuilding WHERE project_id = ?",
                (pid,),
            ).fetchone()
            outline = int((outline_row["c"] if outline_row else 0) or 0)
            characters = int((character_row["c"] if character_row else 0) or 0)
            worldbuilding = int((world_row["c"] if world_row else 0) or 0)
        return {"outline": outline, "characters": characters, "worldbuilding": worldbuilding}

    def _select_chapters_for_extract(pid: str, max_samples: int = 18) -> list[str]:
        with get_db() as db:
            rows = db.execute(
                "SELECT id FROM chapters WHERE project_id = ? ORDER BY chapter_num ASC, sort_order ASC",
                (pid,),
            ).fetchall()
        chapter_ids = [str(r["id"]) for r in rows if str(r["id"] or "").strip()]
        if len(chapter_ids) <= max_samples:
            return chapter_ids
        picked: list[str] = []
        seen: set[str] = set()
        n = len(chapter_ids)
        denom = max(1, max_samples - 1)
        for i in range(max_samples):
            idx = int(round(i * (n - 1) / denom))
            cid = chapter_ids[idx]
            if cid in seen:
                continue
            seen.add(cid)
            picked.append(cid)
        return picked

    def _is_model_unavailable_error(err: Exception) -> bool:
        text = str(err)
        lowered = text.lower()
        return (
            "no available channels" in lowered
            or "serviceunavailableerror" in lowered
            or ("模型" in text and "失败" in text and "scope" in lowered)
        )

    result: dict[str, Any] = {
        "inserted": {"outline": 0, "characters": 0, "worldbuilding": 0},
        "errors": [],
        "entity_extract": {
            "chapters_scanned": 0,
            "candidates_inserted": 0,
            "candidates_skipped": 0,
            "created": 0,
            "merged": 0,
        },
    }
    baseline_counts = _planning_counts(project_id)

    # Step 1: 基于章节文本抽取实体候选并自动落库（角色/世界观）。
    try:
        # 延迟导入避免模块初始化时潜在循环依赖
        from api.content import (
            _extract_and_store_entity_candidates,
            EntityCandidateCommitOperation,
            EntityCandidateCommitRequest,
            commit_entity_candidates,
        )
        chapter_ids = _select_chapters_for_extract(project_id)
        result["entity_extract"]["chapters_scanned"] = len(chapter_ids)
        for chapter_id in chapter_ids:
            try:
                extracted = await _extract_and_store_entity_candidates(
                    project_id=project_id,
                    chapter_id=chapter_id,
                    text="",
                    limit=8,
                    strict=False,
                )
                result["entity_extract"]["candidates_inserted"] += int(extracted.get("inserted", 0) or 0)
                result["entity_extract"]["candidates_skipped"] += int(extracted.get("skipped", 0) or 0)
            except Exception as exc:
                result["errors"].append(_clip(f"extract:{exc}", 220))
                if _is_model_unavailable_error(exc):
                    break

        with get_db() as db:
            pending_rows = db.execute(
                "SELECT id FROM entity_candidates WHERE project_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 260",
                (project_id,),
            ).fetchall()
        pending_ids = [str(r["id"]) for r in pending_rows if str(r["id"] or "").strip()]
        if pending_ids:
            commit_req = EntityCandidateCommitRequest(
                project_id=project_id,
                operations=[
                    EntityCandidateCommitOperation(candidate_id=cid, action="create")
                    for cid in pending_ids
                ],
            )
            commit_res = commit_entity_candidates(commit_req)
            result["entity_extract"]["created"] += int(commit_res.get("created", 0) or 0)
            result["entity_extract"]["merged"] += int(commit_res.get("merged", 0) or 0)
    except Exception as exc:
        result["errors"].append(_clip(f"extract_import_failed:{exc}", 220))

    # Step 2: 对缺失板块补跑 bootstrap（避免对已有板块重复调模型）。
    post_extract_counts = _planning_counts(project_id)
    scopes_to_bootstrap: list[str] = []
    if post_extract_counts["characters"] == 0:
        scopes_to_bootstrap.append("characters")
    if post_extract_counts["worldbuilding"] == 0:
        scopes_to_bootstrap.append("worldbuilding")
    if post_extract_counts["outline"] == 0:
        scopes_to_bootstrap.append("outline")

    if not scopes_to_bootstrap:
        final_counts = _planning_counts(project_id)
        result["inserted"] = {
            "outline": max(0, int(final_counts["outline"] - baseline_counts["outline"])),
            "characters": max(0, int(final_counts["characters"] - baseline_counts["characters"])),
            "worldbuilding": max(0, int(final_counts["worldbuilding"] - baseline_counts["worldbuilding"])),
        }
        return result

    try:
        # 延迟导入避免模块初始化时潜在循环依赖
        from api.pipeline import BootstrapRequest, bootstrap_project
    except Exception as exc:
        result["errors"].append(_clip(f"bootstrap_import_failed:{exc}", 220))
        final_counts = _planning_counts(project_id)
        result["inserted"] = {
            "outline": max(0, int(final_counts["outline"] - baseline_counts["outline"])),
            "characters": max(0, int(final_counts["characters"] - baseline_counts["characters"])),
            "worldbuilding": max(0, int(final_counts["worldbuilding"] - baseline_counts["worldbuilding"])),
        }
        return result

    for scope in scopes_to_bootstrap:
        try:
            await bootstrap_project(
                BootstrapRequest(
                    project_id=project_id,
                    scope=scope,
                    force=False,
                    use_bible=False,
                    use_profile=True,
                )
            )
        except Exception as exc:
            # 单个 scope 失败只记录，不影响导入成功
            err_text = _clip(f"{scope}:{exc}", 260)
            result["errors"].append(err_text)
            # 模型/通道不可用时后续 scope 通常都会失败，直接短路避免导入等待过长。
            if _is_model_unavailable_error(exc):
                break

    final_counts = _planning_counts(project_id)
    result["inserted"] = {
        "outline": max(0, int(final_counts["outline"] - baseline_counts["outline"])),
        "characters": max(0, int(final_counts["characters"] - baseline_counts["characters"])),
        "worldbuilding": max(0, int(final_counts["worldbuilding"] - baseline_counts["worldbuilding"])),
    }
    return result


def _normalized_generate_scope(scope: str) -> set[str]:
    clean = str(scope or "").strip().lower()
    if clean in {"", "all"}:
        return {"characters", "worldbuilding", "outline"}
    if clean in {"characters", "worldbuilding", "outline"}:
        return {clean}
    raise HTTPException(400, "scope 仅支持 all/characters/worldbuilding/outline")


def _planning_counts_for_project(project_id: str) -> dict[str, int]:
    with get_db() as db:
        outline_row = db.execute(
            "SELECT COUNT(*) AS c FROM outlines WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        character_row = db.execute(
            "SELECT COUNT(*) AS c FROM characters WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        world_row = db.execute(
            "SELECT COUNT(*) AS c FROM worldbuilding WHERE project_id = ?",
            (project_id,),
        ).fetchone()
    return {
        "outline": int((outline_row["c"] if outline_row else 0) or 0),
        "characters": int((character_row["c"] if character_row else 0) or 0),
        "worldbuilding": int((world_row["c"] if world_row else 0) or 0),
    }


def _sample_chapter_ids_for_extract(project_id: str, max_samples: int = 18) -> list[str]:
    with get_db() as db:
        rows = db.execute(
            "SELECT id FROM chapters WHERE project_id = ? ORDER BY chapter_num ASC, sort_order ASC",
            (project_id,),
        ).fetchall()
    chapter_ids = [str(r["id"]) for r in rows if str(r["id"] or "").strip()]
    if len(chapter_ids) <= max_samples:
        return chapter_ids

    picked: list[str] = []
    seen: set[str] = set()
    n = len(chapter_ids)
    denom = max(1, max_samples - 1)
    for i in range(max_samples):
        idx = int(round(i * (n - 1) / denom))
        cid = chapter_ids[idx]
        if cid in seen:
            continue
        seen.add(cid)
        picked.append(cid)
    return picked


def _is_model_unavailable_error(err: Exception) -> bool:
    text = str(err)
    lowered = text.lower()
    return (
        "no available channels" in lowered
        or "serviceunavailableerror" in lowered
        or ("模型" in text and "失败" in text and "scope" in lowered)
    )


def _strip_fence(raw: str) -> str:
    text = str(raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _parse_json_object(raw: str) -> dict[str, Any]:
    cleaned = _strip_fence(raw)
    if not cleaned:
        return {}
    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        pass
    match = re.search(r"\{[\s\S]*\}", cleaned)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _resolve_outline_phase_labels(structure: str, custom_structure: str) -> list[str]:
    st = str(structure or "起承转合").strip() or "起承转合"
    custom = str(custom_structure or "").strip()
    if st == "三幕式":
        return ["第一幕", "第二幕", "第三幕"]
    if st == "英雄之旅":
        return ["平凡世界", "冒险召唤", "跨越门槛", "试炼与盟友", "重大考验", "获得奖励", "归途", "重生"]
    if st == "自定义" and custom:
        tokens = [t.strip() for t in re.split(r"[,，；;\n|/→\-]+", custom) if t.strip()]
        if tokens:
            return tokens[:12]
    return ["起", "承", "转", "合"]


def _clear_scopes_before_chapter_generate(project_id: str, scopes: set[str]) -> None:
    with get_db() as db:
        if "outline" in scopes:
            db.execute("DELETE FROM outlines WHERE project_id = ?", (project_id,))

        if "worldbuilding" in scopes:
            db.execute("DELETE FROM worldbuilding WHERE project_id = ?", (project_id,))
            if _table_exists(db, "entity_candidates"):
                db.execute(
                    "DELETE FROM entity_candidates WHERE project_id = ? AND entity_type = 'worldbuilding'",
                    (project_id,),
                )

        if "characters" in scopes:
            if _table_exists(db, "character_relations"):
                db.execute(
                    "DELETE FROM character_relations "
                    "WHERE character_a_id IN (SELECT id FROM characters WHERE project_id = ?) "
                    "   OR character_b_id IN (SELECT id FROM characters WHERE project_id = ?)",
                    (project_id, project_id),
                )
            db.execute("DELETE FROM characters WHERE project_id = ?", (project_id,))
            if _table_exists(db, "entity_candidates"):
                db.execute(
                    "DELETE FROM entity_candidates WHERE project_id = ? AND entity_type = 'character'",
                    (project_id,),
                )


async def _generate_entities_from_chapters(
    *,
    project_id: str,
    scopes: set[str],
) -> tuple[dict[str, int], list[str], dict[str, int]]:
    inserted = {"characters": 0, "worldbuilding": 0}
    errors: list[str] = []
    extract_stats = {
        "chapters_scanned": 0,
        "candidates_inserted": 0,
        "candidates_skipped": 0,
        "created": 0,
        "merged": 0,
    }
    if not ({"characters", "worldbuilding"} & scopes):
        return inserted, errors, extract_stats

    types = sorted(list(({"characters", "worldbuilding"} & scopes)))
    type_map = {"characters": "character", "worldbuilding": "worldbuilding"}
    candidate_types = [type_map[t] for t in types if t in type_map]
    before_counts = _planning_counts_for_project(project_id)

    try:
        # 延迟导入避免模块初始化时循环依赖
        from api.content import (
            _extract_and_store_entity_candidates,
            EntityCandidateCommitOperation,
            EntityCandidateCommitRequest,
            commit_entity_candidates,
        )
    except Exception as exc:
        errors.append(_clip(f"extract_import_failed:{exc}", 260))
        return inserted, errors, extract_stats

    chapter_ids = _sample_chapter_ids_for_extract(project_id)
    extract_stats["chapters_scanned"] = len(chapter_ids)
    for chapter_id in chapter_ids:
        try:
            extracted = await _extract_and_store_entity_candidates(
                project_id=project_id,
                chapter_id=chapter_id,
                text="",
                limit=8,
                strict=False,
            )
            extract_stats["candidates_inserted"] += int(extracted.get("inserted", 0) or 0)
            extract_stats["candidates_skipped"] += int(extracted.get("skipped", 0) or 0)
        except Exception as exc:
            errors.append(_clip(f"extract:{exc}", 260))
            if _is_model_unavailable_error(exc):
                break

    try:
        with get_db() as db:
            if candidate_types:
                placeholders = ",".join(["?"] * len(candidate_types))
                rows = db.execute(
                    f"SELECT id FROM entity_candidates WHERE project_id = ? AND status = 'pending' "
                    f"AND entity_type IN ({placeholders}) ORDER BY created_at ASC LIMIT 360",
                    [project_id, *candidate_types],
                ).fetchall()
            else:
                rows = []
        pending_ids = [str(r["id"]) for r in rows if str(r["id"] or "").strip()]
        if pending_ids:
            commit_req = EntityCandidateCommitRequest(
                project_id=project_id,
                operations=[
                    EntityCandidateCommitOperation(candidate_id=cid, action="create")
                    for cid in pending_ids
                ],
            )
            commit_res = commit_entity_candidates(commit_req)
            extract_stats["created"] += int(commit_res.get("created", 0) or 0)
            extract_stats["merged"] += int(commit_res.get("merged", 0) or 0)
    except Exception as exc:
        errors.append(_clip(f"commit:{exc}", 260))

    after_counts = _planning_counts_for_project(project_id)
    inserted["characters"] = max(0, int(after_counts["characters"] - before_counts["characters"]))
    inserted["worldbuilding"] = max(0, int(after_counts["worldbuilding"] - before_counts["worldbuilding"]))
    return inserted, errors, extract_stats


async def _generate_outline_from_chapters(*, project_id: str, force: bool) -> tuple[int, int, list[str]]:
    def _safe_int(value: Any, default: int = 0) -> int:
        try:
            return int(value or default)
        except Exception:
            return int(default)

    def _default_phase_word_range(idx: int, count: int, total_word_target: int) -> str:
        if total_word_target <= 0 or count <= 0:
            return ""
        if count <= 1:
            center = total_word_target
        else:
            weights: list[float] = []
            for i in range(count):
                pos = i / max(1, count - 1)
                # 中段略重，两端略轻，避免各阶段机械平均。
                weight = 0.92 + (1 - abs(pos - 0.5) * 2) * 0.18
                weights.append(weight)
            total_weight = sum(weights) or 1.0
            center = int(total_word_target * (weights[idx] / total_weight))
        low = max(800, int(center * 0.82))
        high = max(low + 200, int(center * 1.18))
        return f"{low}-{high}"

    def _parse_word_range(text: str) -> tuple[int, int] | None:
        raw = str(text or "").strip()
        if not raw:
            return None
        m = re.search(r"(\d{3,7})\s*(?:-|~|—|–|到|至)\s*(\d{3,7})", raw)
        if not m:
            m_single = re.search(r"(\d{3,7})", raw)
            if not m_single:
                return None
            n = _safe_int(m_single.group(1), 0)
            if n <= 0:
                return None
            return (n, n)
        a = _safe_int(m.group(1), 0)
        b = _safe_int(m.group(2), 0)
        if a <= 0 or b <= 0:
            return None
        if a > b:
            a, b = b, a
        return (a, b)

    def _phase_allocation(
        labels: list[str],
        total_chapters: int,
        existing_chapters: int,
    ) -> list[dict[str, int]]:
        """
        分配规则（按用户要求）：
        - 先按总章数给各阶段分配基础区间；
        - 已写章节从前往后“填充”阶段（通常先占满“起”）；
        - 每阶段返回：
          phase_start/phase_end: 阶段全区间
          written_start/written_end: 已写落在本阶段的区间（可能为空）
          planned_start/planned_end: 待写落在本阶段的区间（可能为空）
        """
        phase_count = max(1, len(labels))
        safe_total = max(1, int(total_chapters or 1))
        safe_existing = max(0, min(safe_total, int(existing_chapters or 0)))

        # 轻微前置偏权：起/承稍多，转/合略少，避免机械平均
        base_weights: list[float]
        if phase_count == 4:
            base_weights = [1.08, 1.02, 0.97, 0.93]
        else:
            base_weights = [1.0 for _ in range(phase_count)]
        w_sum = sum(base_weights) or float(phase_count)
        raw_sizes = [safe_total * (w / w_sum) for w in base_weights]
        sizes = [max(1, int(round(v))) for v in raw_sizes]

        # 调整到总和精确等于 safe_total
        diff = safe_total - sum(sizes)
        step = 1 if diff > 0 else -1
        idx = 0
        while diff != 0 and phase_count > 0:
            pos = idx % phase_count
            if step > 0:
                sizes[pos] += 1
                diff -= 1
            else:
                if sizes[pos] > 1:
                    sizes[pos] -= 1
                    diff += 1
            idx += 1

        segments: list[dict[str, int]] = []
        cursor = 1
        remaining_written = safe_existing
        for size in sizes:
            start = cursor
            end = min(safe_total, start + size - 1)
            cursor = end + 1

            segment_len = max(0, end - start + 1)
            written_take = min(segment_len, max(0, remaining_written))
            remaining_written = max(0, remaining_written - written_take)

            if written_take > 0:
                written_start = start
                written_end = start + written_take - 1
            else:
                written_start = 0
                written_end = 0

            planned_start = (written_end + 1) if written_take > 0 else start
            if planned_start > end:
                planned_start = 0
                planned_end = 0
            else:
                planned_end = end

            segments.append(
                {
                    "phase_start": start,
                    "phase_end": end,
                    "written_start": written_start,
                    "written_end": written_end,
                    "planned_start": planned_start,
                    "planned_end": planned_end,
                }
            )
        return segments

    errors: list[str] = []
    with get_db() as db:
        project = db.execute(
            "SELECT id, name, structure, custom_structure, chapter_words, word_target, model_main, temperature "
            "FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()
        if not project:
            raise HTTPException(404, "项目不存在")
        existing_outline = int(
            (db.execute("SELECT COUNT(*) AS c FROM outlines WHERE project_id = ?", (project_id,)).fetchone() or {"c": 0})["c"]
            or 0
        )
        chapters = db.execute(
            "SELECT chapter_num, title, synopsis, word_count FROM chapters WHERE project_id = ? "
            "ORDER BY chapter_num ASC, sort_order ASC",
            (project_id,),
        ).fetchall()

    if not force and existing_outline > 0:
        return 0, existing_outline, errors
    if not chapters:
        errors.append("outline:项目没有章节，无法按章节生成大纲")
        return 0, 0, errors

    project_word_target = max(0, _safe_int(project["word_target"], 0))
    chapter_word_target = max(0, _safe_int(project["chapter_words"], 0))
    chapter_count_existing = len(chapters)
    existing_total_words = sum(max(0, _safe_int(ch.get("word_count") if isinstance(ch, dict) else ch["word_count"], 0)) for ch in chapters)
    theoretical_chapter_count = (
        (project_word_target + chapter_word_target - 1) // chapter_word_target
        if project_word_target > 0 and chapter_word_target > 0
        else 0
    )
    target_total_chapters = max(chapter_count_existing, theoretical_chapter_count or chapter_count_existing)
    target_total_chapters = max(1, min(1000, int(target_total_chapters)))
    remaining_chapter_count = max(0, target_total_chapters - chapter_count_existing)

    phase_labels = _resolve_outline_phase_labels(project["structure"], project["custom_structure"])
    target_count = max(1, min(12, len(phase_labels)))
    phase_segments = _phase_allocation(
        phase_labels[:target_count],
        target_total_chapters,
        chapter_count_existing,
    )
    chapter_lines: list[str] = []
    for ch in chapters[:160]:
        chapter_num = int(ch["chapter_num"] or 0)
        title = _clip(str(ch["title"] or "").strip() or f"第{chapter_num}章", 80)
        synopsis = _clip(str(ch["synopsis"] or "").strip(), 180)
        ch_word_count = _safe_int(ch.get("word_count") if isinstance(ch, dict) else ch["word_count"], 0)
        word_suffix = f"（约{ch_word_count}字）" if ch_word_count > 0 else ""
        chapter_lines.append(f"- 第{chapter_num}章 {title}{word_suffix}：{synopsis or '（暂无梗概）'}")
    chapter_block = "\n".join(chapter_lines)

    agent_router._init_services()
    llm = agent_router._llm
    if llm is None:
        errors.append("outline:模型服务未初始化")
        return 0, 0, errors

    model_name = str(project["model_main"] or "claude-sonnet-4")
    temperature = float(project["temperature"] if project["temperature"] is not None else 0.35)
    prompt = f"""
请基于“已有章节梗概”反推阶段大纲，不要发明与章节矛盾的信息。

输出 JSON 对象，格式必须为：
{{
  "outlines": [
    {{
      "phase": "阶段名",
      "title": "阶段标题",
      "content": "该阶段的核心推进（80-220字）",
      "word_range": "可留空"
    }}
  ]
}}

要求：
1) 必须输出 {target_count} 条，阶段名优先使用：{ " / ".join(phase_labels[:target_count]) }。
2) content 必须基于已给章节信息总结，不要新增关键设定。
3) 标题简洁且可执行，避免空话。
4) 若可判断字数节奏，word_range 尽量填写为区间（如 18000-24000），且总量尽量贴近项目目标总字数。
5) 必须覆盖“第1章~第{target_total_chapters}章”的完整长线规划，不能只写已存在章节。
6) 已写章节（第1~第{chapter_count_existing}章）必须体现在阶段内容中；待规划章节（第{chapter_count_existing + 1 if remaining_chapter_count > 0 else chapter_count_existing}~第{target_total_chapters}章）必须给出明确后续推进。
7) 每条 content 请显式写出该阶段覆盖的章节范围与“已写回顾/后续规划”边界（如果同时包含两者）。

【项目字数目标】
- 目标总字数：{project_word_target or "未设定"}
- 每章目标字数：{chapter_word_target or "未设定"}
- 理论目标章节数（由总字数/每章字数推导）：{theoretical_chapter_count or "未设定"}
- 当前已有章节数：{chapter_count_existing}
- 当前已写总字数（按章节统计）：{existing_total_words}
- 本次规划总章节目标：{target_total_chapters}
- 待新增规划章节数：{remaining_chapter_count}

【已有章节信息】
{chapter_block}
    """.strip()

    try:
        raw = await llm.chat(
            model=model_name,
            messages=[
                {"role": "system", "content": "你是小说结构编辑，只输出合法JSON对象，不要附加解释。"},
                {"role": "user", "content": prompt},
            ],
            temperature=min(max(temperature, 0.0), 0.5),
            max_tokens=min(4200, 1000 + target_count * 320),
        )
    except Exception as exc:
        errors.append(_clip(f"outline:{exc}", 260))
        return 0, 0, errors

    payload = _parse_json_object(raw)
    raw_items = payload.get("outlines", []) if isinstance(payload.get("outlines"), list) else []
    if not raw_items:
        errors.append("outline:模型返回为空或格式不可解析")
        return 0, 0, errors

    normalized_items: list[dict[str, str]] = []
    parsed_ranges: list[tuple[int, int] | None] = []
    for idx in range(target_count):
        src = raw_items[idx] if idx < len(raw_items) and isinstance(raw_items[idx], dict) else {}
        phase = _clip(str(src.get("phase", "")).strip() or phase_labels[idx], 20)
        title = _clip(str(src.get("title", "")).strip() or f"{phase}阶段", 80)
        content = _clip(str(src.get("content", "")).strip(), 1000)
        word_range = _clip(str(src.get("word_range", "")).strip(), 60)
        parsed = _parse_word_range(word_range)
        if project_word_target > 0 and parsed is None:
            word_range = _default_phase_word_range(idx, target_count, project_word_target)
            parsed = _parse_word_range(word_range)
        if not content:
            content = "（待补充）"

        seg = phase_segments[idx] if idx < len(phase_segments) else {
            "phase_start": 1,
            "phase_end": 1,
            "written_start": 0,
            "written_end": 0,
            "planned_start": 0,
            "planned_end": 0,
        }
        phase_start = int(seg["phase_start"])
        phase_end = int(seg["phase_end"])
        written_start = int(seg["written_start"])
        written_end = int(seg["written_end"])
        planned_start = int(seg["planned_start"])
        planned_end = int(seg["planned_end"])

        range_prefix = f"【章节范围：第{phase_start}-{phase_end}章】"
        if written_start > 0 and planned_start > 0:
            coverage_prefix = (
                f"【已写回顾：第{written_start}-{written_end}章；"
                f"后续规划：第{planned_start}-{planned_end}章】"
            )
        elif written_start > 0:
            coverage_prefix = f"【已写回顾：第{written_start}-{written_end}章】"
        elif planned_start > 0:
            coverage_prefix = f"【后续规划：第{planned_start}-{planned_end}章】"
        else:
            coverage_prefix = "【阶段内容待规划】"
        content = _clip(f"{range_prefix}{coverage_prefix} {content}".strip(), 1200)

        parsed_ranges.append(parsed)
        normalized_items.append(
            {
                "phase": phase,
                "title": title,
                "content": content,
                "word_range": word_range,
            }
        )

    if project_word_target > 0:
        mids = [int((rng[0] + rng[1]) / 2) for rng in parsed_ranges if rng]
        if mids:
            estimated_total = sum(mids)
            ratio = estimated_total / max(1, project_word_target)
            if ratio < 0.6 or ratio > 1.5:
                errors.append(
                    f"outline:word_range 总量约 {estimated_total}，偏离目标总字数 {project_word_target}，已按目标字数重算区间"
                )
                for idx in range(len(normalized_items)):
                    normalized_items[idx]["word_range"] = _default_phase_word_range(idx, target_count, project_word_target)

    inserted = 0
    with get_db() as db:
        if force:
            db.execute("DELETE FROM outlines WHERE project_id = ?", (project_id,))
        for idx, item in enumerate(normalized_items):
            db.execute(
                "INSERT INTO outlines (project_id, structure, phase, phase_order, title, content, word_range) "
                "VALUES (?,?,?,?,?,?,?)",
                (
                    project_id,
                    str(project["structure"] or "起承转合"),
                    item["phase"],
                    idx,
                    item["title"],
                    item["content"],
                    item["word_range"],
                ),
            )
            inserted += 1
    return inserted, 0, errors


async def _generate_scopes_from_chapters(
    *,
    project_id: str,
    scopes: set[str],
    force: bool,
) -> dict[str, Any]:
    with get_db() as db:
        exists = db.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not exists:
        raise HTTPException(404, "项目不存在")

    if force:
        _clear_scopes_before_chapter_generate(project_id, scopes)

    inserted = {"outline": 0, "characters": 0, "worldbuilding": 0}
    skipped = {"outline": 0, "characters": 0, "worldbuilding": 0}
    errors: list[str] = []
    entity_extract = {
        "chapters_scanned": 0,
        "candidates_inserted": 0,
        "candidates_skipped": 0,
        "created": 0,
        "merged": 0,
    }

    before_counts = _planning_counts_for_project(project_id)
    entity_inserted, entity_errors, entity_stats = await _generate_entities_from_chapters(
        project_id=project_id,
        scopes=scopes,
    )
    inserted["characters"] += int(entity_inserted.get("characters", 0) or 0)
    inserted["worldbuilding"] += int(entity_inserted.get("worldbuilding", 0) or 0)
    errors.extend(entity_errors)
    for k in entity_extract.keys():
        entity_extract[k] = int(entity_stats.get(k, 0) or 0)

    if "outline" in scopes:
        outline_inserted, outline_skipped, outline_errors = await _generate_outline_from_chapters(
            project_id=project_id,
            force=force,
        )
        inserted["outline"] += int(outline_inserted or 0)
        skipped["outline"] += int(outline_skipped or 0)
        errors.extend(outline_errors)

    after_counts = _planning_counts_for_project(project_id)
    inserted["characters"] = max(0, int(after_counts["characters"] - before_counts["characters"]))
    inserted["worldbuilding"] = max(0, int(after_counts["worldbuilding"] - before_counts["worldbuilding"]))
    if "outline" not in scopes:
        inserted["outline"] = 0
        skipped["outline"] = 0

    scope_label = "、".join(
        [s for s in ("characters", "worldbuilding", "outline") if s in scopes]
    ) or "none"
    message = (
        f"章节派生生成完成（{scope_label}）："
        f"新增 角色 {inserted['characters']}、世界观 {inserted['worldbuilding']}、大纲 {inserted['outline']}；"
        f"跳过 大纲 {skipped['outline']}。"
    )
    if errors:
        message += f"（有 {len(errors)} 条告警）"

    return {
        "channel": "chapters_derived",
        "inserted": inserted,
        "skipped": skipped,
        "errors": errors,
        "entity_extract": entity_extract,
        "message": message,
    }


@router.get("/")
def list_projects():
    with get_db() as db:
        rows = db.execute(
            "SELECT id, name, genre, description, structure, custom_structure, chapter_words, priority, "
            "status, word_target, model_main, model_secondary, temperature, created_at, updated_at "
            "FROM projects ORDER BY updated_at DESC"
        ).fetchall()
        projects = []
        for r in rows:
            p = dict(r)
            # 附加统计
            stats = db.execute(
                "SELECT COUNT(*) as chapter_count, COALESCE(SUM(word_count),0) as total_words "
                "FROM chapters WHERE project_id = ?", (r["id"],)
            ).fetchone()
            p["chapter_count"] = stats["chapter_count"]
            p["total_words"] = stats["total_words"]
            projects.append(p)
        return projects


@router.get("/{project_id}/export")
def export_project(project_id: str, format: str = "json"):
    export_format = str(format or "json").strip().lower()
    if export_format not in {"json", "txt", "md"}:
        raise HTTPException(400, "format 仅支持 json/txt/md")

    bundle = _load_project_bundle(project_id)
    project_name = str((bundle.get("project") or {}).get("name", "project"))
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_name = _safe_filename(project_name)

    if export_format == "json":
        filename = f"{safe_name}_{stamp}.sanhuoai.json"
        content = json.dumps(bundle, ensure_ascii=False, indent=2)
        mime_type = "application/json"
    elif export_format == "md":
        filename = f"{safe_name}_{stamp}.md"
        content = _build_novel_text(bundle, markdown=True)
        mime_type = "text/markdown"
    else:
        filename = f"{safe_name}_{stamp}.txt"
        content = _build_novel_text(bundle, markdown=False)
        mime_type = "text/plain"

    return {"filename": filename, "mime_type": mime_type, "content": content}


@router.post("/import")
async def import_project(
    file: UploadFile = File(...),
    project_name: str = Form(default=""),
):
    filename = str(file.filename or "").strip() or "import.txt"
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "导入文件为空")

    text = _decode_text_bytes(raw).strip()
    ext = filename.lower().split(".")[-1] if "." in filename else ""
    as_json = ext in {"json"} or text.startswith("{")

    if as_json:
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                if parsed.get("type") == "sanhuoai_project_export" or ("project" in parsed and "chapters" in parsed):
                    result = _insert_project_from_bundle(parsed, override_name=project_name)
                    result["message"] = f"项目导入完成：新增 {result['imported']['chapters']} 章，可直接续写。"
                    return result
        except Exception:
            # 若 JSON 解析失败，降级为纯文本导入
            pass

    inferred_name = project_name.strip() or _safe_filename(filename.rsplit(".", 1)[0])
    result = _insert_plain_text_as_project(text, project_name=inferred_name)
    auto_bootstrap = await _auto_bootstrap_plain_import(str(result.get("project_id", "")))
    auto_inserted = dict(auto_bootstrap.get("inserted", {}) or {})
    auto_errors = list(auto_bootstrap.get("errors", []) or [])
    result["auto_generated"] = auto_inserted
    result["auto_generate_errors"] = auto_errors

    auto_total = (
        int(auto_inserted.get("outline", 0) or 0)
        + int(auto_inserted.get("characters", 0) or 0)
        + int(auto_inserted.get("worldbuilding", 0) or 0)
    )
    if auto_total > 0:
        result["message"] = (
            f"旧书导入完成：新增 {result['imported']['chapters']} 章；"
            f"已自动生成 大纲 {int(auto_inserted.get('outline', 0) or 0)}、"
            f"角色 {int(auto_inserted.get('characters', 0) or 0)}、"
            f"世界观 {int(auto_inserted.get('worldbuilding', 0) or 0)}。"
        )
    else:
        result["message"] = (
            f"旧书导入完成：新增 {result['imported']['chapters']} 章。"
            "未自动生成大纲/角色/世界观（可在角色管理/世界观/故事大纲页点击“按章节生成”）。"
        )
    return result


@router.post("/{project_id}/generate-from-chapters")
async def generate_from_chapters(project_id: str, req: GenerateFromChaptersRequest):
    scopes = _normalized_generate_scope(req.scope)
    result = await _generate_scopes_from_chapters(
        project_id=project_id,
        scopes=scopes,
        force=bool(req.force),
    )
    return result


@router.post("/")
def create_project(req: ProjectCreate):
    with get_db() as db:
        db.execute(
            "INSERT INTO projects (name, genre, description, structure, custom_structure, chapter_words, priority, "
            "model_main, model_secondary, temperature, embedding_dim, word_target) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                req.name,
                req.genre,
                req.description,
                req.structure,
                req.custom_structure,
                req.chapter_words,
                req.priority,
                req.model_main,
                req.model_secondary,
                req.temperature,
                req.embedding_dim,
                req.word_target,
            ),
        )
        row = db.execute("SELECT * FROM projects ORDER BY created_at DESC LIMIT 1").fetchone()
        return dict(row)


@router.get("/{project_id}")
def get_project(project_id: str):
    with get_db() as db:
        row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not row:
            raise HTTPException(404, "项目不存在")
        return dict(row)


@router.put("/{project_id}")
def update_project(project_id: str, req: ProjectUpdate):
    updates, values = [], []
    for field, val in req.model_dump(exclude_none=True).items():
        updates.append(f"{field} = ?")
        values.append(val)
    if not updates:
        raise HTTPException(400, "无更新字段")
    values.append(project_id)
    with get_db() as db:
        db.execute(f"UPDATE projects SET {', '.join(updates)} WHERE id = ?", values)
        row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not row:
            raise HTTPException(404, "项目不存在")
        return dict(row)


@router.delete("/{project_id}")
def delete_project(project_id: str):
    # 先清理向量库中的该项目残留（避免磁盘堆积/脏索引）
    try:
        agent_router._init_services()
        chunk_manager = agent_router._chunk_manager
        if chunk_manager is not None:
            chunk_manager.delete_project(project_id)
    except Exception:
        pass

    with get_db() as db:
        db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        return {"ok": True}
