# Todo 原地置换（todo-displacement）

状态：实施中（UX 波 D4，2026-10-18）
来源：oh-my-pi (MIT) tool-execution.ts 的 displaceableToolName 机制（wait/todo
结果原地置换不堆卡）+ collab-web todo.tsx 的最新板渲染。机制参照，代码自撰。

## 背景与动机

计划密集型任务里模型每完成一步就调 TodoWrite 刷新计划板；当前每次调用渲染一张
全尺寸卡片，一个 turn 内 5 次更新 = 5 张几乎相同的卡（旧板全部过时仍占屏）。
omp 的语义：todo/wait 是 displaceable 工具——最新结果**原地置换**旧卡，转录里
只保留当前板。

## 产品规则

### R1 置换范围与锚点

- 作用域 = 单次 `buildAssistantWorkRenderItems` 投影（一个 assistant turn 的
  work rows）。跨 turn 不置换：历史 turn 的计划板是该时刻的真实状态，保留。
- **锚点** = 序列中最后一个 status ∈ {success, running, inputStreaming,
  pendingApproval} 的 todo 行（当前板，含正在形成的板）。
- **被置换** = 锚点之前所有 status=success 的 todo 行；error/cancelled 行永不
  置换（失败信息必须可见）。锚点行携带 `todoSupersededCount` = 被置换行数。
- 单张 todo 行（无前置成功板）不产生任何置换与徽章。

### R2 传递通道

- 投影层（conversationAssistantWorkItems）预扫描计算置换集，经
  `v4/todoDisplacement.ts` 的 **WeakMap 侧信道**（row 对象身份键）登记锚点计数
  ——v4 row 是协议数据不可变异，legacy 桥接（toolCallRowToLegacyNode）读侧信道
  把 `todoSupersededCount` 桥进 legacy toolCall 可选字段。
- row 对象在 v4 reducer 中按修订不可变更新：修订换新对象 → 侧信道自然失效，
  重投影重登记，与 `useMemo([row])` 桥接的失效节奏一致（无陈旧计数渲染面）。
- 旧快照/legacy 链路无此字段 → 徽章缺席，行为与改动前一致。

### R3 展示

- todo.tsx 渲染器在 `todoSupersededCount > 0` 时于计划板卡头部显示徽章
  「已置换 {count} 次先前更新」（i18n：chat.toolCall.todo.superseded，zh/en）。
- 徽章仅陈述折叠事实，不提供展开入口（被置换板仍可在 Model Trajectory 调试面
  与 replay 中查看；聊天阅读面只保留当前板——omp 同语义）。
- 运行中的锚点（running/inputStreaming）同样携带计数：置换发生在旧板完成时，
  与新板是否完成无关。

### R4 与既有分组的关系

todo 族不参与 explore/execute/changes 分组（identity family = "todo"，
isExploreToolCall 不命中）；置换预扫描在分组循环之前完成，被置换行直接从
items 缺席。todo 行本就不属于任何分组族，其缺席不会**切断**既有分组；被置换
行两侧的只读行会因此新增相邻关系、可能升级为 exploreGroup（噪音只减不增，
评分自审勘误：初稿「与现状渲染顺序一致」措辞不准）。

## 状态所有者

- 置换判定唯一所有者：conversationAssistantWorkItems 的预扫描
  （computeTodoDisplacement 纯函数，可单测）。
- 计数传递唯一通道：v4/todoDisplacement.ts WeakMap（登记=投影层，读取=桥接层）。
- 展示唯一消费者：ToolCallBlocks/renderers/todo.tsx。

## 验收场景

1. 同 turn 三次成功 TodoWrite → 只渲染最后一张卡，徽章 count=2。
2. S1 S2 E1 S3（E=error）→ E1 卡保留；S3 徽章 count=2（S1/S2 被置换）。
3. 末行 running 的 todo → 锚点为 running 行，前置成功板全部置换。
4. 单张 todo / 全部 error → 无置换无徽章。
5. 跨 turn：上一 turn 的板不受本 turn 置换影响（投影作用域隔离）。
6. legacy 快照（无 v4 row）→ 无徽章，渲染与改动前一致。
7. 被置换行不产生 items（DOM 缺席），锚点行 item 正常。
