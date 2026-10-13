/**
 * 链路乙 wire 服务端原语（specs/windows-helper-producer.md §2.5/§2.6/§4.6/§6.3；
 * wire 契约以 packages/acode-cua/specs/broker-wire-protocol.md 为单一事实源，本文只钉
 * producer 侧实现细节）。
 *
 * ACode 原创实现（producer spec §1.2 裁决 (b)）：Helper 运行时解析不到 @acode/acode-cua
 * （两种加载模式下都无解析路径），故 parse/serialize/dispatch 在自有树内按 wire 契约自建，
 * 占位包三件套永不回填。本模块无进程耦合（不 import node:net、不触 process），可独立单测（§6.3）。
 */

/**
 * wire 方法名全集（wire spec §8.1）。方法名字符串是 wire 契约词汇/接口事实，producer 在
 * 自有树内持有该名单；名单的实现代码为 ACode 原创，不从 broker.js 复制表达（§4.6 末条）。
 */
export const WIRE_METHOD_NAMES: readonly string[] = Object.freeze([
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

/** 带外 health/身份探测方法（wire spec §6.1：不在 14 方法表内，dispatch 须单独受理）。 */
export const BROKER_INFO_METHOD = "broker_info";

/** 每连接行缓冲上限 1 MiB（producer spec §2.6：与客户端请求上限对称，wire spec §7.1）。 */
export const MAX_REQUEST_LINE_BYTES = 1024 * 1024;

/** 连接空闲上限 30s（producer spec §2.6：对齐 wire spec §7.2 客户端缺省超时，防句柄泄漏）。 */
export const CONNECTION_IDLE_TIMEOUT_MS = 30_000;

/**
 * 封闭 wire error 字面量表（producer spec §4.6 A1 可达场景全集，零插值——§3.2 红线：
 * 结构上排除窗口标题/元素名/文本内容/路径/凭据进入 wire 响应）。码取自 wire spec §4.1
 * 的 17 码词汇表。`internal` 对应防御分支（handler 抛错 / 空成功违约）：A1 的 backend 只
 * 注册同步纯函数 broker_info，该分支结构上不可达；保留它是为 wire「每请求欠一行响应」
 * 义务兜底（wire spec §9.1），A2 注册真实 handler 前须先扩充 producer spec §4.6 表。
 */
export const WIRE_ERROR_MESSAGES = Object.freeze({
  warming: "Computer Use Helper is starting up.",
  unimplemented: "Computer Use method is not implemented by this producer.",
  methodNotFound: "Unknown Computer Use broker method.",
  invalidRequest: "Invalid Computer Use broker request line.",
  internal: "Computer Use broker failed to handle the request.",
} as const);

/** 请求行形状（wire spec §2.1：id 可选仅信息性、method 必填字符串、params 任意）。 */
export interface BrokerRequestLine {
  id?: string | null;
  method: string;
  params?: unknown;
}

/**
 * 响应形态（wire spec §3.1 同构，producer 内原创实现）：成功 { ok:true, result }；
 * 失败 { ok:false, error:{ message, code? } }——code 仅在有值时出现。
 */
export type WireResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { message: string; code?: string } };

/** 功能层状态门（producer spec §2.4）：A1 只有 warming/ready 两态参与 dispatch。 */
export type WireState = "warming" | "ready";

/** handler 签名（wire spec §9.3 BrokerHandler 同构）。 */
export type BrokerHandler = (params: unknown, context?: unknown) => unknown | Promise<unknown>;

/** 扁平 method-name → handler 注册表（wire spec §9.3 NativeAutomationBackend 同构注入 seam）。 */
export type BackendRecord = Record<string, BrokerHandler | undefined>;

export function okResponse(result: unknown): WireResponse {
  return { ok: true, result };
}

export function errorResponse(message: string, code?: string): WireResponse {
  return { ok: false, error: code === undefined ? { message } : { message, code } };
}

/** 响应行序列化（wire spec §1.3/§3.1 同构）：JSON + 单个 \n，单行。 */
export function serializeResponse(response: WireResponse): string {
  return `${JSON.stringify(response)}\n`;
}

/**
 * 请求行解析判据（wire spec §9.1 / producer spec §4.6）：对象（非数组非 null）且
 * typeof method === "string"；id（若存在）须 string|null；params 不校验（校验属 handler，
 * A1 无 handler）。非法 → undefined（调用方仍欠一行 invalid_request 响应，不得静默关连接）。
 */
export function parseRequestLine(line: string): BrokerRequestLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.method !== "string") return undefined;
  if ("id" in candidate && candidate.id !== null && typeof candidate.id !== "string") {
    return undefined;
  }
  const request: BrokerRequestLine = { method: candidate.method };
  if ("id" in candidate) request.id = candidate.id as string | null;
  if ("params" in candidate) request.params = candidate.params;
  return request;
}

/** WARMING 统一应答（producer spec §2.5：只用于「请求未进 native」的 warm-up 重试）。 */
export function warmingResponse(): WireResponse {
  return errorResponse(WIRE_ERROR_MESSAGES.warming, "broker_unavailable");
}

/**
 * 派发（wire spec §9.2 + producer spec §2.5/§4.6）：
 * 1. WARMING 门先于方法门——READY 之前任何请求（14 方法 + broker_info + 未知方法）一律
 *    broker_unavailable（§2.5 ACode 自定收紧：ready 代表完整 health probe 成功，warming 期
 *    应答 broker_info 会让设置页 300ms ping 把功能层未就绪的 Helper 报成健康）。
 *    结构上保证 warming 期请求根本不触达 backend/native（§2.5）。
 * 2. 方法门：14 方法表或 broker_info；都不是 → method_not_found。
 * 3. handler 解析：14 表内未注册 → unimplemented（wire spec §9.2 裁决：→SDK
 *    ACTION_UNAVAILABLE→retry never，比 method_not_found→INTERNAL 更诚实）；A1 的 backend
 *    对 14 方法一个 handler 都不注册，unimplemented 由本层统一产出（§4.6）。
 *    broker_info 未注册（A1 不可达）按「不在 14 表内」分支 → method_not_found。
 * 4. 成功 → okResponse(result)；result === undefined = 空成功 = 协议违规（wire spec §3.3），
 *    诚实转 internal 失败，绝不冒充成功。
 * 5. handler 抛错 → code 透传（限非空字符串）+ 封闭字面量 message（防御分支，A1 不可达；
 *    绝不把异常 message 插值上 wire，§3.2 零插值红线）。
 */
export async function dispatchRequest(
  backend: BackendRecord,
  request: BrokerRequestLine,
  state: WireState,
): Promise<WireResponse> {
  if (state !== "ready") return warmingResponse();
  const { method } = request;
  const known = method === BROKER_INFO_METHOD || WIRE_METHOD_NAMES.includes(method);
  if (!known) return errorResponse(WIRE_ERROR_MESSAGES.methodNotFound, "method_not_found");
  const handler = backend[method];
  if (typeof handler !== "function") {
    return method === BROKER_INFO_METHOD
      ? errorResponse(WIRE_ERROR_MESSAGES.methodNotFound, "method_not_found")
      : errorResponse(WIRE_ERROR_MESSAGES.unimplemented, "unimplemented");
  }
  try {
    const result = await handler(request.params);
    if (result === undefined) return errorResponse(WIRE_ERROR_MESSAGES.internal, "internal");
    return okResponse(result);
  } catch (error) {
    const code =
      error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? ((error as { code: string }).code.length > 0 ? (error as { code: string }).code : "internal")
        : "internal";
    return errorResponse(WIRE_ERROR_MESSAGES.internal, code);
  }
}

/** 有状态派发器（§2.4 状态机的 wire 面）：warming → ready 单向。 */
export interface WireDispatcher {
  readonly state: WireState;
  /**
   * 注入 backend 并单向切 READY（§2.4「注入 backend，状态=READY」是同一步）。
   * 状态只前进不回退：READY 后重复调用为 no-op，且不存在任何回退 API（§6.3）。
   */
  activate(backend: BackendRecord): void;
  /** 处理一行请求，恒产出一行响应（wire spec §9.1：解析失败也欠响应，不得静默）。 */
  handleRequestLine(line: string): Promise<WireResponse>;
}

export function createWireDispatcher(): WireDispatcher {
  let state: WireState = "warming";
  let backend: BackendRecord = {};
  return {
    get state(): WireState {
      return state;
    },
    activate(nextBackend: BackendRecord): void {
      if (state === "ready") return;
      backend = nextBackend;
      state = "ready";
    },
    async handleRequestLine(line: string): Promise<WireResponse> {
      // 解析门先于状态门：非法行不是「请求」（§2.5 的 warming 全门枚举对象是 14 方法/
      // broker_info/未知方法），invalid_request 在任何状态下都欠一行响应（wire spec §9.1）。
      const request = parseRequestLine(line);
      if (!request) {
        return errorResponse(WIRE_ERROR_MESSAGES.invalidRequest, "invalid_request");
      }
      return dispatchRequest(backend, request, state);
    },
  };
}
