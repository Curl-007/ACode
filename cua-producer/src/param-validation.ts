/**
 * A2 wire handler 参数校验（specs/windows-helper-producer.md §10.2/§10.9/§13——封闭
 * schema、手写验证器、未知键拒绝）。A2 实现批次自 backend-a2.ts 拆出（§5.3「文件划分
 * 可微调」；纯函数、CI 可单测）。
 *
 * 纪律：校验失败一律 WireRequestFailure(invalid_request 固定字面量)——零插值、绝不回显
 * 参数内容（type/paste 的文本是用户内容，进错误消息即隐私泄漏，§10.2）；校验全部发生
 * 在派发前（§10.12 ok:false 安全区）。app_ref 的 name/bundle_id 形态用专属字面量
 * （能力诚实：A2 不做半套名称解析，§10.9）；element target 用 A2 诚实拒绝字面量（C09 同律）。
 */
import { WIRE_ERROR_MESSAGES, WireRequestFailure } from "./wire-server.js";

/** §10.2 文本上限（code units）。 */
export const TYPE_TEXT_MAX_CODE_UNITS = 32_768;
export const PASTE_TEXT_MAX_CODE_UNITS = 8 * 1024 * 1024;
/** §10.2/§13 行 8：set_value.value ≤ 8 Mi code units（A3）。 */
export const SET_VALUE_MAX_CODE_UNITS = 8 * 1024 * 1024;
/** §10.2 stop reason 上限（接受即丢弃——任何回显路径都是隐私面）。 */
export const STOP_REASON_MAX_CODE_UNITS = 512;

export const MOUSE_BUTTONS: ReadonlySet<string> = new Set(["left", "right", "middle"]);
export const MODIFIERS: ReadonlySet<string> = new Set(["ctrl", "alt", "shift", "win"]);
export const MODIFIER_VK: Readonly<Record<string, number>> = Object.freeze({
  ctrl: 0x11, // VK_CONTROL
  alt: 0x12, // VK_MENU
  shift: 0x10, // VK_SHIFT
  win: 0x5b, // VK_LWIN
});
export const SCROLL_DIRECTIONS: ReadonlySet<string> = new Set(["up", "down", "left", "right"]);
/** §10.2：1 页 = 3×WHEEL_DELTA = 360（delta 单位 = WHEEL_DELTA(120) 倍数，§10.1）。 */
export const SCROLL_UNITS_PER_PAGE = 360;
/** §10.2 hold_seconds ∈ [0,30]。 */
export const HOLD_SECONDS_MAX = 30;

export function invalidParams(): never {
  throw new WireRequestFailure(WIRE_ERROR_MESSAGES.invalidParams, "invalid_request");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 封闭参数集（§13 表为单一事实源）：未知键拒绝、必填缺失拒绝。 */
export function pickKeys(
  params: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  const value = params === undefined ? {} : params;
  if (!isRecord(value)) invalidParams();
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) invalidParams();
  }
  for (const key of required) {
    if (value[key] === undefined) invalidParams();
  }
  return value;
}

export function requireString(value: unknown): string {
  if (typeof value !== "string") invalidParams();
  return value as string;
}

export function requireFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidParams();
  return value as number;
}

export function requireOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalidParams();
  return value as string;
}

/** app_ref（A2 切片，§10.9）：只接受 {pid: 正整数}（window_id 可附、忽略）。 */
export function parseAppRefPid(appRef: unknown): number {
  if (!isRecord(appRef)) invalidParams();
  const record = appRef as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "pid" || key === "window_id") continue;
    if (key === "name" || key === "bundle_id") {
      // 能力诚实：A2 不做半套名称解析（name/bundle_id 形态 → 固定字面量拒绝，A3 收口）。
      throw new WireRequestFailure(WIRE_ERROR_MESSAGES.appRefRequiresPid, "invalid_request");
    }
    invalidParams(); // 未知键拒绝（§10.2）
  }
  const pid = record.pid;
  if (pid === undefined) {
    throw new WireRequestFailure(WIRE_ERROR_MESSAGES.appRefRequiresPid, "invalid_request");
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) invalidParams();
  return pid as number;
}

export interface CoordinateTarget {
  x: number;
  y: number;
  frameId?: string;
}

/** target（A2 切片，§10.9）：element → 诚实拒绝；coordinate → 形态校验。 */
export function parseCoordinateTarget(target: unknown): CoordinateTarget {
  if (!isRecord(target)) invalidParams();
  const record = target as Record<string, unknown>;
  if (record.type === "element") {
    // UIA 面未实现，C09 同律诚实拒绝（SDK 链条诚实终止，模型不会无限打转，§10.9）。
    throw new WireRequestFailure(
      WIRE_ERROR_MESSAGES.elementTargetsRequireUia,
      "element_unavailable",
    );
  }
  if (record.type !== "coordinate") invalidParams();
  for (const key of Object.keys(record)) {
    if (key !== "type" && key !== "x" && key !== "y" && key !== "frame_id") invalidParams();
  }
  const x = record.x;
  const y = record.y;
  // x/y 非负整数（模型栅格像素，SDK bindTarget 同判据，§10.9）。
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0) invalidParams();
  if (typeof y !== "number" || !Number.isInteger(y) || y < 0) invalidParams();
  if (record.frame_id !== undefined && typeof record.frame_id !== "string") invalidParams();
  const parsed: CoordinateTarget = { x: x as number, y: y as number };
  if (typeof record.frame_id === "string") parsed.frameId = record.frame_id;
  return parsed;
}

/** modifiers 封闭词汇 {ctrl, alt, shift, win}（§10.2）；未知修饰键 → invalid_request。 */
export function parseModifiers(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalidParams();
  const modifiers: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !MODIFIERS.has(entry)) invalidParams();
    modifiers.push(entry);
  }
  return modifiers;
}

// ── A3 增补（specs/windows-helper-producer.md §11.2/§11.3/§13）────────────────

/** 结构解析后的 app_ref（解析语义在 app-ref.ts；本函数只做形态校验，派发前安全区）。 */
export interface ParsedAppRef {
  pid?: number;
  name?: string;
  bundleId?: string;
  /** A2 忽略、A3 生效（get_app_state 窗口选择；其余方法接受并忽略，§13）。 */
  windowId?: number;
}

/**
 * app_ref 全形态结构校验（§11.3）：封闭键集 {pid, name, bundle_id, window_id}；至少一个
 * 身份字段（pid/name/bundle_id）；pid/window_id 正整数、name/bundle_id 非空字符串。
 * 组合一致性（冲突拒绝）与候选解析在 app-ref.ts（需要 driver 素材，属派发前异步段）。
 */
export function parseAppRefShape(appRef: unknown): ParsedAppRef {
  if (!isRecord(appRef)) invalidParams();
  const record = appRef as Record<string, unknown>;
  const parsed: ParsedAppRef = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (key === "pid") {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) invalidParams();
      parsed.pid = value as number;
    } else if (key === "name") {
      if (typeof value !== "string" || value.length === 0) invalidParams();
      parsed.name = value as string;
    } else if (key === "bundle_id") {
      if (typeof value !== "string" || value.length === 0) invalidParams();
      parsed.bundleId = value as string;
    } else if (key === "window_id") {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) invalidParams();
      parsed.windowId = value as number;
    } else {
      invalidParams(); // 未知键拒绝（§10.2 封闭参数集）
    }
  }
  if (parsed.pid === undefined && parsed.name === undefined && parsed.bundleId === undefined) {
    invalidParams(); // 至少一个身份字段
  }
  return parsed;
}

/** 动作 target（A3 联合形态，§11.2）：element（index 非负整数）或 coordinate（A2 判据不变）。 */
export type ActionTarget =
  | { kind: "coordinate"; x: number; y: number; frameId?: string }
  | { kind: "element"; index: number };

export function parseActionTarget(target: unknown): ActionTarget {
  if (!isRecord(target)) invalidParams();
  const record = target as Record<string, unknown>;
  if (record.type === "element") {
    for (const key of Object.keys(record)) {
      if (key !== "type" && key !== "index") invalidParams();
    }
    const index = record.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) invalidParams();
    return { kind: "element", index: index as number };
  }
  const coordinate = parseCoordinateTarget(target) as CoordinateTarget;
  return {
    kind: "coordinate",
    x: coordinate.x,
    y: coordinate.y,
    ...(coordinate.frameId !== undefined ? { frameId: coordinate.frameId } : {}),
  };
}

/**
 * element target 专属解析（set_value/select_text/perform_action——坐标 target 无该类方法
 * 语义 → invalid_request 固定字面量，§11.2）。
 */
export function parseElementTarget(target: unknown): number {
  if (!isRecord(target)) invalidParams();
  const record = target as Record<string, unknown>;
  if (record.type !== "element") invalidParams();
  for (const key of Object.keys(record)) {
    if (key !== "type" && key !== "index") invalidParams();
  }
  const index = record.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) invalidParams();
  return index as number;
}

/** perform_action 的 action 封闭词汇（§11.2 A3 v1；滚动语义一律走 scroll 工具，不受理）。 */
export const ACTION_NAMES: ReadonlySet<string> = new Set([
  "invoke",
  "toggle",
  "expand",
  "collapse",
  "select",
  "focus",
]);

export function parseActionName(value: unknown): string {
  const action = requireString(value);
  if (!ACTION_NAMES.has(action)) invalidParams();
  return action;
}

/**
 * select_text 的 text_range（§11.2）：[start, length] 整数二元组——length 缺省 0 合法
 * （光标折叠）；负数/非整数 → invalid_request（确定性参数错，派发前安全区）。
 */
export function parseTextRange(value: unknown): { start: number; length: number } {
  if (!Array.isArray(value)) invalidParams();
  if (value.length < 1 || value.length > 2) invalidParams();
  const start = value[0];
  if (typeof start !== "number" || !Number.isInteger(start) || start < 0) invalidParams();
  let length = 0;
  if (value.length === 2) {
    const lengthValue = value[1];
    if (typeof lengthValue !== "number" || !Number.isInteger(lengthValue) || lengthValue < 0) {
      invalidParams();
    }
    length = lengthValue as number;
  }
  return { start: start as number, length };
}

/** get_app_state 的封闭参数集（§13 行 3）；detail 接受并忽略（A3 v1 恒 full 快照）。 */
export interface GetAppStateParams {
  appRef: ParsedAppRef;
  includeScreenshot: boolean;
  treeShownToModel: boolean;
}

export function parseGetAppStateParams(params: unknown): GetAppStateParams {
  const p = pickKeys(params, ["app_ref"], [
    "window_id",
    "include_screenshot",
    "disable_diffing",
    "tree_shown_to_model",
    "detail",
  ]);
  const appRef = parseAppRefShape(p.app_ref);
  // window_id 若出现在 app_ref 外层（SDK 形态以 app_ref.window_id 为准；外层同键也受理
  // 并合并进 ParsedAppRef——封闭集内，语义同一）。
  if (p.window_id !== undefined) {
    if (typeof p.window_id !== "number" || !Number.isInteger(p.window_id) || p.window_id <= 0) {
      invalidParams();
    }
    if (appRef.windowId === undefined) appRef.windowId = p.window_id as number;
  }
  for (const key of ["include_screenshot", "disable_diffing", "tree_shown_to_model"]) {
    if (p[key] !== undefined && typeof p[key] !== "boolean") invalidParams();
  }
  if (p.detail !== undefined) requireOptionalString(p.detail);
  return {
    appRef,
    includeScreenshot: p.include_screenshot === true,
    treeShownToModel: p.tree_shown_to_model === true,
  };
}
