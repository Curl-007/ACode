// WorkspaceShellLayout 批次 5 外迁（workspaceSidebarWidth）的接缝内决策表测试。
// window/localStorage 用最小桩（Object.assign globalThis，测试后还原），覆盖 SSR 守卫与异常分支。
import assert from "node:assert/strict";
import test from "node:test";

import {
  clampWorkspaceSidebarWidth,
  LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY,
  persistWorkspaceSidebarWidthPx,
  readLegacyWorkspaceSidebarWidthRatio,
  readStoredWorkspaceSidebarWidthPx,
  WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX,
  WORKSPACE_SIDEBAR_MIN_WIDTH_PX,
  WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY,
} from "../src/app-shell/workspaceSidebarWidth.js";

/** 安装最小 window.localStorage 桩并返回还原函数。 */
const installLocalStorageStub = (
  store: Record<string, string>,
  overrides: { throwOnAccess?: boolean } = {},
): (() => void) => {
  const stub = {
    localStorage: {
      getItem: (key: string): string | null => {
        if (overrides.throwOnAccess) throw new Error("denied");
        const value = store[key];
        return value === undefined ? null : value;
      },
      setItem: (key: string, value: string): void => {
        if (overrides.throwOnAccess) throw new Error("denied");
        store[key] = value;
      },
    },
  };
  // 测试桩：最小 localStorage 面覆盖被测函数全部分支；Object.assign 避免对 globalThis 的断言。
  const originalWindow = globalThis.window;
  Object.assign(globalThis, { window: stub });
  return () => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.assign(globalThis, { window: originalWindow });
    }
  };
};

test("clampWorkspaceSidebarWidth：下限 / 容器比例上限 / 取整", () => {
  assert.equal(clampWorkspaceSidebarWidth(100), WORKSPACE_SIDEBAR_MIN_WIDTH_PX);
  assert.equal(clampWorkspaceSidebarWidth(264), 264);
  assert.equal(clampWorkspaceSidebarWidth(300.6), 301);
  // 无容器宽度时无上限。
  assert.equal(clampWorkspaceSidebarWidth(99999), 99999);
  // 容器 800 → 上限 400。
  assert.equal(clampWorkspaceSidebarWidth(500, 800), 400);
  // 容器太窄时上限不小于 MIN（500 * 0.5 = 250 < 264 → 264）。
  assert.equal(clampWorkspaceSidebarWidth(300, 500), 264);
  // 容器宽度非正数视为无上限。
  assert.equal(clampWorkspaceSidebarWidth(999, 0), 999);
});

test("readStoredWorkspaceSidebarWidthPx：无 window / 缺 key / 非法值 / 钳制", () => {
  assert.equal(readStoredWorkspaceSidebarWidthPx(), null);

  const store: Record<string, string> = {};
  let restore = installLocalStorageStub(store);
  try {
    assert.equal(readStoredWorkspaceSidebarWidthPx(), null);
    store[WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY] = "320";
    assert.equal(readStoredWorkspaceSidebarWidthPx(), 320);
    // 读取也经过 clamp（小于下限被抬回 264）。
    store[WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY] = "10";
    assert.equal(readStoredWorkspaceSidebarWidthPx(), WORKSPACE_SIDEBAR_MIN_WIDTH_PX);
    store[WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY] = "abc";
    assert.equal(readStoredWorkspaceSidebarWidthPx(), null);
    store[WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY] = "-5";
    assert.equal(readStoredWorkspaceSidebarWidthPx(), null);
  } finally {
    restore();
  }

  // localStorage 抛错（隐私模式）→ null。
  restore = installLocalStorageStub({}, { throwOnAccess: true });
  try {
    assert.equal(readStoredWorkspaceSidebarWidthPx(), null);
  } finally {
    restore();
  }
});

test("readLegacyWorkspaceSidebarWidthRatio：JSON 解析与 0-100 → 0-1 换算", () => {
  assert.equal(readLegacyWorkspaceSidebarWidthRatio(), null);

  const store: Record<string, string> = {};
  const restore = installLocalStorageStub(store);
  try {
    assert.equal(readLegacyWorkspaceSidebarWidthRatio(), null);
    store[LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY] = JSON.stringify({ sidebar: 25 });
    assert.equal(readLegacyWorkspaceSidebarWidthRatio(), 0.25);
    store[LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY] = "not-json";
    assert.equal(readLegacyWorkspaceSidebarWidthRatio(), null);
    store[LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY] = JSON.stringify({ sidebar: 0 });
    assert.equal(readLegacyWorkspaceSidebarWidthRatio(), null);
    store[LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY] = JSON.stringify({});
    assert.equal(readLegacyWorkspaceSidebarWidthRatio(), null);
  } finally {
    restore();
  }
});

test("persistWorkspaceSidebarWidthPx：取整写入 / 无 window 静默 / 异常吞咽", () => {
  persistWorkspaceSidebarWidthPx(300); // 无 window：不抛错

  const store: Record<string, string> = {};
  let restore = installLocalStorageStub(store);
  try {
    persistWorkspaceSidebarWidthPx(320.6);
    assert.equal(store[WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY], "321");
  } finally {
    restore();
  }

  restore = installLocalStorageStub({}, { throwOnAccess: true });
  try {
    persistWorkspaceSidebarWidthPx(300); // 写入抛错被吞咽
  } finally {
    restore();
  }
});

test("默认宽度常量与下限一致（懒初始化缺省语义）", () => {
  assert.equal(WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX, WORKSPACE_SIDEBAR_MIN_WIDTH_PX);
});
