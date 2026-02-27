"""RAG混合检索模块 - BM25 + 向量语义检索"""
import sqlite3
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

from db import get_data_dir
from memory.chunk_manager import ChunkManager

rag_router = APIRouter()

_chunk_manager: Optional[ChunkManager] = None


def _get_chunk_manager() -> Optional[ChunkManager]:
    global _chunk_manager
    if _chunk_manager is None:
        import os
        data_dir = get_data_dir()
        db_path = os.path.join(data_dir, "sanhuoai.db")
        chroma_path = os.path.join(data_dir, "chromadb")
        try:
            _chunk_manager = ChunkManager(db_path, chroma_path)
        except Exception:
            return None
    return _chunk_manager


class SearchRequest(BaseModel):
    project_id: str
    query: str
    source_type: Optional[str] = None
    top_k: int = 10
    bm25_weight: float = 0.4
    vector_weight: float = 0.6


class SearchResult(BaseModel):
    chunk_id: str
    content: str
    score: float
    source_type: str
    metadata: dict = {}


class SearchResponse(BaseModel):
    results: list[SearchResult]
    query: str


def _bm25_search(db_path: str, project_id: str, query: str, top_k: int = 20) -> list[dict]:
    """FTS5 BM25关键词检索"""
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute(
            """SELECT mc.id, mc.content, mc.source_type, mc.importance,
                      bm25(chunks_fts) as bm25_score
               FROM chunks_fts
               JOIN memory_chunks mc ON mc.rowid = chunks_fts.rowid
               WHERE chunks_fts MATCH ? AND mc.project_id = ?
               ORDER BY bm25_score
               LIMIT ?""",
            (query, project_id, top_k),
        ).fetchall()
        # bm25() returns negative scores (lower = better), normalize to 0-1
        if not rows:
            return []
        min_s = min(r["bm25_score"] for r in rows)
        max_s = max(r["bm25_score"] for r in rows)
        span = max_s - min_s if max_s != min_s else 1.0
        return [
            {
                "id": r["id"], "content": r["content"],
                "source_type": r["source_type"],
                "importance": r["importance"],
                "score": 1.0 - (r["bm25_score"] - min_s) / span,
            }
            for r in rows
        ]
    except Exception:
        return []
    finally:
        db.close()


def _apply_importance_and_decay(results: list[dict]) -> list[dict]:
    """重要度加权 + 时间衰减"""
    for r in results:
        importance = r.get("importance", 0.5)
        base = r.get("final_score", r.get("score", 0.0))
        r["final_score"] = base * (0.5 + importance * 0.5)
    return results


@rag_router.post("/search", response_model=SearchResponse)
async def hybrid_search(req: SearchRequest):
    """混合检索: BM25关键词(0.4) + 向量语义(0.6)"""
    import os
    data_dir = get_data_dir()
    db_path = os.path.join(data_dir, "sanhuoai.db")

    cm = _get_chunk_manager()

    # 1. BM25检索
    bm25_results = _bm25_search(db_path, req.project_id, req.query, req.top_k * 2)

    # 2. 向量检索
    vector_results = []
    if cm:
        try:
            vector_results = cm.search(
                project_id=req.project_id,
                query=req.query,
                source_type=req.source_type,
                top_k=req.top_k * 2,
            )
        except Exception:
            vector_results = []

    # 3. 混合评分 (RRF-style fusion)
    score_map: dict[str, dict] = {}

    for r in bm25_results:
        cid = r["id"]
        score_map[cid] = {
            **r,
            "final_score": r["score"] * req.bm25_weight,
        }

    for r in vector_results:
        cid = r["id"]
        if cid in score_map:
            score_map[cid]["final_score"] += r["score"] * req.vector_weight
        else:
            score_map[cid] = {
                **r,
                "final_score": r["score"] * req.vector_weight,
            }

    # 4. 重要度加权
    merged = list(score_map.values())
    merged = _apply_importance_and_decay(merged)

    # 5. 排序截断
    merged.sort(key=lambda x: x.get("final_score", 0), reverse=True)
    merged = merged[: req.top_k]

    return SearchResponse(
        query=req.query,
        results=[
            SearchResult(
                chunk_id=r["id"],
                content=r["content"],
                score=r.get("final_score", 0),
                source_type=r.get("source_type", "unknown"),
                metadata=r.get("metadata", {}),
            )
            for r in merged
        ],
    )
