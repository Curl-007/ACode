// ============================================================
// jcode 外部 agent 桥接：常量单一事实源
// spec: apps/acode-cli/specs/jcode-agent-bridge.md（R1-R7 常量表）
//
// 所有 jcode 相关的魔法值集中在此，不散落到业务逻辑（根 AGENTS.md「常量提取」）。
// 值来源标注见 spec 常量表；jcode 侧事实来自 docs/jcode-adapter-spike-2026-10-23.md
// 的 Windows 真机实测（下称 spike）。
// ============================================================

/**
 * jcode 强制 pin 的 ACP 协议大版本。
 * spike §2 实测：jcode initialize 响应恒返回 protocolVersion:1，忽略客户端请求值
 * （jcode src/cli/acp.rs:1614-1618）。
 */
export const JCODE_ACP_PROTOCOL_VERSION = 1 as const;

/** 普通 ACP 请求（initialize/session.new/load 等）的默认超时。对齐 jcode SDK client.ts:323。 */
export const JCODE_ACP_REQUEST_TIMEOUT_MS = 30_000 as const;

/**
 * session/prompt 的超时——一轮 agent 执行可能很长，镜像 K8 ACP_PROMPT_TIMEOUT_MS 量级
 * （acp/protocol.ts 同源）。spec 常量表 R5。
 */
export const JCODE_PROMPT_TIMEOUT_MS = 600_000 as const;

/**
 * spawn jcode 的 argv（spec R4-2 硬要求 + R4-3 双保险）。
 * - `acp` = ACP agent 模式（stdio JSON-RPC）。
 * - `--no-update` = 关自动更新（jcode 自动更新默认开、SHA256 校验 fail-open，会绕过
 *   ACode 版本锁定，见评估 §7）。
 * - `--no-selfdev` = 关 jcode 的源码检出自动检测（jcode src/cli/args.rs:86-88 是
 *   global flag，可与 acp 同用）。这是 selfdev-guard 之外的第二道保险：即使静态
 *   cwd 判定漏判，jcode 也不会自行进入 self-dev 模式。
 */
export const JCODE_SPAWN_ARGS = ["acp", "--no-update", "--no-selfdev"] as const;

/**
 * spawn jcode 时强制注入的环境变量（spec R4-2，不可选）。
 * jcode 遥测默认开、上报自有端点 telemetry.jcode.sh（含 provider OAuth 邮箱）；
 * ACode 的 no-telemetry 守护测试只扫仓库内 JS/TS，对原生子进程运行时行为失明，
 * 故注入是硬要求而非依赖守护兜底。两个 env 名都是 jcode 自己认的 kill-switch
 * （jcode crates/jcode-telemetry-core/src/lib.rs:526，尊重业界 DO_NOT_TRACK）。
 */
export const JCODE_TELEMETRY_OFF_ENV = {
  JCODE_NO_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
} as const;

/** jcode 子进程就绪探测/健康检查的轮询间隔。 */
export const JCODE_READY_POLL_INTERVAL_MS = 50 as const;

/** jcode 子进程 spawn 后就绪（initialize 可发）的最大等待。 */
export const JCODE_SPAWN_READY_TIMEOUT_MS = 30_000 as const;

/**
 * ACP JSON-RPC 未知/内部错误码（spec R5，JSON-RPC internal 保留段）。
 * jcode 侧错误无法归类时统一归此，不透内部栈。
 */
export const JCODE_UNKNOWN_ERROR_CODE = -32603 as const;

/**
 * 能力不支持的稳定 reasonCode（spec R5）。
 * jcode 无对应 v4 命令（fork/rewind/editUserQuery/workflow/swarm/goal/hook/artifact）
 * 时，ACK 回 rejected + 此码，不静默 noop 让客户端误以为成功。
 * 命名沿用 v4 fault 语义前缀（对齐 command-inbox 的 reasonCode 习惯）。
 */
export const JCODE_CAPABILITY_UNSUPPORTED_REASON = "fault.capability.unsupportedByExternalAgent" as const;

/**
 * self-dev 防护拒绝启动时的 reasonCode（spec R4-3）。
 * cwd 指向 jcode 源码检出会让普通 session 自动进 self-dev（agent 可改写自己被分发的
 * 二进制、绕过全部签名校验），必须拒绝 spawn。
 */
export const JCODE_SELFDEV_CWD_REJECTED_REASON = "fault.jcode.selfdevCwdRejected" as const;

/**
 * jcode session/load 对不存在会话 fail-open（返回 {} 而非 error，spike §4.3 实测）。
 * shim 自校验失败时的 reasonCode（spec R4-4）。
 */
export const JCODE_SESSION_LOAD_UNVERIFIED_REASON = "fault.jcode.sessionLoadUnverified" as const;

/** ACP session/update 通知里 shim 关心的 sessionUpdate 判别值（spike §3 实测枚举）。 */
export const ACP_SESSION_UPDATE_KIND = {
  agentMessageChunk: "agent_message_chunk",
  toolCall: "tool_call",
  toolCallUpdate: "tool_call_update",
  usageUpdate: "usage_update",
  availableCommandsUpdate: "available_commands_update",
  sessionInfoUpdate: "session_info_update",
} as const;

/** ACP tool_call 的 status 判别值（spike §3 实测：pending→in_progress→completed/failed）。 */
export const ACP_TOOL_STATUS = {
  pending: "pending",
  inProgress: "in_progress",
  completed: "completed",
  failed: "failed",
} as const;

/** ACP prompt 返回的 stopReason 判别值（spike §2/§3 实测 end_turn；其余按 jcode acp.rs）。 */
export const ACP_STOP_REASON = {
  endTurn: "end_turn",
  cancelled: "cancelled",
  maxTokens: "max_tokens",
  refusal: "refusal",
} as const;
