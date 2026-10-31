// Browser 命令联合、执行结果与端口契约 —— BrowserCommand、结果形态与 BrowserControlPort。
// 例外偿还（contracts-onboarding-max-file-lines-browser-control-port）：自
// interfaces/browser-control.port.ts 拆出。原文件降为 barrel 并对本叶 `export *`，
// 公开导出面逐名不变。
// 依赖单向：本叶 → browser-backend.js / browser-command.js；本叶是依赖图末端，无叶子回边。
/**
 * BrowserControlPort —— agent 侧浏览器控制端口（命令联合与执行结果段）。
 * BrowserCommand 与 @acode/shared 的 browserCommandSchema 各变体结构镜像同步。
 */

import type { TraceContext } from "../tracing/tracer.js";
import type { BrowserBackendDescriptor, BrowserBackendType, BrowserViewportSize } from "./browser-backend.js";
import type {
  BrowserKeyModifier,
  BrowserMouseButton,
  BrowserPlaywrightAction,
  BrowserPoint,
  BrowserRecordingOptions,
} from "./browser-command.js";

// tabId（可选）：agent 对象模型用于寻址指定受控 tab（含 human 开的 tab）；缺省作用于会话默认 view。
// 与 @acode/shared 的 browserCommandSchema 各变体结构镜像同步。
export type BrowserCommand =
  | { method: "navigate"; url: string; tabId?: string }
  | { method: "back"; tabId?: string }
  | { method: "forward"; tabId?: string }
  | { method: "reload"; tabId?: string }
  | { method: "snapshot"; maxElements?: number; includeHidden?: boolean; tabId?: string }
  | {
      method: "click";
      ref?: string;
      x?: number;
      y?: number;
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "fill"; ref: string; value: string; tabId?: string }
  | { method: "type"; ref?: string; text: string; tabId?: string }
  | { method: "press"; key: string; ref?: string; modifiers?: BrowserKeyModifier[]; tabId?: string }
  | { method: "cuaKeypress"; keys: string[]; tabId?: string }
  | { method: "scroll"; ref?: string; x?: number; y?: number; tabId?: string }
  | {
      method: "cuaScroll";
      x: number;
      y: number;
      scrollX: number;
      scrollY: number;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "domCuaScroll"; nodeId?: string; scrollX: number; scrollY: number; tabId?: string }
  | {
      method: "hover";
      ref?: string;
      x?: number;
      y?: number;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "select"; ref: string; values: string[]; tabId?: string }
  | { method: "check"; ref: string; checked?: boolean; tabId?: string }
  | {
      method: "drag";
      fromRef?: string;
      toRef?: string;
      from?: BrowserPoint;
      to?: BrowserPoint;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | {
      method: "cuaDrag";
      path: BrowserPoint[];
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | {
      method: "screenshot";
      ref?: string;
      fullPage?: boolean;
      clip?: { x: number; y: number; width: number; height: number };
      tabId?: string;
    }
  | { method: "getState"; tabId?: string }
  | { method: "elementInfo"; x: number; y: number; tabId?: string }
  | { method: "evaluate"; expression: string; tabId?: string }
  | { method: "getDialog"; tabId?: string }
  | { method: "handleDialog"; accept: boolean; promptText?: string; tabId?: string }
  | {
      method: "waitFor";
      selector?: string;
      text?: string;
      textGone?: string;
      timeoutMs?: number;
      tabId?: string;
    }
  | { method: "playwrightWaitForTimeout"; timeoutMs: number; tabId?: string }
  | { method: "playwright"; action: BrowserPlaywrightAction; tabId?: string }
  | { method: "capabilities"; tabId?: string }
  | { method: "browserVisibilityGet" }
  | { method: "browserVisibilitySet"; visible: boolean }
  | { method: "browserViewportSet"; width: number; height: number; tabId?: string }
  | { method: "browserViewportReset"; tabId?: string }
  | { method: "recordingStart"; options?: BrowserRecordingOptions; tabId?: string }
  | {
      method: "recordingStatus";
      recordingId: string;
      outputPath?: string;
      tabId?: string;
    }
  | { method: "recordingCancel"; recordingId: string; tabId?: string }
  | { method: "activateTab"; tabId: string }
  | { method: "newTab" }
  | { method: "listUserTabs" }
  | { method: "claimTab"; tabId: string }
  | {
      method: "finalizeTabs";
      keep: Array<{ tabId: string; status: "handoff" | "deliverable" }>;
    }
  | { method: "markDeliverable"; tabId: string }
  | { method: "markHandoff"; tabId: string }
  | { method: "nameSession"; name: string }
  | { method: "finalize"; tabId?: string; deliverable?: boolean }
  | { method: "turnEnded"; turnId?: string }
  | { method: "closeSession" }
  | { method: "cancelRequest"; requestId: string }
  // close：关闭指定受控 tab；manager 层处理。
  | { method: "close"; tabId?: string }
  // list：枚举当前会话窗口下所有受控 tab 摘要，manager 层拦截处理，返回 tabs。
  | { method: "list" };

export type BrowserErrorCode =
  | "backend_unavailable"
  | "capability_unsupported"
  | "duplicate_request_id"
  | "ref_not_found"
  | "navigation_blocked"
  | "timeout"
  | "renderer_unreachable"
  | "cancelled"
  | "execution_error";

export interface BrowserPageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  scrollX?: number;
  scrollY?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  selector: string;
  xpath: string;
  rect: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
  parentRef?: string;
  framePath?: string;
  attributes?: Record<string, string>;
}

export interface BrowserSnapshotDomNode {
  tag: string;
  depth: number;
  inViewport: boolean;
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  attributes?: Record<string, string>;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  elements: BrowserSnapshotElement[];
  truncated: boolean;
  dom?: BrowserSnapshotDomNode[];
  domTruncated?: boolean;
}

/** 受控 tab 摘要（list 命令返回）；与 @acode/shared 的 browserTabSummarySchema 镜像同步。 */
export interface BrowserTabSummary {
  tabId: string;
  url: string;
  title: string;
  /** guest 当前真实 CSS viewport；normal/free-size 均必须返回。 */
  viewport: BrowserViewportSize;
  /** 当前可见/激活的内置浏览器 tab；agent 用它优先读取用户正在看的页面。 */
  active?: boolean;
  lifecycle?: "active" | "deliverable" | "handoff";
}

export interface BrowserUserTabInfo {
  id: string;
  lastOpened?: string;
  tabGroup?: string;
  title?: string;
  url?: string;
}

export interface BrowserResponseMeta {
  browserUse: true;
  backendType: BrowserBackendType;
  browserId: string;
  browserGeneration: number;
  openTabIds: string[];
  tabId?: string;
  currentUrl?: string;
  lifecycle?: "active" | "deliverable" | "handoff" | "closed";
}

/** JS 弹窗信息（getDialog 返回）。 */
export interface BrowserDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
}

export interface BrowserRecordingArtifact {
  path: string;
  mimeType: "video/webm";
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameCount: number;
}

export interface BrowserRecordingJob {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: "preparing" | "capturing" | "finalizing" | "completed" | "failed" | "cancelled";
  progress: number;
  startedAt: number;
  updatedAt: number;
  artifact?: BrowserRecordingArtifact;
  error?: string;
}

export interface BrowserCommandResult {
  ok: boolean;
  state?: BrowserPageState;
  snapshot?: BrowserSnapshot;
  image?: { base64: string; mimeType: "image/png" };
  /** list 命令返回：当前会话窗口下所有受控 tab 的摘要。 */
  tabs?: BrowserTabSummary[];
  userTabs?: BrowserUserTabInfo[];
  tab?: BrowserTabSummary;
  /** evaluate 返回：页面表达式的可 JSON 序列化结果。 */
  value?: unknown;
  /** elementInfo 返回：坐标命中元素的信息（未命中则省略）。 */
  element?: BrowserSnapshotElement;
  /** getDialog 返回：当前 JS 弹窗信息；无弹窗时为 null。 */
  dialog?: BrowserDialog | null;
  recording?: BrowserRecordingJob;
  error?: { code: BrowserErrorCode; message: string; sideEffect?: "none" | "uncertain" };
  meta?: BrowserResponseMeta;
  elapsedMs: number;
}

export interface BrowserControlExecuteInput {
  /** 精确 runtime backend id；不能只传 iab/extension/cdp family。 */
  browserId: string;
  browserGeneration: number;
  sessionId: string;
  turnId?: string;
  command: BrowserCommand;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

export interface BrowserControlListInput {
  sessionId: string;
  turnId?: string;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

export interface BrowserControlPort {
  /** 只返回完成握手且当前 context 可达的 backend，不允许伪造 stub。 */
  list(input: BrowserControlListInput): Promise<BrowserBackendDescriptor[]>;
  execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult>;
  /** turn 结束时取消该 turn 尚未完成的 IAB 请求，不跨 session 清 tab。 */
  turnEnded?(input: BrowserControlListInput): Promise<void>;
  /** session 关闭时释放 browser guest、pending request 与 lease。 */
  closeSession?(input: BrowserControlListInput): Promise<void>;
}
