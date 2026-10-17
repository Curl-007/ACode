import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_USAGE_STATUSBAR_PREFERENCES,
  getUsageStatusbarPreferencesSnapshot,
  isSameUsageStatusbarPreferences,
  loadUsageStatusbarPreferences,
  normalizeUsageStatusbarPreferences,
  setUsageStatusbarPreferences,
  subscribeToUsageStatusbarPreferences,
  USAGE_STATUSBAR_PREFERENCES_STORAGE_KEY,
} from "../src/lib/usageStatusbarPreferences.js";
import * as usageStatusbarState from "../src/store/usageStatusbarPreferencesState.js";

// 偏好两件套契约测试（照 appearancePreferences.test.ts 纪律：无 jsdom，
// localStorage 经 globalThis 注入结构化替身——browserEnvironment 的裸 localStorage 分支）。

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

const globals = globalThis as Record<string, unknown>;

function withStorage(storage: ReturnType<typeof createFakeStorage>, run: () => void) {
  const original = globals.localStorage;
  globals.localStorage = storage;
  try {
    run();
  } finally {
    if (original === undefined) {
      delete globals.localStorage;
    } else {
      globals.localStorage = original;
    }
  }
}

test("normalizeUsageStatusbarPreferences：垃圾值归一收敛默认（全开），不抛错", () => {
  assert.deepEqual(normalizeUsageStatusbarPreferences(null), DEFAULT_USAGE_STATUSBAR_PREFERENCES);
  assert.deepEqual(
    normalizeUsageStatusbarPreferences("garbage"),
    DEFAULT_USAGE_STATUSBAR_PREFERENCES,
  );
  const normalized = normalizeUsageStatusbarPreferences({
    visibleItems: { generationSpeed: false, turnUsage: "yes", toolCalls: 0, unknownItem: true },
    rateLineEnabled: "off",
    junk: 1,
  });
  assert.equal(normalized.visibleItems.generationSpeed, false);
  // 非 boolean 值 → 默认 true；闭集外的键被丢弃。
  assert.equal(normalized.visibleItems.turnUsage, true);
  assert.equal(normalized.visibleItems.toolCalls, true);
  assert.equal("unknownItem" in normalized.visibleItems, false);
  assert.equal(normalized.rateLineEnabled, true);
});

test("loadUsageStatusbarPreferences：空/坏 JSON → 默认；有效值逐键归一", () => {
  withStorage(createFakeStorage(), () => {
    assert.deepEqual(loadUsageStatusbarPreferences(), DEFAULT_USAGE_STATUSBAR_PREFERENCES);
  });
  withStorage(createFakeStorage({ [USAGE_STATUSBAR_PREFERENCES_STORAGE_KEY]: "{not json" }), () => {
    assert.deepEqual(loadUsageStatusbarPreferences(), DEFAULT_USAGE_STATUSBAR_PREFERENCES);
  });
  withStorage(
    createFakeStorage({
      [USAGE_STATUSBAR_PREFERENCES_STORAGE_KEY]: JSON.stringify({
        visibleItems: { todayTotal: false },
        rateLineEnabled: false,
      }),
    }),
    () => {
      const loaded = loadUsageStatusbarPreferences();
      assert.equal(loaded.visibleItems.todayTotal, false);
      // 缺席键保持默认（全开）。
      assert.equal(loaded.visibleItems.subagents, true);
      assert.equal(loaded.rateLineEnabled, false);
    },
  );
});

test("setUsageStatusbarPreferences：唯一写入口——合并补丁、持久化 JSON、值级变化才通知", () => {
  const storage = createFakeStorage();
  withStorage(storage, () => {
    let notifications = 0;
    const unsubscribe = subscribeToUsageStatusbarPreferences(() => {
      notifications += 1;
    });
    try {
      const next = setUsageStatusbarPreferences({ visibleItems: { subagents: false } });
      assert.equal(next.visibleItems.subagents, false);
      assert.equal(next.visibleItems.generationSpeed, true);
      assert.equal(notifications, 1);
      assert.deepEqual(
        JSON.parse(storage.values.get(USAGE_STATUSBAR_PREFERENCES_STORAGE_KEY) ?? "null"),
        next,
      );
      assert.equal(getUsageStatusbarPreferencesSnapshot().visibleItems.subagents, false);

      // 同值重写不通知（防回环放大）。
      setUsageStatusbarPreferences({ visibleItems: { subagents: false } });
      assert.equal(notifications, 1);

      // 部分补丁不覆盖其他键。
      setUsageStatusbarPreferences({ rateLineEnabled: false });
      assert.equal(notifications, 2);
      const persisted = JSON.parse(
        storage.values.get(USAGE_STATUSBAR_PREFERENCES_STORAGE_KEY) ?? "null",
      ) as ReturnType<typeof loadUsageStatusbarPreferences>;
      assert.equal(persisted.rateLineEnabled, false);
      assert.equal(persisted.visibleItems.subagents, false);

      // 垃圾补丁值经写入口归一。
      const normalized = setUsageStatusbarPreferences({
        rateLineEnabled: "nope" as unknown as boolean,
      });
      assert.equal(normalized.rateLineEnabled, true);
    } finally {
      unsubscribe();
    }
  });
});

test("isSameUsageStatusbarPreferences：值级比较，忽略对象引用", () => {
  const left = loadUsageStatusbarPreferencesLike();
  const right = loadUsageStatusbarPreferencesLike();
  assert.notEqual(left, right);
  assert.equal(isSameUsageStatusbarPreferences(left, right), true);
  assert.equal(
    isSameUsageStatusbarPreferences(left, { ...right, rateLineEnabled: !right.rateLineEnabled }),
    false,
  );

  function loadUsageStatusbarPreferencesLike() {
    return normalizeUsageStatusbarPreferences(null);
  }
});

test("store 切片：createSlice 初始值来自事实源；setter 经 lib 收口；applyBroadcast 只认对象", () => {
  const storage = createFakeStorage({
    [USAGE_STATUSBAR_PREFERENCES_STORAGE_KEY]: JSON.stringify({
      visibleItems: { toolCalls: false },
      rateLineEnabled: false,
    }),
  });
  withStorage(storage, () => {
    const writes: Array<Partial<usageStatusbarState.UsageStatusbarPreferencesSlice>> = [];
    let state: usageStatusbarState.UsageStatusbarPreferencesSlice | null = null;
    state = usageStatusbarState.createSlice({
      readState: () => state as usageStatusbarState.UsageStatusbarPreferencesSlice,
      writeState: (patch) => {
        writes.push(patch);
        state = { ...(state as usageStatusbarState.UsageStatusbarPreferencesSlice), ...patch };
      },
    });
    assert.equal(state.usageStatusbarPreferences.visibleItems.toolCalls, false);
    assert.equal(state.usageStatusbarPreferences.rateLineEnabled, false);

    state.setUsageStatusbarPreferences({ visibleItems: { toolCalls: true } });
    assert.equal(writes.length, 1);
    assert.equal(state.usageStatusbarPreferences.visibleItems.toolCalls, true);
    // lib 事实源同步更新（唯一写入口）。
    assert.equal(loadUsageStatusbarPreferences().visibleItems.toolCalls, true);

    // 同值 set 不写 store。
    state.setUsageStatusbarPreferences({ visibleItems: { toolCalls: true } });
    assert.equal(writes.length, 1);

    // 广播收件：非对象载荷忽略；对象载荷经 setter 归一。
    usageStatusbarState.applyBroadcast(state.setUsageStatusbarPreferences, "garbage");
    assert.equal(writes.length, 1);
    usageStatusbarState.applyBroadcast(state.setUsageStatusbarPreferences, {
      visibleItems: { todayTotal: false },
    });
    assert.equal(writes.length, 2);
    assert.equal(state.usageStatusbarPreferences.visibleItems.todayTotal, false);
    // 缺席键保持本窗持久值（广播值不整体信任）。
    assert.equal(state.usageStatusbarPreferences.visibleItems.toolCalls, true);
  });
});
