# 外部会话导入来源扩展：SourceAdapter 框架 + 四来源（K5）

方案条目：`docs/k-series-upgrade-plan.md` §K5。来源覆盖与解析形态参照 jcode (MIT)
`crates/jcode-import-core`（2421 行：Claude Code / OpenAI Codex / Gemini CLI(pi) /
opencode / Cursor 五来源解析、`ExternalSessionRecord` 统一模型、`repo_ranking.rs` git
活跃度排序、`claude_adversarial.rs` 对抗测试），ACode 侧落在既有 claude-native 导入
链路的泛化上，自撰 TypeScript 实现，未拷贝任何文件。

ACode 的会话导入今天只支持 Claude Code 一个来源
（`packages/services/src/session/claude-native/` 一族，含解析/修复/onboarding UI，
约 1600 行，形态成熟）。本项把该模式泛化为**外部来源适配器框架**并新增四个来源：
OpenAI Codex CLI、Gemini CLI、opencode、Cursor——把「从竞品迁来」从单点能力变成
可扩展面。

红线：**Claude Code 导入行为零回归**（既有 UI/时间范围过滤/onboarding 流程不动，
其 parser 移入框架但输出逐字节兼容）；导入是**读取+转换**，不写任何外部工具的本地
状态；恶意会话文件防护是验收硬门槛（jcode 对抗测试对齐）。

裁剪边界：不做双向导出；不做增量/持续同步（一次性导入）；repo_ranking（git 活跃度
排序）为可选子项（R7，缺省不启用）；每来源只导入「对话转录」层（用户/助手消息、
工具调用摘要），不还原工具执行环境。

---

## 背景：已核实的现状

1. **既有链路**：`claude-native/claudeNativeSessionImportService.ts`（编排、跳过/失败
   分类）、`claudeNativeSessionImportParser.ts`（JSONL 解析，`parseClaudeNativeSessionFile`
   导出于 `:348`、sidechain 标记 `:91`、头部信息 `:217`）、`claudeNativeSessionHeadParser.ts`、
   `claudeNativeSessionImportRepo.ts`（发现与扫描）、`buildImportedClaudeTaskFile.ts` /
   `persistImportedClaudeTask.ts`（落成 ACode 任务）、`importedClaudeHistoryRepair.ts`
   （导入后修复）、`sessionHistoryJsonl.ts` / `jsonLineRecord.ts`（JSONL 基础件）；
2. **API 面**：`acodeTaskService` 的 `importSessions` 入口（adapter 层
   `acodeTaskServiceAdapter.ts:2659` 透传）；UI 面 `useClaudeSessionMigration.ts`
   （7d/30d/90d/all 时间范围、工作区过滤、500/unlimited 上限）；
3. **jcode 参照要点**（来源数据形态，只读提炼）：
   - **Codex CLI**：`~/.codex/sessions/`（rollout-\*.jsonl，含树状事件流）；
   - **Gemini CLI**：`~/.gemini/tmp/<hash>/`（chats/\*.json，含消息对与元数据）；
   - **opencode**：`~/.local/share/opencode/storage/`（session/message/部分目录，
     消息含 parts 结构）；
   - **Cursor**：`~/.cursor/projects/<proj>/agent-transcripts/*.jsonl`，含 subagent
     转录识别与项目目录名→cwd 解码（路径里的 base64/URL 编码段）；
   - 统一输出 `ExternalSessionRecord/ExternalMessageRecord`（role/content/ts/元数据），
     导入 id 带来源前缀（`imported_claude_/codex_/opencode_/pi_/cursor_`）；
   - **对抗测试**：恶意构造的会话文件（超长行、深嵌套、伪 role、路径穿越字段）不崩、
     不越界读。

## 产品规则

### R1 SourceAdapter 契约（services 新 `session/external-import/`）

```ts
interface ExternalSessionSourceAdapter {
  readonly source: ExternalSessionSource;        // "claude-code"|"openai-codex"|"gemini-cli"|"opencode"|"cursor"
  discover(params: { sinceTs?: number; limit?: number }): Promise<ExternalSessionSummary[]>;
  parse(sessionRef): Promise<ExternalSessionRecord>;
}
ExternalSessionSummary = { sourceSessionId; projectHint?: string; lastActivityTs; messageCountEstimate }
ExternalSessionRecord = {
  source; sourceSessionId; importedTaskIdPrefix;   // "imported-codex-" 等
  cwd?: string; startedAtTs?; lastActivityTs?;
  messages: ExternalMessageRecord[];               // role: user|assistant; content 文本投影; ts; toolCallSummaries[]
}
```

- claude-native parser **重构为 `"claude-code"` adapter**（输出契约不变，`buildImported
ClaudeudeTaskFile` 等下游零改动——id 前缀 `imported_claude_` 保持原样以防历史数据
  关联断裂）；
- 四个新 adapter 各自独立文件（`adapters/{codex,gemini-cli,opencode,cursor}.ts`），
  互不依赖、独立单测；
- **发现范围**：每 adapter 自带默认根目录 + 环境变量覆盖（测试桩需要）；目录不存在 =
  空结果（不报错——没装过该工具是常态不是异常）。

### R2 解析健壮性（对抗硬门槛，对齐 jcode claude_adversarial）

所有 adapter 过同一套基础件（复用 `jsonLineRecord.ts` 的行级防护并补强）：

- 单行长度上限 `IMPORT_LINE_MAX_BYTES = 4 MiB`（超限跳行 + 计入 skipped，不崩）；
- JSON 深度上限 64（防深嵌套炸弹）；字符串字段长度上限 1 MiB；
- 未知事件类型静默跳过（forward-compat：外部工具格式演进不该让导入失败）；
- **伪 role/伪字段**：role 只认白名单，其余消息丢弃计数；content 投影只取已知文本字段，
  不执行任何来自文件的可计算内容（无 eval/无模板展开）；
- **路径穿越**：sourceSessionId/文件名进 importedTaskId 前必须过 `isValidPathSegment`
  同款校验（services `memoryService.ts` 既有私有实现，提取复用——不新写第二份）；
- 每次导入输出结构化结果：`{ imported, skipped: [{ reason, count }], failed: [{ ref, error }] }`
  ——UI 可解释，不静默吞。

### R3 转换与落库（复用既有下游）

- `ExternalSessionRecord` → 既有 `buildImportedClaudeTaskFile` 泛化版
  （`buildImportedExternalTaskFile`：claude 特有字段可选化）→ `persistImportedClaudeTask`
  同链路落任务；导入后修复（`importedClaudeHistoryRepair`）按来源适配（其对 claude
  特定格式的假设要参数化——实施时若发现修复器与来源强耦合，则新来源走空修复器
  （no-op）并登记，不硬套）；
- **来源标记**：导入任务带 `origin: { source, sourceSessionId }` 元数据（查询/去重依据）；
  重复导入同 sourceSessionId → 幂等跳过（upsert 语义，不产生双份任务）。
  upsert 的恢复语义（批次 C 复核 F6）：幂等去重只针对活任务；用户删除导入任务后
  重导同一 session = 恢复该任务（重新落 snapshot 且 `archived:false/deleted:false`，
  任务重新可见），不是 skip。

### R4 服务编排（`external-import/importService.ts`）

- 多来源并行发现（`Promise.allSettled`，单来源失败不拖垮整轮——单来源 warn）；
- 时间范围/上限参数沿用既有 UI 语义（7d/30d/90d/all、500/unlimited）；
- **workspace 匹配守卫（批次 C 复核 F4）**：导入时 `record.cwd` 与过滤
  `workspacePath` 归一比较（win32 大小写不敏感，同 claude-native 链路先例）不一致 →
  skip(`workspace-mismatch`)，`workspaceIdentity` 只在过滤 workspace 与落盘 workspace
  一致时绑定；adapter 发现阶段拿到的 cwd 只是列表提示，正确性由 importService 守卫
  唯一兜底（见 types.ts 的 discoverSessions 契约注释）；
- 现有 `importSessions` API 扩展出 `source` 参数（缺省 `"claude-code"` 保持兼容），
  UI 侧来源多选是 UI 批次（本项先交付 services + CLI 侧入口）。

### R5 Cursor 专项（cwd 解码与 subagent）

- 项目目录名 → cwd 解码：按 Cursor 的编码规则（URL/base64 段）解码失败 → `projectHint`
  置原始目录名（不猜）；解码出的 cwd 仅作 workspace 匹配提示，不作为任何写路径依据；
- subagent 转录（Cursor 的嵌套 agent 消息）：拍平为带标记的 assistant 消息段
  （`[subagent]` 前缀），不还原子会话结构（导入层不做行为还原）。

### R6 状态所有权

| 状态                     | 所有者                           | 生命周期 |
| ------------------------ | -------------------------------- | -------- |
| 外部工具本地文件         | 外部工具（只读）                 | 外部     |
| ExternalSessionRecord    | adapter 局部（解析产物，纯数据） | 单次导入 |
| 导入任务 + origin 元数据 | ACode 任务存储（既有链路）       | 持久     |
| 幂等去重键               | origin（source+sourceSessionId） | 持久     |

不变量：导入全程对外部目录**只读**；adapter 无共享可变状态（纯函数 + 每次调用新建
解析上下文）；解析失败的范围最小化（行级/消息级跳过，不整源放弃）。

### R7 可选子项：repo_ranking（git 活跃度排序，缺省不启用）

发现结果按「仓库 git 活跃度」排序（最近提交时间/频率），帮用户先看到活跃项目的会话。
实现：对去重后的 cwd 集合读 `.git` 元数据（mtime + HEAD 提交时间），排序 key 附在
`ExternalSessionSummary.rankHint`。**缺省关闭**（feature flag）——探测成本与价值
需 UI 联动评估，先落纯函数与测试。

## 常量

| 常量                            | 值      | 出处                     |
| ------------------------------- | ------- | ------------------------ |
| `IMPORT_LINE_MAX_BYTES`         | `4 MiB` | R2                       |
| `IMPORT_JSON_MAX_DEPTH`         | `64`    | R2                       |
| `IMPORT_FIELD_MAX_CHARS`        | `1 MiB` | R2                       |
| `IMPORT_DISCOVER_DEFAULT_LIMIT` | `500`   | R4（与既有 UI 上限同源） |

## 接口

services：`session/external-import/{index,types,importService,adapters/*}.ts`；
claude-native parser 迁移为 adapter（保持原导出兼容或全仓引用一次性更新——以 knip
零悬空出口为准）；`acodeTaskService.importSessions` 增 `source` 参数（向后兼容缺省）。

## 验收场景

测试：`packages/services/tests/external-session-import.test.mjs`（fixture 文件树 +
对抗样本）。

1. **claude-code 零回归**：既有 claude 导入测试全绿 + 相同 fixture 下产出的任务内容
   逐字节一致（快照）；
2. 四来源 happy path：各自最小 fixture（2-3 消息含一次工具调用）→ 正确的
   ExternalSessionRecord（role/content/ts/工具摘要）与导入任务；来源目录缺失 → 空结果
   不报错；
3. **对抗套件**（每来源同跑）：4MiB+ 单行跳过且计数；深嵌套不爆栈；伪 role 丢弃计数；
   路径穿越型 sourceSessionId（`../../x`）被拒；未知事件类型静默跳过；损坏 JSONL
   中途截断 → 部分导入 + failed 记录（不整源放弃）；
4. 幂等：同 sourceSessionId 二次导入 → 跳过，任务不双份；
5. 编排：两来源一失败（桩抛错）→ 另一来源照常导入 + 失败来源 warn（allSettled 语义）；
6. Cursor 专项：cwd 解码成功/失败两路；subagent 段 `[subagent]` 前缀拍平；
7. `importSessions` 缺省 source 行为与现状一致（兼容性钉住）。

## 未做与取舍

1. **不做 Gemini CLI 的 pi 变体**（jcode 来源之一）：pi 是小众分叉，等用户需求登记；
2. **不做工具执行还原**：导入的是对话史，工具结果只留摘要——外部工具的环境不可复现，
   假装可复现是撒谎；
3. **不做 UI**：来源多选/进度/失败明细的 UI 面是 UI 批次（services 层结构化结果已备好）；
4. **外部格式快照时效**：四来源格式基于 jcode v0.89.2 时期的形态（2026-09 检出），
   实施首日用真实本机样本（如可得）复核——`~/.codex` 等目录在本机存在时以真实文件
   修正 fixture，spec 附录补记差异。

## 第三方归属

来源覆盖与解析形态参照 jcode (MIT) `crates/jcode-import-core`（各来源存储布局、
统一 record 模型、对抗测试清单）；fixture 为自造最小样本，不含任何 jcode 代码。
外部工具（Codex/Gemini CLI/opencode/Cursor）本地文件仅为只读消费对象，无代码归属。

---

## 附录：实施记录（2026-10-04，dev/0.0.3）

### 本机真实样本核实（spec「未做与取舍」第 4 条的落地）

| 来源目录              | 本机状态 | fixture 依据                                   |
| --------------------- | -------- | ---------------------------------------------- |
| `~/.codex/sessions/`  | 存在     | 真实 rollout 文件（2026-08，cli 0.147.0-alpha） |
| `~/.local/share/opencode/storage/` | 存在，但只有 `tui-state/`，无 session/message 数据 | jcode 时期形态自造 |
| `~/.gemini/`          | 不存在   | jcode 时期形态自造                             |
| `~/.cursor/`          | 不存在   | jcode 时期形态自造                             |

Codex 真实样本核实的形态差异（已并入 adapter 行为）：

1. 目录按 `年/月/日` 分层，文件名 `rollout-<时间>-<uuid>.jsonl`（时间分隔符已折叠）；
2. 首行 `session_meta.payload` 携带 `session_id`/`cwd`；
3. `event_msg` 的 `user_message`/`agent_message` 是用户可见文本的权威来源；
   `response_item` 的 `message` 会重复同一轮内容，且首条 user 消息常是注入的
   AGENTS.md/环境上下文（数 KB）。因此 adapter 只从 `event_msg` 取正文，
   `response_item` 仅提取 `function_call`/`custom_tool_call` 的工具名——否则
   同一轮消息会双份落库、且环境注入会被当成用户提问；
4. `turn_context.payload` 携带 model/cwd，作为缺省补充。

### 实施中的边界决策

1. **claude taskId 前缀**：ACode 既有前缀是 `claude-import-<digest>`（非 jcode 的
   `imported_claude_`）。零回归红线要求历史关联不断，claude-code adapter 沿用
   `buildImportedClaudeTaskId` 原样；新来源前缀为 `imported-codex-` 等（R1 示例形态）。
2. **origin 元数据**：`ACodeTaskMeta` 的 zod schema 冻结在本批次之外（shared 不在
   K5 写权限），未知字段会在 `parseLegacyTaskSessionFile` 时被剥离。origin
   （source+sourceSessionId）因此由**确定性 importedTaskId** 承载：
   `sha256(source:sourceSessionId)` + 来源前缀（批次 C 复核 F5：digest 不含 cwd——
   cwd 只进 meta.workspacePath，进幂等键会让同 session 跨 cwd 的文件双份导入）；
   幂等去重 = 任务索引中该 taskId 已存在于**活任务集** → skipped(`already_imported`)，
   已删除任务的重导入走恢复语义（见 R3）。等 meta 协议扩展后再落显式 origin 字段。
3. **结果类型**：shared 的 `ACodeImportSessionSourceProvider` 只有 `"claude"` 一个值，
   新来源的导入结果无法塞进 `ACodeImportSessionsResult`。services 层定义
   `ExternalImportResult`（含 `skippedReasons` 聚合）；`importClaudeSessions` 用
   TypeScript 重载保持缺省调用返回类型不变（UI 零改动），显式新来源返回
   `ExternalImportResult`。
4. **新来源落库链路**：`acodeSessionImportHistorySchema` 是 `.strict()` 的
   `source: "claudeCode"` 单值判别联合，新来源无法走 createSession+importedHistory
   续聊路径。当前走 `persistImportedClaudeTask`（legacy snapshot + 任务索引，函数名
   带 claude 但实现是通用的）；协议扩展出多来源 importedHistory 后再接续聊。
5. **路径段守卫**：spec 要求复用 `memoryService.ts` 的 `isValidPathSegment` 私有
   实现，但 `packages/services/src/memory/**` 是本批次禁碰的互斥写区，无法提取导出。
   `external-import/pathSegmentGuard.ts` 承载判定条件逐条一致的唯一实现，
   memory 侧解禁后应合并。
6. **claude-code 与 R2 行级防护的关系**：既有 parser 对损坏行是整文件抛错（行为红线
   不能改），因此 claude-code adapter 的对抗语义是「路径穿越 adapter 层拒绝、未知
   事件静默跳过（parser 原有能力）、损坏文件归入 failed 不崩」；4MiB/深嵌套行级跳过
   只在四个新来源 + `importGuards` 基础件上生效（`readJsonLinesFile` 未动）。
7. **修复器策略**：`importedClaudeHistoryRepair` 的判定假设（migrationSource=
   claudeCode、claude-import- 前缀、原生 jsonl 反查）对非 claude 来源全部不成立，
   `shouldRepairImportedClaudeSnapshot` 天然返回 false。策略已在
   `importedHistoryRepairPolicy` 登记：claude-code → claude-native，其余 → noop。
8. **`messageCountEstimate` 语义**：发现阶段的粗略估计（codex/cursor 取头部 32 行
   扫描计数，gemini/opencode 全量读取成本高记 0=未估算），不是精确值。

### 批次 C 对抗复核修复（2026-10-04，K5 finding F1/F4/F5/F6）

1. **F1 opencode part 路径穿越**：`part/<messageId>/<partId>.json` 拼路径前
   messageId（外部 value.id）与 entry（外部 parts 字符串）各过路径段守卫——messageId
   非法按会话级拒绝，entry 非法按 entry 级丢弃计数；解析后再断言 resolved 路径仍在
   ownerDir 之内（relative 不以 `..` 开头且非绝对）作双层防御。同类面排查结论：
   codex/cursor/gemini/claude-code 的路径均来自 readdir 遍历 + 入口处已断言的
   sourceSessionId，无第二处外部值拼路径点。
2. **F4 workspace 匹配守卫 / F5 幂等键去 cwd / F6 已删除任务重导=恢复**：见 R4、
   附录实施记录第 2 条与 R3 的对应补记。
