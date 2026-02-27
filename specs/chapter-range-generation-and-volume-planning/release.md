# 发布说明：章节区间生成 + 卷级规划

## 1. API 变更（T-REL-601）

### `POST /api/pipeline/bootstrap`（章节区间模式）
- 新增请求字段（仅 `scope=chapters` 可用）：
  - `start_chapter: int`（可选）
  - `end_chapter: int`（可选）
  - `batch_size: int`（可选，系统会钳制到 10~40）
  - `volume_index: int`（可选）
  - `volume_title: str`（可选）
  - `volume_start_chapter: int`（可选）
  - `volume_end_chapter: int`（可选）
- 参数优先级：
  - `start/end` > `chapter_count` > 圣经/项目默认推导
- 错误语义（可读化）：
  - `scope!=chapters` 却传区间参数：返回 400（区间参数仅支持章节）
  - `end_chapter < start_chapter`：返回 400（区间参数错误）
  - `end_chapter > 5000`：返回 400（超出上限）
  - 生成异常/超时：返回可读提示（建议缩小区间重试）

### `POST /api/pipeline/bootstrap` 响应增强
- 保留兼容字段：
  - `inserted`
  - `skipped`
  - `message`
- 新增字段：
  - `effective_range: {start_chapter, end_chapter}`
  - `batch_stats: {planned_batches, success_batches}`
  - `failed_range: {start_chapter, end_chapter} | null`
  - `retry_count: int`
  - `format_degraded: bool`（圣经 4.4 缺失时为 true）

### 卷级规划接口
- `GET /api/pipeline/volume-plans?project_id=...`
- `GET /api/pipeline/volume-plans/check?project_id=...&chapter_count=...`
- `POST /api/pipeline/volume-plans/generate`

---

## 2. 前端交互文案（T-REL-602）

### 章节管理页
- 新增输入：起始章、结束章
- 新增快捷：`下一批20章`
- 新增卷入口：`AI卷计划`、`选择卷`、`套用卷范围`
- 保留开关：`覆盖重生成章节`
- 结果反馈：
  - 区间、批次、新增/跳过、降批重试次数
  - 若有失败区间，显示建议：从失败区间按 10-20 章续跑
  - 若 4.4 缺失，显示“已降级默认章节格式”

### 大纲页
- 新增 `骨架视图 / 卷级视图` 切换
- 卷级视图展示一致性提示（重叠/缺口/未覆盖）

---

## 3. 迁移与切换指南（T-REL-603）

### 迁移文件
- `010_volume_plans.sql`：新增卷计划独立表
- `011_chapters_unique_chapter_num.sql`：章节去重 + 唯一约束

### 旧项目切换建议
1. 执行应用启动，自动跑迁移。
2. 在章节页使用区间生成，避免一次全量。
3. 建议默认每批 20~40 章；遇到超时降到 10~20 章。
4. 先生成卷计划，再按卷套用区间生成章节。

---

## 4. 备份与回滚（T-REL-604）

### 覆盖前备份建议
1. 备份 `sanhuoai.db` 文件（或至少备份 `chapters` 表）。
2. 勾选 `覆盖重生成章节` 前，先导出当前章节列表（章号/标题/梗概）。

### 数据回滚策略
1. 轻量回滚：按区间重新生成（不勾覆盖）补回缺失内容。
2. 完整回滚：停止应用后替换回备份 `sanhuoai.db`。
3. 若仅误覆盖局部区间，可通过备份库导回指定 `chapter_num` 记录。
