"""记忆系统核心 - 参考VCPToolBox架构
模块:
- chunk_manager: 记忆块CRUD与ChromaDB同步
- hybrid_search: BM25 + 向量混合检索
- epa_analyzer: EPA情感分析 (Evaluation-Potency-Activity)
- meta_thinking: 递归向量增强
- agent_dream: 记忆整合 (merge/delete/insight)
- context_vector: 上下文向量管理与衰减
"""
