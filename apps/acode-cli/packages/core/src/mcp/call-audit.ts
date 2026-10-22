// 第一方 MCP server 的工具调用写审计（specs/mcp-lifecycle-ttl-approval.md R3）。
//
// 机制形态参照外部第一方 MCP 宿主的公开行为（annotations.readOnlyHint → is_write
// 推导 + 每次调用审计事件 + 未覆盖写工具告警），实现自撰。
//
// 接线形态对齐 bash-confirm-reflex-gate.ts 的审计 sink：进程级缺省 stderr 兜底
// （stdio 协议走 stdout，stderr 是安全通道）+ 按 sessionId 注册表路由。装配期
// （bootstrap/create-app.ts）用 registerMcpCallAuditSink(sessionId, sink) 换成
// createServiceLogger 的 info 级落盘日志——与 registerBashReflexAuditSink 同一接线位
// （spec「范围外接线」）。
//
// 审计是旁路：sink 故障不得影响工具调用与注册（try/catch 吞掉）。

export type McpToolCallAuditStatus = "completed" | "tool-error" | "failed";

/** 第一方判定依据（进审计条目，便于事后核对口径）。 */
export type McpFirstPartyBasis = "official-http" | "builtin-node-repl" | "official-cua";

/** 一次第一方 MCP 工具调用的审计条目（info 级）。 */
export interface McpToolCallAuditEntry {
  kind: "tool-call";
  serverName: string;
  toolName: string;
  /** 模型可见的注册名（mcp__server__tool 形态）。 */
  registeredName: string;
  /** readOnlyHint 推导（deriveMcpToolIsWrite）；缺省 fail-closed 为写。 */
  isWrite: boolean;
  durationMs: number;
  /** completed=正常返回；tool-error=in-band isError；failed=传输级异常。 */
  status: McpToolCallAuditStatus;
  firstPartyBasis: McpFirstPartyBasis;
  sessionId?: string;
}

/**
 * 注册期告警：第一方 server 暴露的写工具被 allowedTools 显式放行——默认审批门
 * （MCP 工具 needsApproval 恒真）被持久 allow 规则关掉（spec R3「未覆盖写工具」
 * 的 ACode 化语义）。按 server 聚合，每次注册派发一次。
 *
 * sessionId 由 registerMcpTools 从注册上下文透传（this.sessionId），使告警也能按
 * sessionId 路由到对应 App 的落盘 sink——否则改造后它会回落进程级缺省 stderr，
 * 相比原进程级 set 是行为回归（原装配把它接到 info/warn Logger）。
 */
export interface McpUncoveredWriteToolsEntry {
  kind: "uncovered-write-tools";
  serverName: string;
  toolNames: string[];
  sessionId?: string;
}

export type McpCallAuditEvent = McpToolCallAuditEntry | McpUncoveredWriteToolsEntry;

export type McpCallAuditSink = (event: McpCallAuditEvent) => void;

// 缺省写 stderr 兜底（与 bash 反射门审计同一先例）：未接线的独立调用与单测不至于
// 完全丢掉审计；生产装配必须换成 info 级服务日志。
const defaultAuditSink: McpCallAuditSink = (event) => {
  console.warn(`[mcp-call-audit] ${JSON.stringify(event)}`);
};

let auditSink: McpCallAuditSink = defaultAuditSink;
// 根因（2026-10-22 review CLI-04 同类残余）：MCP 写审计 sink 曾是进程级 set，
// 无 sessionId 注册表——同进程多 App（桌面 app-server）下后装配者覆盖、任一 App
// close 复位缺省 stderr，把在跑 App 的落盘审计打回易失的 stderr。改为按 sessionId
// 注册表路由（照 bash-confirm-reflex-gate.ts 的 sessionAuditSinks + 幂等释放范式）：
// entry.sessionId 命中则落各自 App 的 sink，未命中回落进程级缺省兜底，一个 App
// 的 close 只删自己的注册项，不影响其它 App。
const sessionAuditSinks = new Map<string, McpCallAuditSink>();

/**
 * 替换进程级缺省审计 sink（与 setBashReflexAuditSink 同一接线形态）。
 * 传 undefined 复位为缺省 stderr sink（测试隔离用）。
 */
export function setMcpCallAuditSink(sink: McpCallAuditSink | undefined): void {
  auditSink = sink ?? defaultAuditSink;
}

/**
 * 注册一个 app/session 的 MCP 审计 sink，返回幂等释放函数（照
 * registerBashReflexAuditSink）。释放只删自己登记的 sink，后来者覆盖后旧释放不误删。
 */
export function registerMcpCallAuditSink(sessionId: string, sink: McpCallAuditSink): () => void {
  sessionAuditSinks.set(sessionId, sink);
  return () => {
    if (sessionAuditSinks.get(sessionId) === sink) sessionAuditSinks.delete(sessionId);
  };
}

function emitAudit(event: McpCallAuditEvent): void {
  try {
    // 按 entry.sessionId 路由：命中该会话的注册 sink，未命中回落进程级缺省。
    // 两类 entry 都带可选 sessionId（tool-call 从调用上下文、uncovered-write-tools 从注册上下文）。
    (event.sessionId === undefined
      ? auditSink
      : (sessionAuditSinks.get(event.sessionId) ?? auditSink))(event);
  } catch {
    // 审计 sink 故障不得反向影响工具调用：失败静默（spec R3）。
  }
}

/**
 * readOnlyHint → is_write 推导（spec R3）。fail-closed 方向：hint 缺席按写对待，
 * destructiveHint=true 时即便 readOnlyHint=true（服务端自相矛盾）也按写对待——
 * 审计口径宁可把读记成写，不可把写记成读。
 */
export function deriveMcpToolIsWrite(annotations: {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
} | undefined): boolean {
  if (annotations?.destructiveHint === true) return true;
  return annotations?.readOnlyHint !== true;
}

/** 一次第一方工具调用的审计派发点（core/src/mcp/index.ts 的 handler 包装）。 */
export function auditMcpToolCall(entry: McpToolCallAuditEntry): void {
  emitAudit(entry);
}

/** 注册期的未覆盖写工具告警派发点。 */
export function warnUncoveredMcpWriteTools(entry: McpUncoveredWriteToolsEntry): void {
  emitAudit(entry);
}
