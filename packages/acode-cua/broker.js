import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BROKER_SOCKET_ENV = "ACODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "ACODE_CUA_PERMISSION_BROKER_UNAVAILABLE";

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

// ── 链路乙（host RPC 客户端 ↔ Helper broker 服务端）wire 实现（角色 B）──────
// 契约见 specs/broker-wire-protocol.md。下面两张方法表逐字复制自上游 zai-org/ZCode
// （Apache-2.0, Copyright 2026 Z.AI Co., Ltd）的
// apps/zcode-cli/packages/zcode-cua-plugin/scripts/computer-use-client.mjs
// （COMPUTER_METHOD_NAMES :30-45、MUTATING_METHODS :60-71）。
// 模块私有、不导出——不变量 3：不改 broker.d.ts 公开面。
const COMPUTER_METHOD_NAMES = Object.freeze([
  "list_apps",
  "list_windows",
  "get_app_state",
  "left_click",
  "scroll",
  "left_click_drag",
  "type",
  "set_value",
  "select_text",
  "key",
  "perform_action",
  "paste",
  "request_access",
  "stop_computer_control",
]);
const MUTATING_METHODS = new Set([
  "left_click",
  "scroll",
  "left_click_drag",
  "type",
  "set_value",
  "select_text",
  "key",
  "perform_action",
  "paste",
  "stop_computer_control",
]);

// 限额与超时（wire spec §7）：沿用链路甲既有值（本仓 cua-broker.ts:13 / cua-bridge.ts:9）。
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
// health 探测（wire spec §6.3）：整体预算对齐 DEFAULT_STARTUP_TIMEOUT_MS(30s)，单次 300ms（设置页 ping 语义），间隔 100ms。
const HEALTH_PROBE_METHOD = "broker_info";
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_PER_TRY_MS = 300;
const DEFAULT_HEALTH_POLL_MS = 100;

/**
 * 链路乙单连接单请求往返（wire spec §1.2）：connect → write 一行请求 → read 一行响应 → destroy。
 * 传输层失败（连接被拒 / 超时 / 请求超限 / 响应超限 / 非法 JSON / 提前关闭）一律抛 BrokerError，
 * 绝不静默返回 undefined（§1.2「连接失败即 fail-closed」）。返回已解析响应对象，由调用方解释 ok/error。
 * 不做 id 回显校验（链路乙响应不含 id，靠单连接单请求对齐，§2.2）；不带 token（§2.3）。
 */
function sendBrokerRequest(socketPath, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const requestLine = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(requestLine) > MAX_REQUEST_BYTES) {
      reject(
        new BrokerError(`Computer Use broker request exceeded ${MAX_REQUEST_BYTES} bytes`, {
          code: "invalid_request",
        }),
      );
      return;
    }
    let settled = false;
    const socket = createConnection(socketPath);
    // 字节级行缓冲（producer spec §17.2 修复，2026-10-14 A2 批次）：旧实现按 chunk 逐个
    // `chunk.toString("utf8")` 累积字符串——多字节 UTF-8 字符（中文 3 字节 / emoji 4 字节）
    // 跨 chunk 劈裂时逐 chunk 解码产生不可逆的 U+FFFD 替换符（响应行含树文本/中文时是常态，
    // A3 起概率真实存在）；且 cap 判定对已损坏重编码的字符串量长，与 wire 原始字节数漂移。
    // 修复 = 累积 Buffer（Buffer.concat），在字节域扫描 0x0A 切行，完整行字节一次性
    // toString("utf8")（单行内无劈裂可能），cap 按 wire 原始字节长度判定。
    // JSON 行内容天然无裸 \n（wire spec §1.3 单行契约），字节切行安全。
    let buffer = Buffer.alloc(0);
    // delivery-state 基础（wire spec §5.2 / C08）：请求行是否已写出。已写出 ⇒ 动作**可能已送达**
    // Helper（possibly_sent），变更类方法绝不可自动重放；未写出（connect 就失败）⇒ 确定未送达，可安全重试。
    // 这个区分是 possibly_sent 判定的唯一事实来源，故随错误一并上报（BrokerError.details.possiblySent）。
    let requestWritten = false;
    const fail = (message, code) =>
      new BrokerError(message, { code, details: { possiblySent: requestWritten } });
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      settle(value);
    };
    const timer = setTimeout(() => {
      finish(reject, fail(`Computer Use broker call timed out after ${timeoutMs}ms`, "timeout"));
    }, timeoutMs);
    // timer.unref() 不做：callBrokerMethod/probeHelperHealth 是调用方主动 await 的前台操作，
    // 不应因其挂起而让进程提前退出（与 host 侧生命周期 timer 的 unref 语义相反）。
    socket.once("connect", () => {
      // 同步置位（不等 flush 回调）：一旦调用 write，就必须假定动作可能已送达 Helper。
      // C08 的 possibly_sent 语义要求保守方向——宁可误判「已发送」而拒绝重放，
      // 也不可漏判导致变更类动作被重放。若在 write 回调里置位，超时 race 下会漏报。
      requestWritten = true;
      socket.write(requestLine);
    });
    socket.on("data", (chunk) => {
      // §17.2 字节级缓冲：concat 累积原始 wire 字节，cap 与切行都在字节域判定。
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_RESPONSE_BYTES) {
        finish(
          reject,
          fail(`Computer Use broker response exceeded ${MAX_RESPONSE_BYTES} bytes`, "internal"),
        );
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      let response;
      try {
        // 完整行字节一次性解码：多字节字符即使跨 chunk 劈裂也无损（§17.2）。
        response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        finish(reject, fail("Computer Use broker returned a malformed response line", "internal"));
        return;
      }
      finish(resolve, response);
    });
    socket.on("error", (error) => {
      finish(
        reject,
        fail(
          `Computer Use broker connection failed: ${error?.code ?? error?.message ?? "unknown"}`,
          "broker_unavailable",
        ),
      );
    });
    socket.on("close", () => {
      // 完整响应行到达前连接关闭：fail-closed，不返回半个响应。
      finish(reject, fail("Computer Use broker closed before a complete response", "broker_unavailable"));
    });
  });
}

export async function callBrokerMethod(args) {
  const socketPath = args?.socketPath;
  const method = args?.method;
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new BrokerError("callBrokerMethod requires a socketPath", { code: "invalid_request" });
  }
  if (typeof method !== "string" || method.length === 0) {
    throw new BrokerError("callBrokerMethod requires a method", { code: "invalid_request" });
  }
  const timeoutMs =
    Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_CALL_TIMEOUT_MS;
  const request = {
    id: randomUUID(),
    method,
    ...(args.params !== undefined ? { params: args.params } : {}),
  };
  let response;
  try {
    response = await sendBrokerRequest(socketPath, request, timeoutMs);
  } catch (error) {
    // 传输层失败也要带上 possiblySent（若已写出请求行则动作可能已送达），供上层 delivery-state 判定。
    if (error instanceof BrokerError && error.details === undefined) {
      throw new BrokerError(error.message, { code: error.code, details: { possiblySent: false } });
    }
    throw error;
  }
  // ok:false → 抛 BrokerError 透传 error.code（§4.2），绝不返回 result / undefined（§4.3 红线）。
  //
  // possiblySent 只在**传输层歧义**（请求已写出但拿不到收据：超时/提前关闭/非法响应）时为真。
  // 应用层 ok:false 是 Helper 的**明确回信**——它已受理并拒绝了该请求，故不属歧义：
  //   - broker_unavailable / stale_socket 更是 Helper 权威声明「未受理」，必须可重试（wire spec §5.3）；
  //   - 若动作确实可能已落地，那是 producer 自己的判断，经 **ok:true 的收据**携
  //     dispatch_status:"possibly_sent" 上报（上游 receiptOf/assertOk 即从此读取），
  //     execute 原样透传，客户端不得凭传输状态伪造。
  if (!response || response.ok !== true) {
    const error = response && typeof response.error === "object" && response.error !== null ? response.error : {};
    throw new BrokerError(error.message ?? "Computer Use broker call failed", {
      code: typeof error.code === "string" ? error.code : "internal",
      details: { possiblySent: false },
    });
  }
  return response.result;
}

export async function probeHelperHealth(socketPath, options = {}) {
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new CuaHelperError("probeHelperHealth requires a socketPath", { code: "helper_unavailable" });
  }
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_HEALTH_TIMEOUT_MS;
  const perTryTimeoutMs =
    Number.isFinite(options.perTryTimeoutMs) && options.perTryTimeoutMs > 0
      ? options.perTryTimeoutMs
      : DEFAULT_HEALTH_PER_TRY_MS;
  const pollIntervalMs =
    Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs >= 0
      ? options.pollIntervalMs
      : DEFAULT_HEALTH_POLL_MS;
  const startedAt = Date.now();
  let lastError;
  // 轮询 broker_info 直到成功或整体预算耗尽（§6.1/§6.3）。
  for (;;) {
    try {
      const response = await sendBrokerRequest(
        socketPath,
        { id: randomUUID(), method: HEALTH_PROBE_METHOD },
        perTryTimeoutMs,
      );
      const result = response && response.ok === true && typeof response.result === "object" && response.result !== null
        ? response.result
        : null;
      const pid = result ? result.pid : undefined;
      if (result && Number.isInteger(pid) && pid > 0) {
        // Windows 上 bundle_id 可能缺失（无 CFBundle id / AUMID，§6.2）——bundleId=null 不是 health 失败，
        // health 门只校 PID（isExactHealthPid，windowsCuaHelperHostSupport.ts:230-235）。
        const bundleId = typeof result.bundle_id === "string" ? result.bundle_id : null;
        return { bundleId, pid };
      }
      const error = response && typeof response.error === "object" && response.error !== null ? response.error : null;
      lastError = error
        ? new CuaHelperError(error.message ?? "Computer Use Helper health probe failed", {
            code: typeof error.code === "string" ? error.code : "helper_unavailable",
          })
        : new CuaHelperError("Computer Use Helper health probe returned no positive pid", {
            code: "helper_unavailable",
          });
    } catch (error) {
      lastError =
        error instanceof Error ? error : new CuaHelperError(String(error), { code: "helper_unavailable" });
    }
    if (Date.now() - startedAt >= timeoutMs) {
      // §6.4：探测失败必须 throw，绝不返回 {bundleId:null,pid:null}（那是当前占位的「假成功空值」）。
      throw lastError ?? new CuaHelperError("Computer Use Helper health probe timed out", { code: "timeout" });
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export function mintBrokerSocketPath(options = {}) {
  // win32：named pipe \\.\pipe\ 前缀（§1.1）。不用 path.join（会规范化分隔符、破坏前缀），
  // 且忽略 options.dir（pipe 命名空间是全局的）。前缀 acode-cua-broker- 与链路甲的
  // acode-node-repl-cua- 互不为对方前缀，同机不撞名。SocketPathOptions 无 platform 字段
  // （broker.d.ts:49-52，签名不变——§11.1），故按 process.platform 判定。
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\acode-cua-broker-${randomUUID()}`;
  }
  const dir = typeof options.dir === "string" ? options.dir : tmpdir();
  return join(dir, `acode-cua-broker-${randomUUID()}.sock`);
}

export function resolveBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[BROKER_SOCKET_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  return mintBrokerSocketPath(options);
}

export function parseRequestLine(_line) {
  return undefined;
}

export function okResponse(result) {
  return { ok: true, result };
}

export function errorResponse(message, options = {}) {
  return {
    ok: false,
    error: { message, ...(options.code ? { code: options.code } : {}) },
  };
}

export function errorResponseFromException(error) {
  return errorResponse(error instanceof Error ? error.message : String(error));
}

export function serializeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

export async function dispatchRequest(_backend, _request) {
  throw new CuaHelperError("Computer Use is not available in this build.");
}

export async function handleRequestLine(_backend, _line) {
  throw new CuaHelperError("Computer Use is not available in this build.");
}

export function isBrokerMethod(method) {
  // 14 方法能力表谓词（wire spec §8.1）。非字符串一律 false。
  return typeof method === "string" && COMPUTER_METHOD_NAMES.includes(method);
}

export function isReadOnlyBrokerMethod(method) {
  // 只读 = 是 broker 方法且不在 10 个变更类方法集内（wire spec §8.2）。
  // 变更类方法可能已产生副作用，possibly_sent 判定据此「绝不自动重放」（§5.2）。
  return isBrokerMethod(method) && !MUTATING_METHODS.has(method);
}
