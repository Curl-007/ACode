import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyAppearancePreferences,
  applyPersistedAppearancePreferences,
  DENSITY_ATTRIBUTE,
  DENSITY_STORAGE_KEY,
  DEFAULT_APPEARANCE_PREFERENCES,
  loadAppearancePreferences,
  normalizeDensityPreference,
  normalizeReduceMotionPreference,
  normalizeTextSizePreference,
  REDUCE_MOTION_ATTRIBUTE,
  REDUCE_MOTION_STORAGE_KEY,
  setAppearancePreferences,
  subscribeToAppearanceStorageChanges,
  TEXT_SIZE_ATTRIBUTE,
  TEXT_SIZE_STORAGE_KEY,
  type AppearanceAttributeTarget,
  type AppearancePreferences,
} from "../src/lib/appearancePreferences.js";

/**
 * 多轴外观偏好契约验收（packages/ui/specs/appearance-preference-axes.md 场景 1–6）。
 * ui 测试无 jsdom 先例：根节点/localStorage/window 全部手搓结构化替身
 * （bootSkeletonSampler.test.ts 同款纪律），被测模块经注入点吃替身。
 */

function createFakeRoot(): AppearanceAttributeTarget & { attributes: Map<string, string> } {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
  };
}

function createFakeStorage(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

// localStorage 替身经 globalThis 注入（browserEnvironment 的裸 localStorage 分支）。
const globals = globalThis as Record<string, unknown>;

function withStorage(storage: ReturnType<typeof createFakeStorage>, run: () => void) {
  const original = globals.localStorage;
  globals.localStorage = storage;
  try {
    run();
  } finally {
    if (original === undefined) delete globals.localStorage;
    else globals.localStorage = original;
  }
}

test("(场景1) 归一化闭集：合法值原样，垃圾值收敛默认", () => {
  assert.equal(normalizeDensityPreference("compact"), "compact");
  assert.equal(normalizeTextSizePreference("lg"), "lg");
  assert.equal(normalizeReduceMotionPreference("reduce"), "reduce");
  for (const garbage of [null, undefined, "", "huge", "COMFORTABLE", 42, {}]) {
    assert.equal(normalizeDensityPreference(garbage), DEFAULT_APPEARANCE_PREFERENCES.density);
    assert.equal(normalizeTextSizePreference(garbage), DEFAULT_APPEARANCE_PREFERENCES.textSize);
    assert.equal(
      normalizeReduceMotionPreference(garbage),
      DEFAULT_APPEARANCE_PREFERENCES.reduceMotion,
    );
  }
});

test("(场景2) apply 对注入根写满三属性，默认档也显式写出", () => {
  const root = createFakeRoot();
  applyAppearancePreferences(DEFAULT_APPEARANCE_PREFERENCES, root);
  assert.equal(root.attributes.get(DENSITY_ATTRIBUTE), "comfortable");
  assert.equal(root.attributes.get(TEXT_SIZE_ATTRIBUTE), "md");
  assert.equal(root.attributes.get(REDUCE_MOTION_ATTRIBUTE), "auto");
});

test("(场景2) 无根环境静默跳过不抛错", () => {
  assert.doesNotThrow(() => applyPersistedAppearancePreferences(null));
});

test("(场景3) setAppearancePreferences 部分补丁：其余轴保持既持久值，垃圾补丁归一化", () => {
  const storage = createFakeStorage({
    [DENSITY_STORAGE_KEY]: "compact",
    [TEXT_SIZE_STORAGE_KEY]: "lg",
  });
  const root = createFakeRoot();
  withStorage(storage, () => {
    const next = setAppearancePreferences({ reduceMotion: "reduce" }, root);
    assert.deepEqual(next, { density: "compact", textSize: "lg", reduceMotion: "reduce" });
    // 写入 localStorage 的必须是归一化后的闭集值。
    assert.equal(storage.values.get(REDUCE_MOTION_STORAGE_KEY), "reduce");
    assert.equal(root.attributes.get(REDUCE_MOTION_ATTRIBUTE), "reduce");

    const garbagePatch = {
      density: "tight",
      textSize: 7,
    } as unknown as Partial<AppearancePreferences>;
    const normalized = setAppearancePreferences(garbagePatch, root);
    assert.equal(normalized.density, "comfortable");
    assert.equal(normalized.textSize, "md");
    assert.equal(storage.values.get(DENSITY_STORAGE_KEY), "comfortable");
    assert.equal(storage.values.get(TEXT_SIZE_STORAGE_KEY), "md");
  });
});

test("(场景1) load 从持久面读，垃圾值收敛默认", () => {
  withStorage(
    createFakeStorage({ [DENSITY_STORAGE_KEY]: "compact", [TEXT_SIZE_STORAGE_KEY]: "xl" }),
    () => {
      assert.deepEqual(loadAppearancePreferences(), {
        density: "compact",
        textSize: "md",
        reduceMotion: "auto",
      });
    },
  );
  withStorage(createFakeStorage(), () => {
    assert.deepEqual(loadAppearancePreferences(), DEFAULT_APPEARANCE_PREFERENCES);
  });
});

test("(场景4) storage 订阅只响应三键；退订后不再响应", () => {
  const storage = createFakeStorage({ [DENSITY_STORAGE_KEY]: "compact" });
  const root = createFakeRoot();
  const handlers: Array<(event: { key: string | null }) => void> = [];
  const fakeWindow = {
    // browserEnvironment 优先走 window.localStorage 分支：替身必须带上同一 storage，
    // 否则候选解析拿到 undefined 收敛默认值（真实浏览器窗口天然两者同在）。
    localStorage: storage,
    addEventListener: (_type: string, handler: (event: { key: string | null }) => void) => {
      handlers.push(handler);
    },
    removeEventListener: (_type: string, handler: (event: { key: string | null }) => void) => {
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    },
  };
  const originalWindow = globals.window;
  const originalDocument = globals.document;
  globals.window = fakeWindow;
  // applyPersistedAppearancePreferences 走 document.documentElement 分支：注入可记录根。
  globals.document = { documentElement: root };
  try {
    withStorage(storage, () => {
      const unsubscribe = subscribeToAppearanceStorageChanges();
      assert.equal(handlers.length, 1);

      handlers[0]({ key: "acode-theme" });
      assert.equal(root.attributes.size, 0, "无关键不得触发重应用");

      handlers[0]({ key: DENSITY_STORAGE_KEY });
      assert.equal(root.attributes.get(DENSITY_ATTRIBUTE), "compact");
      assert.equal(root.attributes.get(TEXT_SIZE_ATTRIBUTE), "md");

      unsubscribe();
      assert.equal(handlers.length, 0);
      // 退订后即使持久值再变化也没有响应面（handler 已全部移除）。
      storage.values.set(DENSITY_STORAGE_KEY, "comfortable");
      root.attributes.clear();
      assert.equal(root.attributes.size, 0);
    });
  } finally {
    if (originalWindow === undefined) delete globals.window;
    else globals.window = originalWindow;
    if (originalDocument === undefined) delete globals.document;
    else globals.document = originalDocument;
  }
});

test("(场景6) applyTheme 收口：主题应用后三属性在场", async () => {
  const root = createFakeRoot();
  const storage = createFakeStorage({ [TEXT_SIZE_STORAGE_KEY]: "lg" });
  const classToggles: Array<[string, boolean]> = [];
  const originalDocument = globals.document;
  const originalLocalStorage = globals.localStorage;
  globals.localStorage = storage;
  globals.document = {
    documentElement: {
      ...root,
      classList: {
        toggle: (name: string, on: boolean) => {
          classToggles.push([name, on]);
        },
      },
      // syncBrowserThemeSurface 走 hasAttribute 缺席分支（typeof !== "function" 即早退）。
      style: {},
    },
  };
  try {
    const { applyTheme } = await import("../src/useTheme.js");
    applyTheme("zai-dark");
    assert.ok(classToggles.some(([name, on]) => name === "dark" && on === true));
    assert.equal(root.attributes.get(DENSITY_ATTRIBUTE), "comfortable");
    assert.equal(root.attributes.get(TEXT_SIZE_ATTRIBUTE), "lg");
    assert.equal(root.attributes.get(REDUCE_MOTION_ATTRIBUTE), "auto");
  } finally {
    if (originalDocument === undefined) delete globals.document;
    else globals.document = originalDocument;
    if (originalLocalStorage === undefined) delete globals.localStorage;
    else globals.localStorage = originalLocalStorage;
  }
});

test("(场景5) styles.css 示范消费点选择器面钉住（防漂移）", async () => {
  const cssPath = fileURLToPath(new URL("../src/styles.css", import.meta.url));
  const css = await readFile(cssPath, "utf8");
  // density：side-pane 开页签紧凑档。
  assert.ok(css.includes('[data-acode-density="compact"] .side-pane-open-tab-button'));
  // text-size：opt-in 组件档位调整；轴消费面不写 --ui-font-size（滑杆唯一写入者）。
  assert.ok(css.includes('[data-acode-text-size="lg"] .side-pane-open-tab-button-label'));
  assert.ok(css.includes('[data-acode-text-size="sm"] .side-pane-open-tab-button-label'));
  assert.ok(!/\[data-acode-text-size[^}]*--ui-font-size:/.test(css));
  // reduce-motion in-app 档：流式动画与 wf 运动词汇双门；collapsible 镜像带 !important。
  assert.ok(css.includes('[data-acode-reduce-motion="reduce"] [data-acode-stream-animate="true"]'));
  assert.ok(css.includes(".wf-lamp-running,"));
  assert.ok(
    /\[data-acode-reduce-motion="reduce"\][^}]*\[data-acode-collapsible-animate-close="true"\]\[data-state="closed"\][^}]*\{\s*animation: none !important/.test(
      css,
    ),
  );
});
