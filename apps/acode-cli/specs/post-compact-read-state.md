# 压缩后已读状态保留（post-compact read state）

修复长对话中 Edit/Write/ApplyPatch 高频误报 `FILE_NOT_READ`（"File has not been read
yet…"）的主因。性质：**缺陷修复 + 语义定版**。2026-10-20 诊断确认，用户裁决修复。

## 背景（已核实的根因）

写前门禁（Edit `edit.ts` getEditableReadStateFailure、ApplyPatch `apply-patch.ts`
getPatchableReadStateFailure、Write `write.ts` assertWritableExistingFileIsFresh）依赖
runtime 内存表 `readFileState`：查不到条目 → `FILE_NOT_READ` 拒绝。压缩流程存在三条
互相叠加的误报路径：

1. **压缩收尾无条件整表清空**：`runtime/methods/compact-active.ts` 的
   `this.readFileState.clear()`（上游初始提交继承行为），且
   `hydrateReadFileStateFromSession` 只接 resume/rewind 两个调用点——live 压缩后无任何
   重建。压缩后模型对任何压缩前读过的文件首次 Edit/ApplyPatch 必报 `FILE_NOT_READ`。
2. **内容投影提醒不回填状态**：`runtime/helpers/compact-post-reminders.ts` 把最近读过
   的至多 5 个小文件内容以 system-reminder 投影回上下文（"Called the Read tool…
   Result of calling the Read tool:"），模型据此认为已读、直接 Edit——状态表却是空的。
3. **保留尾巴（preserved tail）里的 Read 被双盲**：未进摘要、仍留在上下文里的
   Read/Write/Edit 工具调用，其路径被提醒构建器显式排除（模型"看得见"原始读取），
   状态却同样被清空——模型能看到自己刚发的 Read 结果，Edit 仍被拒，且无内容提醒。

次级放大面（同一文案、不同成因）：token 上限截断的 Read 标记 `isPartialView`
（`read.ts` updateReadFileState），三个写工具把「读过但视图被截断」与「从未读过」合并
成同一条 `FILE_NOT_READ` 文案，模型收到"先读文件"指引后原地重读整文件仍被截断，
容易打转。

已排除的假设：同一并行块内 Read+Edit 竞态不存在（`tool/scheduler.ts` 无依赖时按发出
顺序分组，写工具独占串行组）；外部改文件走 `STALE_FILE` 文案，与本缺陷无关。

## 产品规则

### R1 压缩后 readFileState 按「模型可见」口径修剪，不再整表清空

压缩成功收尾时，仅保留模型压缩后仍能看见读取事实的条目，其余清除：

- **保留**：(a) preserved tail（`preservedEntries`）中 assistant 工具调用
  `Read`/`Write`/`Edit` 的 `file_path` 目标（原始工具调用与结果仍在上下文里）；
  (b) 提醒构建器**内容投影**（`formatReadStateProjection`）回放的文件。
- **清除**：只活在摘要里的读取（模型已看不见内容，重新 Read 是正确代价）；以及
  「too large」引用型提醒（`formatCompactFileReference`）指向的文件——该提醒自身
  指引 "Use Read tool if you need to access it"，清状态与文案自洽。
- 路径匹配统一走 `normalizeReadStatePathKey`（与 readFileState 键同一归一化所有者，
  win32 折叠大小写），不做裸字符串比较。
- ApplyPatch 的 preserved 调用不参与收集：其入参是 `patch_text`（多文件、无
  `file_path`），解析入补丁格式超出本项范围；对应条目按「摘要侧」清除（保守 fail-safe，
  与 hydrator 对 ApplyPatch 单槽位的既有保守语义同向）。

### R2 正确性由既有写前 stale 守卫兜底，保留不放行脏写

保留的条目不跳过任何写前校验：Edit/Write/ApplyPatch 落盘前照旧以
mtime（整数毫秒）/size/revision 对照磁盘实时校验（hasReadStateChanged /
hasPatchTargetChanged），压缩期间文件真被外部改过 → `STALE_FILE` 拒绝。因此 R1 的
保留只影响「模型是否看过内容」这一门禁维度，不影响「磁盘是否已变」维度。

### R3 partial view 拒绝文案必须与「从未读过」区分

三个写工具在 `lastRead.isPartialView === true` 时：

- 错误码**维持 `FILE_NOT_READ` 不变**（contracts 枚举不动，避免跨包契约变更）；
- 文案改为独立常量，必须包含：视图被截断的事实（truncated view）+ 可执行恢复动作
  （Edit/ApplyPatch：用 offset/limit 重读覆盖目标编辑区间的范围；Write：重读完整
  文件）。遵循 `error-message-style.md` R1 纪律：只写模型能执行的动作，不写死路。

### R5 resume/rewind 水合镜像 live 修剪口径

- 水合扫描**包含 compact preserved segment**（hydrator 的
  `includeCompactPreservedSegment` 由 false 改 true）：preserved tail 里的
  Read/Write/Edit 在 resume 后仍对模型可见，状态必须与 live（R1）同步恢复；排除它们
  与 live 整表清空是同类判定缺陷（上下文看得见读取却报 FILE_NOT_READ）。
- Read part 按 metadata 描述的窗口与 `isPartialView` **原样恢复**（range/partial
  视图同口径）；前提是 metadata 齐全（mtimeMs/sizeBytes/revisionId，由
  `createReadFileStateMetadataFromEntry` 写入时强制），恢复后 stale 守卫与 live 等价。
- 无结构化 metadata 的历史读取仍不恢复（freshness 无依据，保守 fail-safe）；range
  窗口入参单独计入 `skippedRangeReadCount`，resume 日志口径不变。
- **仅内容投影的文件不恢复**：reminder attachment 有内容无 freshness metadata，恢复
  会削弱 stale 守卫（R2）；保守要求重新 Read（已知边界登记）。

### R4 所有权与唯一实现点

「模型可见」判定与修剪策略唯一实现在 `runtime/helpers/compact-post-reminders.ts`
（与提醒构建同一所有者——两者共用同一可见性口径，避免双事实源）；
`compact-active.ts` 只消费。Edit/ApplyPatch 的文案常量留在各 handler 文件（既有
先例：三个 handler 对 stale 守卫各自本地实现）；Write 的新鲜度守卫（未读/partial/
stale 三态拒绝 + 三条文案常量）整体迁至 `tool/handlers/write-freshness.ts`——
架构 legacy ratchet 对 write.ts 有 max-file-lines 400 上限（HEAD 396 行），新增
partial 分支即超限；守卫语义逐行未变，仅换文件（write.ts 落至 333 行）。

## 状态所有者与事件顺序

| 事实 | 唯一所有者 |
| --- | --- |
| 压缩后哪些已读状态保留 | `runtime/helpers/compact-post-reminders.ts`（`pruneReadFileStateAfterCompact`） |
| 内容投影提醒的选择与投影路径 | 同上（`selectPostCompactReadStateReminders`） |
| 写前未读/partial/stale 门禁 | edit.ts / apply-patch.ts 各自本地实现；write 在 `tool/handlers/write-freshness.ts`。语义与 `specs/apply-patch-tool.md` 一致 |
| 路径归一化 | `tool/path-normalization.ts`（`normalizeReadStatePathKey`；read-state 键/比较专用，win32 折叠大小写） |

事件顺序（压缩成功路径）：

```
selectCompactEntries → summary 请求 → selectPostCompactReadStateReminders
  （产出 reminder entries + contentProjectedPaths，读 readFileState 快照）
→ 持久化/回写 messageHistory
→ pruneReadFileStateAfterCompact（preserved tail 路径 ∪ 投影路径 之外的条目删除）
→ 下个 turn：Edit/ApplyPatch/Write 门禁照常查表 + stale 守卫兜底
```

## 设计取舍裁决（2026-10-21，用户授权「按推荐来」）

三项扫描登记项裁决为**有意边界，非缺陷**，记录防未来误「修」：

- **D1 仅内容投影文件跨 resume 不恢复**：维持。reminder attachment 有内容无
  freshness metadata，恢复会让 stale 守卫退化为仅 size 对照（同字节数内容改动漏检 →
  脏写风险）；保守重 Read 代价一次调用。重议触发：attachment 或 boundary metadata
  承载 mtime/revision 之日。
- **D2 子代理 read-state 不继承主会话**：维持。门禁不变量是「编辑主体亲眼见过内容」；
  子代理的报告是摘要非字节，继承会让主会话编辑从未见过的内容、破坏不变量。摩擦成本
  =主会话一次额外 Read，恰为门禁文案指引的动作。重议触发：子代理产出字节保真工件通道
  （带 freshness）之日。
- **D3 2000 行行上限截断不标 isPartialView**：维持宽。门禁无法知晓编辑目标区域；标
  partial 会挡住大文件整读后的一切编辑（含已见区域），纯增摩擦；未见区域的编辑由
  old_string 对盘匹配失败天然拦截（虚构文本不匹配），残余巧合匹配风险远小于阻挡代价。
  重议触发：门禁能做编辑区域 vs 视图窗口比对之日。

## 已知边界（登记，不在本项范围）

- **仅内容投影的文件跨 resume 不恢复**（R5 末条）：reminder attachment 无 freshness
  metadata，恢复会削弱 stale 守卫；保守要求重新 Read。live 侧这些文件的状态由 R1
  保留，resume 侧有意不镜像这一子集。
- **子代理读取不计入主会话状态**：跨 runtime 隔离是设计使然，不改。
- **无结构化 metadata 的历史读取不恢复**：freshness 无依据，保守 fail-safe（R5）。

## 验收场景

1. **修剪语义**（`packages/core/tests/post-compact-read-state.test.ts`）：
   - preserved tail 含 Read/Write/Edit 调用 → 对应路径条目保留；
   - 内容投影文件 → 保留；「too large」引用提醒文件 → 清除；
   - 只活在摘要侧的读取 → 清除；
   - 路径归一化匹配（平台条件分支：win32 全路径大小写/盘符别名/分隔符变体视为同一路径，
     posix 大小写敏感；`packages/core/tests/read-file-state-path-key.test.ts` 钉键空间）；
   - 返回值如实报告 retained/removed 计数。
2. **提醒选择**：`selectPostCompactReadStateReminders` 的 `contentProjectedPaths`
   只含内容投影文件；`buildPostCompactReadStateReminderEntries` 包装行为与既有一致
   （preserved 路径跳过、.git 跳过、maxFiles/预算上限）。
3. **partial-view 文案**（`apps/acode-cli/tests/read-state-partial-view.test.mjs`）：
   - Edit：`isPartialView` 条目 → `FILE_NOT_READ` 码 + truncated view 文案（含
     offset/limit 指引）；未读 → 原文案不变。
   - ApplyPatch：同上（patching 措辞）。
   - Write：`isPartialView` 条目 → 抛错含 truncated view 文案（完整重读指引）；
     未读 → 原文案不变。
4. **零回归**：`apply-patch-tool.test.mjs` 全套（既有 FILE_NOT_READ/STALE_FILE 断言
   钉住错误码不变）、`compact-invariants.test.mjs` 全套（压缩不变量 I1–I5 不受影响）。
6. **水合镜像**（`packages/core/tests/read-file-state-hydration.test.ts`，R5）：
   - preserved segment 内的 Read（带 metadata）跨 resume 恢复，mtime/size/revision 透传；
   - range Read 的 metadata 按 offset/limit 原样恢复；partial-view metadata 恢复后
     `isPartialView` 保持 true；
   - 无 metadata 的读取不恢复，range 入参计入 `skippedRangeReadCount`；
   - Write part 的 metadata 恢复路径零回归（sourceTool=Write）。
5. **真实链路 E2E**（`apps/acode-cli/tests/post-compact-edit-e2e.test.mjs`）：真
   AgentRuntime + 真 sqlite store + 真 `compactActiveConversation` 管线 + 真
   Read/Edit handler（真 Node fs adapter），唯一桩件为摘要文本的 generateText——
   - 小文件真实 Read 过 → 真实压缩后状态保留 → 真实 Edit 成功落盘（修复前必报
     FILE_NOT_READ 的用户缺陷形态）；
   - 大文件（>5k token 投影上限）真实 Read 过 → 压缩后状态清除 → 真实 Edit 如实
     报 FILE_NOT_READ 且文件未被修改。

## 验证命令

```bash
node --import tsx --test apps/acode-cli/packages/core/tests/post-compact-read-state.test.ts
node --import tsx --test apps/acode-cli/tests/read-state-partial-view.test.mjs
node --import tsx --test apps/acode-cli/tests/post-compact-edit-e2e.test.mjs
node --import tsx --test apps/acode-cli/tests/apply-patch-tool.test.mjs
node --import tsx --test apps/acode-cli/tests/compact-invariants.test.mjs
node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/core/tsconfig.json --noEmit
pnpm architecture:check --changed
```

## 门禁实跑结果（2026-10-20，Windows 本机，全部亲自执行）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 新增单测（修剪/提醒，场景 1/2） | `node --import tsx --test apps/acode-cli/packages/core/tests/post-compact-read-state.test.ts` | **7 / 7 通过** |
| 新增 partial-view 文案测试（场景 3，三工具） | `node --import tsx --test apps/acode-cli/tests/read-state-partial-view.test.mjs` | **5 / 5 通过** |
| ApplyPatch 回归（场景 4） | `node --import tsx --test apps/acode-cli/tests/apply-patch-tool.test.mjs` | **21 / 21 通过** |
| 压缩不变量回归（场景 4） | `node --import tsx --test apps/acode-cli/tests/compact-invariants.test.mjs` | **23 / 23 通过** |
| write handler 消费方回归 | `node --import tsx --test apps/acode-cli/tests/permission-breaker-honest-dialog.test.mjs` | **6 / 6 通过** |
| core 包全套 | `packages/core` 下 `node --import tsx --test "tests/*.test.ts"` | **116 / 116 通过** |
| core 类型检查 | `node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/core/tsconfig.json --noEmit` | **exit 0** |
| 架构检查 | `pnpm architecture:check --changed` | **`architecture: OK`，exit 0**（violations 54 = 既有基线；首轮曾红：write.ts 410 行超 legacy ratchet 400 上限，经 write-freshness.ts 提取后 333 行转绿） |
| CLI 侧 lint（覆盖本次文件） | `apps/acode-cli/node_modules/.bin/oxlint <改动文件> --no-ignore` | 新文件与 handler 改动 **0 warning / 0 error**；`compact-active.ts` 1 warning（`executionMaxOutputTokens` 未使用，HEAD 既有，本次未触碰该行） |
| 格式 | `oxfmt --check` | 本次新写/重写的 4 个文件（compact-post-reminders.ts、write-freshness.ts、post-compact-read-state.test.ts、read-state-partial-view.test.mjs）**全部合规**；apply-patch.ts / write.ts 在 HEAD 即有 oxfmt 基线偏差——经「HEAD 与工作区各自 oxfmt 后 diff」验证：差异仅含本次预期代码改动，新增行零格式偏差，按先例不顺手重排 |

**未执行 / 说明**：

- 根 `pnpm typecheck` 与根 `pnpm lint`：本次改动全部在 `apps/acode-cli`（根 typecheck
  只覆盖 `packages/*`，根 lint 的 ignorePatterns 排除 `apps/acode-cli`），两条根门禁
  对本次改动无信号——与 compact-invariants.md 门禁表同口径；实际类型/​lint 验证由上表
  CLI 侧命令承担。
- live 压缩端到端（真实 provider 触发 auto-compact 后验证 Edit 不再误报）未实机跑：
  修剪函数与提醒选择为纯函数单测覆盖，compact-active 接线为 2 处调用替换，编译期
  由 tsc 钉住。
- 本次改动已提交 **b3779769**（feature/value-extract-23737-r3），并按用户指令
  （2026-10-20「以 1.0.1 为基础新建 dev/1.0.2 再合入」）以 `--no-ff` 合入
  **dev/1.0.2 @c4779a93**；合并树与 feature 尖端逐字节一致（`git diff b3779769 HEAD`
  为空），上表门禁结论对 dev/1.0.2 直接承继。**未推送**（推送纪律：本地全量绿才推，
  分支基线自带 2 个电池失败待用户裁决）。

## 完整真实测试补跑（2026-10-20 用户指令「完整真实测试」，全部亲自执行）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 真实链路 E2E（验收场景 5） | `node --import tsx --test apps/acode-cli/tests/post-compact-edit-e2e.test.mjs` | **1 / 1 通过**（真 runtime+真 compact 管线+真 Read/Edit handler；对旧 clear() 行为有判别力） |
| acode-cli 全套 mjs 电池（含 E2E） | `node --import tsx --test "apps/acode-cli/tests/**/*.test.mjs"` | **2950 例：2944 pass / 2 fail / 4 skipped**。2 个失败为工作区既有问题（builtin-subagent-catalog「bundled 包必须在场」、skill-seeding-integration 插件缓存 ENOENT）——**归因实证**：将本项 10 文件单独 `git stash push -u` 后复跑，两者同样失败，与本项无关 |
| core 包全套（含新单测） | `packages/core` 下 `node --import tsx --test "tests/*.test.ts"` | **116 / 116 通过**（write-freshness 常量去导出化后复跑确认） |
| agent-teams-plugin 套件 | `packages/agent-teams-plugin` 下 `node --import tsx --test tests/*.test.ts` | **65 / 65 通过** |
| 根类型门禁 | `pnpm typecheck`（typecheck-gate：packages → desktop-renderer + cli 三阶段） | **exit 0**，三阶段 done（cli 55s，覆盖 apps/acode-cli） |
| 根 lint | `pnpm lint` | **exit 0，0 errors**（166 warnings 为工作区既有基线；涉及本次改动面的仅 compact-active.ts:207 HEAD 既有 warning） |
| 全量架构检查 | `pnpm architecture:check`（不带 --changed） | FAILED：violations 415 / baseline 414，**+1 为 `browser-use-plugin/scripts/relay-server.mjs`（1912 行）——gitignore 的本地产物，未被跟踪、非本项文件**；官方门禁 `--changed` 为 OK / exit 0 |
| knip | `pnpm knip` | exit 1（既有基线）。首轮曾新增 3 条未用导出（write-freshness 三文案常量）→ **已去导出化收敛**；复跑后本项新增符号（prune/select/常量/测试文件）**零命中**，基线未扩大 |
| write-freshness 终态 | `oxlint --no-ignore` + `oxfmt --check` | **0 warning / 0 error**、格式合规 |

上表首轮「未执行/说明」中的两条已由本表覆盖更正：根 `pnpm typecheck`（typecheck-gate
含 cli 阶段，实际覆盖 apps/acode-cli，exit 0）与 live 压缩端到端（以真实 runtime 集成
测试替代真实 provider：唯一桩件是摘要文本，压缩选择/持久化/修剪/门禁全部走真实代码）。

## R5 水合镜像门禁实跑（2026-10-20 工具判定侧修复轮，提交 daf32bee）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 新增水合镜像单测（场景 6） | `node --import tsx --test apps/acode-cli/packages/core/tests/read-file-state-hydration.test.ts` | **5 / 5 通过** |
| resume 路径回归 | `runtime-state-ownership` + `runtime-branch-continuation-races` + `runtime-branch-notification-races` + `agent-peer-messaging` 四套件 | **58 / 58 通过** |
| core 包全套 | `packages/core` 下 `node --import tsx --test "tests/*.test.ts"` | **121 / 121 通过**（116 + 新增 5） |
| core 类型检查 / lint / 格式 / 架构 | tsc `-p core --noEmit`；`oxlint --no-ignore`；`oxfmt --check`；`pnpm architecture:check --changed` | **exit 0 / 0 warning 0 error / 合规 / OK（violations 52 基线内）** |
