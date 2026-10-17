import assert from "node:assert/strict";
import test from "node:test";
import {
  loadPromptPolishModelPreference,
  normalizePromptPolishModelSelection,
  PROMPT_POLISH_MODEL_STORAGE_KEY,
  setPromptPolishModelPreference,
  subscribeToPromptPolishStorageChanges,
} from "../src/lib/promptPolishPreferences.js";
import { applyBroadcast } from "../src/store/promptPolishPreferencesState.js";

/**
 * 润色模型偏好持久化契约（specs/prompt-polish.md 验收场景 3）：localStorage 读写、
 * 垃圾值归一、跨窗 storage 订阅只认本键。ui 测试无 jsdom 先例：storage/window
 * 全部手搓结构化替身（appearancePreferences.test.ts 同款纪律）。
 */

const globals = globalThis as Record<string, unknown>;

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

test("归一化：合法选择 trim 后保留，垃圾值一律 null", () => {
  assert.deepEqual(normalizePromptPolishModelSelection({ providerId: " zhipu ", modelId: "glm " }), {
    providerId: "zhipu",
    modelId: "glm",
  });
  for (const garbage of [
    null,
    undefined,
    "",
    "zhipu/glm",
    42,
    [],
    { providerId: "zhipu" },
    { modelId: "glm" },
    { providerId: "  ", modelId: "glm" },
    { providerId: 1, modelId: "glm" },
  ]) {
    assert.equal(normalizePromptPolishModelSelection(garbage), null, `垃圾值未归一: ${JSON.stringify(garbage)}`);
  }
});

test("读写回环：set 写归一化 JSON，load 读回；null 清除", () => {
  const storage = createFakeStorage();
  withStorage(storage, () => {
    assert.equal(loadPromptPolishModelPreference(), null);

    const next = setPromptPolishModelPreference({ providerId: "zhipu", modelId: "glm-a" });
    assert.deepEqual(next, { providerId: "zhipu", modelId: "glm-a" });
    assert.equal(
      storage.values.get(PROMPT_POLISH_MODEL_STORAGE_KEY),
      JSON.stringify({ providerId: "zhipu", modelId: "glm-a" }),
    );
    assert.deepEqual(loadPromptPolishModelPreference(), { providerId: "zhipu", modelId: "glm-a" });

    // 垃圾输入经唯一写入口也被归一成清除，不会把坏值写进持久面。
    assert.equal(setPromptPolishModelPreference({ providerId: "", modelId: "" }), null);
    assert.equal(loadPromptPolishModelPreference(), null);
  });
});

test("load 对持久面垃圾值鲁棒：坏 JSON/坏形状收敛 null 不抛错", () => {
  withStorage(createFakeStorage({ [PROMPT_POLISH_MODEL_STORAGE_KEY]: "{broken json" }), () => {
    assert.equal(loadPromptPolishModelPreference(), null);
  });
  withStorage(
    createFakeStorage({ [PROMPT_POLISH_MODEL_STORAGE_KEY]: JSON.stringify({ providerId: "p" }) }),
    () => {
      assert.equal(loadPromptPolishModelPreference(), null);
    },
  );
  withStorage(createFakeStorage({ [PROMPT_POLISH_MODEL_STORAGE_KEY]: "42" }), () => {
    assert.equal(loadPromptPolishModelPreference(), null);
  });
});

test("跨窗订阅：只认本键，事件到达时回读持久面；退订后不再响应", () => {
  const storage = createFakeStorage();
  const handlers: Array<(event: { key: string | null }) => void> = [];
  const fakeWindow = {
    // browserEnvironment 优先走 window.localStorage 分支：替身必须带同一 storage。
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
  globals.window = fakeWindow;
  try {
    withStorage(storage, () => {
      const received: unknown[] = [];
      const unsubscribe = subscribeToPromptPolishStorageChanges((next) => received.push(next));
      assert.equal(handlers.length, 1);

      handlers[0]({ key: "acode-theme" });
      assert.equal(received.length, 0, "无关键不得触发");

      storage.values.set(
        PROMPT_POLISH_MODEL_STORAGE_KEY,
        JSON.stringify({ providerId: "other", modelId: "m1" }),
      );
      handlers[0]({ key: PROMPT_POLISH_MODEL_STORAGE_KEY });
      assert.deepEqual(received, [{ providerId: "other", modelId: "m1" }]);

      unsubscribe();
      assert.equal(handlers.length, 0);
      // 退订后即使持久值再变化也没有响应面（handler 已从 window 移除）。
      storage.values.delete(PROMPT_POLISH_MODEL_STORAGE_KEY);
      assert.equal(received.length, 1);
    });
  } finally {
    if (originalWindow === undefined) delete globals.window;
    else globals.window = originalWindow;
  }
});

test("广播收件：null 清除、合法载荷归一化转发、垃圾载荷忽略（不能抹掉本窗持久值）", () => {
  const received: unknown[] = [];
  const setter = (value: unknown) => received.push(value);
  applyBroadcast(setter as never, null);
  applyBroadcast(setter as never, { providerId: " zhipu ", modelId: "glm-a" });
  applyBroadcast(setter as never, { providerId: "", modelId: "glm-a" });
  applyBroadcast(setter as never, "zhipu/glm-a");
  applyBroadcast(setter as never, 42);
  assert.deepEqual(received, [
    null,
    { providerId: "zhipu", modelId: "glm-a" },
  ]);
});
