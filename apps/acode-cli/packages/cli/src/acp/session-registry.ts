/* eslint-disable max-lines -- ACP 会话状态机集中维护（帧循环/方法面/事件泵/权限桥与 spec R2-R4 逐条对应），拆散会让「一条 ACP 消息的生命周期」失去单一审计出处；方法面映射纯函数已在 mapping.ts。 */
// ============================================================
// 会话注册表与适配器状态机：Map<acpSessionId, 会话记录> 是唯一会话关联
// 事实源（spec R4）；ACP 会话上限 ACP_MAX_CONCURRENT_SESSIONS=8。
// 每 turn 的流 reset（turnCounter）、权限 fail-closed 计时、prompt 终态
// 关联都挂在会话记录上——适配层无持久状态，重启即新映射。
//
// 参照 jcode (MIT) acp.rs 的 per-session 状态机组织法，自撰实现。
// ============================================================

import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { SDK_PERMISSION_TIMEOUT_MS } from "@acode/harness-sdk";
import type { HarnessEvent, PermissionRequestedEvent } from "@acode/shared/harness-api";
import {
  ACP_MAX_CONCURRENT_SESSIONS,
  ACP_MODEL_CONFIG_ID,
  ACP_PROTOCOL_VERSION,
  ACP_RESOURCE_NOT_FOUND,
  ACP_SESSION_BUSY,
  ACP_UNKNOWN_ERROR_CODE,
  AcpProtocolError,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  type AcpIo,
} from "./protocol.js";
import type { InProcessHarnessLink } from "./in-process-harness.js";
import {
  harnessErrorToRpcBody,
  mapPermissionOptions,
  permissionRequestParams,
  permissionToolCallToUpdate,
  pickEngineDenyOption,
  promptBlocksToEngineText,
  resultTypeToStopReason,
  textDeltaToUpdate,
  toolCallFinishedToUpdate,
  toolCallStartedToUpdate,
} from "./mapping.js";

/** ACP 会话默认禁用的 UI 交互工具（spec R3 + 附录 A.3 替代路径：
 * K7 configure_tools 为 not_supported，用 create_session.toolDenylist 落地；
 * 两工具均为 sideEffectScope="userInteraction" 的 UI 面承载工具）。 */
export const ACP_TOOL_DENYLIST: readonly string[] = ["AskUserQuestion", "Open"];

/**
 * F3（K8 对抗复核）：session/prompt 等待 turn 终态的超时——量级对齐 K7
 * `run` 的默认超时（packages/server/src/harness/translate.ts 的
 * RUN_DEFAULT_TIMEOUT_MS = 10min；该常量未公开导出，此处镜像并注释来源，
 * 上游若公开导出后改为 import 单一出处）。超时回 -32603 错误并释放 busy 锁，
 * 迟到终态按 F2 归属过滤自然丢弃。
 */
export const ACP_PROMPT_TIMEOUT_MS = 600_000 as const;

interface PendingPermission {
  engineEvent: PermissionRequestedEvent;
  engineOptionIdByAcpId: Map<string, string>;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface PendingPrompt {
  /** F2：prompt 预分配并随 send_message 下发的 inputId（`acp-prompt-<uuid>`）。 */
  inputId: string;
  /** F2：TurnStarted 回显本 inputId 的 turnId 集合（主路径归属）。 */
  ownedTurnIds: Set<string>;
  /** F2：prompt 之后观察到的 TurnStarted turnId（退化路径归属窗口）。 */
  liveTurnIds: Set<string>;
  /** F2：已捕获本 prompt 归属信号（关闭退化窗口，K7 H1 同款）。 */
  sawOwnershipSignal: boolean;
  /** F3：无终态超时计时器。 */
  timer: ReturnType<typeof setTimeout>;
  resolve: (stopReason: "end_turn" | "cancelled") => void;
  reject: (body: { code: number; message: string; data?: unknown }) => void;
}

interface AcpSessionRecord {
  acpSessionId: string;
  harnessSessionId: string;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  subscriptionId: string | undefined;
  /** 每 turn 单调递增——流 reset 标记的载体（spec R2 流形态）。 */
  turnCounter: number;
  /** F11：已计入 turnCounter 的 turnId（重复 turn_started 幂等防御）。 */
  countedTurnIds: Set<string>;
  pendingPrompt: PendingPrompt | undefined;
  /** 本 prompt 请求的 JSON-RPC id（$/cancel_request 反查用）。 */
  promptRequestId: number | string | undefined;
  pendingPermissions: Map<string, PendingPermission>;
  /** 已播报 tool_call 的 toolCallId 集合（权限前置播报去重）。 */
  announcedToolCallIds: Set<string>;
}

export interface AcpAdapterOptions {
  io: AcpIo;
  link: InProcessHarnessLink;
  /** workspace 边界根（session/new 的 cwd 必须等于或位于其内）。 */
  allowedRoot: string;
  agentVersion: string;
  /** 权限 fail-closed 超时（测试注入；缺省 SDK_PERMISSION_TIMEOUT_MS）。 */
  permissionTimeoutMs?: number;
  /** F3：prompt 终态等待超时（测试注入；缺省 ACP_PROMPT_TIMEOUT_MS）。 */
  promptTimeoutMs?: number;
  log?: (message: string) => void;
  stderr?: (message: string) => void;
}

/** 从原始行解析出 client 应答帧（无 method；id + result/error），否则 undefined。 */
function parseClientResponse(line: string): Record<string, unknown> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.jsonrpc !== "2.0") return undefined;
  if (!("id" in record) || "method" in record) return undefined;
  if (!("result" in record) && !("error" in record)) return undefined;
  return record;
}

/** 解析 client→agent 的请求/通知；非法形态返回 undefined（调用方回协议错误）。 */
function parseClientCall(
  line: string,
): { id?: number | string; method: string; params?: unknown } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || typeof record.method !== "string" || record.method === "") {
    return undefined;
  }
  if ("id" in record) {
    const id = record.id;
    if (typeof id !== "number" && typeof id !== "string") return undefined;
    return {
      id,
      method: record.method,
      ...(record.params !== undefined ? { params: record.params } : {}),
    };
  }
  return {
    method: record.method,
    ...(record.params !== undefined ? { params: record.params } : {}),
  };
}

/**
 * ACP 宿主适配器：stdin NDJSON 帧循环 + 事件泵。
 * 生命周期：run() 起（initialize 前不发任何引擎调用），stdin 结束或 shutdown 止。
 */
export class AcpHostAdapter {
  readonly #options: AcpAdapterOptions;
  readonly #sessions = new Map<string, AcpSessionRecord>();
  readonly #removeLinkListener: () => void;
  readonly #removeLinkCloseListener: () => void;
  #nextServerRequestId = 0;
  readonly #serverRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #initialized = false;
  #stopped = false;

  constructor(options: AcpAdapterOptions) {
    this.#options = options;
    this.#removeLinkListener = options.link.addEventListener((frame) => {
      this.#onHarnessEventFrame(frame.sessionId, frame.event);
    });
    // F7（K8 对抗复核）：harness 链路单侧死亡（server stop / transport dispose）
    // 传播到适配层——在途 prompt 立即失败回执，不等 F3 超时。
    this.#removeLinkCloseListener = options.link.onClose(() => {
      this.#failPendingPrompts("harness link closed unexpectedly");
    });
  }

  #stderr(message: string): void {
    this.#options.stderr?.(message);
  }

  // ── 出帧 ──

  #writeMessage(message: unknown): void {
    this.#options.io.output.writeLine(JSON.stringify(message));
  }

  #notify(sessionId: string, update: unknown): void {
    this.#writeMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  #respond(id: number | string, result: unknown): void {
    this.#writeMessage({ jsonrpc: "2.0", id, result });
  }

  #respondError(
    id: number | string | null,
    body: { code: number; message: string; data?: unknown },
  ): void {
    this.#writeMessage({
      jsonrpc: "2.0",
      id,
      error: {
        code: body.code,
        message: body.message,
        ...(body.data !== undefined ? { data: body.data } : {}),
      },
    });
  }

  // ── agent→client 请求（session/request_permission）──

  #sendServerRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.#nextServerRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#serverRequests.delete(id);
        reject(new Error(`agent->client request '${method}' timed out`));
      }, timeoutMs);
      this.#serverRequests.set(id, { resolve, reject, timer });
      this.#writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  #settleServerRequest(id: number, result: unknown): void {
    const entry = this.#serverRequests.get(id);
    if (!entry) return;
    this.#serverRequests.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }

  #failServerRequest(id: number, message: string): void {
    const entry = this.#serverRequests.get(id);
    if (!entry) return;
    this.#serverRequests.delete(id);
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }

  // ── 事件泵（harness → ACP）──

  #onHarnessEventFrame(harnessSessionId: string, event: HarnessEvent): void {
    const record = this.#findByHarnessSessionId(harnessSessionId);
    if (!record) return;
    switch (event.kind) {
      case "turn_started": {
        // 流 reset 标记：每 turn 递增计数器，本 turn 的 delta 落入新 ACP
        // messageId 命名空间（吸收引擎重发/替换语义，不反向要求 K7 加事件）。
        // F11（K8 对抗复核）：prompt 预递增与 turn_started 递增并存的现状下，
        // 同一 turn 重复到达的 turn_started 会把命名空间多推一格——同 turnId
        // 已计数则跳过（turnId 缺席时无法去重，保守沿用递增，与原行为一致）。
        if (event.turnId !== undefined) {
          if (record.countedTurnIds.has(event.turnId)) return;
          // 防无限增长（与 server 侧 seenPermissionRequestIds 同款纪律）：
          // 超界清空的 worst case 是极迟到重复帧双计数——回到修复前行为。
          if (record.countedTurnIds.size > 512) record.countedTurnIds.clear();
          record.countedTurnIds.add(event.turnId);
        }
        record.turnCounter += 1;
        // F2（K8 对抗复核，对齐 K7 H1 纪律）：归属捕获——TurnStarted 回显本
        // prompt 的 inputId（主路径，捕获后关闭退化窗口）或记入 prompt 后的
        // live 窗口（退化路径：无 inputId 回显时只认「prompt 后完整对」）。
        const pending = record.pendingPrompt;
        if (pending) {
          if (event.turnId !== undefined) pending.liveTurnIds.add(event.turnId);
          if (event.inputId !== undefined && event.inputId === pending.inputId) {
            pending.sawOwnershipSignal = true;
            if (event.turnId !== undefined) pending.ownedTurnIds.add(event.turnId);
          }
        }
        return;
      }
      case "text_delta":
        this.#notify(record.acpSessionId, textDeltaToUpdate(record.turnCounter, event));
        return;
      case "tool_call_started":
        record.announcedToolCallIds.add(event.toolCallId);
        this.#notify(record.acpSessionId, toolCallStartedToUpdate(event));
        return;
      case "tool_call_finished":
        this.#notify(record.acpSessionId, toolCallFinishedToUpdate(event));
        return;
      case "permission_requested":
        void this.#onPermissionRequested(record, event);
        return;
      case "turn_done":
        this.#settlePrompt(record, event);
        return;
      default:
        // token_usage（usage_update 需要上下文窗口 size，引擎 v1 未提供）与
        // 独立 error 事件（终态语义由 turn_done 承载）不播报，仅观测。
        this.#stderr(`harness ${event.kind} event on session ${record.acpSessionId}`);
        return;
    }
  }

  #settlePrompt(
    record: AcpSessionRecord,
    event: Extract<HarnessEvent, { kind: "turn_done" }>,
  ): void {
    const pending = record.pendingPrompt;
    if (!pending) return;
    // F2（K8 对抗复核，对齐 K7 H1 纪律）：终态归属过滤——只接受
    // 1) payload.inputId 匹配本 prompt 预分配的 inputId（主路径）；
    // 2) turnId ∈ ownedTurnIds（TurnStarted 回显本 inputId 捕获）；
    // 3) 退化路径（引擎不回显 inputId）：prompt 之后观察到 TurnStarted 的
    //    turnId（liveTurnIds），且尚未捕获任何归属信号——迟到重复终态/
    //    prompt 之前已在途的旧 turn 终态一律丢弃，不误释放 busy 锁。
    const byInputId = event.inputId !== undefined && event.inputId === pending.inputId;
    const byOwnedTurnId = event.turnId !== undefined && pending.ownedTurnIds.has(event.turnId);
    const byLiveTurnId =
      !pending.sawOwnershipSignal &&
      event.turnId !== undefined &&
      pending.liveTurnIds.has(event.turnId);
    if (!byInputId && !byOwnedTurnId && !byLiveTurnId) {
      this.#stderr(
        `turn_done for unowned turn dropped (session ${record.acpSessionId}` +
          `${event.turnId !== undefined ? `, turnId ${event.turnId}` : ""})`,
      );
      return;
    }
    record.pendingPrompt = undefined;
    record.promptRequestId = undefined;
    clearTimeout(pending.timer); // F3：结算即清超时计时器。
    // 权限请求随 turn 终态一并收口（引擎侧已不可再应答；迟到应答按无记录忽略）。
    for (const [, permission] of record.pendingPermissions) {
      clearTimeout(permission.timer);
    }
    record.pendingPermissions.clear();
    if (event.resultType === "error") {
      // 附录 A.3：turn 错误 → prompt 请求回 JSON-RPC internal + 人话 data（无栈）。
      const data =
        event.error?.message !== undefined ? { engineMessage: event.error.message } : undefined;
      pending.reject(new AcpProtocolError(ACP_UNKNOWN_ERROR_CODE, "agent turn failed", data));
      return;
    }
    const stopReason = resultTypeToStopReason(event.resultType);
    if (!stopReason) {
      pending.reject(
        new AcpProtocolError(ACP_UNKNOWN_ERROR_CODE, "agent turn ended in an unknown state"),
      );
      return;
    }
    pending.resolve(stopReason);
  }

  // ── 权限桥（R3：永不自动 allow；无应答超时按拒绝）──

  async #onPermissionRequested(
    record: AcpSessionRecord,
    event: PermissionRequestedEvent,
  ): Promise<void> {
    if (record.pendingPermissions.has(event.requestId)) return;
    const { acpOptions, engineOptionIdByAcpId } = mapPermissionOptions(event);
    if (acpOptions.length === 0) {
      // 引擎没给可选档位：无法形成 ACP 请求，按 fail-closed 直接拒绝回执。
      await this.#respondEngineDeny(record, event);
      return;
    }
    // 未播报过的 toolCall 先补一条 pending 播报（client 需要工具卡片承载权限弹层）。
    const toolCallId = event.toolCallId ?? event.requestId;
    if (!record.announcedToolCallIds.has(toolCallId)) {
      record.announcedToolCallIds.add(toolCallId);
      this.#notify(record.acpSessionId, permissionToolCallToUpdate(event));
    }
    const pending: PendingPermission = {
      engineEvent: event,
      engineOptionIdByAcpId,
      timer: setTimeout(() => {
        // fail-closed：client 无应答（无人值守 IDE 脚本）→ 超时按拒绝回执引擎。
        void this.#settlePermission(record, event.requestId, undefined);
      }, this.#options.permissionTimeoutMs ?? SDK_PERMISSION_TIMEOUT_MS),
      settled: false,
    };
    record.pendingPermissions.set(event.requestId, pending);
    try {
      const outcome = (await this.#sendServerRequest(
        "session/request_permission",
        permissionRequestParams(record.acpSessionId, event, acpOptions),
        // agent→client 请求自身的应答超时与 fail-closed 计时同源（一次注入）。
        this.#options.permissionTimeoutMs ?? SDK_PERMISSION_TIMEOUT_MS,
      )) as { outcome?: { outcome?: string; optionId?: string } } | undefined;
      // ACP 应答形态（附录 A.2 §6）：result = { outcome: { outcome: "selected",
      // optionId } | { outcome: "cancelled" } }——取 selected 的 optionId 回译。
      const selected = outcome?.outcome;
      const optionId =
        selected?.outcome === "selected" && typeof selected.optionId === "string"
          ? selected.optionId
          : undefined;
      await this.#settlePermission(record, event.requestId, optionId);
    } catch {
      // client 未应答（超时/拒绝/断链）——按拒绝收口。
      await this.#settlePermission(record, event.requestId, undefined);
    }
  }

  /** 结算一次权限请求：optionId 缺失/无法还原 → deny（更严侧）。 */
  async #settlePermission(
    record: AcpSessionRecord,
    requestId: string,
    acpOptionId: string | undefined,
  ): Promise<void> {
    const pending = record.pendingPermissions.get(requestId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    record.pendingPermissions.delete(requestId);
    let engineOptionId = acpOptionId ? pending.engineOptionIdByAcpId.get(acpOptionId) : undefined;
    if (!engineOptionId) {
      // 还原失败（未知 optionId / cancelled outcome / 超时）→ 拒绝档。
      engineOptionId = pickEngineDenyOption(pending.engineEvent)?.optionId;
    }
    if (!engineOptionId) return; // 连可回执选项都没有：只能放行给引擎侧自身超时。
    await this.#sendPermissionRespond(record, requestId, engineOptionId);
  }

  async #respondEngineDeny(
    record: AcpSessionRecord,
    event: PermissionRequestedEvent,
  ): Promise<void> {
    const deny = pickEngineDenyOption(event);
    if (deny) await this.#sendPermissionRespond(record, event.requestId, deny.optionId);
  }

  async #sendPermissionRespond(
    record: AcpSessionRecord,
    requestId: string,
    optionId: string,
  ): Promise<void> {
    try {
      await this.#options.link.request("permission_respond", {
        workspacePath: record.workspacePath,
        ...(record.workspaceIdentity ? { workspaceIdentity: record.workspaceIdentity } : {}),
        sessionId: record.harnessSessionId,
        requestId,
        optionId,
      });
    } catch (error) {
      this.#stderr(
        `permission_respond failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ── 会话登记 ──

  #findByHarnessSessionId(harnessSessionId: string): AcpSessionRecord | undefined {
    for (const record of this.#sessions.values()) {
      if (record.harnessSessionId === harnessSessionId) return record;
    }
    return undefined;
  }

  #requireSession(sessionId: unknown): AcpSessionRecord {
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new AcpProtocolError(JSONRPC_INVALID_PARAMS, "sessionId must be a non-empty string");
    }
    const record = this.#sessions.get(sessionId);
    if (!record) {
      throw new AcpProtocolError(ACP_RESOURCE_NOT_FOUND, `unknown session '${sessionId}'`);
    }
    return record;
  }

  /**
   * cwd 边界（R3）：绝对路径、已存在目录，且 realpath 后在启动根内（含根自身）。
   *
   * 这里必须先 realpath 再做边界比较：仅比较词法路径会放过指向 workspace
   * 外部的 symlink/junction；同时 relative() 的完整路径段判断避免把合法的
   * `..cache` 误当作父目录 `..`。
   */
  async #validateCwd(cwd: unknown): Promise<string> {
    if (typeof cwd !== "string" || cwd === "") {
      throw new AcpProtocolError(JSONRPC_INVALID_PARAMS, "session/new requires a non-empty cwd", {
        reason: "invalid_cwd",
      });
    }
    if (!isAbsolute(cwd)) {
      throw new AcpProtocolError(
        JSONRPC_INVALID_PARAMS,
        `session/new cwd must be an absolute path (received '${cwd}')`,
        { reason: "invalid_cwd" },
      );
    }
    const resolved = resolve(cwd);
    let rootRealpath: string;
    let cwdRealpath: string;
    try {
      rootRealpath = await realpath(this.#options.allowedRoot);
      cwdRealpath = await realpath(resolved);
      const cwdStat = await stat(cwdRealpath);
      if (!cwdStat.isDirectory()) throw new Error("cwd is not a directory");
    } catch {
      // 把 ENOENT、非目录和 realpath 失败收敛为稳定的参数错误，不能把 fs 内部
      // 异常（含平台路径细节）透传成 ACP internal error。
      throw new AcpProtocolError(
        JSONRPC_INVALID_PARAMS,
        `session/new cwd '${cwd}' must be an existing directory`,
        { reason: "invalid_cwd" },
      );
    }
    const rel = relative(rootRealpath, cwdRealpath);
    // 仅拒绝完整的 `..` 路径段；startsWith("..") 会错误拒绝合法的 `..cache`。
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new AcpProtocolError(
        JSONRPC_INVALID_PARAMS,
        `session/new cwd '${cwd}' is outside the agent workspace '${this.#options.allowedRoot}'`,
        { reason: "invalid_cwd" },
      );
    }
    return cwdRealpath;
  }

  // ── client→agent 方法面 ──

  #handleInitialize(id: number | string, params: unknown): void {
    this.#initialized = true;
    const requested =
      typeof params === "object" &&
      params !== null &&
      typeof (params as Record<string, unknown>).protocolVersion === "number"
        ? (params as Record<string, unknown>).protocolVersion
        : undefined;
    // 版本协商（附录 A.2）：支持即回显，否则回自己最新（=1）。
    const negotiated = requested === ACP_PROTOCOL_VERSION ? requested : ACP_PROTOCOL_VERSION;
    this.#respond(id, {
      protocolVersion: negotiated,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
        // fs 不开：适配层不发 fs/read_text_file 等 agent→client 请求（R2 表末行）。
        sessionCapabilities: {},
      },
      authMethods: [],
      agentInfo: { name: "acode", version: this.#options.agentVersion },
    });
  }

  async #handleNewSession(id: number | string, params: unknown): Promise<void> {
    const request = (params ?? {}) as Record<string, unknown>;
    const workspacePath = await this.#validateCwd(request.cwd);
    // F6：软预检保留（已满时快速拒绝，不白打引擎调用）；硬检查移到
    // create_session 响应成功后的原子登记（并发窗口内两个 create 都成功时
    // 恰好一个登记，另一个回收引擎侧会话后拒绝）。
    if (this.#sessions.size >= ACP_MAX_CONCURRENT_SESSIONS) {
      throw new AcpProtocolError(ACP_SESSION_BUSY, this.#sessionLimitMessage());
    }
    // mcpServers：harness v1 无 MCP 面——静默丢弃（附录 A.3），非空时 stderr 记录。
    if (Array.isArray(request.mcpServers) && request.mcpServers.length > 0) {
      this.#stderr(
        `session/new: dropping ${request.mcpServers.length} mcpServers (harness v1 has no MCP surface)`,
      );
    }
    const created = (await this.#options.link.request("create_session", {
      workspacePath,
      // R3 工具裁剪：创建时禁 UI 交互工具（configure_tools 为 not_supported，
      // 走 spec 附录 A 的 toolDenylist 替代路径）。
      toolDenylist: [...ACP_TOOL_DENYLIST],
    })) as { sessionId: string };
    // ACP sessionId 直接复用 harness sessionId（对 client opaque；映射表仍是
    // 唯一关联事实源——重启后可经 list_sessions/attach 重建，属 K7 面）。
    const acpSessionId = created.sessionId;
    // F6：原子登记——create 成功但注册表已满（并发竞态）时，回收刚建的会话
    // （detach best-effort，不留引擎侧孤儿）再拒绝。
    if (this.#sessions.size >= ACP_MAX_CONCURRENT_SESSIONS) {
      await this.#detachHarnessSession(workspacePath, undefined, acpSessionId);
      throw new AcpProtocolError(ACP_SESSION_BUSY, this.#sessionLimitMessage());
    }
    const record: AcpSessionRecord = {
      acpSessionId,
      harnessSessionId: acpSessionId,
      workspacePath,
      workspaceIdentity: undefined,
      subscriptionId: undefined,
      turnCounter: 0,
      countedTurnIds: new Set(),
      pendingPrompt: undefined,
      promptRequestId: undefined,
      pendingPermissions: new Map(),
      announcedToolCallIds: new Set(),
    };
    this.#sessions.set(acpSessionId, record);
    // F3（K8 对抗复核）：订阅事件流失败 → session/new 直接失败并回收会话——
    // 哑会话（无事件流）的 prompt 永远等不到终态，只能靠超时收口，不如拒绝。
    try {
      const subscription = (await this.#options.link.request("subscribe_events", {
        workspacePath,
        sessionId: record.harnessSessionId,
      })) as { subscriptionId: string };
      record.subscriptionId = subscription.subscriptionId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.closeSession(acpSessionId);
      throw new AcpProtocolError(
        ACP_UNKNOWN_ERROR_CODE,
        `session created but event subscription failed: ${message}; session discarded`,
      );
    }
    // 模型选择 config option（附录 A.3）：get_models best-effort。
    const result: Record<string, unknown> = { sessionId: acpSessionId };
    const configOptions = await this.#buildModelConfigOptions();
    if (configOptions) result.configOptions = [configOptions];
    this.#respond(id, result);
  }

  /**
   * F6（K8 对抗复核）：可行动的超限文案——ACP v1 没有 session destroy 方法
   * （上游缺口，spec 附录 A.4 登记），client 无法主动释放；只能复用既有会话
   * 或重启适配进程。将来上游落 destroy / 复用 $/cancel_request 语义时在此接入。
   */
  #sessionLimitMessage(): string {
    return (
      `concurrent session limit reached (${ACP_MAX_CONCURRENT_SESSIONS}); ` +
      "ACP v1 defines no session destroy method - reuse an existing session or restart the adapter process"
    );
  }

  /**
   * F6（K8 对抗复核）：回收一个会话登记——unsubscribe_events + harness 侧
   * detach_session（best-effort）+ 映射表删除。注册表是唯一关联事实源（R4），
   * 删除后名额即可复用；引擎侧会话本体不关闭（detach 语义是「放手」）。
   */
  async closeSession(acpSessionId: string): Promise<void> {
    const record = this.#sessions.get(acpSessionId);
    if (!record) return;
    this.#sessions.delete(acpSessionId);
    await this.#releaseSessionRecord(record);
  }

  async #releaseSessionRecord(record: AcpSessionRecord): Promise<void> {
    const pending = record.pendingPrompt;
    if (pending) {
      record.pendingPrompt = undefined;
      record.promptRequestId = undefined;
      clearTimeout(pending.timer);
      // 回收时在途 prompt 一并失败回执（会话已从事实源移除，终态无处投递）。
      pending.reject(
        new AcpProtocolError(ACP_UNKNOWN_ERROR_CODE, "session discarded by host adapter"),
      );
    }
    for (const permission of record.pendingPermissions.values()) {
      clearTimeout(permission.timer);
    }
    record.pendingPermissions.clear();
    if (record.subscriptionId !== undefined) {
      const subscriptionId = record.subscriptionId;
      record.subscriptionId = undefined;
      try {
        await this.#options.link.request("unsubscribe_events", { subscriptionId });
      } catch (error) {
        this.#stderr(
          `unsubscribe_events failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await this.#detachHarnessSession(
      record.workspacePath,
      record.workspaceIdentity,
      record.harnessSessionId,
    );
  }

  /** harness 侧 detach（best-effort：失败只记 stderr，不阻断回收路径）。 */
  async #detachHarnessSession(
    workspacePath: string,
    workspaceIdentity: string | undefined,
    harnessSessionId: string,
  ): Promise<void> {
    try {
      await this.#options.link.request("detach_session", {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        sessionId: harnessSessionId,
      });
    } catch (error) {
      this.#stderr(
        `detach_session failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #buildModelConfigOptions(): Promise<unknown | undefined> {
    try {
      const models = (await this.#options.link.request("get_models", {})) as {
        providers?: { providerId: string; providerName?: string; models: { modelId: string }[] }[];
        preferredSelection?: { providerId: string; modelId: string };
      };
      const options: { id: string; name: string }[] = [];
      for (const provider of models.providers ?? []) {
        for (const model of provider.models ?? []) {
          options.push({
            id: `${provider.providerId}/${model.modelId}`,
            name: `${provider.providerName ?? provider.providerId} · ${model.modelId}`,
          });
        }
      }
      if (options.length === 0) return undefined;
      const currentValue = models.preferredSelection
        ? `${models.preferredSelection.providerId}/${models.preferredSelection.modelId}`
        : (options[0] as { id: string }).id;
      return {
        id: ACP_MODEL_CONFIG_ID,
        name: "Model",
        type: "select",
        currentValue,
        options,
      };
    } catch {
      return undefined; // get_models 不可用（如未登录）：不暴露模型选择面。
    }
  }

  async #handleSetConfigOption(params: unknown): Promise<unknown> {
    const request = (params ?? {}) as Record<string, unknown>;
    if (request.configId !== ACP_MODEL_CONFIG_ID) {
      throw new AcpProtocolError(
        JSONRPC_INVALID_PARAMS,
        `unknown config option '${String(request.configId)}'`,
      );
    }
    const record = this.#requireSession(request.sessionId);
    const value = request.value;
    if (typeof value !== "string" || !value.includes("/")) {
      throw new AcpProtocolError(
        JSONRPC_INVALID_PARAMS,
        `config value must be 'providerId/modelId' (received '${String(value)}')`,
      );
    }
    const separatorIndex = value.indexOf("/");
    const providerId = value.slice(0, separatorIndex);
    const modelId = value.slice(separatorIndex + 1);
    if (providerId === "" || modelId === "") {
      throw new AcpProtocolError(
        JSONRPC_INVALID_PARAMS,
        `config value must be 'providerId/modelId' (received '${value}')`,
      );
    }
    await this.#options.link.request("set_model", {
      workspacePath: record.workspacePath,
      sessionId: record.harnessSessionId,
      model: { providerId, modelId },
    });
    return {};
  }

  async #handlePrompt(id: number | string, params: unknown): Promise<void> {
    const request = (params ?? {}) as Record<string, unknown>;
    const record = this.#requireSession(request.sessionId);
    if (record.pendingPrompt) {
      throw new AcpProtocolError(
        ACP_SESSION_BUSY,
        "a prompt turn is already in progress for this session; wait for its stopReason or send session/cancel",
      );
    }
    const content = promptBlocksToEngineText(request.prompt);
    // prompt 被接受的同一时刻起，本 turn 的 chunk 语义上属于该 prompt：
    // 预递增计数器（若引擎 turn_started 缺席也不至于把两个 turn 的消息串档）。
    record.turnCounter += 1;
    record.promptRequestId = id;
    // F2：预分配 inputId 随 send_message 下发（`acp-prompt-<uuid>`，K7 H1 同款）。
    // 注：当前 harness send_message wire 面尚无 inputId 字段（H2 兼容剥离未知
    // 字段），主路径待上游 additive 放开后自动生效（spec 附录 A.4 登记）；
    // 退化路径（prompt 后 TurnStarted→TurnDone 完整对）先行兜底。
    const inputId = `acp-prompt-${randomUUID()}`;
    const timeoutMs = this.#options.promptTimeoutMs ?? ACP_PROMPT_TIMEOUT_MS;
    // 先挂 pendingPrompt 再发 send_message：引擎事件（turn_started/done）可能
    // 先于 send 响应帧到达（桥按到达顺序写帧）——晚挂会把终态事件丢掉，
    // prompt 请求就永远等不到 stopReason。
    await new Promise<void>((resolve) => {
      const pending: PendingPrompt = {
        inputId,
        ownedTurnIds: new Set(),
        liveTurnIds: new Set(),
        sawOwnershipSignal: false,
        // F3：无终态超时——错误回执（-32603）+ 释放 busy 锁；引擎迟到的终态
        // 按 F2 归属过滤自然丢弃（pendingPrompt 已清，不归属任何后续 prompt）。
        timer: setTimeout(() => {
          if (record.pendingPrompt !== pending) return;
          record.pendingPrompt = undefined;
          record.promptRequestId = undefined;
          pending.reject(
            new AcpProtocolError(
              ACP_UNKNOWN_ERROR_CODE,
              `prompt turn timed out after ${timeoutMs}ms without a terminal turn event`,
            ),
          );
        }, timeoutMs),
        resolve: (stopReason) => {
          this.#respond(id, { stopReason });
          resolve();
        },
        reject: (body) => {
          this.#respondError(id, body);
          resolve();
        },
      };
      record.pendingPrompt = pending;
      void this.#options.link
        .request("send_message", {
          workspacePath: record.workspacePath,
          sessionId: record.harnessSessionId,
          content,
          inputId,
        })
        .catch((error: unknown) => {
          if (record.pendingPrompt !== pending) return; // 已被事件路径结算，不双发。
          record.pendingPrompt = undefined;
          record.promptRequestId = undefined;
          clearTimeout(pending.timer);
          pending.reject(harnessErrorToRpcBody(error));
        });
    });
  }

  async #handleCancel(params: unknown): Promise<void> {
    const request = (params ?? {}) as Record<string, unknown>;
    const record = this.#requireSession(request.sessionId);
    await this.#options.link.request("cancel_turn", {
      workspacePath: record.workspacePath,
      sessionId: record.harnessSessionId,
    });
    // F3：cancel 转发成功即收口在途 prompt（清计时器与 busy 锁）；引擎侧
    // 迟到的 cancelled 终态按 F2 归属过滤自然丢弃（pendingPrompt 已清）。
    this.#settlePromptCancelled(record);
  }

  async #handleJsonRpcCancel(params: unknown): Promise<void> {
    // $/cancel_request（附录 A.2 §7）：只对在途 session/prompt 有意义——转发
    // 引擎取消；prompt 最终以 cancelled stopReason 收口（合法应答）。
    const request = (params ?? {}) as { id?: number | string } | undefined;
    if (request?.id === undefined) return;
    const record = this.#findSessionByPromptId(request.id);
    if (!record) return;
    await this.#options.link.request("cancel_turn", {
      workspacePath: record.workspacePath,
      sessionId: record.harnessSessionId,
    });
    this.#settlePromptCancelled(record); // F3：同 session/cancel 的即时收口。
  }

  /** F3：cancel 成功后的即时收口——pending prompt 以 cancelled 应答并释放锁。 */
  #settlePromptCancelled(record: AcpSessionRecord): void {
    const pending = record.pendingPrompt;
    if (!pending) return;
    record.pendingPrompt = undefined;
    record.promptRequestId = undefined;
    clearTimeout(pending.timer);
    pending.resolve("cancelled");
  }

  /**
   * F7/F3：链路死亡或适配进程收口时，全部在途 prompt 立即失败回执
   * （-32603，不透内部栈）——ACP client 不挂等超时。
   */
  #failPendingPrompts(message: string): void {
    for (const record of this.#sessions.values()) {
      const pending = record.pendingPrompt;
      if (!pending) continue;
      record.pendingPrompt = undefined;
      record.promptRequestId = undefined;
      clearTimeout(pending.timer);
      pending.reject(new AcpProtocolError(ACP_UNKNOWN_ERROR_CODE, message));
    }
  }

  #findSessionByPromptId(id: number | string): AcpSessionRecord | undefined {
    for (const record of this.#sessions.values()) {
      if (record.promptRequestId === id) return record;
    }
    return undefined;
  }

  // ── 帧循环 ──

  async run(): Promise<void> {
    try {
      for await (const line of this.#options.io.input.lines()) {
        if (this.#stopped) break;
        if (line.trim().length === 0) continue;
        // 先认应答帧（对 agent→client 请求的回应，无 method）。
        const response = parseClientResponse(line);
        if (response) {
          const id = Number(response.id);
          if ("result" in response) this.#settleServerRequest(id, response.result);
          else this.#failServerRequest(id, "client responded with an error");
          continue;
        }
        const call = parseClientCall(line);
        if (!call) {
          // 验收 1：非 ACP 输入回协议错误，不崩进程。
          this.#respondError(null, {
            code: JSONRPC_PARSE_ERROR,
            message: "frame is not a valid JSON-RPC 2.0 message (one message per line)",
          });
          continue;
        }
        // 请求/通知并发处理（与 K7 桥同款纪律）：session/prompt 要等 turn 终态，
        // 串行会饿死同连接后续帧——权限应答、session/cancel、第二个会话的
        // prompt 都必须能立即进入分发。分发自带 try/catch，异常不外溢。
        if (call.id !== undefined) {
          void this.#dispatchRequest(call.id, call.method, call.params);
        } else {
          void this.#dispatchNotification(call.method, call.params);
        }
      }
    } finally {
      await this.shutdown();
    }
  }

  async #dispatchRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      if (method === "initialize") {
        this.#handleInitialize(id, params);
        return;
      }
      if (!this.#initialized) {
        throw new AcpProtocolError(
          JSONRPC_INVALID_REQUEST,
          "client must call initialize before other methods",
        );
      }
      switch (method) {
        case "session/new":
          await this.#handleNewSession(id, params);
          return;
        case "session/prompt":
          await this.#handlePrompt(id, params);
          return;
        case "session/set_config_option":
          this.#respond(id, await this.#handleSetConfigOption(params));
          return;
        default:
          // 未实现面（session/load、session/set_mode、fs/*、authenticate…）：
          // 能力未声明即不存在（附录 A.3）。
          throw new AcpProtocolError(
            JSONRPC_METHOD_NOT_FOUND,
            `method '${method}' is not implemented by this agent`,
          );
      }
    } catch (error) {
      this.#respondError(id, harnessErrorToRpcBody(error));
    }
  }

  async #dispatchNotification(method: string, params: unknown): Promise<void> {
    try {
      switch (method) {
        case "session/cancel":
          await this.#handleCancel(params);
          return;
        case "$/cancel_request":
          await this.#handleJsonRpcCancel(params);
          return;
        case "initialized":
          return; // client 完成握手的礼节性通知：无动作。
        default:
          this.#options.log?.(`ignored notification '${method}'`);
      }
    } catch (error) {
      // 通知没有应答面：错误只落 stderr，不影响帧循环。
      this.#stderr(
        `notification '${method}' failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 收口：清理计时器与引擎链路（幂等；stdin 结束或命令层 shutdown 时调用）。 */
  async shutdown(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    // F3：在途 prompt 先失败回执（client 可能仍在读 stdout），再断链路。
    this.#failPendingPrompts("adapter shutting down");
    for (const record of this.#sessions.values()) {
      for (const permission of record.pendingPermissions.values()) clearTimeout(permission.timer);
      record.pendingPermissions.clear();
    }
    for (const entry of this.#serverRequests.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("adapter shutting down"));
    }
    this.#serverRequests.clear();
    this.#removeLinkListener();
    this.#removeLinkCloseListener();
    await this.#options.link.close();
  }
}
