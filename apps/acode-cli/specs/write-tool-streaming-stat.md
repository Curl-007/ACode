# Write 工具流式阶段与行数显示（writeStreamingStat）

复活 `231118f`（分支 dev/from-acode-2026-10，作者 zhengjunkj）的半成品：Write 工具在
**流式生成 input 阶段**实时显示阶段词与已生成行数，替换原实现因零消费者、导入笔误
（`""@acode/shared"`）被 merge `0cc983f` 剔除的状态。所有者：`packages/ui/src/ToolCallBlocks/renderers/writeStreamingStat.ts`
（唯一派生器）+ `renderers/edit.tsx`（唯一接线点）。

## 背景与现状

- Write 工具（v4 toolName `Write`，identity family `file-write` 的内容写子集）由
  `EditToolCallBlock` 渲染。流式期间 legacy status 是 `pending`（`v4/toolCallRowAdapter.ts`
  的 `STATUS_MAP` 把 `inputStreaming`/`pendingApproval` 都映射为 `pending`），卡片只能显示
  笼统的 "Write"，且 `rawFileSummaries` 为空、diffCount 为空——用户在生成阶段看不到任何进度。
- v4 适配器已把流式半截 JSON 解析进 `toolCall.input`（`buildACodeStreamingToolInputPreview`
  的 partial preview），并把 `v4Status`、`inputPreviewComplete` 放进 `toolCall.raw`。派生器
  不再做解析，只消费这份权威投影。

## 口径定义

### 阶段词表（`readWritePhase`）

`WritePhase = generating | waiting | writing | written | failed | stopped`，判定优先级：

1. `isFailed === true` → `failed`（失败判定是权威覆盖，任何阶段都让位于它）。
2. 阶段源 = `raw.v4Status`（v4 权威字段）；缺席时回退 legacy `status`，禁止凭
   `file_path` 之类输入字段或运行文案**推测**落盘结果。
3. 映射：

| 阶段源                                  | WritePhase   | i18n id（`WRITE_PHASE_MESSAGE_IDS`） |
| --------------------------------------- | ------------ | ------------------------------------ |
| `inputStreaming` / legacy `pending`，且 `inputPreviewComplete !== true` | `generating` | `chat.toolCall.write.generating`     |
| `inputStreaming` / legacy `pending`，且 `inputPreviewComplete === true` | `waiting`    | `chat.toolCall.write.waiting`        |
| `pendingApproval`                       | `waiting`    | 同上                                 |
| `running` / legacy `in_progress`        | `writing`    | `chat.toolCall.write.writingFile`    |
| `success` / legacy `completed`          | `written`    | `chat.toolCall.edit.wrote`（复用既有）|
| `error` / legacy `failed`               | `failed`     | `chat.toolCall.write.failed`         |
| `cancelled` / legacy `stopped`          | `stopped`    | `chat.toolCall.write.stopped`        |
| 其他/未知                               | `waiting`    | `chat.toolCall.write.waiting`        |

### 行数口径（`readWriteStreamingChangeStat`）

- 输入是适配器产出的 preview `input`（可能是未闭合 JSON 的半截对象）。只认字符串型的
  正文字段，按固定优先级取**第一个命中的**：`content`、`newText`、`new_text`、`newString`、
  `new_string`、`text`、`fileContent`、`file_content`、`contents`、`code`。
- 行数 = `computeLineChangeStat(null, content)`：与 Edit 卡同源的逻辑行统计——按 `\n` 切分、
  丢弃末尾空段（结尾换行不重复计数）、空正文返回 undefined（**不发明 0 行**）。
- 流式未闭合 JSON：适配器层 `buildACodeStreamingToolInputPreview` 已把已闭合的字符串字段
  扫进 preview（`PARTIAL_JSON_STRING_FIELD_KEYS` 含 `content`），因此正文第一个 chunk 起即可
  计数，`file_path` 是否已生成都无所谓。派生器对非对象/数组/空对象输入一律返回 undefined。
- 单一所有者：`rawFileSummaries` 非空（摘要层已给出权威 changeStat）后，流式推导立即退出，
  展示回到既有 `totalChangeStat` 路径；两条计数路径不叠加。

### 显示规则（edit.tsx 接线）

- 仅对 file-content Write 生效（`isFileContentWriteToolCall`），Edit/MultiEdit 不受影响。
- `kindLabel` 用阶段词（Write 专属文案，六态成对 i18n）；`diffCount` 在
  `rawFileSummaries` 为空时显示流式行数（`renderDiffCount` 复用，语义色
  `text-diff-added/removed`、`font-mono tabular-nums` 由其自带，字号走 DESIGN.md `text-ui-*` 约束）。

## 验收场景

1. v4 `inputStreaming` 且 preview 未闭合 → kindLabel 显示「正在生成/Generating」。
2. preview 已闭合或 `pendingApproval` → 「等待写入/Waiting」。
3. `running` → 「正在写入/Writing」，且流式期间 diffCount 显示 `+N`（N 随 content 增长）。
4. `success` → 「已写入/Wrote」；`error`/工具失败 → 「写入失败/Write failed」；
   `cancelled` → 「已停止写入/Write stopped」。
5. legacy 快照（无 `v4Status`）按 legacy status 走同一词表，不从路径推断成功。
6. 半截 JSON（`'{"content":"first\nsecond'` 无闭合引号）已能统计 2 行。
7. 空正文/无正文字段 → 不显示行数（渲染为 null，不显示 +0）。
8. Edit 工具（非 Write）的 kindLabel 与 diffCount 行为与改动前完全一致。

## 测试

- `packages/ui/test/writeStreamingStat.test.ts`：复活自原提交的 8 个用例，适配
  `buildACodeStreamingToolInputPreview` 更名与 test/ 目录位置，其余断言逐字保留。
