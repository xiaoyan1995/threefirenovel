"""Memory regression check.

Checks the critical long-memory path:
1) DB connectivity and project existence
2) ChunkManager.add_chunk write
3) ChunkManager.search retrieval
4) RAG hybrid path smoke
"""
from __future__ import annotations

import os
import sqlite3
import uuid

from memory.chunk_manager import ChunkManager
from rag.search import _bm25_search


def main():
    data_dir = os.environ.get("SANHUOAI_DATA_DIR") or os.path.join(os.environ.get("APPDATA", ""), "sanhuoai")
    db_path = os.path.join(data_dir, "sanhuoai.db")
    chroma_path = os.path.join(data_dir, "chromadb")

    if not os.path.exists(db_path):
        raise SystemExit(f"[FAIL] DB not found: {db_path}")

    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    row = db.execute("SELECT id FROM projects ORDER BY created_at ASC LIMIT 1").fetchone()
    if not row:
        pid = uuid.uuid4().hex
        db.execute(
            "INSERT INTO projects (id, name, genre) VALUES (?, ?, ?)",
            (pid, "Memory Regression Project", "测试"),
        )
        db.commit()
    else:
        pid = row["id"]
    db.close()

    cm = ChunkManager(db_path, chroma_path)
    marker = f"memoryregression{uuid.uuid4().hex[:12]}"
    content = f"Regression check chunk {marker} for write search validation."
    chunk_id = cm.add_chunk(
        project_id=pid,
        source_type="agent",
        content=content,
        source_id="regression",
        summary=marker,
        importance=0.7,
        metadata={"regression": True, "marker": marker},
    )
    if not chunk_id:
        raise SystemExit("[FAIL] add_chunk returned empty id")

    vector_results = cm.search(project_id=pid, query=marker, top_k=5)
    if not any(r.get("id") == chunk_id for r in vector_results):
        raise SystemExit("[FAIL] vector search did not return inserted chunk")

    bm25_results = _bm25_search(db_path, pid, marker, top_k=10)
    if not bm25_results:
        raise SystemExit("[FAIL] bm25 search returned empty")

    print("[PASS] memory write/search path is healthy")
    print(f"[INFO] project_id={pid}")
    print(f"[INFO] chunk_id={chunk_id}")


if __name__ == "__main__":
    main()
