# ApplyPatch 工具（S2：悬空 contract 落地为真实 handler）

状态：已实施（批次 4）。上游遗留的完整 contract（`contracts/src/tools/apply-patch.ts`）
自始无 handler；本 spec 定义 v1 落地范围与语义。

## 背景与裁决

**为什么是实现而不是移除**（路线图 S2 给了两个选项）：移除面反而更大且丢弃能力——
下游接线是有意预铺的，全部在等一个 handler：

| 接线点 | 位置 | 现状 |
| --- | --- | --- |
| 工具身份/GUI family | `packages/shared/src/tool-identity.ts`（`ApplyPatch: "file-write"`） | 已登记 |
| GUI Changes 聚合 | `packages/shared/src/protocol.ts:327`（Write/Edit/ApplyPatch 聚合注释） | 已预期 |
| hook 匹配别名 | `core/src/tool/compat.ts`（`ApplyPatch → [Write, Edit]`，用户 Write/Edit 规则与 hook 自动覆盖） | 已登记 |
| 权限规则 subject | `core/src/permission/service.ts` `ruleSubjects` 提取键含 `patch_text` | 已提取 |
| 写工具启发式 | `core/src/permission/service.ts` `isWriteTool` 含 ApplyPatch | 已登记 |
| 旁路免疫熔断器 | `core/src/permission/bypass-immune-breakers.ts` `WRITE_TOOLS` 含 ApplyPatch | 已登记，但**路径提取有缺口**（见 R4） |
| 策略地板 spec | `specs/managed-policy-floor-and-bypass-immune-breakers.md` 熔断表含 ApplyPatch | 已声明 |

能力面：多文件**一次校验、一次应用**的原子化编辑是 Edit（单文件单串）与 Write（整文件
重写）之间的真实空档；zoode 对 Codex 的逆向研究确认 apply_patch 是该模型族的原生主
编辑面（本实现为自有代码，格式语法为公开约定，不复制任何上游实现）。

**v1 范围**：Add / Update / Delete 三种 section。**Move 不支持**——`FileSystemPort`
无 rename 原语，用 read+write+remove 模拟 move 对二进制文件不安全；解析器认识 Move
section 并给出明确拒绝文案（指向 Bash `git mv`），端口扩展登记 v2。

## R1 补丁格式（V4A 风格，自有解析器 `core/src/tool/apply-patch-format.ts`）

```
*** Begin Patch
*** Add File: <path>
+<新行>
*** Update File: <path>
@@ <可选提示，解析但不参与匹配>
 <上下文行，前缀一个空格>
-<删除行>
+<新增行>
*** Delete File: <path>
*** End Patch
```

- 必须以 `*** Begin Patch` 开始、`*** End Patch` 结束；`End Patch` 后只允许空白行。
- 补丁文本先整体做 EOL 归一（CRLF→LF）再按行解析；空行（`""`）在 hunk 内视为空上下
  行文（容忍模型丢失前导空格的常见形态）。
- `*** Add File` body 每行必须以 `+` 开头；新文件内容 = 各行去前缀后以 `\n` 连接并
  以换行收尾（空 body = 空文件）。v1 不支持 "no newline at end of file" 标记。
- `*** Update File` 的 hunk = 连续的 context/remove/add 行；**匹配语义与 Edit 同纪律**：
  context+remove 行必须与文件当前内容（EOL 归一后）逐行精确一致且**唯一**——0 处命中
  报 `HUNK_NOT_FOUND`，多处命中报 `AMBIGUOUS_HUNK`（提示补更多上下文）。同一文件多个
  hunk 顺序应用，后一个 hunk 对前一个的结果匹配。
- Update 写回保留文件既有换行风格（`read.lineEndings` 透传给 `writeTextFile`，与 Edit
  同源）与尾换行状态（按原文件的 trailing-newline 重建）。
- `*** Delete File` 无 body；`*** Move File` / `*** Move to` 解析为 move section，
  handler 一律拒绝（v1）。
- 同一文件出现在多个 section → `INVALID_PATCH`（v1 单文件单 section，避免应用序歧义）。
- 未知 `***` 指令、section 前出现 body 行、缺 Begin/End → `INVALID_PATCH`；
  零 section → `EMPTY_PATCH`；空路径 → `INVALID_PATH`。

## R2 执行语义（两段式，诚实原子性）

1. **校验段**（零写入）：解析 → 逐 section `resolveWorkspacePath` → stat/存在性
   （Add 要求不存在→`FILE_EXISTS`；Update/Delete 要求存在→`FILE_NOT_EXIST`，附 cwd
   提示）→ 1GB 上限（`FILE_TOO_LARGE`，与 Edit 同值）→ `.ipynb` 守卫（`NOTEBOOK_FILE`，
   文案与 Edit F7 修复后同源：指向 Write 整写 / Bash 结构化编辑）→ readTextFile →
   **read-before-edit 与 staleness**（Update/Delete 目标必须已 Read 且未变化，语义与
   Edit 的 `getEditableReadStateFailure` 一致，用 `read-file-state.ts` 导出原语实现，
   错误码 `FILE_NOT_READ`/`STALE_FILE`）→ hunk 匹配 → 在内存算出每个文件的新内容。
2. **应用段**：按 section 序写盘——Add/Update 走 `writeTextFile`（`atomic: true`、
   `expectedRevision` 乐观并发、`createParents: true`、`stampMemoryOriginSessionId`
   同 Edit/Write）；Delete 走 `removeFile`。中途 IO 失败 → `IO_ERROR`，message 如实
   列出已应用的文件（**不做跨文件回滚，不谎称事务**——校验段已把常见失败前置到零写入）。
3. 应用后逐文件更新 `readFileState`（`sourceTool: "ApplyPatch"`；Delete 移除条目）并
   `recordReadFileStateMetadata`，使后续 Edit/Write 看到新鲜状态。**resume 诚实边界**：
   持久化 metadata 是单文件槽位，多文件补丁 resume 只恢复最后写入的文件，其余退回未读
   态（保守 fail-safe，模型需重新 Read）；`PersistedReadFileStateTool` 联合与 hydrator
   分支已接 ApplyPatch。
4. 输出 = contract 的 `ApplyPatchOutput`：`files[]`（含逐文件 `structuredPatch`，经
   `createStructuredPatch`）、顶层 `structuredPatch`（逐文件串联）、`summary`
   （`Applied patch: N file(s) — a.ts updated (+x −y), b.ts added, c.ts deleted`）。
   `formatModelContent` 输出 summary + Edit 同款 freshness 后缀。

## R3 错误码契约修订（字符串 → 数字）

`ToolHandlerFailure.errorCode` 全仓为 **number**（`core/src/tool/executor/errors.ts:83`
强校验 `typeof === "number"`；Edit/Write/Bash 全部数字码）。悬空 contract 的
`ApplyPatchErrorCode` 是字符串常量且**零消费者**——修订为数字常量，语义与 Edit 同值
对齐（跨工具同语义同码，GUI/遥测分组不意外）：

```
INVALID_PATCH: 1, EMPTY_PATCH: 2, FILE_EXISTS: 3, FILE_NOT_EXIST: 4,
NOTEBOOK_FILE: 5, FILE_NOT_READ: 6, STALE_FILE: 7, HUNK_NOT_FOUND: 8,
AMBIGUOUS_HUNK: 9, FILE_TOO_LARGE: 10, IO_ERROR: 11, INVALID_PATH: 13
```

原字符串码值（`apply_patch_invalid_patch` 等）随修订删除；`ApplyPatchOutput.files[].type`
词汇（add/update/delete/move）不变——move 保留在输出 schema 供 v2。

## R4 权限与安全接线

- **entry 元数据与 Write/Edit 同档**：`riskLevel: "medium"`、`sideEffectScope:
  "workspace"`、`needsApproval: true`、`permission: "edit"`、`patternSources: ["path"]`、
  `alwaysAllowPatternSources: ["path"]`、`denyPriority: "beforeAsk"`、`readOnly: false`、
  `concurrentSafe: false`、`timeoutMs: 30000`。auto 模式经批次 3 分类器走灰区（medium
  档既有语义，零新接线）。
- **熔断路径提取缺口（本批修复）**：`checkPathEscapeWrite` 只认 `input.file_path /
  input.path` 字段，ApplyPatch 输入是 `patch_text` → 现状会**静默跳过**路径逃逸熔断。
  新增 `extractApplyPatchTargetPaths(patchText)`（`apply-patch-format.ts`，逐行宽松提取
  section 头路径，含 Move to 目标；畸形补丁不抛错、尽力提取），breaker 对 ApplyPatch
  改用它：**任一**目标路径解析后逃逸 workspaceRoot → `breaker.pathEscapeWrite` 命中
  （ask 语义不变）。import 方向 permission→tool 有先例（bash-command-parser）。
- 规则/hook 面零改动即生效：`ruleSubjects` 已提取 `patch_text`（通配规则可匹配补丁内
  路径子串）；`compat.ts` 别名使 Write/Edit 规则与 hook 匹配器覆盖 ApplyPatch。
- automation/off-peak 轮次无 handler 级门（与 Edit/Write 一致，由权限层统一处理）。

## R5 注册面

- `handlers/index.ts` `builtInTools` 注册 `applyPatchToolEntry`（Edit 之后），无灰度门
  （核心编辑原语，与 Edit/Write 同列；接线全部无条件预铺，门控反而制造不可达表面——
  批次 3「无表面则死代码」教训的反面应用：接线在而表面缺席同样是死的）。
- `provider-visible-order.ts` sort set 加入 `"ApplyPatch"`（字母序 Agent 之后）。
- 模型可见描述：紧凑语法说明 + 定位引导（多文件协同变更用 ApplyPatch；单文件单点编辑
  优先 Edit；整文件创建/重写用 Write），明示 read-before 与唯一匹配纪律、workspace
  边界与 Move 不支持。描述进提示词语料，遵循审计纪律（无悬空工具引用——描述只提
  真实存在的工具名）。

## 验收场景

1. **解析器**：合法 Add/Update/Delete 补丁；缺 Begin/End；End 后有内容；空补丁；未知
   指令；section 前 body；Add body 非 `+` 行；同文件多 section；`@@` 提示容忍；CRLF
   补丁文本归一；Move section 解析出 from/to。
2. **路径提取**：四种 section 头 + `Move to` 全部提取；畸形文本不抛错。
3. **handler 集成**（内存 port 夹具）：add 创建；add 已存在→FILE_EXISTS；update 精确
   应用（多 hunk 顺序）；不匹配→HUNK_NOT_FOUND；多处匹配→AMBIGUOUS_HUNK；未读→
   FILE_NOT_READ；陈旧→STALE_FILE；delete 移除；delete 不存在→FILE_NOT_EXIST；
   ipynb→NOTEBOOK_FILE；move→拒绝文案含 Bash 指引；应用后 readFileState 更新
   （sourceTool=ApplyPatch、delete 移除条目）；输出 files/summary 计数正确。
4. **熔断**：patch_text 含逃逸路径→`breaker.pathEscapeWrite` 命中；全在 workspace 内
   →不命中；畸形 patch_text 不抛错。
5. **注册不变量**：builtInTools 含 ApplyPatch；sort set 含 ApplyPatch 且不含 S3 移除
   的死名。
6. **验证命令**：`node --import tsx --test apps/acode-cli/tests/apply-patch-tool.test.mjs`；
   回归 `bypass-immune-breakers.test.mjs`、权限电池全套；CLI 三包 tsc + 根 typecheck +
   lint + arch。

## 不在本 spec 范围（登记）

- Move/rename：v2，`FileSystemPort.rename` 端口扩展独立批。
- GUI 专属 renderer 核验：family 映射（file-write）已存在，未识别时 raw fallback 容错；
  桌面 E2E 轮补验。
- `MultiEdit`（breaker `WRITE_TOOLS` 中的另一死名）：防御性集合成员、非模型可见占位，
  保留不动。
- "no newline at end of file" 标记、`@@` 提示参与消歧：v2 按需。
