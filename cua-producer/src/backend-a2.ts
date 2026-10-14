/**
 * A2 wire handlers（specs/windows-helper-producer.md §10）：7 个变更类
 * （left_click/scroll/left_click_drag/type/key/paste/stop_computer_control）+
 * request_access + broker_info 的 capabilities 增量（§10.9）。
 *
 * A3 增补（§11.2/§11.3）：
 * - 指针三工具的 element target 路径（InvokePattern 优先 / clickable point 兜底 /
 *   皆不可 → action_unavailable；收据 message 固定字面量分支如实标注路径）；
 * - app_ref 全形态（组合注入 resolveAppRef 时 name/bundle_id 生效；A2-alone 面维持
 *   pid-only + 专属诚实拒绝字面量）；
 * - 一切带已解析 app_ref 的动作收据附 _meta targetApp 展示投影（§11.6）。
 *
 * 6 个 UIA 工具在 backend-a3.ts（A3）；本文件的 broker_info 是 A2 三键基础面，
 * capabilities.uia 由 backend-a3 装饰（§10.9）。
 *
 * delivery-state 派发侧契约（§10.12 铁律）：
 * 1. 变更类派发启动后禁止 ok:false——NativeAmbiguousError 一律 possibly_sent 收据、
 *    取消/部分注入一律 interrupted 收据（accepted+action_sent:true）；ok:false 只出现在
 *    「确定未派发」域（参数校验/预检/app_ref 死亡/前台拒绝/队满/stale）；
 * 2. broker_unavailable 仅限 WARMING（wire-server 状态门是唯一产点，本文件结构性不产出）；
 * 3. 只读方法（request_access）不携带 delivery-state 键（缺席即语义）。
 *
 * 收据构造/字面量在 receipts.ts，参数校验在 param-validation.ts，target/app_ref 解析与
 * element 动作面在 target-resolution.ts（A3 拆分，§5.3 先例；三者都是纯 TS + 注入
 * driver——§10.11 模块规则①：不得 import native-driver/uia-driver）。
 */
import {
  NativeAmbiguousError,
  NativeRejectedError,
  type CuaNativeDriver,
  type ElementActionSurface,
  type MouseButtonName,
  type PressKeysEntry,
} from "./driver-contract.js";
import { type FrameRegistry } from "./frame-registry.js";
import { type InputSession } from "./input-session.js";
import { parseKeyChord, PASTE_CHORD_SEQUENCE } from "./keymap.js";
import { createMutatingDispatch } from "./mutating-dispatch.js";
import {
  HOLD_SECONDS_MAX,
  MOUSE_BUTTONS,
  PASTE_TEXT_MAX_CODE_UNITS,
  SCROLL_DIRECTIONS,
  SCROLL_UNITS_PER_PAGE,
  STOP_REASON_MAX_CODE_UNITS,
  TYPE_TEXT_MAX_CODE_UNITS,
  invalidParams,
  parseActionTarget,
  parseAppRefPid,
  parseAppRefShape,
  parseModifiers,
  pickKeys,
  requireFiniteNumber,
  requireOptionalString,
  requireString,
  type ActionTarget,
  type ParsedAppRef,
} from "./param-validation.js";
import {
  RECEIPT_MESSAGES,
  WIRE_BY_NATIVE_CODE,
  acceptedReceipt,
  interruptedReceipt,
  possiblySentReceipt,
  receiptResult,
  targetAppMeta,
  type ToolResultPayload,
} from "./receipts.js";
import { createTargetResolution } from "./target-resolution.js";
import type { AppRefResolver } from "./app-ref.js";
import {
  BROKER_INFO_METHOD,
  WIRE_ERROR_MESSAGES,
  WireRequestFailure,
  type BackendRecord,
} from "./wire-server.js";

// 测试/防漂移面从本模块取字面量表（拆分后单一来源仍是 receipts.ts，此处再导出）。
export { RECEIPT_MESSAGES } from "./receipts.js";

/**
 * request_access 结果 _meta 状态块键（§10.9；接口事实 = 本仓
 * packages/acode-cua/request-access-contract.js:1 的 CUA_REQUEST_ACCESS_STATUS_META_KEY，
 * producer 树内自持——解析隔离 §1.1 禁止按名 import 占位包）。
 */
export const CUA_REQUEST_ACCESS_STATUS_META_KEY = "acode.cua/request-access-status-v1";

// ── backend 构造 ───────────────────────────────────────────────────────────────

export interface BackendA2Deps {
  readonly driver: CuaNativeDriver;
  readonly session: InputSession;
  readonly frames: FrameRegistry;
  /** A3 组合注入：element target 动作面（缺席 = A2-alone，element 诚实拒绝）。 */
  readonly elements?: ElementActionSurface;
  /** A3 组合注入：app_ref 全形态解析器（缺席 = pid-only + A2 专属拒绝字面量）。 */
  readonly resolveAppRef?: AppRefResolver;
  /**
   * request_access 的 accessibility 判据（§10.9：A2 判据 = 可输入；A3 起叠加 UIA 可用）。
   * undefined = A2-alone 面维持原判据（测试兼容）；生产组合注入真实 uia presence。
   */
  readonly uiaPresence?: boolean;
}

export function createBackendA2(deps: BackendA2Deps): BackendRecord {
  const { driver, session } = deps;
  const backend: BackendRecord = {};
  const presence = driver.capabilityPresence;
  const resolution = createTargetResolution({
    driver,
    frames: deps.frames,
    ...(deps.elements ? { elements: deps.elements } : {}),
    ...(deps.resolveAppRef ? { resolveAppRef: deps.resolveAppRef } : {}),
  });

  // app_ref 结构解析（派发前安全区）：组合面走全形态 shape；A2-alone 维持 pid-only
  // （name/bundle 形态 → 专属诚实拒绝字面量，parseAppRefPid 内钉死）。
  const parseRef = (value: unknown): ParsedAppRef =>
    deps.resolveAppRef ? parseAppRefShape(value) : { pid: parseAppRefPid(value) };

  // 变更类派发编排（admission 包装 / 二分收口 / cleanup 释放 / 修饰键包裹——
  // mutating-dispatch.ts，§10.4 规则 4/5 + §10.5 + §10.12 铁律 1 的落点）。
  const { runMutating, releaseQuiet, withModifiers } = createMutatingDispatch({ driver, session });

  // ── left_click（§13 行 4；A3 element 路径 §11.2）────────────────────────────
  if (presence.input) {
    backend.left_click = async (params: unknown): Promise<ToolResultPayload> => {
      const p = pickKeys(params, ["target", "app_ref"], [
        "mouse_button",
        "click_count",
        "modifiers",
        "strategy",
      ]);
      // strategy：Windows 单一 SendInput 派发机制，接受并忽略（§10.2）。
      requireOptionalString(p.strategy);
      const buttonRaw = p.mouse_button === undefined ? "left" : requireString(p.mouse_button);
      if (!MOUSE_BUTTONS.has(buttonRaw)) invalidParams();
      const button = buttonRaw as MouseButtonName;
      const clickCountRaw = p.click_count === undefined ? 1 : requireFiniteNumber(p.click_count);
      if (!Number.isInteger(clickCountRaw) || clickCountRaw < 1 || clickCountRaw > 3) {
        invalidParams();  // click_count ∈ {1,2,3}（§10.2）
      }
      const clickCount = clickCountRaw as number;
      const modifiers = parseModifiers(p.modifiers);
      const ref = parseRef(p.app_ref);
      const target: ActionTarget = parseActionTarget(p.target);

      return runMutating("click", async () => {
        const identity = await resolution.resolveIdentity(ref);
        const pid = identity.pid;
        const meta = targetAppMeta(identity);

        // 物理点击序列（坐标路径与 element point 兜底路径共用；前台校验全程适用）。
        const clickPhysically = async (point: { x: number; y: number }): Promise<ToolResultPayload | undefined> => {
          const outcome = await withModifiers(pid, modifiers, async () => {
            await driver.moveTo(point.x, point.y, { expectedForegroundPid: pid });
            for (let click = 0; click < clickCount; click += 1) {
              await driver.mouseDown(button, { expectedForegroundPid: pid });
              session.noteHeld(`mouse:${button}`);
              try {
                await driver.mouseUp(button, { mode: "action", expectedForegroundPid: pid });
              } finally {
                session.noteReleased(`mouse:${button}`);
              }
            }
          });
          if (outcome?.modifierCleanupAfterBodySuccess) {
            // 主体成功但修饰 up 业务段失败：cleanup 已收口（规则 5），诚实收据（§10.12.1）。
            return interruptedReceipt("internal", RECEIPT_MESSAGES.modifierReleaseCleanup, {}, meta);
          }
          return undefined;
        };

        if (target.kind === "element") {
          // ① 语义等价条件（left ∧ 单击 ∧ 无修饰键）→ InvokePattern 优先（后台安全，
          // 不抢焦点——element 路径不经坐标命中 = §10.7 像素归属残余风险的正面缓解）。
          // ② 其余形态或无 InvokePattern → GetClickablePoint + 物理点击；③ point 为 null
          // 的 action_unavailable 在 resolveActionPoint 内产出（§11.2）。
          const semanticEquivalent =
            button === "left" && clickCount === 1 && (!modifiers || modifiers.length === 0);
          if (semanticEquivalent && (await resolution.invokeElement(pid, target.index))) {
            return acceptedReceipt({ message: RECEIPT_MESSAGES.elementPatternDispatched }, meta);
          }
          const cleanup = await clickPhysically(await resolution.resolveActionPoint(pid, target));
          return cleanup ?? acceptedReceipt({ message: RECEIPT_MESSAGES.elementPointDispatched }, meta);
        }
        const cleanup = await clickPhysically(resolution.physicalPoint(pid, target));
        return cleanup ?? acceptedReceipt({}, meta);
      });
    };

    // ── scroll（§13 行 5；A3 element 路径 §11.2）──────────────────────────────
    backend.scroll = async (params: unknown): Promise<ToolResultPayload> => {
      const p = pickKeys(params, ["target", "app_ref", "scroll_direction", "scroll_amount"], [
        "strategy",
      ]);
      requireOptionalString(p.strategy);
      const direction = requireString(p.scroll_direction);
      if (!SCROLL_DIRECTIONS.has(direction)) invalidParams();
      const amount = requireFiniteNumber(p.scroll_amount);
      if (!(amount > 0)) invalidParams();  // scroll_amount 为正数（页，§10.2）
      const ref = parseRef(p.app_ref);
      const target = parseActionTarget(p.target);
      // 1 页 = 3×WHEEL_DELTA = 360；up/right 为正（Windows 滚轮惯例），水平走 HWHEEL。
      const delta = Math.round(amount * SCROLL_UNITS_PER_PAGE);
      const deltaX = direction === "right" ? delta : direction === "left" ? -delta : 0;
      const deltaY = direction === "up" ? delta : direction === "down" ? -delta : 0;

      return runMutating("scroll", async () => {
        const identity = await resolution.resolveIdentity(ref);
        const pid = identity.pid;
        const meta = targetAppMeta(identity);
        if (target.kind === "element") {
          // ScrollPattern 在 → ScrollByAmount（后台安全）；不在 → clickable point +
          // 物理 scrollAt（前台校验）；皆不可 → action_unavailable（§11.2）。
          const scrolled = await resolution.scrollElement(pid, target.index, deltaX, deltaY);
          if (scrolled) {
            return acceptedReceipt({ message: RECEIPT_MESSAGES.elementPatternDispatched }, meta);
          }
          const point = await resolution.resolveActionPoint(pid, target);
          await driver.scrollAt(point.x, point.y, deltaX, deltaY, { expectedForegroundPid: pid });
          return acceptedReceipt({ message: RECEIPT_MESSAGES.elementPointDispatched }, meta);
        }
        const point = resolution.physicalPoint(pid, target);
        await driver.scrollAt(point.x, point.y, deltaX, deltaY, { expectedForegroundPid: pid });
        return acceptedReceipt({}, meta);
      });
    };

    // ── left_click_drag（§13 行 6；A3 两端 target 独立解析 §11.2）──────────────
    backend.left_click_drag = async (params: unknown): Promise<ToolResultPayload> => {
      const p = pickKeys(params, ["from_target", "to", "app_ref"], ["modifiers"]);
      const modifiers = parseModifiers(p.modifiers);
      const ref = parseRef(p.app_ref);
      const fromTarget = parseActionTarget(p.from_target);
      const toTarget = parseActionTarget(p.to);

      return runMutating("drag", async () => {
        const identity = await resolution.resolveIdentity(ref);
        const pid = identity.pid;
        const meta = targetAppMeta(identity);
        let viaElement = fromTarget.kind === "element" || toTarget.kind === "element";
        let from: { x: number; y: number };
        let to: { x: number; y: number };
        if (fromTarget.kind === "element" && toTarget.kind === "element") {
          // 无 pattern 等价物——两端 GetClickablePoint + native drag（任一端无 →
          // action_unavailable，§11.2）。
          const points = await resolution.dragElementPoints(pid, fromTarget.index, toTarget.index);
          if (points === null) {
            throw new WireRequestFailure(
              WIRE_ERROR_MESSAGES.elementActionNotAdvertised,
              "action_unavailable",
            );
          }
          from = points.from;
          to = points.to;
        } else {
          const fromPoint = await resolution.resolveActionPoint(pid, fromTarget);
          const toPoint = await resolution.resolveActionPoint(pid, toTarget);
          from = fromPoint;
          to = toPoint;
          viaElement = fromPoint.viaElement || toPoint.viaElement;
        }
        let dragResult: { injectedPoints: number; canceled: boolean } | undefined;
        const outcome = await withModifiers(pid, modifiers, async () => {
          dragResult = await driver.drag(from.x, from.y, to.x, to.y, {
            expectedForegroundPid: pid,
            button: "left",
          });
        });
        const injectedPoints = dragResult?.injectedPoints ?? 0;
        if (dragResult?.canceled) {
          // stop 中断（§10.6）：部分副作用已发生 ⇒ action_sent:true ⇒ SDK retry=reobserve。
          return interruptedReceipt("controller_busy", RECEIPT_MESSAGES.interruptedByStop, {
            injected_points: injectedPoints,
          }, meta);
        }
        if (outcome?.modifierCleanupAfterBodySuccess) {
          return receiptResult(
            {
              dispatch_status: "accepted",
              action_sent: true,
              code: "internal",
              message: RECEIPT_MESSAGES.modifierReleaseCleanup,
              injected_points: injectedPoints,
            },
            true,
            meta,
          );
        }
        return acceptedReceipt({
          message: viaElement
            ? RECEIPT_MESSAGES.elementPointDispatched
            : RECEIPT_MESSAGES.dragCompleted,
          injected_points: injectedPoints,
        }, meta);
      });
    };

    // ── type（§13 行 7）───────────────────────────────────────────────────────
    backend.type = async (params: unknown): Promise<ToolResultPayload> => {
      // §13 行 7 封闭集 = {text, app_ref}（无 strategy——params 封闭集以 §13 表为
      // 单一事实源，§10.2）。空 text 拒绝（§10.2：空 no-op 不得产 action_sent:true 假收据）。
      const p = pickKeys(params, ["text", "app_ref"], []);
      const text = requireString(p.text);
      if (text.length === 0 || text.length > TYPE_TEXT_MAX_CODE_UNITS) invalidParams();
      const ref = parseRef(p.app_ref);

      return runMutating("text", async () => {
        const identity = await resolution.resolveIdentity(ref);
        const meta = targetAppMeta(identity);
        // chunk（≤64 code units、代理对不劈裂、chunk 间取消/前台校验）在 native 内执行
        //（§10.9；injected/total/canceled 是 native 的部分事实通道）。
        const outcome = await driver.sendText(text, { expectedForegroundPid: identity.pid });
        if (outcome.canceled) {
          return interruptedReceipt("controller_busy", RECEIPT_MESSAGES.interruptedByStop, {
            injected: outcome.injected,
            total: outcome.total,
          }, meta);
        }
        if (outcome.injected < outcome.total) {
          return interruptedReceipt("internal", RECEIPT_MESSAGES.textPartiallyInjected, {
            injected: outcome.injected,
            total: outcome.total,
          }, meta);
        }
        return acceptedReceipt({ injected: outcome.injected, total: outcome.total }, meta);
      });
    };

    // ── key（§13 行 10）───────────────────────────────────────────────────────
    backend.key = async (params: unknown): Promise<ToolResultPayload> => {
      const p = pickKeys(params, ["text", "app_ref"], ["hold_seconds", "strategy"]);
      requireOptionalString(p.strategy);
      const chord = parseKeyChord(p.text);
      if (chord === undefined) invalidParams();  // 未知键名 → 固定字面量（封闭词汇，§10.9）
      let holdMs = 0;
      if (p.hold_seconds !== undefined) {
        const holdSeconds = requireFiniteNumber(p.hold_seconds);
        if (holdSeconds < 0 || holdSeconds > HOLD_SECONDS_MAX) invalidParams();
        holdMs = Math.round(holdSeconds * 1000);
      }
      const ref = parseRef(p.app_ref);

      return runMutating(holdMs > 0 ? "keys-hold" : "keys", async () => {
        const identity = await resolution.resolveIdentity(ref);
        const meta = targetAppMeta(identity);
        const outcome = await driver.pressKeys(chord as PressKeysEntry[], {
          expectedForegroundPid: identity.pid,
          ...(holdMs > 0 ? { holdMs } : {}),
        });
        if (outcome.canceled) {
          // hold 中断 = interrupted（§13 行 10；C07 的 stop 中断验收面，§15.2 --pointer）。
          return interruptedReceipt("controller_busy", RECEIPT_MESSAGES.interruptedByStop, {}, meta);
        }
        return acceptedReceipt({}, meta);
      });
    };

    // ── stop_computer_control（§13 行 14；旁路不入队——排队即自废，§10.5）──────
    backend.stop_computer_control = async (params: unknown): Promise<ToolResultPayload> => {
      const p = pickKeys(params, [], ["reason"]);
      if (p.reason !== undefined) {
        const reason = requireString(p.reason);
        if (reason.length > STOP_REASON_MAX_CODE_UNITS) invalidParams();
        // reason 接受即丢弃（§10.2）：不回显、不入日志、不进收据——模型自由文本，
        // 任何回显路径都是隐私面。
      }
      try {
        const { released } = await session.stop();
        return acceptedReceipt({
          message: RECEIPT_MESSAGES.stopped,
          released_inputs: released,
        });
      } catch (error) {
        // stop 自身失败（releaseAllHeldInputs 不可证）→ possibly_sent（释放可能部分
        // 完成——保守方向，§10.6 / C08 case 10 同型）。
        if (error instanceof NativeAmbiguousError) {
          return possiblySentReceipt(error.code, error.reason);
        }
        if (error instanceof NativeRejectedError) {
          const mapped = WIRE_BY_NATIVE_CODE[error.code] ?? {
            code: "internal",
            message: WIRE_ERROR_MESSAGES.internal,
          };
          throw new WireRequestFailure(mapped.message, mapped.code);
        }
        throw error;
      }
    };
  }

  // ── paste（§13 行 12；需要 input + clipboard 双面在场）──────────────────────
  if (presence.input && presence.clipboard) {
    backend.paste = async (params: unknown): Promise<ToolResultPayload> => {
      const p = pickKeys(params, ["app_ref", "text"], ["format"]);
      if (p.format !== undefined && p.format !== "text") invalidParams();  // A2 只实现文本
      const text = requireString(p.text);
      if (text.length > PASTE_TEXT_MAX_CODE_UNITS) invalidParams();
      const ref = parseRef(p.app_ref);

      return runMutating("paste", async () => {
        const identity = await resolution.resolveIdentity(ref);
        const meta = targetAppMeta(identity);
        // 序列（§10.9）：preflight → app_ref 解析 → clipboardWriteText → Ctrl+V 注入
        //（同一 admission 项、同一前台校验域）。
        await driver.clipboardWriteText(text);
        // 剪贴板已写入：自此刻起任何失败都不得 ok:false / not_sent——剪贴板副作用
        // 已发生（§10.9 delivery-state 细节；paste 不恢复原剪贴板内容 = 登记的产品副作用）。
        try {
          const outcome = await driver.pressKeys([...PASTE_CHORD_SEQUENCE], {
            expectedForegroundPid: identity.pid,
          });
          if (outcome.canceled) {
            return interruptedReceipt("controller_busy", RECEIPT_MESSAGES.interruptedByStop, {
              clipboard_modified: true,
            }, meta);
          }
          return acceptedReceipt({
            message: RECEIPT_MESSAGES.pasteCompletedClipboardModified,
            clipboard_modified: true,
          }, meta);
        } catch (error) {
          await releaseQuiet();  // 规则 5 收口：收据前 held 恒空
          if (error instanceof NativeAmbiguousError) {
            return possiblySentReceipt(error.code, error.reason, { clipboard_modified: true }, meta);
          }
          if (error instanceof NativeRejectedError) {
            return interruptedReceipt("internal", RECEIPT_MESSAGES.clipboardModifiedPasteIncomplete, {
              clipboard_modified: true,
            }, meta);
          }
          throw error;
        }
      });
    };
  }

  // ── request_access（§13 行 13；只读快照、旁路不入队、结果永不失败[除参数面]）──
  backend.request_access = async (params: unknown): Promise<ToolResultPayload> => {
    const p = pickKeys(params, [], ["capabilities"]);
    if (p.capabilities !== undefined) {
      if (!Array.isArray(p.capabilities)) invalidParams();
      for (const entry of p.capabilities) {
        if (typeof entry !== "string") invalidParams();
      }
      // capabilities 接受；「过滤报告」在 A2 为 no-op——四键结果形态是 SDK/宿主投影的
      // 钉死消费面（§10.9 A2 实现批次钉死）；未知 capability 名忽略。
    }
    // 只读预检快照（§10.9）：Windows 无 TCC，快照 = preflight + 能力在场性。
    const env = await driver.environmentProbe();
    const preflightOk = env.interactiveDesktop && !env.sessionZero && env.dpiAware;
    // accessibility 判据：A2 = 可输入；A3 起叠加 UIA 可用（§10.9）。uiaPresence 未注入
    // = A2-alone 面维持原判据（组合面由 entry 注入真实 presence）。
    const uiaOk = deps.uiaPresence ?? true;
    const accessibility = preflightOk && uiaOk ? "granted" : "denied";  // "stale" Windows 永不产出（§12.2）
    const screenRecording = !preflightOk
      ? "denied"
      : presence.capture
        ? "granted"
        : "unknown";  // unknown = capture 面未实现（A2 前过渡态）
    const status = {
      ready: env.interactiveDesktop && presence.input,
      platform: "win32" as const,
      accessibility,
      screen_recording: screenRecording,
    };
    // _meta 状态块（§10.9/§12.2 形态）：grantOwner = Helper canonical exe 绝对路径；
    // 宿主 display 投影的 win32 受理面属阶段 4（§12.2），producer 侧按契约产出。
    const metaStatus = {
      schemaVersion: 1,
      platform: "win32",
      grantOwner: process.execPath,
      accessibility,
      screenRecording,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(status) }],
      structuredContent: status,
      _meta: { [CUA_REQUEST_ACCESS_STATUS_META_KEY]: metaStatus },
    };
  };

  // ── broker_info（A2 增量 additive，§10.9；capabilities.uia 由 backend-a3 装饰）─
  backend[BROKER_INFO_METHOD] = async (): Promise<Record<string, unknown>> => {
    // capabilities = 导出在场性（typeof 检查，构造期完成）∧ environmentProbe 预检，
    // 每请求现算不缓存（能力真实性：声明与 dispatch 行为同源；漂移即被 §10.11 一致性
    // 测试抓住）。非交互桌面 → capabilities 全 false（诚实降级），pid/bundle_id 照常
    // —— health 门只校 pid（wire spec §6.2），零影响。
    let preflightOk = false;
    try {
      const env = await driver.environmentProbe();
      preflightOk = env.interactiveDesktop && !env.sessionZero && env.dpiAware;
    } catch {
      preflightOk = false;  // 探针失败 → 能力诚实报 false（绝不虚报）
    }
    return {
      pid: process.pid,
      bundle_id: process.execPath,
      capabilities: {
        input: presence.input && preflightOk,
        capture: presence.capture && preflightOk,
        clipboard: presence.clipboard && preflightOk,
      },
    };
  };

  return backend;
}
