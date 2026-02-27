# Implementation Plan

## Phase 1: Backend Context Plumbing
1. 扩展请求模型：
   - `BrainstormRequest.selected_source_ids: list[str] = []`
   - `GenerateBibleRequest.selected_source_ids: list[str] = []`
2. 新增知识源上下文 helper：
   - 按 `project_id + source_ids + enabled=1` 拉取 source；
   - 生成紧凑文本块（标题/类型/片段）并做长度裁剪。
3. 注入策略：
   - `/brainstorm`：在 prompt 中追加“活动规则包 + 选中知识源”；
   - `/bible/generate`：同上，确保圣经生成能读到引用资料。

## Phase 2: Knowledge Page Drag Source
1. `KnowledgeAssets.tsx` 在 source 列表项与卡片项添加：
   - `draggable={true}`
   - `onDragStart` 写入自定义 MIME + `text/plain` fallback。
2. Payload 字段统一：`kind/project_id/source_id/title/reference_type`。

## Phase 3: Planning Studio Drop + Context UI
1. 新增状态：
   - `knowledgeSources`、`activeProfile`、`selectedKnowledgeSourceIds`、drag-over 状态。
2. 加载与持久化：
   - 拉取 `/api/knowledge/sources` 与 `/api/knowledge/profile/active`；
   - `PlanningStudioCache` 加入 `selectedKnowledgeSourceIds` 并保持兼容旧缓存。
3. Drop 行为：
   - 识别“知识库拖拽 payload”并加入引用；
   - 识别本地文件，调用 `/api/knowledge/import-file`，导入后自动引用。
4. API 请求：
   - `sendBrainstorm()` 与 `generateBible()` 请求体增加 `selected_source_ids`。

## Phase 4: Bible Panel UX Alignment
1. 预览区优先：
   - 改写预览时先显示摘要和左右并排“改前/改后”。
2. 输入区后置：
   - 将“对话改写”输入框与锁定段落输入移动到底部操作区。

## Validation
1. `python -m py_compile agent/api/pipeline.py`
2. `npm run build`
3. 手动冒烟：
   - 知识库拖拽 -> 立项引用成功；
   - 本地拖入 -> 导入 + 引用成功；
   - 立项对话/圣经生成可利用选中知识源；
   - 圣经面板顺序符合“先对比，后输入改写”。
