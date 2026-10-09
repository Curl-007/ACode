# Script Workflow owner gate bounded context

状态：W2 最小写边界切片（2026-10-09）。`@acode/workflow-run-command` 公开
脚本工作流 resume 的 owner gate；bootstrap 只负责组装当前会话上下文并调用该契约。

## 所有权与接口

- `assertScriptWorkflowResumeOwner` 是 resume 前唯一的 owner 校验实现。
- 运行记录的 `parentSessionId`、`workspaceIdentity`/`cwd` 和 `remoteSessionId` 是被校验的持久事实；
  当前请求的会话、workspace 和远端连接由调用方注入。
- package 只读取 `SessionStorePort.getSession`，不保存运行状态、不创建第二份 owner registry，
  也不读取或写入 workflow journal。

## 校验顺序与失败语义

1. `run.parentSessionId` 必须同时等于当前 owner 的 `parentSessionId` 与注入的 `sessionId`。
2. workspace identity 按 `run.workspaceIdentity`、父 session 的持久 `workspaceID`、`run.cwd` 顺序回退，
   再与当前 `workspaceIdentity` 或 `workspacePath` 比较。
3. `remoteSessionId` 采用 trim 后的精确相等比较；缺失的一侧不会被视作通配符。
4. 任一校验失败抛出不可恢复、不可重试的 `PermissionDenied`，并携带 `ownerMismatch` 与边界名称；
   成功返回 `void`。校验失败发生在任何脚本执行、缓存导入或运行状态写入之前。

## 迁移边界与验收

- bootstrap 的 `script-workflow-tool-port` 与 `script-workflow-runtime` 只能从
  `@acode/workflow-run-command` 公共入口导入 owner gate，不得深导入 bootstrap 的实现文件。
- 删除 bootstrap 原 `script-workflow-owner.ts` 后，bootstrap 与 package 仍可 typecheck/lint。
- focused 测试覆盖：合法 owner、parent session 越权、workspace fallback/越权、远端 identity 不匹配，
  以及错误结构化属性。
