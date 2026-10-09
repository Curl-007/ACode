# Harness SDK module boundary

## Scope

`packages/harness-sdk` 是 Harness API v1 的 TypeScript SDK（connect/launch 双模式）。
本 spec 登记其纳管为架构模块（managed，ARCH-04）：公开契约、状态所有权、依赖方向与
验收场景。纳管批次不改变任何运行时行为与包根公开 API。

## Ownership and invariants

- owner：`harness-sdk-client`。
- 连接层状态（pending request map、seq 单调性、事件监听器集合、行缓冲/StringDecoder）
  唯一所有者是 `HarnessConnection` 实例；握手阶段（`handshake.ts`）成功后把 decoder 与
  残留缓冲整体移交给连接实例，移交窗口用 pause/attach/resume 保证零丢帧零双发。
- 会话状态（订阅、events() 队列、权限 fail-closed 计时器）唯一所有者是 `HarnessSession`
  实例；`AcodeHarnessClient` 只登记活跃 session 并在 close 时统一回收，不另存第二份状态。
- 权限红线（spec R5）：`PermissionRequested` 必须由消费方应答，或在
  `SDK_PERMISSION_TIMEOUT_MS` 内无应答时自动回执拒绝（超时=拒绝，fail-closed）；
  SDK 不提供绕过权限管线的执行捷径。
- launch 凭据继承只做 ACode 自有加密库的成对字节拷贝（零解密零明文）；主密钥在 OS
  钥匙串且无随行材料时如实 fail（`HarnessLaunchError`），不降级明文。

## Public boundary

- 公开契约是 `src/contract.ts`；`src/index.ts`（包根 `@acode/harness-sdk`）整体转发契约，
  两者都登记为 publicEntrypoints。其余源文件是内部实现，跨模块 deep import 会被
  architecture checker 以 `deep-import` 拒绝。
- 有意不入契约的深导出面（K7 提交面，仅诊断/测试回归）：`resolveHarnessCommand`
  （client.ts）、`pickDenyOption`、`describeZodSchema`（session.ts 转发 structured-output.ts）。
- 内部依赖方向：client → {session, connection, launch, errors}；session/connection 各自
  依赖中立类型文件（session-types/connection-types）与内聚实现（structured-output/
  handshake）；session 对 client 的依赖经 `SessionClientPort` 倒置——client ↔ session
  无循环（forbidCycles）。

## Dependency direction

- 允许：`@acode/shared/harness-api`（协议投影，requires: [shared]）、node 内置模块
  （child_process/string_decoder/crypto/fs/os/path/url）、zod。
- 禁止：harness-sdk 依赖 shared 之外的 workspace 模块；任何模块反向依赖 harness-sdk
  内部文件。
- 层：单层 `app`（`layers: { app: "." }`，workflow-run-command 同款形态）——SDK 直接
  持有子进程与文件 IO，声明 domain 层会触发 domain-io。

## Acceptance scenarios

1. `node scripts/architecture/architecture-check.mjs check`：harness-sdk 在 managed 语义下
   零违规（max-file-lines 严格、forbidCycles、max-contract-lines、max-public-methods、
   deep-import）；纳管前 connection.ts 417 行、session.ts 461 行的 2 条新违规消除，
   且不靠基线掩盖（`.architecture-baseline.json` 不动）。
2. `node scripts/architecture/architecture-check.mjs context harness-sdk` 展示本模块的
   owner 与 contract。
3. `pnpm --filter @acode/harness-sdk test`（parity 测试）全绿；包根导出面
   （index.ts）与纳管前逐名一致。
4. `tsc -b packages/harness-sdk`（根 `pnpm typecheck` 名单内）通过。
