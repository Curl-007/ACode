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
