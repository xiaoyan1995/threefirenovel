from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from db import get_db

router = APIRouter(prefix="/api/beats", tags=["beats"])

class BeatCreate(BaseModel):
    chapter_id: str
    order_index: int
    content: str
    status: Optional[str] = "pending"

class BeatUpdate(BaseModel):
    order_index: Optional[int] = None
    content: Optional[str] = None
    status: Optional[str] = None

@router.get("/")
def get_beats(chapter_id: str):
    with get_db() as db:
        cursor = db.execute(
            "SELECT * FROM chapter_beats WHERE chapter_id = ? ORDER BY order_index ASC", 
            (chapter_id,)
        )
        columns = [col[0] for col in cursor.description]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]

@router.post("/")
def create_beat(beat: BeatCreate):
    with get_db() as db:
        cursor = db.execute(
            "INSERT INTO chapter_beats (chapter_id, order_index, content, status) VALUES (?, ?, ?, ?) RETURNING *",
            (beat.chapter_id, beat.order_index, beat.content, beat.status)
        )
        row = cursor.fetchone()
        db.commit()
        columns = [col[0] for col in cursor.description]
        return dict(zip(columns, row))

@router.put("/{beat_id}")
def update_beat(beat_id: str, beat: BeatUpdate):
    updates = []
    params = []
    
    if beat.order_index is not None:
        updates.append("order_index = ?")
        params.append(beat.order_index)
    if beat.content is not None:
        updates.append("content = ?")
        params.append(beat.content)
    if beat.status is not None:
        updates.append("status = ?")
        params.append(beat.status)
        
    if not updates:
        return {"success": True}
        
    updates.append("updated_at = datetime('now')")
    params.append(beat_id)
    
    query = f"UPDATE chapter_beats SET {', '.join(updates)} WHERE id = ? RETURNING *"
    
    with get_db() as db:
        cursor = db.execute(query, params)
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Beat not found")
        db.commit()
        columns = [col[0] for col in cursor.description]
        return dict(zip(columns, row))

@router.delete("/{beat_id}")
def delete_beat(beat_id: str):
    with get_db() as db:
        db.execute("DELETE FROM chapter_beats WHERE id = ?", (beat_id,))
        db.commit()
    return {"success": True}
