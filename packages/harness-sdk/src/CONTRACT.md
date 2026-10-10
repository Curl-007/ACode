# harness-sdk

`contract.ts` 是本模块的唯一公开契约；`index.ts`（包根 `@acode/harness-sdk`）整体转发它，
两者同时登记为 publicEntrypoints。消费方拿到的是：connect/launch 双模式客户端
（`AcodeHarnessClient`）、会话面（`HarnessSession`：run/send/events/ask/respondPermission/
fork/close）、连接层（`HarnessConnection`）、launch 运行时治理（`prepareLaunchRuntime`）、
错误归因（`describeDisconnect` 与各 `Harness*Error`）以及 SDK 常量。

owner 是 `harness-sdk-client`。状态所有权：连接层状态（pending request map、seq 单调性、
事件监听器集合）唯一所有者是 `HarnessConnection` 实例；会话状态（订阅、events() 队列、
权限 fail-closed 计时器）唯一所有者是 `HarnessSession` 实例；`AcodeHarnessClient` 只登记
活跃 session 并在 close 时统一回收，不另存第二份状态。

依赖方向：本模块只依赖 `@acode/shared/harness-api` 协议投影（requires: [shared]）、node
内置模块与 zod；任何模块不得反向依赖本模块的内部文件。`handshake.ts`、`session-types.ts`、
`structured-output.ts`、`connection-types.ts` 是拆分出的内部实现/中立类型落点（400 行物理
上限与 forbidCycles 治理），跨模块 deep import 会被架构检查拒绝。session 对 client 的依赖
经 `SessionClientPort` 倒置，client ↔ session 无循环。

权限红线（spec R5）：SDK 不提供绕过权限管线的执行捷径；`PermissionRequested` 无应答时在
`SDK_PERMISSION_TIMEOUT_MS` 内自动回执拒绝（超时=拒绝，fail-closed），绝不挂死 turn。
