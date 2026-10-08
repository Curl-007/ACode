# 服务层文件操作路径收口（commands / subagents / feedback）

状态：已实施（2026-10-08，安全修复批次 H3/M7/M8/M9 落地件）。
守护测试：`packages/services/test/feedbackLogArchiveCleanup.test.ts`、
`packages/services/test/commandsPathConfinement.test.ts`、
`packages/services/test/subagentsPathConfinement.test.ts`。

## 背景与威胁模型

- commands / subagents / feedback 三个服务经 `packages/client/src/remoteServiceAccess.ts` 的
  ProxyChannel 全量暴露给 renderer 与远程 web 客户端；`packages/rpc` 层不做参数 schema 校验，
  文件路径类参数是裸 string。
- 被攻破的客户端可以让服务进程以自身权限删除/读取/覆盖受控目录之外的任意文件
  （confused deputy）。本批次四个漏洞同源：
  - H3：`feedback/compactLogArchive.ts` 的 `cleanupLogArchive` 对 RPC 裸 string 直接
    `rm(join(path,".."), {recursive:true,force:true})` 且吞异常——传 `<任意目录>\x`
    即递归删除任意目录整树；`feedbackService.cleanupPreparedLogArchive` 原样透传。
  - M7：`commandsService.deleteCommandFile` 直接 `rm(params.filePath)`；
    `updateCommandFile` 直接 `readFile(params.oldFilePath)`（内容并入返回值
    `command.content` 外泄）并 `rm(params.oldFilePath)`。
  - M8：`commandsService.getCommandFileName` 仅去前导 `/` 并按 separator 转换 `:`，
    `config.name` 中的 `..` 段可穿越 commandsRoot；且 `updateCommandFile` 的存在性检查以
    `newFilePath !== params.oldFilePath` 为前提，令 oldFilePath 等于穿越后的 newFilePath
    即跳过检查、覆盖任意已存在文件。
  - M9：`subagentsService.deleteAgent/updateAgent` 直接 `rm(params.filePath/oldFilePath,
    {force:true})`，唯一防护 `isBuiltInAgentAliasPath` 只挡 `built-in:`/`bundled:` 展示别名。

## 收口原则与所有权

- **服务层是路径收口的唯一所有者**：校验落在各服务实现内，不改 rpc 框架、不在 client/UI
  做第二份"权威"校验（UI 表单校验只是体验前置，不构成安全边界）。
- 共享助手：`src/fs/pathConfinement.ts` 的 `confinePath`（三态判定，见下）。既有同仓先例：
  `skillsService.deleteSkill`（realpath + 受控根白名单 + relative 越界拒绝）、
  `subagentsService.validateUserAgentConfig`（name 白名单）、
  `commandsService.resolveInside`（插件清单相对路径收口）。
- `confinePath` 判定语义：
  - `inside`：目标存在且 realpath 规范化后严格位于某个受控根之内（或命中结构兜底）。
    返回规范化路径，后续 fs 操作只消费该路径。
  - `absent`：目标不存在、但词法解析后位于受控根之内——调用方按幂等 no-op 处理，
    保持既有 ENOENT-as-success 语义（重复删除/清理不报错，附带状态清理照常执行）。
  - `outside`：越界（含"词法在内但 realpath 逃逸"的软链祖先穿越）——调用方必须拒绝并抛错
    （fail-closed），不得消费返回路径。
  - 两侧比较前先 `realpath` 规范化，系统软链别名（如 macOS `/tmp`→`/private/tmp`）在两侧
    抵消不误判；目标不存在时退化为词法比较（不存在的路径无法经软链被利用）。
  - `fallbackDirectorySegments` 结构兜底：仅用于"RPC 参数无法解析出真实受控根"的场景
    （`CommandDeleteParams`/`AgentDeleteParams` 不携带 workspacePath），要求目标的规范化
    路径位于任意一个以给定段序列结尾的目录（如 `.acode/commands`）严格之内。结构兜底把
    可删除面收敛到"命令/agent 文件本域"，排除任意路径删除。

## 产品规则

### R1 feedback：cleanupLogArchive（H3）

- 清理目标（归档文件 path 的父目录）必须严格位于 `getFeedbackLogArchiveDir()` 之内，
  realpath 规范化后比较。
- 越界：拒绝（抛错）并记录 `warn` 日志（createServiceLogger("feedback")）；
  目标不存在：幂等 no-op，不抛错。
- 合法链路不受影响：compact 归档（`createFeedbackDiagnosticArchive`）与 desktop main 的
  full 归档（`createFeedbackLogArchiveFromExportLogs`）outputRootDir 同为
  `getFeedbackLogArchiveDir()`，`attachLogsFromExport` 的 finally 清理与
  `cleanupPreparedLogArchive` RPC 走同一收口。
- 根目录自身（relative 为 ""）不可被当作清理目标。

### R2 commands：自由格式路径入参（M7）

- 受控根集合（仅 `.acode` 来源；`.agents/commands` 在 UI 为只读来源
  ——`isEditableUserCommand` 要求 `location.source === "acode"`——不进入可写删根；
  插件命令文件由插件管理，同样越界）：
  - 用户级根：`getUserCommandsRootForDescriptor(descriptor)`（`<home>/.acode/commands`）。
  - 项目级根：`join(workspacePath, ...descriptor.workspaceDirectorySegments)`
    （`<ws>/.acode/commands`，仅当参数携带 workspacePath）。
- `updateCommandFile.oldFilePath`（读取 + 删除）：必须落在受控根集合内（用户级 ∪ 项目级，
  覆盖"编辑时切换 scope"的跨根改名场景）。越界：抛错拒绝，读取不发生、内容不外泄、
  删除不发生；校验前置在任何写盘之前。absent：`existingContent` 按 undefined 处理、跳过删除。
- `deleteCommandFile.filePath`：参数无 workspacePath，受控根为用户级根 + 结构兜底
  `[".acode","commands"]`（项目级命令文件）。越界抛错；absent 保持幂等
  （enabled override 清理照常执行）。
- 收口后 `readFile` 只可能命中 `inside` 判定的规范化路径。

### R3 commands：config.name 净化与最终路径断言（M8）

- `getCommandFileName` 在去前导 `/`、按 namespaceSeparator 做 `:`→`/` 转换后逐段校验：
  - 段非空；拒绝 `.` 与 `..` 段；拒绝含 `\`、`:` 与控制字符（<0x20）的段
    （`\` 挡 Windows 分隔符/UNC，`:` 挡盘符与 NTFS ADS，同时不破坏 `:`→`/` 转换语义）。
  - 保留 `/` 分层能力（嵌套命令目录是既有语义，`getCommandName` 会从嵌套目录生成分层名）；
    字符集不在服务层收窄到 UI 表单白名单（`^[a-zA-Z0-9_-]+$`）以内——盘上手写/CLI 生成的
    合法命令文件名可能含点号等字符，防穿越由段规则 + 双保险断言承担。
- `writeCommandFile`/`updateCommandFile` 在 join 后用 `relative()` 断言最终路径仍严格位于
  commandsRoot 之内（双保险），否则抛错；`mkdir(dirname(newFilePath))` 因此不可能创建
  逃逸中间目录。
- `oldFilePath == newFilePath` 跳过存在性检查的分支收口后只能命中 commandsRoot 内文件，
  即"原地更新"的正常语义；以穿越路径覆盖任意已存在文件的技巧失效（name 校验先拒绝）。

### R4 subagents：deleteAgent/updateAgent（M9）

- `updateAgent.oldFilePath`：必须位于按 scope 解析出的受控 agent 根内——
  user → `resolveUserSubagentRoot(storageOptions)`；
  workspace → `resolveWorkspaceSubagentRoot(workspacePath)`（参数必带 workspacePath，
  缺失即既有 `requireWorkspacePath` 抛错）。越界：抛错拒绝，且校验前置在新文件写盘与
  disabled 状态迁移之前；absent：跳过删除（保持原 `force:true` 幂等）。
- `deleteAgent.filePath`：`AgentDeleteParams` 无 scope/workspacePath，受控根为用户级
  agent 根 + 结构兜底 `[".acode","agents"]`（项目级 agent 文件）。越界抛错；absent 保持
  幂等（disabledAgentIds 状态清理照常执行）。
- `built-in:`/`bundled:` 展示别名的既有拒绝逻辑保留，先于路径收口执行。
- 新文件路径 `join(agentDir, "<name>.md")` 的 name 已由 `validateUserAgentConfig`
  白名单（`^[a-zA-Z0-9-]+$`）约束，无穿越面。
- 已知边界：用户 agent markdown 迁移失败被保留在旧位置时（`migrateUserSubagentMarkdown`
  failures），删除该文件会被收口拒绝——fail-closed，与"迁移失败保留原文件"的既有纪律一致。

## 验收场景

1. 合法路径照常：命令创建/更新/改名/删除（用户级与项目级）、subagent 创建/改名/删除
   （用户级与 workspace 级）、feedback 归档准备与清理全链路成功。
2. 越界拒绝：向 `deleteCommandFile`/`updateCommandFile(oldFilePath)`/`deleteAgent`/
   `updateAgent(oldFilePath)`/`cleanupLogArchive` 传受控根之外的任意存在路径 → 抛错，
   目标文件/目录保持原样，越界文件内容不经返回值外泄。
3. `..` 段拒绝：`config.name` 为 `../../evil`、`a/../b`、`C:/evil`、`a\b` 等 → 创建/更新
   拒绝，最终写入路径恒在 commandsRoot 内。
4. `oldFilePath == newFilePath` 技巧失效：以穿越路径同时充当 old/new 路径不能跳过存在性
   检查覆盖任意已存在文件。
5. 软链祖先不穿越：受控根内指向外部的软链目标经 realpath 规范化后判定 outside。
6. 幂等：对不存在目标重复删除/清理不抛错（absent no-op），附带的状态清理
   （enabled override / disabledAgentIds）仍执行。
