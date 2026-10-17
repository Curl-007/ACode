/**
 * bootSkeletonSampler —— 上次会话布局骨架的采样与延迟持久化上报器。
 *
 * 机制见 packages/desktop/specs/boot-placeholder.md（T2-s3）：桌面 renderer 在 workspace
 * shell 稳定后，从现有布局 DOM（侧栏 + 主要分区）采样骨架矩形，视口归一化后防抖写入
 * 设置通道；下次冷启动由 main 经 additionalArguments 注入，index.html 首帧直绘。
 * 本模块只读 DOM、只经注入的 persist 回调写设置（复用现有 settingService.update +
 * platform.syncAppSettings 通道，不新增 IPC 常量）；非 shell 页面绝不覆盖上次好数据。
 */

/** 骨架矩形：视口归一化比值，与 desktop 侧 BootPlaceholderShape 契约一致（spec §2）。 */
export type BootSkeletonShape = {
  top: number;
  left: number;
  width: number;
  height: number;
  radius: number;
};

/** 持久化帧：与 AppSettings.desktopBootPlaceholder 接线形状一致（spec §9）。 */
export type BootSkeletonFrame = {
  shapes: BootSkeletonShape[];
  /** 侧栏宽度 / 视口宽度（0..1；collapsed 时为 0）。 */
  sidebarWidth: number;
  collapsed: boolean;
  /** 采样时页面 zoom（1.1^desktopZoomLevel），溯源与契约校验用。 */
  zoomFactor: number;
  sampledAt: number;
};

/** 可注入的最小 DOM 面（测试用手搓替身，仓库 ui 测试无 jsdom 先例同款纪律）。 */
export type BootSkeletonRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type BootSkeletonElement = {
  getBoundingClientRect(): BootSkeletonRect;
};

export type BootSkeletonDocument = {
  querySelector(selector: string): BootSkeletonElement | null;
  querySelectorAll(selector: string): ArrayLike<BootSkeletonElement>;
};

/** 原版同款上限（index.chunk:137286-137306）：≤160 个、每值 0..1e4。 */
export const BOOT_SKELETON_MAX_SHAPES = 160;
export const BOOT_SKELETON_MAX_VALUE = 1e4;
/** 侧栏最多采样的 workspace 行数；超出部分骨架上不可辨，截断防止 shape 膨胀。 */
export const BOOT_SKELETON_MAX_SIDEBAR_ROWS = 20;
/** #sidebar 收起态宽度为 4px（桌面 inset）或 0（WorkspaceShellLayout collapsedSidebarWidthPx）。 */
export const BOOT_SKELETON_COLLAPSED_MAX_WIDTH_PX = 8;
/** 小于该 CSS px 尺寸的矩形在骨架上不可辨，丢弃。 */
export const BOOT_SKELETON_MIN_SHAPE_PX = 2;

/**
 * 主要分区采样源：全部为仓库已验证的稳定 DOM 标记（spec §8）。
 * 选择器不命中时静默跳过——布局演进只减 shape，不让采样报错。
 */
const BOOT_SKELETON_SECTION_SOURCES: ReadonlyArray<{
  selector: string;
  radiusPx: number;
}> = [
  { selector: '[data-testid="workspace-header"]', radiusPx: 12 }, // WorkspaceHeader.tsx:137
  { selector: '[data-workspace-conversation-frame="true"]', radiusPx: 12 }, // WorkspaceShellLayout.tsx:1673
  { selector: '[data-workspace-terminal-frame="true"]', radiusPx: 12 }, // AnimatedTerminalPanel.tsx:123
  // AnimatedSidePanePanel.tsx:658；隐藏 tab 面板 rect 为 0，被最小尺寸过滤剔除。
  { selector: "[data-side-pane-tab-id]", radiusPx: 12 },
];

function clampBootSkeletonRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundBootSkeletonRatio(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/** 契约校验：与 desktop 侧 validateBootPlaceholderShapes 同构，产出端先自我设限。 */
export function isBootSkeletonShapeValid(shape: BootSkeletonShape): boolean {
  return (Object.values(shape) as number[]).every(
    (value) =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= BOOT_SKELETON_MAX_VALUE,
  );
}

export function sampleBootSkeletonFrame(deps: {
  document: BootSkeletonDocument;
  innerWidth: number;
  innerHeight: number;
  zoomFactor: number;
  now?: () => number;
}): BootSkeletonFrame | null {
  const { innerWidth: vw, innerHeight: vh } = deps;
  if (!(vw > 0) || !(vh > 0)) {
    return null;
  }
  // 门控：不在 workspace shell（Welcome/设置页/更新窗）时不采样，保留上次好数据。
  if (!deps.document.querySelector('[data-workspace-shell="true"]')) {
    return null;
  }

  const radiusBase = Math.min(vw, vh);
  const shapes: BootSkeletonShape[] = [];
  const pushRect = (rect: BootSkeletonRect, radiusPx: number): void => {
    if (shapes.length >= BOOT_SKELETON_MAX_SHAPES) {
      return;
    }
    if (
      !(rect.width >= BOOT_SKELETON_MIN_SHAPE_PX) ||
      !(rect.height >= BOOT_SKELETON_MIN_SHAPE_PX)
    ) {
      return;
    }
    // 完全出视口的矩形（虚拟滚动/离屏面板）不进骨架。
    if (rect.left + rect.width <= 0 || rect.top + rect.height <= 0) {
      return;
    }
    if (rect.left >= vw || rect.top >= vh) {
      return;
    }
    const shape: BootSkeletonShape = {
      top: roundBootSkeletonRatio(clampBootSkeletonRatio(rect.top / vh)),
      left: roundBootSkeletonRatio(clampBootSkeletonRatio(rect.left / vw)),
      width: roundBootSkeletonRatio(clampBootSkeletonRatio(rect.width / vw)),
      height: roundBootSkeletonRatio(clampBootSkeletonRatio(rect.height / vh)),
      radius: roundBootSkeletonRatio(
        clampBootSkeletonRatio(Math.max(0, Math.min(radiusPx, rect.height / 2)) / radiusBase),
      ),
    };
    if (isBootSkeletonShapeValid(shape)) {
      shapes.push(shape);
    }
  };

  // 侧栏：宽度与 collapsed 取自 #sidebar 面板 rect（CSS 变量驱动，收起态 4px/0）。
  let collapsed = true;
  let sidebarWidth = 0;
  const sidebar = deps.document.querySelector("#sidebar");
  if (sidebar) {
    const rect = sidebar.getBoundingClientRect();
    collapsed = rect.width <= BOOT_SKELETON_COLLAPSED_MAX_WIDTH_PX;
    if (!collapsed) {
      sidebarWidth = roundBootSkeletonRatio(clampBootSkeletonRatio(rect.width / vw));
    }
  }

  // 侧栏行仅在展开态采样：收起态 #sidebar overflow-hidden 但子行布局宽度仍在，
  // getBoundingClientRect 会把被裁剪的行泄漏成越出侧栏的骨架（spec §8）。
  if (!collapsed) {
    const rows = deps.document.querySelectorAll('[data-testid="workspace-list"] > li');
    for (let index = 0; index < rows.length && index < BOOT_SKELETON_MAX_SIDEBAR_ROWS; index++) {
      const row = rows[index];
      if (row) {
        pushRect(row.getBoundingClientRect(), 10);
      }
    }
  }

  for (const source of BOOT_SKELETON_SECTION_SOURCES) {
    const matches = deps.document.querySelectorAll(source.selector);
    for (let index = 0; index < matches.length; index++) {
      const element = matches[index];
      if (element) {
        pushRect(element.getBoundingClientRect(), source.radiusPx);
      }
    }
  }

  const zoomFactor = deps.zoomFactor;
  return {
    shapes,
    sidebarWidth: collapsed ? 0 : sidebarWidth,
    collapsed,
    zoomFactor:
      typeof zoomFactor === "number" && Number.isFinite(zoomFactor) && zoomFactor > 0
        ? zoomFactor
        : 1,
    sampledAt: (deps.now ?? Date.now)(),
  };
}

/** 去重序列化：sampledAt 每次不同，不参与「布局是否变化」判定。 */
export function serializeBootSkeletonFrame(frame: BootSkeletonFrame): string {
  const { sampledAt: _sampledAt, ...geometry } = frame;
  return JSON.stringify(geometry);
}

export type BootSkeletonPersist = (frame: BootSkeletonFrame) => void | Promise<void>;

export type BootSkeletonReporter = {
  /** 触发一次防抖采样；重复调用只重置定时器（延迟持久化，spec §8）。 */
  schedule(): void;
  /** 立即执行一次采样+条件持久化（测试与特殊时机用）。 */
  settle(): void;
  dispose(): void;
};

/**
 * 延迟持久化上报器：schedule → debounceMs 防抖 → settle（采样、去重、persist）。
 * persist 失败重置去重键，让下一个触发源重试；不做失败重试风暴。
 */
export function createBootSkeletonReporter(options: {
  sample: () => BootSkeletonFrame | null;
  persist: BootSkeletonPersist;
  onError?: (error: unknown) => void;
  debounceMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}): BootSkeletonReporter {
  const debounceMs = options.debounceMs ?? 2000;
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSerialized: string | null = null;
  let disposed = false;

  const settle = (): void => {
    if (disposed) {
      return;
    }
    let frame: BootSkeletonFrame | null;
    try {
      frame = options.sample();
    } catch (error) {
      options.onError?.(error);
      return;
    }
    // null = 非 workspace shell / 视口非法：保留上次持久化数据，不覆盖。
    if (!frame) {
      return;
    }
    const serialized = serializeBootSkeletonFrame(frame);
    if (serialized === lastSerialized) {
      return;
    }
    lastSerialized = serialized;
    try {
      const result = options.persist(frame);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((error: unknown) => {
          // 写失败清掉去重键：下一次触发源（resize/轮询/可见性）会重试同一帧。
          lastSerialized = null;
          options.onError?.(error);
        });
      }
    } catch (error) {
      lastSerialized = null;
      options.onError?.(error);
    }
  };

  return {
    schedule(): void {
      if (disposed) {
        return;
      }
      if (timer !== null) {
        clearTimeoutImpl(timer);
      }
      timer = setTimeoutImpl(() => {
        timer = null;
        settle();
      }, debounceMs);
    },
    settle,
    dispose(): void {
      disposed = true;
      if (timer !== null) {
        clearTimeoutImpl(timer);
        timer = null;
      }
    },
  };
}

export type BootSkeletonWindowLike = {
  innerWidth: number;
  innerHeight: number;
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
  setTimeout: typeof setTimeout;
  setInterval: typeof setInterval;
  clearTimeout: typeof clearTimeout;
  clearInterval: typeof clearInterval;
};

export type BootSkeletonVisibilityDocument = BootSkeletonDocument & {
  hidden?: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

/** 结构化 MutationObserver 面：真实实现与测试替身共用，避免依赖 DOM Node 类型。 */
export type BootSkeletonMutationObserverLike = {
  observe(target: unknown, options: { attributes: boolean; attributeFilter: string[] }): void;
  disconnect(): void;
};

export type BootSkeletonMutationObserverCtor = new (
  callback: () => void,
) => BootSkeletonMutationObserverLike;

/**
 * 桌面接线入口（spec §9.5）：挂到 workspace shell 生命周期上自动采样上报。
 * 触发源 = 初始延迟 + resize + 可见性恢复 + 兜底轮询 + shell/sidebar 属性变更
 * （侧栏开合切 #sidebar class、宽度拖拽写 shell style 变量，两者都是属性级变更）。
 * 返回 disposer；非浏览器环境直接返回 no-op。
 */
export function startBootSkeletonReporting(deps: {
  persist: BootSkeletonPersist;
  /** 现值 zoomFactor（接线用 platform.getDesktopZoomLevel/onDesktopZoomLevelChanged 维护）。 */
  readZoomFactor?: () => number;
  onError?: (error: unknown) => void;
  window?: BootSkeletonWindowLike;
  document?: BootSkeletonVisibilityDocument;
  debounceMs?: number;
  /** 首采延迟：等 startup 动画与首屏布局稳定后再取「用户真正看到的布局」。 */
  initialDelayMs?: number;
  intervalMs?: number;
  mutationObserverImpl?: BootSkeletonMutationObserverCtor;
}): () => void {
  const win =
    deps.window ??
    (typeof window !== "undefined" ? (window as unknown as BootSkeletonWindowLike) : undefined);
  const doc =
    deps.document ??
    (typeof document !== "undefined"
      ? (document as unknown as BootSkeletonVisibilityDocument)
      : undefined);
  if (!win || !doc) {
    return () => {};
  }

  const reporter = createBootSkeletonReporter({
    sample: () =>
      sampleBootSkeletonFrame({
        document: doc,
        innerWidth: win.innerWidth,
        innerHeight: win.innerHeight,
        zoomFactor: deps.readZoomFactor?.() ?? 1,
      }),
    persist: deps.persist,
    onError: deps.onError,
    debounceMs: deps.debounceMs,
    setTimeoutImpl: win.setTimeout.bind(win),
    clearTimeoutImpl: win.clearTimeout.bind(win),
  });

  const initialDelayMs = deps.initialDelayMs ?? 3000;
  const intervalMs = deps.intervalMs ?? 60_000;
  const initialTimer = win.setTimeout(() => reporter.schedule(), initialDelayMs);
  const interval = win.setInterval(() => reporter.schedule(), intervalMs);

  const onResize = (): void => reporter.schedule();
  win.addEventListener("resize", onResize);
  const onVisibilityChange = (): void => {
    if (!doc.hidden) {
      reporter.schedule();
    }
  };
  doc.addEventListener("visibilitychange", onVisibilityChange);

  const ObserverImpl: BootSkeletonMutationObserverCtor | undefined =
    deps.mutationObserverImpl ??
    (typeof MutationObserver === "function"
      ? (MutationObserver as unknown as BootSkeletonMutationObserverCtor)
      : undefined);
  let observer: BootSkeletonMutationObserverLike | undefined;
  if (ObserverImpl) {
    observer = new ObserverImpl(() => reporter.schedule());
    const observedNodes = [
      doc.querySelector('[data-workspace-shell="true"]'),
      doc.querySelector("#sidebar"),
    ];
    for (const node of observedNodes) {
      if (node) {
        observer.observe(node, { attributes: true, attributeFilter: ["style", "class"] });
      }
    }
  }

  return () => {
    win.clearTimeout(initialTimer);
    win.clearInterval(interval);
    win.removeEventListener("resize", onResize);
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    observer?.disconnect();
    reporter.dispose();
  };
}
