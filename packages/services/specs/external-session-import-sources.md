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

### R4 服务编排（`external-import/importService.ts`）

- 多来源并行发现（`Promise.allSettled`，单来源失败不拖垮整轮——单来源 warn）；
- 时间范围/上限参数沿用既有 UI 语义（7d/30d/90d/all、500/unlimited）；
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
