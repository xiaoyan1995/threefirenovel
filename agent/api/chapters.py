"""章节 CRUD API"""
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import Optional
import hashlib
import time
from db import get_db
from api.content import auto_extract_entity_candidates_background

router = APIRouter()

_AUTO_ENTITY_EXTRACT_MIN_INTERVAL_SEC = 180
_AUTO_ENTITY_EXTRACT_MIN_GROWTH_CHARS = 600
_auto_entity_extract_state: dict[str, dict[str, object]] = {}


class ChapterCreate(BaseModel):
    project_id: str
    title: str
    chapter_num: int
    phase: str = ""
    synopsis: str = ""


class ChapterUpdate(BaseModel):
    title: Optional[str] = None
    phase: Optional[str] = None
    synopsis: Optional[str] = None
    status: Optional[str] = None
    sort_order: Optional[int] = None


class ChapterBatchDeleteRequest(BaseModel):
    project_id: str
    chapter_ids: list[str]


@router.get("/")
def list_chapters(project_id: str):
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM chapters WHERE project_id = ? ORDER BY sort_order",
            (project_id,),
        ).fetchall()
        return [dict(r) for r in rows]


@router.post("/")
def create_chapter(req: ChapterCreate):
    with get_db() as db:
        db.execute(
            "INSERT INTO chapters (project_id, chapter_num, title, phase, synopsis, sort_order) "
            "VALUES (?,?,?,?,?,?)",
            (req.project_id, req.chapter_num, req.title, req.phase, req.synopsis, req.chapter_num),
        )
        row = db.execute(
            "SELECT * FROM chapters WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
            (req.project_id,),
        ).fetchone()
        return dict(row)


@router.get("/{chapter_id}")
def get_chapter(chapter_id: str):
    with get_db() as db:
        row = db.execute("SELECT * FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
        if not row:
            raise HTTPException(404, "章节不存在")
        # 附带段落
        paras = db.execute(
            "SELECT * FROM chapter_paragraphs WHERE chapter_id = ? ORDER BY para_index",
            (chapter_id,),
        ).fetchall()
        result = dict(row)
        result["paragraphs"] = [dict(p) for p in paras]
        return result


@router.put("/{chapter_id}")
def update_chapter(chapter_id: str, req: ChapterUpdate):
    updates, values = [], []
    for field, val in req.model_dump(exclude_none=True).items():
        updates.append(f"{field} = ?")
        values.append(val)
    if not updates:
        raise HTTPException(400, "无更新字段")
    values.append(chapter_id)
    with get_db() as db:
        db.execute(f"UPDATE chapters SET {', '.join(updates)} WHERE id = ?", values)
        row = db.execute("SELECT * FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
        if not row:
            raise HTTPException(404, "章节不存在")
        return dict(row)


@router.delete("/{chapter_id}")
def delete_chapter(chapter_id: str):
    with get_db() as db:
        db.execute("DELETE FROM chapters WHERE id = ?", (chapter_id,))
        return {"ok": True}


@router.post("/batch-delete")
def batch_delete_chapters(req: ChapterBatchDeleteRequest):
    project_id = str(req.project_id or "").strip()
    if not project_id:
        raise HTTPException(400, "project_id 不能为空")

    raw_ids = req.chapter_ids or []
    deduped_ids: list[str] = []
    seen: set[str] = set()
    for chapter_id in raw_ids:
        cid = str(chapter_id or "").strip()
        if not cid or cid in seen:
            continue
        seen.add(cid)
        deduped_ids.append(cid)
    if not deduped_ids:
        raise HTTPException(400, "chapter_ids 不能为空")

    placeholders = ",".join(["?"] * len(deduped_ids))
    query_params = [project_id, *deduped_ids]

    with get_db() as db:
        rows = db.execute(
            f"SELECT id FROM chapters WHERE project_id = ? AND id IN ({placeholders})",
            query_params,
        ).fetchall()
        existing_ids = [str(r["id"]) for r in rows]
        if not existing_ids:
            return {
                "ok": True,
                "requested": len(deduped_ids),
                "deleted": 0,
                "not_found": len(deduped_ids),
                "deleted_ids": [],
            }

        delete_placeholders = ",".join(["?"] * len(existing_ids))
        db.execute(
            f"DELETE FROM chapters WHERE project_id = ? AND id IN ({delete_placeholders})",
            [project_id, *existing_ids],
        )
        deleted = int(db.execute("SELECT changes()").fetchone()[0] or 0)
        not_found = max(0, len(deduped_ids) - deleted)
        return {
            "ok": True,
            "requested": len(deduped_ids),
            "deleted": deleted,
            "not_found": not_found,
            "deleted_ids": existing_ids,
        }


# --- 段落 API ---

class ParagraphSave(BaseModel):
    chapter_id: str
    auto_extract: bool = True
    paragraphs: list[dict]  # [{para_index, content, scene_tag?, pov_char_id?}]


@router.post("/paragraphs/save")
async def save_paragraphs(req: ParagraphSave, background_tasks: BackgroundTasks):
    """批量保存章节段落 (全量替换)"""
    source_parts: list[str] = []
    project_id = ""
    with get_db() as db:
        chapter_row = db.execute(
            "SELECT project_id FROM chapters WHERE id = ?",
            (req.chapter_id,),
        ).fetchone()
        project_id = str(chapter_row["project_id"]) if chapter_row else ""
        db.execute("DELETE FROM chapter_paragraphs WHERE chapter_id = ?", (req.chapter_id,))
        for p in req.paragraphs:
            content = p.get("content", "")
            content_text = str(content or "").strip()
            if content_text:
                source_parts.append(content_text)
            db.execute(
                "INSERT INTO chapter_paragraphs (chapter_id, para_index, content, char_count, scene_tag, pov_char_id) "
                "VALUES (?,?,?,?,?,?)",
                (req.chapter_id, p["para_index"], content, len(content),
                 p.get("scene_tag"), p.get("pov_char_id")),
            )
        # 更新章节字数
        total = db.execute(
            "SELECT COALESCE(SUM(char_count),0) as total FROM chapter_paragraphs WHERE chapter_id = ?",
            (req.chapter_id,),
        ).fetchone()["total"]
        db.execute("UPDATE chapters SET word_count = ? WHERE id = ?", (total, req.chapter_id))

    queued = False
    if req.auto_extract and project_id and source_parts:
        source_text = "\n".join(source_parts)
        text_hash = hashlib.sha1(source_text.encode("utf-8")).hexdigest()
        now_ts = float(time.time())
        prev = _auto_entity_extract_state.get(req.chapter_id) or {}
        prev_hash = str(prev.get("hash") or "")
        prev_len = int(prev.get("len") or 0)
        prev_ts = float(prev.get("ts") or 0.0)

        should_queue = False
        if text_hash != prev_hash:
            if not prev_hash:
                should_queue = True
            else:
                elapsed = max(0.0, now_ts - prev_ts)
                growth = abs(len(source_text) - prev_len)
                if (
                    elapsed >= _AUTO_ENTITY_EXTRACT_MIN_INTERVAL_SEC
                    or growth >= _AUTO_ENTITY_EXTRACT_MIN_GROWTH_CHARS
                ):
                    should_queue = True

        if should_queue:
            queued = True
            _auto_entity_extract_state[req.chapter_id] = {
                "hash": text_hash,
                "len": len(source_text),
                "ts": now_ts,
            }
            background_tasks.add_task(
                auto_extract_entity_candidates_background,
                project_id,
                req.chapter_id,
                source_text,
                8,
            )

    return {"ok": True, "word_count": total, "entity_extract_queued": queued}
