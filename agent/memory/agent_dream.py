"""记忆整合模块 - 参考VCPToolBox AgentDream
功能:
- merge: 合并相似/冗余记忆块
- delete: 清理过期/低价值记忆
- insight: 从记忆中提炼高层洞察
- summary: 生成章节/角色摘要
"""
import json
import sqlite3
from typing import Optional


class AgentDream:
    """记忆整合引擎，模拟人类睡眠时的记忆整理"""

    def __init__(self, db: sqlite3.Connection, llm_client, chunk_manager=None):
        self.db = db
        self.llm = llm_client
        self.cm = chunk_manager

    async def consolidate(self, project_id: str):
        """执行一轮记忆整合"""
        await self._merge_similar(project_id)
        await self._extract_insights(project_id)
        await self._cleanup_low_value(project_id)

    async def _merge_similar(self, project_id: str):
        """合并语义相似的记忆块"""
        if not self.cm:
            return
        # 获取所有记忆块
        rows = self.db.execute(
            "SELECT id, content, importance FROM memory_chunks WHERE project_id = ? ORDER BY importance DESC LIMIT 100",
            (project_id,),
        ).fetchall()

        if len(rows) < 2:
            return

        # 用向量检索找相似对
        for row in rows[:20]:
            similar = self.cm.search(project_id, row[1][:200], top_k=3)
            for s in similar:
                if s["id"] != row[0] and s["score"] > 0.9:
                    # 用LLM合并
                    try:
                        merged = await self.llm.chat(
                            model="gemini/gemini-2.0-flash",
                            messages=[
                                {"role": "system", "content": "合并以下两段相似内容为一段，保留所有关键信息。只输出合并结果。"},
                                {"role": "user", "content": f"内容A:\n{row[1][:500]}\n\n内容B:\n{s['content'][:500]}"},
                            ],
                            temperature=0.2, max_tokens=500,
                        )
                        # 写入合并后的新chunk
                        new_importance = max(row[2], s.get("metadata", {}).get("importance", 0.5))
                        new_id = self.cm.add_chunk(
                            project_id=project_id,
                            source_type="consolidation",
                            content=merged,
                            importance=new_importance,
                            metadata={"merged_from": [row[0], s["id"]]},
                        )
                        # 记录整合日志
                        self.db.execute(
                            """INSERT INTO memory_consolidation
                               (project_id, action, source_chunk_ids, result_chunk_id, reasoning)
                               VALUES (?, 'merge', ?, ?, '语义相似度>0.9，自动合并')""",
                            (project_id, json.dumps([row[0], s["id"]]), new_id),
                        )
                        # 删除旧chunk
                        self.db.execute("DELETE FROM memory_chunks WHERE id IN (?, ?)", (row[0], s["id"]))
                        self.db.commit()
                    except Exception:
                        continue

    async def _extract_insights(self, project_id: str):
        """从记忆中提炼高层洞察"""
        rows = self.db.execute(
            """SELECT content FROM memory_chunks
               WHERE project_id = ? AND source_type != 'consolidation'
               ORDER BY importance DESC LIMIT 20""",
            (project_id,),
        ).fetchall()

        if len(rows) < 5:
            return

        sample = "\n---\n".join(r[0][:200] for r in rows[:10])
        try:
            insight = await self.llm.chat(
                model="gemini/gemini-2.0-flash",
                messages=[
                    {"role": "system", "content": "分析以下小说片段，提炼出跨章节的主题模式、角色发展趋势和叙事线索。用3-5个要点概括。"},
                    {"role": "user", "content": sample},
                ],
                temperature=0.3, max_tokens=500,
            )
            if self.cm:
                self.cm.add_chunk(
                    project_id=project_id,
                    source_type="consolidation",
                    content=insight,
                    summary="跨章节洞察提炼",
                    importance=0.8,
                )
        except Exception:
            pass

    async def _cleanup_low_value(self, project_id: str, min_importance: float = 0.1):
        """清理低价值记忆"""
        self.db.execute(
            """DELETE FROM memory_chunks
               WHERE project_id = ? AND importance < ?
               AND access_count = 0
               AND julianday('now') - julianday(created_at) > 30""",
            (project_id, min_importance),
        )
        self.db.commit()
