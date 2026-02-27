# Feature Spec: Planning Studio Knowledge DnD + Context Injection + Bible UX Alignment

## Context
现有立项工作台已经具备：
- 立项问答（brainstorm）与问题选项刷新
- 小说圣经生成/保存/改写预览
- 立项状态本地 + 后端持久化

但仍存在以下缺口：
- 立项页无法直接引用“知识库里已有文件”
- 立项页拖入本地文件后不能直接纳入本轮立项上下文
- `brainstorm` / `bible/generate` 还未接入“用户当前选中的知识源”
- 立项页对“已启用规则包 + 当前引用文件”缺少清晰可视化
- 圣经面板“改写输入区”位置与“改前/改后对比”交互顺序不符合直觉（输入应在底部，对比应更突出）

## Goals
1. 立项页支持两类拖拽：
   - 从知识库页面拖拽“已有知识文件”到立项页并加入引用；
   - 从本地拖拽文件到立项页，自动导入知识库并加入引用。
2. `brainstorm` 与 `bible/generate` 可接收并使用 `selected_source_ids` 作为上下文。
3. 立项页明确展示“当前启用规则包 + 已选知识引用”。
4. 圣经面板交互优化：
   - 改前/改后对比区域置于上方并左右并排；
   - “对话改写”输入区放到底部（聊天式操作顺序）。
5. 与现有接口和数据兼容，未传新字段时行为保持不变。

## Non-Goals
- 重构知识库页整体 UI。
- 改动规则包提炼算法。
- 引入新的知识库数据表结构。

## Functional Requirements
1. 跨页面拖拽（知识库 -> 立项）：
   - 知识库页 source 条目支持 `draggable`；
   - 拖拽 payload 至少包含：`kind/source_id/project_id/title/reference_type`；
   - 立项页 drop 时校验项目一致，不一致给出提示并拒绝加入。
2. 本地文件拖入立项：
   - 立项页 drop 区支持 `FileList`；
   - 调用现有 `POST /api/knowledge/import-file` 导入；
   - 成功后刷新 source 列表并自动加入选中引用。
3. 上下文注入：
   - `POST /api/pipeline/brainstorm` 新增可选字段 `selected_source_ids`；
   - `POST /api/pipeline/bible/generate` 新增可选字段 `selected_source_ids`；
   - 后端按 `project_id + selected_source_ids + enabled=1` 查询并裁剪拼接上下文；
   - 与活动规则包一起注入 prompt（均需 token 裁剪）。
4. 立项页可视化：
   - 显示 active profile（名称/版本/题材）状态；
   - 显示已选引用文件 chips，支持移除；
   - 状态持久化中包含 `selectedKnowledgeSourceIds`。
5. 圣经面板布局：
   - 有改写预览时先展示“变更摘要 + 左右并排对比”；
   - 改写输入控件（instruction/locked sections/按钮）放在底部。

## Safety / Quality Constraints
- 仅注入启用状态的知识源（`enabled=1`）。
- 知识上下文需剪裁，避免 prompt 失控。
- 改写预览逻辑保持“先预览，后应用，手动保存”不变。
- 所有新交互失败需可回退（toast 提示，不影响已有流程）。

## Acceptance Criteria
- 可将知识库页任意文件拖到立项页并立即成为“已选引用”。
- 本地文件拖入立项页后能完成导入并自动加入引用。
- 立项对话与圣经生成请求都携带并使用 `selected_source_ids`。
- 立项页能看到“当前规则包 + 已选引用”。
- 圣经页交互顺序为“先看对比，再在底部发起改写”。
