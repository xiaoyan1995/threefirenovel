"""Meta-Thinking递归向量增强 - 参考VCPToolBox MetaThinkingManager
在记忆写入时通过多阶段推理提炼更高质量的语义表示
"""
from typing import Optional


class MetaThinking:
    """递归向量增强引擎"""

    def __init__(self, llm_client):
        self.llm = llm_client

    async def enhance(self, text: str, context: str = "", model: str = "claude-sonnet-4") -> dict:
        """多阶段推理增强文本的语义表示
        Stage 1: 提取核心语义
        Stage 2: 关联上下文推理
        Stage 3: 生成增强摘要
        """
        core = await self._extract_core(text, model=model)
        enriched = await self._enrich_with_context(core, context, model=model)
        summary = await self._generate_summary(text, enriched, model=model)
        return {"core": core, "enriched": enriched, "summary": summary}

    async def _extract_core(self, text: str, model: str = "claude-sonnet-4") -> str:
        """提取文本核心语义"""
        try:
            return await self.llm.chat(
                model=model,
                messages=[
                    {"role": "system", "content": "提取以下文本的核心语义，用1-2句话概括关键信息。只输出结果。"},
                    {"role": "user", "content": text[:1000]},
                ],
                temperature=0.2,
                max_tokens=200,
            )
        except Exception:
            return text[:200]

    async def _enrich_with_context(self, core: str, context: str, model: str = "claude-sonnet-4") -> str:
        """结合上下文丰富语义"""
        if not context:
            return core
        try:
            return await self.llm.chat(
                model=model,
                messages=[
                    {"role": "system", "content": "结合上下文信息，丰富和补充核心语义的关联信息。只输出结果。"},
                    {"role": "user", "content": f"核心语义: {core}\n\n上下文: {context[:500]}"},
                ],
                temperature=0.3,
                max_tokens=300,
            )
        except Exception:
            return core

    async def _generate_summary(self, original: str, enriched: str, model: str = "claude-sonnet-4") -> str:
        """生成增强摘要用于embedding"""
        try:
            return await self.llm.chat(
                model=model,
                messages=[
                    {"role": "system", "content": "基于原文和丰富后的语义，生成一段适合向量检索的增强摘要（100-200字）。只输出摘要。"},
                    {"role": "user", "content": f"原文: {original[:500]}\n\n丰富语义: {enriched}"},
                ],
                temperature=0.2,
                max_tokens=300,
            )
        except Exception:
            return enriched[:300]
