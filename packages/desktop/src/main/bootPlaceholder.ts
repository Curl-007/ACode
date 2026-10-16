/**
 * boot placeholder —— 上次会话布局骨架的首帧直绘机制（specs/boot-placeholder.md）。
 *
 * 机制搬自 Claude Desktop 2.37337（mainWindow.js:4518-4603 preload 解析、
 * index.chunk-CHpJbW9_.js:137261-137360 main 构造/sync 重放、
 * renderer-shell/main_window/index.html 两相位内联脚本）：
 * - main 在窗口创建时把 {enabled, frame} 以 `--acode-boot-placeholder=<JSON>` 经
 *   BrowserWindow additionalArguments 注入；
 * - preload 解析 argv 并连同 webFrame.getZoomFactor() 暴露为
 *   globalThis.__ACODE_BOOT_PLACEHOLDER__（接线需求见 spec §9）；
 * - renderer/index.html 的 head/body 内联脚本在 React/样式表加载前把骨架画成绝对定位矩形；
 * - did-finish-load 后 main 以 executeJavaScript 重放 "sync" 相位，在 zoom 重放稳定后
 *   按最新视口对齐（desktopWindowChrome.ts 在 did-finish-load 重放 setZoomFactor，
 *   head/body 相位绘制时 innerWidth 可能仍是过渡 zoom 下的值）。
 *
 * 纪律：本文件**禁止 electron 运行时导入**（只用结构化类型），preload bundle 可以直接
 * import 复用解析/校验器；paint 函数源与 renderer/index.html 内联拷贝逐字一致，
 * 由 tests/boot-placeholder.test.mjs 守护，禁止只改一边。
 */

/** 单个骨架矩形：视口归一化比值（top/left/width/height 相对视口宽高，radius 相对短边）。 */
export type BootPlaceholderShape = {
  top: number;
  left: number;
  width: number;
  height: number;
  radius: number;
};

export type BootPlaceholderFrame = {
  shapes: BootPlaceholderShape[];
  /** 侧栏宽度 / 视口宽度（0..1；collapsed 时为 0）。 */
  sidebarWidth: number;
  collapsed: boolean;
  /** 采样时页面 zoom；比值几何自洽 zoom，此字段用于溯源与契约校验（spec §5）。 */
  zoomFactor: number;
};

/** additionalArguments 注入体。 */
export type BootPlaceholderPayload = {
  enabled: boolean;
  frame?: BootPlaceholderFrame;
};

/** preload 暴露给页面的最终形态（shellZoomFactor 由 preload 补 webFrame.getZoomFactor()）。 */
export type BootPlaceholderExposed = BootPlaceholderPayload & {
  shellZoomFactor?: number;
};

/** 持久化形态（AppSettings.desktopBootPlaceholder，接线见 spec §9）。 */
export type BootPlaceholderPersistedFrame = BootPlaceholderFrame & {
  sampledAt: number;
};

export const BOOT_PLACEHOLDER_ARG_PREFIX = "--acode-boot-placeholder=";
/** 原版同款上限：shapes ≤160、每值 0..1e4（index.chunk:137286-137306）。 */
export const BOOT_PLACEHOLDER_MAX_SHAPES = 160;
export const BOOT_PLACEHOLDER_MAX_VALUE = 1e4;

/** 原版 `$`/`IL` 同款数值校验：有限数且在 0..1e4。 */
function isBootPlaceholderValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e4;
}

/** 原版 `gc/fKn` 同构：超上限截断保留前 160；任一条目非法则整个数组判无效。 */
export function validateBootPlaceholderShapes(raw: unknown): BootPlaceholderShape[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const shapes: BootPlaceholderShape[] = [];
  for (const entry of raw) {
    if (shapes.length >= BOOT_PLACEHOLDER_MAX_SHAPES) {
      break;
    }
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const shape = entry as Partial<BootPlaceholderShape>;
    if (
      !isBootPlaceholderValue(shape.top) ||
      !isBootPlaceholderValue(shape.left) ||
      !isBootPlaceholderValue(shape.width) ||
      !isBootPlaceholderValue(shape.height) ||
      !isBootPlaceholderValue(shape.radius)
    ) {
      return undefined;
    }
    shapes.push({
      top: shape.top,
      left: shape.left,
      width: shape.width,
      height: shape.height,
      radius: shape.radius,
    });
  }
  return shapes;
}

/** 原版 `hc` 同构：标量字段任一非法即整 frame 无效（调用方回退默认骨架）。 */
export function validateBootPlaceholderFrame(raw: unknown): BootPlaceholderFrame | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const frame = raw as Partial<BootPlaceholderFrame>;
  if (
    !isBootPlaceholderValue(frame.sidebarWidth) ||
    typeof frame.collapsed !== "boolean" ||
    typeof frame.zoomFactor !== "number" ||
    !Number.isFinite(frame.zoomFactor) ||
    !(frame.zoomFactor > 0)
  ) {
    return undefined;
  }
  return {
    sidebarWidth: frame.sidebarWidth,
    collapsed: frame.collapsed,
    zoomFactor: frame.zoomFactor,
    // shapes 非法时降级为空数组（frame 其余字段仍成立），与原版 `gc(t.shapes) ?? []` 一致。
    shapes: validateBootPlaceholderShapes(frame.shapes) ?? [],
  };
}

/**
 * preload 侧 argv 解析（原版 mainWindow.js `mc` 同构）：
 * 找不到 flag / JSON 非法 / 非对象 → undefined（head 相位 no-op，fail-safe）；
 * enabled 仅严格 true 才启用；frame 校验失败置 undefined（绘制侧要求 enabled 必带 frame）。
 */
export function parseBootPlaceholderArgv(
  argv: readonly string[],
): BootPlaceholderExposed | undefined {
  const arg = argv.find((entry) => entry.startsWith(BOOT_PLACEHOLDER_ARG_PREFIX));
  if (!arg) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(arg.slice(BOOT_PLACEHOLDER_ARG_PREFIX.length));
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const { enabled, frame } = parsed as { enabled?: unknown; frame?: unknown };
    return { enabled: enabled === true, frame: validateBootPlaceholderFrame(frame) };
  } catch {
    return undefined;
  }
}

/** 合成默认骨架的参考视口：桌面默认窗口尺寸（desktopWindowSize.ts）1200×800。 */
const DEFAULT_FRAME_REFERENCE_WIDTH = 1200;
const DEFAULT_FRAME_REFERENCE_HEIGHT = 800;
/** ACode 侧栏默认宽（WorkspaceShellLayout.tsx WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX）。 */
const DEFAULT_FRAME_SIDEBAR_WIDTH_PX = 264;

function roundBootPlaceholderRatio(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/**
 * 手工合成默认骨架（原版 `pKn` 同母题：侧栏导航行/分组头/会话行 + 主区分区），
 * 按 ACode 默认布局（侧栏 264px、主区左起 288px）在参考视口上换算成比值。
 * 首装/清档等无持久数据时使用，产物必须通过 validateBootPlaceholderFrame（测试守护）。
 */
export function synthesizeDefaultBootPlaceholderFrame(): BootPlaceholderFrame {
  const refW = DEFAULT_FRAME_REFERENCE_WIDTH;
  const refH = DEFAULT_FRAME_REFERENCE_HEIGHT;
  const radiusBase = Math.min(refW, refH);
  const shape = (
    topPx: number,
    leftPx: number,
    widthPx: number,
    heightPx: number,
    radiusPx: number,
  ): BootPlaceholderShape => ({
    top: roundBootPlaceholderRatio(topPx / refH),
    left: roundBootPlaceholderRatio(leftPx / refW),
    width: roundBootPlaceholderRatio(widthPx / refW),
    height: roundBootPlaceholderRatio(heightPx / refH),
    radius: roundBootPlaceholderRatio(radiusPx / radiusBase),
  });

  const shapes: BootPlaceholderShape[] = [];
  // 侧栏：4 行「图标 + 标题」剪影（原版 [36,56,60,72] 宽度节奏，行距 26px）。
  const navLabelWidthsPx = [36, 56, 60, 72];
  navLabelWidthsPx.forEach((labelWidthPx, index) => {
    const rowTopPx = 60 + index * 26;
    shapes.push(shape(rowTopPx - 1, 14, 16, 16, 4));
    shapes.push(shape(rowTopPx, 34, labelWidthPx, 13, 4));
  });
  // 侧栏：分组头分隔条。
  shapes.push(shape(188, 14, 88, 10, 4));
  // 侧栏：5 行会话条目（圆点 + 变宽文本条，宽度比例取自原版 [0.68,0.54,0.44,0.68,0.54]）。
  const conversationBarWidthPx = DEFAULT_FRAME_SIDEBAR_WIDTH_PX - 20;
  const conversationBarRatios = [0.68, 0.54, 0.44, 0.68, 0.54];
  conversationBarRatios.forEach((barRatio, index) => {
    const rowTopPx = 218 + index * 26;
    shapes.push(shape(rowTopPx + 3, 19, 6, 6, 3));
    shapes.push(shape(rowTopPx, 38, Math.round(conversationBarWidthPx * barRatio), 13, 4));
  });
  // 主区：workspace header 条、会话大块、composer 条（左起 = 侧栏 264 + 间隙 24）。
  const mainLeftPx = 288;
  const mainWidthPx = refW - mainLeftPx - 24;
  shapes.push(shape(16, mainLeftPx, mainWidthPx, 32, 8));
  shapes.push(shape(64, mainLeftPx, mainWidthPx, 596, 12));
  shapes.push(shape(676, mainLeftPx, mainWidthPx, 84, 12));

  return {
    shapes,
    sidebarWidth: roundBootPlaceholderRatio(DEFAULT_FRAME_SIDEBAR_WIDTH_PX / refW),
    collapsed: false,
    zoomFactor: 1,
  };
}

/**
 * 构造注入 payload：设置显式关闭 → {enabled:false}（不带 frame）；
 * 否则 frame = 校验通过的持久化数据 ?? 手工合成默认骨架（恒启用判定见 spec §1）。
 */
export function resolveBootPlaceholderPayload(options: {
  persistedFrame?: unknown;
  settingEnabled?: boolean;
}): BootPlaceholderPayload {
  if (options.settingEnabled === false) {
    return { enabled: false };
  }
  return {
    enabled: true,
    frame:
      validateBootPlaceholderFrame(options.persistedFrame) ??
      synthesizeDefaultBootPlaceholderFrame(),
  };
}

export function buildBootPlaceholderArgument(payload: BootPlaceholderPayload): string {
  return `${BOOT_PLACEHOLDER_ARG_PREFIX}${JSON.stringify(payload)}`;
}

/**
 * 三相位 paint 函数源（head/body/sync），与 renderer/index.html 两份内联拷贝逐字一致
 * （tests/boot-placeholder.test.mjs 归一化空白后比对）。原版 `dKn` 同构，差异见 spec §5/§7：
 * - 比值几何：绘制时读最新 innerWidth/innerHeight，zoom 自洽，无 scale 补偿；
 * - shapes 覆盖侧栏+主区（原版仅侧栏），collapsed 时仍绘制（采样即所见）；
 * - startup-ready 幂等守卫：React 接管后 sync 重放不得复活骨架。
 * 修改本源时必须同步修改 index.html 内联拷贝。
 */
export const BOOT_PLACEHOLDER_PAINT_SOURCE = `function (placeholder, phase) {
  try {
    var root = document.documentElement;
    var body = document.body;
    if (body && body.classList && body.classList.contains("acode-startup-ready")) {
      root.removeAttribute("data-acode-boot-placeholder");
      root.removeAttribute("data-acode-boot-placeholder-frame");
      root.removeAttribute("data-acode-boot-theme");
      root.style.removeProperty("--acode-boot-placeholder-sidebar-width");
      return;
    }
    var frame = placeholder && placeholder.frame;
    var host = document.getElementById("acode-boot-placeholder-shapes");
    var paintShapes = function (shapes) {
      if (!host) {
        return;
      }
      host.textContent = "";
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      if (!(vw > 0) || !(vh > 0)) {
        return;
      }
      var radiusBase = Math.min(vw, vh);
      for (var i = 0; shapes && i < shapes.length; i++) {
        var s = shapes[i];
        var el = document.createElement("div");
        el.style.top = s.top * vh + "px";
        el.style.left = s.left * vw + "px";
        el.style.width = s.width * vw + "px";
        el.style.height = s.height * vh + "px";
        el.style.borderRadius = s.radius * radiusBase + "px";
        host.appendChild(el);
      }
    };
    var create = phase === "head";
    if (create) {
      if (!placeholder || placeholder.enabled !== true || !frame) {
        return;
      }
      var theme = "dark";
      try {
        var stored = window.localStorage.getItem("acode-theme");
        if (stored === "light" || stored === "zai-light") {
          theme = "light";
        } else if (stored === "system") {
          theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        }
      } catch (_themeError) {}
      root.setAttribute("data-acode-boot-placeholder", "");
      root.setAttribute("data-acode-boot-theme", theme);
    } else if (!root.hasAttribute("data-acode-boot-placeholder")) {
      return;
    }
    if (phase === "body") {
      if (frame && root.hasAttribute("data-acode-boot-placeholder-frame")) {
        paintShapes(frame.shapes);
      }
      return;
    }
    var shown = root.getAttribute("data-acode-boot-placeholder-frame");
    root.removeAttribute("data-acode-boot-placeholder-frame");
    root.style.removeProperty("--acode-boot-placeholder-sidebar-width");
    paintShapes(null);
    if (!frame || (!create && !shown)) {
      return;
    }
    var collapsed = frame.collapsed === true;
    if (!collapsed) {
      root.style.setProperty(
        "--acode-boot-placeholder-sidebar-width",
        frame.sidebarWidth * window.innerWidth + "px",
      );
    }
    root.setAttribute("data-acode-boot-placeholder-frame", collapsed ? "collapsed" : "sidebar");
    if (host) {
      paintShapes(frame.shapes);
    }
  } catch (_paintError) {}
}`;

/** sync 相位重放脚本（原版 `LL` 的 executeJavaScript 载荷同构）。 */
export function buildBootPlaceholderSyncScript(payload: BootPlaceholderExposed): string {
  return `(${BOOT_PLACEHOLDER_PAINT_SOURCE})(${JSON.stringify(payload)}, "sync")`;
}

/** attach 只依赖结构化 webContents 面，便于测试替身与 preload 安全导入。 */
export type BootPlaceholderWebContentsLike = {
  isDestroyed(): boolean;
  zoomFactor?: number;
  on(event: "did-finish-load", listener: () => void): unknown;
  removeListener(event: "did-finish-load", listener: () => void): unknown;
  executeJavaScript(code: string): Promise<unknown>;
};

export type BootPlaceholderLoggerLike = {
  warn(message: string, meta?: Record<string, unknown>): void;
};

/**
 * did-finish-load 后以 sync 相位重放对齐 zoom（原版 `DKn/LL` 同构）。
 * 接线必须在本函数之前已注册既有的 did-finish-load zoom 重放
 * （desktopWindowChrome.ts createWindow 内部），同事件按注册序执行，
 * 本重放才能读到 settle 后的视口（spec §5）。返回 disposer。
 */
export function attachBootPlaceholderWindow(options: {
  webContents: BootPlaceholderWebContentsLike;
  resolvePayload: () => BootPlaceholderPayload | undefined;
  logger?: BootPlaceholderLoggerLike;
}): () => void {
  const listener = (): void => {
    const { webContents, resolvePayload, logger } = options;
    if (webContents.isDestroyed()) {
      return;
    }
    const payload = resolvePayload();
    if (!payload || payload.enabled !== true || !payload.frame) {
      return;
    }
    const shellZoomFactor = webContents.zoomFactor;
    const script = buildBootPlaceholderSyncScript({
      ...payload,
      ...(typeof shellZoomFactor === "number" && Number.isFinite(shellZoomFactor)
        ? { shellZoomFactor }
        : {}),
    });
    webContents.executeJavaScript(script).catch((error: unknown) => {
      logger?.warn("[boot-placeholder] failed to repaint the shell", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  options.webContents.on("did-finish-load", listener);
  return () => {
    options.webContents.removeListener("did-finish-load", listener);
  };
}
