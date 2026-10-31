// Browser 命令词汇与录制动作契约 —— command method 枚举、playwright 动作、录制选项。
// 例外偿还（contracts-onboarding-max-file-lines-browser-control-port）：自
// interfaces/browser-control.port.ts 拆出。原文件降为 barrel 并对本叶 `export *`，
// 公开导出面逐名不变。
// 依赖单向：本叶 → browser-backend.js（BrowserViewportSize）；browser-result 叶再依赖本叶，
// 无叶子回边。
/**
 * BrowserControlPort —— agent 侧浏览器控制端口（命令词汇段）。
 * 与 @acode/shared 的 browser-use 契约结构镜像；协议边界用 shared zod schema 校验，
 * 两侧一致性由 round-trip 测保证。
 */

import type { BrowserViewportSize } from "./browser-backend.js";

export type BrowserCommandMethod =
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "snapshot"
  | "click"
  | "fill"
  | "type"
  | "press"
  | "cuaKeypress"
  | "scroll"
  | "cuaScroll"
  | "domCuaScroll"
  | "hover"
  | "select"
  | "check"
  | "drag"
  | "cuaDrag"
  | "screenshot"
  | "getState"
  | "elementInfo"
  | "evaluate"
  | "getDialog"
  | "handleDialog"
  | "waitFor"
  | "playwright"
  | "playwrightWaitForTimeout"
  | "capabilities"
  | "browserVisibilityGet"
  | "browserVisibilitySet"
  | "browserViewportSet"
  | "browserViewportReset"
  | "recordingStart"
  | "recordingStatus"
  | "recordingCancel"
  | "activateTab"
  | "newTab"
  | "finalize"
  | "finalizeTabs"
  | "listUserTabs"
  | "claimTab"
  | "markDeliverable"
  | "markHandoff"
  | "nameSession"
  | "turnEnded"
  | "closeSession"
  | "cancelRequest"
  | "close"
  | "list";

export type BrowserMouseButton = "left" | "right" | "middle";
export type BrowserKeyModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";
export type BrowserPlaywrightModifier = BrowserKeyModifier;
export type BrowserPlaywrightLocatorOperation =
  | "allTextContents"
  | "click"
  | "count"
  | "dblclick"
  | "downloadMedia"
  | "evaluate"
  | "fill"
  | "getAttribute"
  | "innerText"
  | "isEnabled"
  | "isVisible"
  | "press"
  | "selectOption"
  | "setChecked"
  | "textContent"
  | "waitFor";
export type BrowserPlaywrightAction =
  | { name: "domSnapshot" }
  | { name: "elementInfo"; x: number; y: number; includeNonInteractable?: boolean }
  | { name: "elementScreenshot"; x: number; y: number; includeNonInteractable?: boolean }
  | {
      name: "evaluate";
      expression: string;
      expressionKind: "string" | "function";
      arg?: unknown;
      timeoutMs?: number;
    }
  | {
      name: "waitForLoadState";
      state?: "load" | "domcontentloaded" | "networkidle";
      timeoutMs?: number;
    }
  | {
      name: "waitForURL";
      url: string;
      waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
      timeoutMs?: number;
    }
  | { name: "waitForEvent"; event: "download" | "filechooser"; timeoutMs?: number }
  | { name: "downloadPath"; downloadId: string; timeoutMs?: number }
  | {
      name: "fileChooserSetFiles";
      fileChooserId: string;
      files: string[];
      timeoutMs?: number;
    }
  | {
      name: "locator";
      selector: string;
      operation: BrowserPlaywrightLocatorOperation;
      value?: unknown;
      arg?: unknown;
      expression?: string;
      expressionKind?: "string" | "function";
      attribute?: string;
      checked?: boolean;
      replace?: boolean;
      force?: boolean;
      button?: BrowserMouseButton;
      modifiers?: BrowserPlaywrightModifier[];
      state?: "attached" | "detached" | "visible" | "hidden";
      selections?: Array<{ value?: string; label?: string; index?: number }>;
      timeoutMs?: number;
    };
export interface BrowserPoint {
  x: number;
  y: number;
}

export type BrowserRecordingAction =
  | { type: "wait"; durationMs: number }
  | {
      type: "click";
      selector?: string;
      x?: number;
      y?: number;
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      delayAfterMs?: number;
    }
  | { type: "type"; selector: string; text: string; delayAfterMs?: number }
  | {
      type: "hover";
      selector?: string;
      x?: number;
      y?: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | { type: "move"; x: number; y: number; durationMs?: number; delayAfterMs?: number }
  | {
      type: "scroll";
      deltaX?: number;
      deltaY: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | {
      type: "scrollTo";
      selector?: string;
      x?: number;
      y?: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | {
      type: "wheel";
      deltaX?: number;
      deltaY: number;
      times?: number;
      intervalMs?: number;
      delayAfterMs?: number;
    }
  | { type: "drag"; path: BrowserPoint[]; durationMs?: number; delayAfterMs?: number }
  | {
      type: "waitFor";
      selector: string;
      state?: "attached" | "detached" | "visible" | "hidden";
      timeoutMs?: number;
      delayAfterMs?: number;
    };

export interface BrowserRecordingOptions {
  viewport?: BrowserViewportSize;
  fps?: number;
  jpegQuality?: number;
  maxDurationMs?: number;
  settleMs?: number;
  showCursor?: boolean;
  actions?: BrowserRecordingAction[];
}
