# 工具调用 intent 字段（tool-intent-field）

状态：实施中（UX 波 D3，2026-10-18，默认关闭灰度）
来源：oh-my-pi (MIT) INTENT_FIELD 机制（packages/wire/src/index.ts:404
`INTENT_FIELD = "i"` + packages/coding-agent/src/utils/tool-schema.ts 的
schema 注入守卫 + collab-web ToolView 的显示前剥离）。机制参照，代码自撰。

## 背景与动机

omp 给每个工具 schema 注入一个 `i` 字符串参数：模型每次调用附带一句话意图
（这次调用要干什么/为什么）。价值：①转录可读性——长会话里工具卡自解释；
②子代理观测——`lastIntent` 是舰队面板活动行的兜底（AgentsPanel）；③审批面
——批准者看到动机而不只是参数。ACode 工具卡当前只有工具名+参数摘要。

## 产品规则

### R1 门控（灰度纪律）

- env `ACODE_TOOL_INTENT=1` 显式开启；**缺省关闭**。开启改变全部工具的
  provider 可见 schema（字节变化 → prompt cache 一次性失效 + 各 provider
  strict 面差异未知），必须先灰度再议默认值（对齐 ACODE_WEBSEARCH_ENGINES /
  ACODE_READ_URL 门控先例；compat 哲学：可回退、fail-safe）。
- 关闭态零痕迹：不注入、不剥离（输入本就没有 `i`）、UI 无感。

### R2 注入（单一收口）

- 注入点 = `getToolsForModel`（core runtime/methods/config.ts）的
  `projectToolModelContract` map 之后——provider 可见工具契约的唯一出口。
  注册表、执行器、度量面看到的都是未注入的原始 entry（内部面零污染）。
- 注入形态：`properties.i = { type: "string", description: <意图指引> }`，
  **不进 required**（缺席合法，模型可忽略）。
- 守卫（omp schemaDefinesProperty 同款）：schema 非 object 形态、无
  properties、或已自有 `i` 属性 → 跳过注入（工具自有参数优先，不覆盖）。

### R3 运行期剥离（strict schema 防御）

- ACode 大量 runtimeInputSchema 是 `.strict()`（agent/edit/apply-patch…），
  模型回传的 `i` 会直接拒掉整个调用。剥离点 = `prepareToolExecutionInput`
  （input-normalization.ts，initial/hook/permission 三 source 共用的唯一
  归一化收口）：JSON 归一后、runtime schema 校验前删除顶层 `i`。
- handler/hook/权限 pattern 永远看不到 `i`；意图不是执行输入。

### R4 wire 与显示

- v4 toolCall row 的 `input` 是 `z.unknown()` 透传：模型原始 args（含 `i`）
  如实上 wire——意图事实的唯一权威记录，不新增 row 字段。
- 桌面 UI 桥接（toolCallRowToLegacyNode）单点处理：从展示 input 剥 `i`，
  并将意图 bridging 为 legacy `toolCall.title`（缺席才填）——ToolLayout 的
  title 属性即悬浮提示，**全部渲染器零改动**获得卡头意图提示（omp ToolView
  head title=intent 同形态）。raw 通道（ModelTrajectory 调试面）保留原始
  args 含 `i`（调试如实）。
- 权限对话框消费的是 pendingInteractions 的**原始 input**（不经本桥接）：开启
  态下审批者会看到 `i` 键——意图对审批者有正面价值（omp 同款哲学：批准者看到
  动机），但键形态未加工；如需剥离/美化在 pendingInteractionAdapter 另批处理
  （评分自审勘误：初稿误称权限面走 legacy 桥接）。缺省关闭下无任何影响。
- CLI TUI 显示面本批不动（登记：开启态 TUI args JSON 可能含 `i`，缺省关闭
  下无影响）。

### R5 意图指引文案（schema description，自撰）

"One-sentence intent of this call (what you are doing and why), shown to the
user in the transcript; not used for execution. Keep it under ~12 words."

## 状态所有者

- 开关判定/注入/剥离纯函数：core `tool/intent-field.ts`（新文件，单一事实源：
  INTENT_FIELD 常量、description 文案、inject/strip）。
- 注入接线：runtime/methods/config.ts（getToolsForModel）。
- 剥离接线：tool/input-normalization.ts（prepareToolExecutionInput）。
- UI 剥离+title 桥接：v4/toolCallRowAdapter.ts。

## 验收场景

1. 关闭态（缺省）：getToolsForModel 产出 schema 无 `i`；输入归一化不动 args。
2. 开启态：object schema 注入 `i`（非 required）；已自有 `i` 的工具跳过；
   非 object/无 properties schema 跳过；注入不修改原对象（纯函数）。
3. 开启态 + 模型回传 `{...args, i:"..."}`：strict schema 工具（Edit 形态）
   校验通过（`i` 已剥）；handler 收到的 input 无 `i`。
4. v4 桥接：input 含 `i` → legacy input 无 `i`、title=意图；input 无 `i` →
   title 不被覆盖（既有 undefined/值保持）。
5. raw 通道保真：raw.rawInput（若有）与 inputText 不被改写（调试面如实）。

## 范围外（登记）

- 子代理活动行消费 lastIntent（随 D6/B1 舰队面板批次）。
- TUI 显示面剥离/展示；意图进搜索/回放索引。
- 默认开启（灰度浸泡后单独裁决：涉及 prompt cache 与 provider strict 面证据）。
