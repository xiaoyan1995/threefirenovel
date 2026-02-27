"""EPA情感分析模块 - 参考VCPToolBox EPAModule
Evaluation (评价): 正面/负面
Potency (力量): 强势/弱势
Activity (活跃度): 主动/被动

用于评估记忆块的情感维度，辅助重要度计算
"""
import json
from typing import Optional


class EPAAnalyzer:
    """EPA三维情感分析"""

    def __init__(self, llm_client):
        self.llm = llm_client

    async def analyze(self, text: str, model: str = "claude-sonnet-4") -> dict:
        """分析文本的EPA三维度评分"""
        try:
            resp = await self.llm.chat(
                model=model,
                messages=[
                    {"role": "system", "content": (
                        "你是一个情感分析引擎。分析文本的三个维度并返回JSON:\n"
                        "- evaluation: 0-1 (0=极负面, 0.5=中性, 1=极正面)\n"
                        "- potency: 0-1 (0=极弱势, 1=极强势)\n"
                        "- activity: 0-1 (0=极被动, 1=极主动)\n"
                        "只返回JSON，不要其他文字。"
                    )},
                    {"role": "user", "content": text[:500]},
                ],
                temperature=0.1,
                max_tokens=100,
            )
            return json.loads(resp)
        except Exception:
            return {"evaluation": 0.5, "potency": 0.5, "activity": 0.5}

    def compute_importance(self, epa: dict, base_importance: float = 0.5) -> float:
        """基于EPA评分计算记忆重要度"""
        e_weight = abs(epa.get("evaluation", 0.5) - 0.5) * 2
        p_weight = epa.get("potency", 0.5)
        a_weight = epa.get("activity", 0.5)
        epa_score = (e_weight * 0.4 + p_weight * 0.3 + a_weight * 0.3)
        return min(1.0, base_importance * 0.5 + epa_score * 0.5)
