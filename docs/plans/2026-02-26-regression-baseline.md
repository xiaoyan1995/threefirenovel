# 回归基线与验证证据（2026-02-26）

## 目标覆盖

- 写作工坊关键链路：改写建议-确认应用、章节跳转、AI 痕迹弹窗、聊天清空。
- 审核中心链路：整本/章节范围审阅、评分与问题结构化展示。
- 导入导出链路：旧书导入、JSON/TXT/MD 导出。
- 关系图谱链路：独立路由、数据查询与基础性能烟测。
- 记忆链路：导入后记忆回填、向量/BM25 检索可用。

## 执行命令与结果

1. `npm run build`  
结果：通过（`tsc` + `vite build` 成功，产物生成）。

2. `python -m py_compile agent/api/content.py agent/api/graph.py agent/api/projects.py agent/main.py`  
结果：通过（无语法错误）。

3. `python scripts/regression_memory_path.py`（工作目录：`agent/`）  
结果：通过（memory 写入/向量检索/BM25 全通过）。

4. `python scripts/regression_import_graph_smoke.py`（工作目录：`agent/`）  
结果：通过（导入解码/章节解析/记忆回填/图谱节点边数量/性能烟测通过）。

5. 路由冒烟：读取 `main.app.routes`  
结果：存在  
- `/api/content/reviews`  
- `/api/content/reviews/latest`  
- `/api/content/reviews/run`  
- `/api/graph/relations`

6. 迁移安全检查：`rg` 扫描 `agent/migrate_db.py` 的破坏性 SQL  
结果：`NO_DESTRUCTIVE_SQL_MATCH`。

## 说明

- 当前基线以“自动化 smoke + 编译构建”覆盖主要回归风险。
- 前端纯交互视觉细节（如图标观感、文本密度）仍建议在真实使用场景做一次人工走查。
