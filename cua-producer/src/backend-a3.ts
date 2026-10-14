/**
 * A3 wire handlers（specs/windows-helper-producer.md §11）：6 个 UIA 工具
 * （list_apps/list_windows/get_app_state/set_value/select_text/perform_action）+
 * broker_info 的 capabilities.uia 装饰（§10.9「uia 键 A3 加入」）。14/14 handler 齐套后，
 * A1 的 unimplemented 面收口为零（§16 A3-AC-10）。
 *
 * 纪律（与 backend-a2 同律）：
 * - delivery-state 铁律（§10.12）：3 个变更类（set_value/select_text/perform_action）
 *   派发后禁 ok:false；4 个只读（list_apps/list_windows/get_app_state + broker_info）
 *   绝不携带 delivery-state 键（缺席即语义）；
 * - C09 红线（§11.2）：native 失败/超时/挂死一律 error 面，结构上不存在「失败读成空树」
 *   的路径——elements:[] 只在遍历真实成功且 0 个可及元素时出现；
 * - UIA 树内容 = 不可信输入（§11.1）：不当指令执行、不整树进日志、错误面零插值由
 *   §4.6.1 封闭字面量结构性保证；
 * - 观察类入 admission 串行（§10.5：所有派发 native 的操作串行，含 A3 观察类）。
 *
 * 纯 TS + 注入 driver（§10.11 模块规则①：不得 import native-driver/uia-driver）。
 */
import {
  NativeAmbiguousError,
  NativeRejectedError,
  TREE_MAX_ELEMENTS,
  TREE_MAX_TEXT_BYTES,
  type CaptureBudget,
  type CuaNativeDriver,
  type CuaUiaDriver,
  type ElementActionSurface,
  type UiaActionName,
} from "./driver-contract.js";
import { CAPTURE_INLINE_BASE64_BUDGET_BYTES, CAPTURE_MAX_DIMENSION } from "./driver-contract.js";
import { appOwnerScope, type FrameRegistry } from "./frame-registry.js";
import { type InputSession } from "./input-session.js";
import { createMutatingDispatch } from "./mutating-dispatch.js";
import {
  SET_VALUE_MAX_CODE_UNITS,
  invalidParams,
  parseActionName,
  parseAppRefShape,
  parseElementTarget,
  parseGetAppStateParams,
  parseTextRange,
  pickKeys,
  requireString,
  type ParsedAppRef,
} from "./param-validation.js";
import {
  RECEIPT_MESSAGES,
  WIRE_BY_NATIVE_CODE,
  acceptedReceipt,
  interruptedReceipt,
  targetAppMeta,
  type ToolResultPayload,
} from "./receipts.js";
import { type StateRegistry } from "./state-registry.js";
import { createTargetResolution } from "./target-resolution.js";
import { exeBasename, renderTreeText, singleLine, truncateCodeUnits, TREE_VALUE_MAX_CODE_UNITS, TREE_TITLE_MAX_CODE_UNITS } from "./tree-text.js";
import { type AppIdentity, type AppRefResolver } from "./app-ref.js";
import {
  BROKER_INFO_METHOD,
  WIRE_ERROR_MESSAGES,
  WireRequestFailure,
  type BackendRecord,
} from "./wire-server.js";

export interface BackendA3Deps {
  readonly driver: CuaNativeDriver;
  readonly uia: CuaUiaDriver;
  readonly session: InputSession;
  readonly frames: FrameRegistry;
  readonly states: StateRegistry;
  readonly resolveAppRef: AppRefResolver;
  /** backend-a2 的 broker_info（装饰基础；缺席时用最小诚实面兜底——结构性不可达）。 */
  readonly a2BrokerInfo?: (params: unknown) => unknown | Promise<unknown>;
}

/** §11.2 树文本值截断（wire structuredContent.elements 与文本行同值口径）。 */
function wireValue(value: string | null): string | null {
  if (value === null) return null;
  return truncateCodeUnits(singleLine(value), TREE_VALUE_MAX_CODE_UNITS);
}

export function createBackendA3(deps: BackendA3Deps): BackendRecord {
  const { driver, uia, session, frames, states, resolveAppRef } = deps;
  const backend: BackendRecord = {};

  // ── broker_info 装饰（§10.9：capabilities 增 uia 键）——**无论 presence 恒注册**：
  // presence=false 时 uia:false，与「6 UIA 方法 unimplemented」两面同源（§13 不变量②的
  // 全量 ⟺ 收口；键缺席会让消费方无法区分「false」与「未装配」）。
  backend[BROKER_INFO_METHOD] = async (): Promise<Record<string, unknown>> => {
    const base = (deps.a2BrokerInfo
      ? ((await deps.a2BrokerInfo({})) as Record<string, unknown>)
      : { pid: process.pid, bundle_id: process.execPath, capabilities: {} }) as {
      capabilities?: Record<string, unknown>;
    } & Record<string, unknown>;
    let uiaAvailable = false;
    if (uia.presence) {
      try {
        const env = await driver.environmentProbe();
        uiaAvailable = env.interactiveDesktop && !env.sessionZero && env.dpiAware;
      } catch {
        uiaAvailable = false; // 探针失败 → 能力诚实报 false（绝不虚报）
      }
    }
    return {
      ...base,
      capabilities: { ...base.capabilities, uia: uiaAvailable },
    };
  };

  if (!uia.presence) {
    // UIA 导出缺席 = 能力诚实降级：6 工具不注册 → dispatch 层 unimplemented（§10.9
    // 两面同源；capabilities.uia=false 由上方装饰同源产出）。
    return backend;
  }

  const { admit, runMutating } = createMutatingDispatch({ driver, session });

  // 统一 preflight 门 + app_ref 解析与 backend-a2 共用同一实现（target-resolution.ts，
  // 单一写路径；§10.9「A3 的 UIA 读走同一门」）。
  const resolution = createTargetResolution({ driver, frames, resolveAppRef });
  const preflight = resolution.preflight;

  /**
   * 观察类收口：admission 串行（§10.5）+ Rejected → 封闭字面量 ok:false；只读分类不产
   * Ambiguous（classifyNativeError 只读分支恒 Rejected）——Ambiguous 到此为结构性违约，
   * 防御性映射 internal（绝不自造 delivery-state 键，铁律 3）。
   */
  const runObserving = async <T>(kind: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await admit(kind, fn);
    } catch (error) {
      if (error instanceof WireRequestFailure) throw error;
      if (error instanceof NativeRejectedError) {
        const mapped = WIRE_BY_NATIVE_CODE[error.code] ?? {
          code: "internal",
          message: WIRE_ERROR_MESSAGES.internal,
        };
        throw new WireRequestFailure(mapped.message, mapped.code);
      }
      if (error instanceof NativeAmbiguousError) {
        throw new WireRequestFailure(WIRE_ERROR_MESSAGES.internal, "internal");
      }
      throw error;
    }
  };

  /** element target 的索引解析（§11.4：按该 app scope 最新一次观察；不可解析 → stale）。 */
  const resolveStateToken = (pid: number, index: number): number => {
    const latest = states.latestForPid(pid);
    if (!latest || index >= latest.elementCount) {
      // 旧观察已被覆盖 / 索引不在最新观察中——同一 stale 码（跨观察索引兼容被结构性排除）。
      throw new NativeRejectedError("stale");
    }
    return latest.nativeStateToken;
  };

  // ── list_apps（§13 行 1；params 封闭集 = {}）─────────────────────────────────
  backend.list_apps = async (params: unknown): Promise<ToolResultPayload> => {
    pickKeys(params, [], []);
    const apps = await runObserving("observe-apps", async () => {
      await preflight();
      return uia.listApplications();
    });
    const wire = {
      apps: [...apps]
        .sort((a, b) => a.pid - b.pid) // pid 升序（确定性，§11.2）
        .map((app) => ({
          pid: app.pid,
          name: app.displayName ?? exeBasename(app.exePath),
          bundle_id: app.aumid,
          exe_path: app.exePath,
          active: app.active,
          window_count: app.windowCount,
        })),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(wire) }],
      structuredContent: wire as unknown as Record<string, unknown>,
    };
  };

  // ── list_windows（§13 行 2；{app_ref?}）──────────────────────────────────────
  backend.list_windows = async (params: unknown): Promise<ToolResultPayload> => {
    const p = pickKeys(params, [], ["app_ref"]);
    let appRef: ParsedAppRef | undefined;
    if (p.app_ref !== undefined) appRef = parseAppRefShape(p.app_ref);
    const outcome = await runObserving("observe-windows", async () => {
      await preflight();
      const identity: AppIdentity | undefined = appRef ? await resolveAppRef(appRef) : undefined;
      const windows = await uia.listWindows(identity ? identity.pid : null);
      return { identity, windows };
    });
    const wire = {
      windows: outcome.windows.map((entry) => ({
        window_id: entry.windowId,
        title: truncateCodeUnits(singleLine(entry.title), TREE_TITLE_MAX_CODE_UNITS),
        app: {
          pid: entry.pid,
          name: exeBasename(entry.exePath),
          exe_path: entry.exePath,
        },
        bounds: entry.bounds,
        minimized: entry.minimized,
      })),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(wire) }],
      structuredContent: wire as unknown as Record<string, unknown>,
    };
  };

  // ── get_app_state（§13 行 3；树 + 可选截图 + _meta）──────────────────────────
  backend.get_app_state = async (params: unknown): Promise<ToolResultPayload> => {
    const parsed = parseGetAppStateParams(params);
    const observed = await runObserving("observe-tree", async () => {
      const identity = await resolution.resolveIdentity(parsed.appRef);
      const tree = await uia.captureUiTree(
        {
          pid: identity.pid,
          ...(parsed.appRef.windowId !== undefined ? { windowId: parsed.appRef.windowId } : {}),
        },
        { maxElements: TREE_MAX_ELEMENTS, maxTextBytes: TREE_MAX_TEXT_BYTES },
      );
      return { identity, tree };
    });
    const { identity, tree } = observed;
    if (tree.window === null) {
      // 进程存活但无可观察窗口（§11.2 专属字面量——「not running」不适用，两种失败对
      // 模型的指引不同，字面量分开；确定未派发域，ok:false 安全）。
      throw new WireRequestFailure(
        WIRE_ERROR_MESSAGES.noObservableWindow,
        "element_unavailable",
      );
    }
    const state = states.register({
      pid: identity.pid,
      nativeStateToken: tree.stateToken,
      windowId: tree.window.windowId,
      elementCount: tree.elements.length,
      treeShownToModel: parsed.treeShownToModel,
    });
    const treeText = renderTreeText({
      header: {
        aumid: identity.aumid,
        exePath: identity.exePath,
        pid: identity.pid,
        displayName: identity.displayName,
        windowId: tree.window.windowId,
        windowTitle: tree.window.title,
      },
      elements: tree.elements,
      truncated: tree.truncated,
      totalElements: tree.totalElements,
    });

    const content: ToolResultPayload["content"] = [{ type: "text", text: treeText }];
    const structured: Record<string, unknown> = {
      state_id: state.stateId,
      app: {
        pid: identity.pid,
        name: identity.displayName ?? exeBasename(identity.exePath),
        bundle_id: identity.aumid,
        exe_path: identity.exePath,
      },
      window: {
        window_id: tree.window.windowId,
        title: truncateCodeUnits(singleLine(tree.window.title), TREE_TITLE_MAX_CODE_UNITS),
        bounds: tree.window.bounds,
      },
      elements: tree.elements.map((element) => ({
        index: element.index,
        role: element.role,
        name: truncateCodeUnits(singleLine(element.name), TREE_VALUE_MAX_CODE_UNITS),
        ...(element.value !== null ? { value: wireValue(element.value) } : {}),
        ...(element.bounds !== null ? { bounds: element.bounds } : {}),
        patterns: element.patterns,
      })),
      text: treeText,
      snapshot_mode: "full",
      truncated: tree.truncated,
    };

    if (parsed.includeScreenshot) {
      // 截图走 §10.7 捕获（窗口捕获 + 前后双复核）；**捕获失败不拖垮树**（§11.2）：
      // 树照常返回 + 告知性文本块 [screenshot unavailable: <固定原因码>] +
      // structuredContent.non_actionable_reason（原因码 = §10.3 封闭 native 词汇）。
      const budget: CaptureBudget = {
        maxDimension: CAPTURE_MAX_DIMENSION,
        inlineBase64BudgetBytes: CAPTURE_INLINE_BASE64_BUDGET_BYTES,
      };
      let reasonCode: string | null = null;
      try {
        const capture = await admit("capture-window", () =>
          driver.captureWindow(tree.window?.windowId as number, budget),
        );
        const frame = frames.register({
          rasterWidth: capture.width,
          rasterHeight: capture.height,
          bounds: capture.bounds,
          ownerScope: appOwnerScope(identity.pid),
          ...(capture.topologyFingerprint !== undefined
            ? { topologyFingerprint: capture.topologyFingerprint }
            : {}),
        });
        const base64 = Buffer.from(
          capture.image.buffer,
          capture.image.byteOffset,
          capture.image.byteLength,
        ).toString("base64");
        // image 块（§11.2：{type:"image", data:<base64>, mimeType}）——CallToolResult
        // content 块词汇的一员；图像字节只进 wire 结果（产品面），绝不进日志（§15.3 同律）。
        content.push({
          type: "image",
          data: base64,
          mimeType: capture.encoding === "jpeg" ? "image/jpeg" : "image/png",
        });
        // frame_id 在发射图像时恒登记并回报（SDK frameIdOf 挖掘点，§11.2）。
        structured.frame_id = frame.frameId;
      } catch (error) {
        if (error instanceof NativeRejectedError) {
          reasonCode = error.code;
        } else if (error instanceof NativeAmbiguousError) {
          reasonCode = error.code;
        } else if (error instanceof WireRequestFailure) {
          throw error; // admission busy 等确定未派发失败：整体失败比假降级更诚实
        } else {
          reasonCode = "internal_native";
        }
      }
      if (reasonCode !== null) {
        content.push({
          type: "text",
          text: `[screenshot unavailable: ${reasonCode}]`,
        });
        structured.non_actionable_reason = reasonCode;
      }
    }

    return {
      content: content as ToolResultPayload["content"],
      structuredContent: structured,
      _meta: targetAppMeta(identity),
    };
  };

  // ── set_value（§13 行 8；element target 必备，坐标 → invalid_request）────────
  backend.set_value = async (params: unknown): Promise<ToolResultPayload> => {
    const p = pickKeys(params, ["target", "app_ref", "value"], []);
    const index = parseElementTarget(p.target);
    const value = requireString(p.value);
    if (value.length > SET_VALUE_MAX_CODE_UNITS) invalidParams();
    const appRef = parseAppRefShape(p.app_ref);

    return runMutating("set-value", async () => {
      const identity = await resolution.resolveIdentity(appRef);
      const meta = targetAppMeta(identity);
      const stateToken = resolveStateToken(identity.pid, index);
      const outcome = await uia.elementSetValue(stateToken, index, value);
      if (!outcome.verified) {
        // 写已发生但读回验证不符（§11.2）：诚实上报 isError 收据（code internal +
        // action_sent:true）——绝不谎称成功，也绝不 ok:false（副作用已发生，铁律 1）。
        return interruptedReceipt("internal", RECEIPT_MESSAGES.setValueReadbackMismatch, {}, meta);
      }
      return acceptedReceipt({}, meta);
    });
  };

  // ── select_text（§13 行 9；text_range = [start, length] 整数二元组）──────────
  backend.select_text = async (params: unknown): Promise<ToolResultPayload> => {
    const p = pickKeys(params, ["target", "app_ref", "text_range"], []);
    const index = parseElementTarget(p.target);
    const range = parseTextRange(p.text_range);
    const appRef = parseAppRefShape(p.app_ref);

    return runMutating("select-text", async () => {
      const identity = await resolution.resolveIdentity(appRef);
      const meta = targetAppMeta(identity);
      const stateToken = resolveStateToken(identity.pid, index);
      const outcome = await uia.elementSelectText(stateToken, index, range.start, range.length);
      if (outcome.outcome === "range-invalid") {
        // start 越出元素 value 长度 = 确定性参数错、未派发（§11.2）→ ok:false 安全区。
        invalidParams();
      }
      return acceptedReceipt({}, meta);
    });
  };

  // ── perform_action（§13 行 11；action 封闭词汇 §11.2）────────────────────────
  backend.perform_action = async (params: unknown): Promise<ToolResultPayload> => {
    const p = pickKeys(params, ["target", "app_ref", "action"], []);
    const index = parseElementTarget(p.target);
    const action = parseActionName(p.action) as UiaActionName;
    const appRef = parseAppRefShape(p.app_ref);

    return runMutating("perform-action", async () => {
      const identity = await resolution.resolveIdentity(appRef);
      const meta = targetAppMeta(identity);
      const stateToken = resolveStateToken(identity.pid, index);
      await uia.elementPerformAction(stateToken, index, action);
      return acceptedReceipt({}, meta);
    });
  };

  return backend;
}

/**
 * 指针三工具的 element-target 动作面（§11.2「AX element → visual fallback → verify」的
 * producer 落地）：backend-a2 经 ElementActionSurface 消费（模块规则①：backend-a2 不
 * import 本模块的实现依赖，接口在 driver-contract）。索引解析与 stale fail-closed 在此
 * 收口；pattern/clickable-point 的活性复验在 native 同一 worker 任务内（§11.2）。
 */
export function createElementActionSurface(deps: {
  uia: CuaUiaDriver;
  states: StateRegistry;
}): ElementActionSurface {
  const { uia, states } = deps;
  const tokenFor = (pid: number, index: number): number => {
    const latest = states.latestForPid(pid);
    if (!latest || index >= latest.elementCount) {
      throw new NativeRejectedError("stale");
    }
    return latest.nativeStateToken;
  };
  return {
    invokeElement(pid: number, index: number): Promise<{ invoked: boolean }> {
      return uia.elementInvoke(tokenFor(pid, index), index);
    },
    elementPoint(pid: number, index: number): Promise<{ x: number; y: number } | null> {
      return uia.elementClickablePoint(tokenFor(pid, index), index);
    },
    scrollElement(
      pid: number,
      index: number,
      deltaX: number,
      deltaY: number,
    ): Promise<{ scrolled: boolean }> {
      return uia.elementScroll(tokenFor(pid, index), index, deltaX, deltaY);
    },
    async dragElementPoints(
      pid: number,
      fromIndex: number,
      toIndex: number,
    ): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } } | null> {
      const token = tokenFor(pid, Math.max(fromIndex, toIndex));
      const from = await uia.elementClickablePoint(token, fromIndex);
      if (from === null) return null;
      const to = await uia.elementClickablePoint(token, toIndex);
      if (to === null) return null;
      return { from, to };
    },
  };
}
