import { BrokerError, callBrokerMethod, isBrokerMethod, isCuaHelperError, isReadOnlyBrokerMethod } from "./broker.js";

// SDK-facing 非-error 结果信封（wire spec §5.1，逐字对齐上游 computer-use-client.mjs 的
// NOT_READY_KIND / reasonCode / retryable 契约）。Helper 冷启动 warming-up 时 execute 返回它，
// SDK 的 not-ready 重试环据此退避重试（NOT_READY_MAX_ATTEMPTS=6）；possibly_sent 时 retryable=false
// 绝不重放（§5.2）。
const NOT_READY_KIND = "CUA_NOT_READY";
const NOT_READY_REASON_BROKER_NOT_ACCEPTING = "broker_not_accepting";
const NOT_READY_REASON_POSSIBLY_SENT = "possibly_sent";

// warming-up 期链路乙的传输错误码（windows-transport-ready.md:22：功能层未就绪时工具调用以
// 可重试的 broker_unavailable 响应）。execute 把它翻译成 CUA_NOT_READY（openQuestion #1 裁决为方案 b：
// Helper/链路乙发 broker_unavailable 传输错误，由 execute 归一为 SDK-facing 非-error 信封）。
const WARMING_UP_BROKER_CODES = new Set(["broker_unavailable", "stale_socket"]);

// 按方法类别分级超时（wire spec §7.2：「变更类动作建议由调用方传更短 timeoutMs，避免一个卡住的
// 变更动作占满 30s」）。变更类动作（click/type/key/…）应快速返回；只读观察类（get_app_state 带
// 截图 + UIA 树遍历）可能耗时数秒，沿用 broker.js 的 30s 缺省（不传 timeoutMs）。
const MUTATING_CALL_TIMEOUT_MS = 10_000;

/** 未知方法名（非 14 方法表内）按只读缺省处理——由 Helper 侧判 method_not_found，不在此预判。 */
function callTimeoutMsFor(method) {
  return isBrokerMethod(method) && !isReadOnlyBrokerMethod(method) ? MUTATING_CALL_TIMEOUT_MS : undefined;
}

/**
 * 把一段文本包成单文本块的 CallToolResult（链路甲 cua-broker.ts:99 会把 execute 的返回值
 * 原样放进 { ok:true, result }，SDK 侧 unwrapEnvelope / notReadyEnvelopeOf / brokerErrorCodeOf
 * 都按「content 里的 text block」解析，故结果必须是这个形态）。
 */
function textResult(text, isError) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * CUA_NOT_READY 非-error 信封（isError 缺省 = false，SDK notReadyEnvelopeOf 要求 isError!==true）。
 * @param {string} reasonCode @param {boolean} retryable @param {string} message
 */
function notReadyResult(reasonCode, retryable, message) {
  return textResult(JSON.stringify({ kind: NOT_READY_KIND, reasonCode, retryable, message }));
}

/**
 * 应用层失败的 isError 结果。code 放进单文本块的 JSON 里，SDK 的 brokerErrorCodeOf 会
 * 从 text block 解析出 code 并经 ERROR_CODE_BY_BROKER 映射（wire spec §4.1）。
 * possibly_sent（变更类动作可能已产生副作用）时 dispatch_status 标记，SDK assertOk 据此
 * 把 retry 判为 "never"/"reobserve"，绝不自动重放（§4.5 / C08）。
 */
function errorResult(message, code, possiblySent) {
  const payload = {
    ...(typeof code === "string" ? { code } : {}),
    error: { message, ...(typeof code === "string" ? { code } : {}) },
    ...(possiblySent ? { dispatch_status: "possibly_sent", action_sent: true } : {}),
  };
  return textResult(JSON.stringify(payload), true);
}

export function createComputerUseRuntime(options = {}) {
  const brokerSocketPath = typeof options.brokerSocketPath === "string" ? options.brokerSocketPath : undefined;
  const refreshMarkerPath =
    typeof options.refreshMarkerPath === "string" ? options.refreshMarkerPath : undefined;
  const ensureBrokerAvailable =
    typeof options.ensureBrokerAvailable === "function" ? options.ensureBrokerAvailable : undefined;

  // 未配置 socketPath：本构建 CUA 不可用。保持占位的 fail-closed 语义——返回 isError 结果，
  // 不抛（抛会被链路甲降成丢码的 error 字符串）。这是「Helper 从未接线」而非「warming-up」，
  // 故不用 CUA_NOT_READY（那会让 SDK 无谓重试 6 次），而是明确的不可用错误。
  const unavailable = () => errorResult("Computer Use is not available in this build.", "internal", false);

  return {
    async execute(input) {
      if (!brokerSocketPath) return unavailable();
      const toolName = input?.toolName;
      if (typeof toolName !== "string" || toolName.length === 0) {
        return errorResult("Computer Use execute requires a toolName", "invalid_request", false);
      }
      // 已知缺口（诚实声明，不静默假装支持）：input.signal（AbortSignal，index.d.ts:19）当前
      // **不被尊重**。链路乙的 CallBrokerMethodArgs（broker.d.ts:29-34 ≡ 上游）无 signal/取消字段，
      // 且不变量 3 禁止改该签名。更重要的是：对变更类方法（type/left_click/…）中途 abort 恰恰就是
      // possibly_sent 场景——请求行可能已写出、动作可能已落地，取消 Promise 并不能撤销副作用。
      // 故此处不实现「假取消」（那会违反能力真实性：让调用方以为动作没发生）。取消语义留待
      // wire spec openQuestion（需角色 A 的 Helper 侧协作定义可取消点）后统一设计。
      try {
        // ensureBrokerAvailable 是 SDK/宿主提供的懒启动钩子（wire spec §5.4）：首调触发 Helper 拉起。
        // 它抛错视为 warming-up 不可用（可重试），不是动作失败。
        if (ensureBrokerAvailable) await ensureBrokerAvailable();
        const result = await callBrokerMethod({
          socketPath: brokerSocketPath,
          method: toolName,
          params: input?.arguments,
          // 变更类方法传更短超时（§7.2），只读观察类沿用 broker.js 的 30s 缺省。
          ...(callTimeoutMsFor(toolName) !== undefined ? { timeoutMs: callTimeoutMsFor(toolName) } : {}),
        });
        // 成功：原样返回 Helper 的 CallToolResult（可能含 content/structuredContent/_meta）。
        // execute 不改写成功结果的形态（SDK unwrapEnvelope 依赖其原样）。
        return result ?? textResult(JSON.stringify({ ok: true }));
      } catch (error) {
        const code =
          error instanceof BrokerError
            ? error.code
            : isCuaHelperError(error)
              ? error.code
              : undefined;
        const possiblySent = Boolean(
          error && typeof error === "object" && error.details && error.details.possiblySent === true,
        );
        // warming-up：Helper 未就绪的传输错误 → CUA_NOT_READY 可重试信封（非 error 结果）。
        // 但若动作可能已送达（possiblySent），retryable 必须 false —— 绝不重放变更类动作（§5.2 红线）。
        if (typeof code === "string" && WARMING_UP_BROKER_CODES.has(code)) {
          return notReadyResult(
            possiblySent ? NOT_READY_REASON_POSSIBLY_SENT : NOT_READY_REASON_BROKER_NOT_ACCEPTING,
            !possiblySent,
            possiblySent
              ? "Computer Use action may have been sent; not retrying automatically."
              : "Computer Use Helper is starting up. Retry the same tool call after a brief wait.",
          );
        }
        // 其它失败（应用层错误 / 超时 / 非法响应）：isError 结果，携带 broker code 供 SDK 映射。
        // possibly_sent 时标记 dispatch_status，SDK 据此不重放（C08）。
        const message =
          error instanceof Error ? error.message : typeof error === "string" ? error : "Computer Use call failed";
        return errorResult(message, typeof code === "string" ? code : "internal", possiblySent);
      }
    },
    async closeSession() {
      // 链路乙单连接单请求（wire spec §1.2），无常驻会话状态需清理；保留 no-op 以满足
      // ComputerUseRuntime 接口（index.d.ts:23）。全仓无调用方（阶段 0 核查）。
    },
    async dispose() {
      // 同上：无常驻连接/资源。refreshMarkerPath 目前仅记录，standalone-helper 懒启动的
      // refresh marker 机制属角色 A（module-boundary.md 栏②），此处不消费。
      void refreshMarkerPath;
    },
  };
}
