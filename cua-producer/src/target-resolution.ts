/**
 * target/app_ref 解析与元素动作面（specs/windows-helper-producer.md §10.9/§11.2/§11.3）。
 * A3 实现批次自 backend-a2.ts 拆出（§5.3「文件划分可微调」先例；oxlint max-lines 400
 * 硬约束 + 解析面独立单测）：
 * - 统一 preflight 门（§10.9：输入/捕获/paste/UIA 读全部走同一门；environmentProbe
 *   不缓存——锁屏/解锁是动态事实）；
 * - app_ref 身份解析：A2-alone 面 = pid-only 存活校验（name/bundle 形态在 parse 层已用
 *   专属字面量拒绝）；A3 组合面 = 注入 resolveAppRef 全形态（§11.3 唯一候选纪律在
 *   app-ref.ts）；
 * - 坐标 target → 物理像素（frame 校验 + producer 自持线性投影，§10.9）；
 * - element target 动作面（§11.2「AX element → visual fallback → verify」）：InvokePattern
 *   优先 / clickable point 兜底 / 皆不可 → action_unavailable；无 UIA 面（A2-alone 组合）
 *   → 诚实拒绝字面量（C09 同律）。
 *
 * 纯 TS + 注入 driver（§10.11 模块规则①：不得 import native-driver/uia-driver）。
 */
import type { CuaNativeDriver, ElementActionSurface } from "./driver-contract.js";
import { appOwnerScope, type FrameRegistry, type FrameRecord } from "./frame-registry.js";
import type { ParsedAppRef } from "./param-validation.js";
import type { ActionTarget, CoordinateTarget } from "./param-validation.js";
import { WIRE_ERROR_MESSAGES, WireRequestFailure } from "./wire-server.js";
import type { AppIdentity, AppRefResolver } from "./app-ref.js";

export interface TargetResolutionDeps {
  readonly driver: CuaNativeDriver;
  readonly frames: FrameRegistry;
  /** UIA element 动作面（A3 组合注入；缺席 = A2-alone，element target 诚实拒绝）。 */
  readonly elements?: ElementActionSurface;
  /** app_ref 全形态解析器（A3 组合注入；缺席 = pid-only）。 */
  readonly resolveAppRef?: AppRefResolver;
}

export interface TargetResolution {
  /** 统一 preflight 门（§10.9）：非交互桌面/Session 0/DPI 未达标 → permission_denied。 */
  preflight(): Promise<void>;
  /** preflight + app_ref 解析 → canonical 身份（展示字段只服务 _meta/树头部，§11.3）。 */
  resolveIdentity(ref: ParsedAppRef): Promise<AppIdentity>;
  /** 坐标 target → 物理像素（frame 校验 + 线性投影；不可解析 → element_unavailable）。 */
  physicalPoint(pid: number, target: CoordinateTarget): { x: number; y: number };
  /** 动作 target 统一解析：coordinate → 投影；element → clickable point（viaElement 事实）。 */
  resolveActionPoint(
    pid: number,
    target: ActionTarget,
  ): Promise<{ x: number; y: number; viaElement: boolean }>;
  /** left_click(element) ①：InvokePattern 优先（后台安全，不抢焦点）；无 UIA 面 → 诚实拒绝。 */
  invokeElement(pid: number, index: number): Promise<boolean>;
  /** scroll(element)：ScrollPattern 在 → true；不在 → false（调用方走 point 兜底）。 */
  scrollElement(
    pid: number,
    index: number,
    deltaX: number,
    deltaY: number,
  ): Promise<boolean>;
  /** left_click_drag(element)：两端 clickable point；任一端无 → null（→ action_unavailable）。 */
  dragElementPoints(
    pid: number,
    fromIndex: number,
    toIndex: number,
  ): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>;
}

export function createTargetResolution(deps: TargetResolutionDeps): TargetResolution {
  const { driver, frames } = deps;

  const preflight = async (): Promise<void> => {
    const env = await driver.environmentProbe();
    if (!env.interactiveDesktop || env.sessionZero || !env.dpiAware) {
      throw new WireRequestFailure(
        WIRE_ERROR_MESSAGES.nonInteractiveDesktop,
        "permission_denied",
      );
    }
  };

  const resolveIdentity = async (ref: ParsedAppRef): Promise<AppIdentity> => {
    await preflight();
    if (deps.resolveAppRef) return deps.resolveAppRef(ref);
    // A2-alone 面（无 UIA driver 组合）：pid-only 存活 + canonical exe 可读（§10.9）。
    const pid = ref.pid as number;
    const exe = await driver.processExecutablePath(pid);
    if (exe.path === null) {
      throw new WireRequestFailure(WIRE_ERROR_MESSAGES.appNotRunning, "invalid_request");
    }
    return { pid, exePath: exe.path, aumid: null, displayName: null };
  };

  const requireElements = (): ElementActionSurface => {
    if (!deps.elements) {
      // UIA 面未组合（能力诚实，C09 同律）：element target → 固定字面量拒绝。
      throw new WireRequestFailure(
        WIRE_ERROR_MESSAGES.elementTargetsRequireUia,
        "element_unavailable",
      );
    }
    return deps.elements;
  };

  const physicalPoint = (pid: number, target: CoordinateTarget): { x: number; y: number } => {
    let frame: FrameRecord;
    if (target.frameId !== undefined) {
      const lookup = frames.resolve(target.frameId);
      if (!lookup.ok || !lookup.frame) {
        throw new WireRequestFailure(
          WIRE_ERROR_MESSAGES.staleObservation,
          "element_unavailable",
        );
      }
      frame = lookup.frame;
    } else {
      // 隐式绑定该 app scope 最近一次可动作 frame；无任何 frame → 固定字面量拒绝
      //（坐标必须以 producer 发射过的栅格为准——模型未见过的坐标就是猜测，猜测即
      // fail-closed，§10.9）。
      const latest = frames.latestForScope(appOwnerScope(pid));
      if (!latest) {
        throw new WireRequestFailure(
          WIRE_ERROR_MESSAGES.staleObservation,
          "element_unavailable",
        );
      }
      frame = latest;
    }
    if (frame.ownerScope !== appOwnerScope(pid)) {
      // frame owner 不符 → fail-closed（对齐上游 frame_dispatch_identity_mismatch 机制）。
      throw new WireRequestFailure(WIRE_ERROR_MESSAGES.staleObservation, "element_unavailable");
    }
    return frames.projectCoordinates(frame, target.x, target.y);
  };

  return {
    preflight,
    resolveIdentity,
    physicalPoint,

    async resolveActionPoint(
      pid: number,
      target: ActionTarget,
    ): Promise<{ x: number; y: number; viaElement: boolean }> {
      if (target.kind === "coordinate") {
        return { ...physicalPoint(pid, target), viaElement: false };
      }
      const elements = requireElements();
      const point = await elements.elementPoint(pid, target.index);
      if (point === null) {
        // 元素无法表达该动作（无 clickable point 且无 pattern 路径，§11.2 ③）。
        throw new WireRequestFailure(
          WIRE_ERROR_MESSAGES.elementActionNotAdvertised,
          "action_unavailable",
        );
      }
      return { ...point, viaElement: true };
    },

    async invokeElement(pid: number, index: number): Promise<boolean> {
      const elements = requireElements();
      const outcome = await elements.invokeElement(pid, index);
      return outcome.invoked;
    },

    async scrollElement(
      pid: number,
      index: number,
      deltaX: number,
      deltaY: number,
    ): Promise<boolean> {
      const elements = requireElements();
      const outcome = await elements.scrollElement(pid, index, deltaX, deltaY);
      return outcome.scrolled;
    },

    async dragElementPoints(
      pid: number,
      fromIndex: number,
      toIndex: number,
    ): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } } | null> {
      const elements = requireElements();
      return elements.dragElementPoints(pid, fromIndex, toIndex);
    },
  };
}
