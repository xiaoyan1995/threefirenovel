"""记忆块管理器 - SQLite + ChromaDB双写同步"""
import chromadb
import json
from typing import Optional

from db import get_db_with_path


class ChunkManager:
    """管理memory_chunks表与ChromaDB集合的同步"""

    def __init__(self, db_path: str, chroma_path: str):
        self.db_path = db_path
        self.chroma = chromadb.PersistentClient(path=chroma_path)
        self._init_collections()

    def _init_collections(self):
        """初始化ChromaDB集合"""
        self.paragraphs = self.chroma.get_or_create_collection("novel_paragraphs")
        self.characters = self.chroma.get_or_create_collection("novel_characters")
        self.worldbuilding = self.chroma.get_or_create_collection("novel_worldbuilding")
        self.memory = self.chroma.get_or_create_collection("novel_memory")
        self.outlines = self.chroma.get_or_create_collection("novel_outlines")

    def add_chunk(
        self,
        project_id: str,
        source_type: str,
        content: str,
        source_id: Optional[str] = None,
        summary: Optional[str] = None,
        importance: float = 0.5,
        metadata: Optional[dict] = None,
    ) -> str:
        """添加记忆块，同时写入SQLite和ChromaDB"""
        with get_db_with_path(self.db_path) as db:
            cursor = db.execute(
                """INSERT INTO memory_chunks
                   (project_id, source_type, source_id, content, summary,
                    char_count, importance, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   RETURNING id""",
                (project_id, source_type, source_id, content, summary,
                 len(content), importance, json.dumps(metadata or {}, ensure_ascii=False)),
            )
            chunk_id = cursor.fetchone()[0]

        # 同步到对应的ChromaDB集合
        collection = self._get_collection(source_type)
        collection.add(
            ids=[chunk_id],
            documents=[content],
            metadatas=[{
                "project_id": project_id,
                "source_type": source_type,
                "source_id": source_id or "",
                "importance": importance,
            }],
        )
        return chunk_id

    def close(self) -> None:
        """保留关闭接口，便于服务生命周期管理。"""
        return None

    def search(
        self,
        project_id: str,
        query: str,
        source_type: Optional[str] = None,
        top_k: int = 10,
    ) -> list[dict]:
        """向量语义检索"""
        collection = self._get_collection(source_type) if source_type else self.memory
        results = collection.query(
            query_texts=[query],
            n_results=top_k,
            where={"project_id": project_id},
        )
        return [
            {
                "id": id_,
                "content": doc,
                "score": 1 - dist,
                "importance": float((meta or {}).get("importance", 0.5)),
                "source_type": (meta or {}).get("source_type", source_type or "memory"),
                "metadata": meta or {},
            }
            for id_, doc, dist, meta in zip(
                results["ids"][0],
                results["documents"][0],
                results["distances"][0],
                results["metadatas"][0],
            )
        ]

    def delete_project(self, project_id: str) -> None:
        """按项目清理 Chroma 向量数据。SQLite 由外层 FK 级联删除。"""
        collections = [
            self.paragraphs,
            self.characters,
            self.worldbuilding,
            self.memory,
            self.outlines,
        ]
        for coll in collections:
            try:
                coll.delete(where={"project_id": project_id})
            except Exception:
                # 兜底：某些集合可能不存在该过滤字段或当前无数据
                continue

    def _get_collection(self, source_type: str):
        """根据来源类型返回对应的ChromaDB集合"""
        mapping = {
            "chapter": self.paragraphs,
            "character": self.characters,
            "worldbuilding": self.worldbuilding,
            "outline": self.outlines,
        }
        return mapping.get(source_type, self.memory)
