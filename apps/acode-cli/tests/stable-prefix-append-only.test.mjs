import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * WI-10 验收测试（specs/stable-prefix-pause-gate.md R1/R2）：
 *
 * R1 StablePrefix 字节稳定前缀：
 * 1. 同输入两次构建（两个 builder 实例、同 sessionId）→ 返回同一冻结对象，
 *    systemMessages/metaUserAttachments 逐字节相等，version 不涨；
 * 2. invalidate 后重建 → 新对象、version 递增、字节仍相等（等价重建）；
 * 3. 输入变化（currentDate）→ 新快照、新字节、version 递增；旧 result 持有者
 *    字节不被原地改写；
 * 4. sessionId 缺席 → builder 实例私有缓存：同实例稳定、跨实例不共享。
 *
 * R2 追加不重序列化：
 * 5. replaceMessages 身份复用：引用相等的会话尾部保留原对象（===），前缀/分叉
 *    位置为新克隆，内容逐字节不变；
 * 6. add*（user/assistant/tool/attachment）纯追加：既有 entry 对象身份不变。
 *
 * 全部断言零真实时序（无计时器/忙等）：冻结与身份都是同步事实。
 */

const { createContextBuilder } = await import("../packages/core/src/context/builder.ts");
const {
  StablePrefixCache,
  clearStablePrefixCaches,
  getStablePrefixCache,
  invalidateStablePrefixCache,
  serializeContextBuildResult,
  stablePrefixFingerprint,
} = await import("../packages/core/src/context/stable-prefix.ts");
const { createMessageHistory, systemReminderAttachmentEntry } = await import(
  "../packages/core/src/agent/message-history.ts"
);

const ENV_INFO = {
  cwd: "C:/tmp/acode-wi10-test",
  platform: "win32",
  shell: "bash",
  osVersion: "10.0.26200 x64",
  nodeVersion: "v24.0.0",
};

const NO_FLAGS = { disabledSections: [], manifestTrace: false };

function baseConfig(overrides = {}) {
  return {
    workingDirectory: ENV_INFO.cwd,
    envInfo: ENV_INFO,
    currentDate: "2026-10-18",
    guidanceToolNames: ["Read", "Bash", "Skill"],
    prompt: NO_FLAGS,
    ...overrides,
  };
}

function bytesOf(result) {
  return JSON.stringify({
    m: result.systemMessages,
    a: result.metaUserAttachments,
    s: result.sections.map((section) => [section.source, section.content]),
  });
}

// ── R1：StablePrefixCache 单元语义 ────────────────────────────────

test("(R1) StablePrefixCache：store/reuse/invalidate/version/fingerprint", () => {
  const cache = new StablePrefixCache();
  assert.equal(cache.built, false);
  assert.equal(cache.fingerprint, "<unbuilt>");
  assert.equal(cache.version, 0);

  const resultA = { marker: "A" };
  assert.equal(cache.store("serialized-a", resultA), true);
  assert.equal(cache.version, 1);
  assert.equal(cache.built, true);
  assert.equal(cache.reuse("serialized-a"), resultA);
  assert.equal(cache.reuse("serialized-b"), null);
  assert.equal(cache.fingerprint, stablePrefixFingerprint("serialized-a"));

  cache.invalidate();
  assert.equal(cache.built, false);
  assert.equal(cache.reuse("serialized-a"), null);
  // version 保留（漂移观测跨失效累计）。
  assert.equal(cache.version, 1);

  const resultB = { marker: "B" };
  cache.store("serialized-a", resultB);
  assert.equal(cache.version, 2);
  assert.equal(cache.reuse("serialized-a"), resultB);
});

test("(R1) 序列化投影确定性：同 result 两次序列化逐字节相等；指纹稳定", () => {
  const result = createContextBuilder(baseConfig()).build();
  const first = serializeContextBuildResult(result);
  const second = serializeContextBuildResult(result);
  assert.equal(first, second);
  assert.equal(stablePrefixFingerprint(first), stablePrefixFingerprint(second));
});

// ── R1：builder 输出层冻结 ────────────────────────────────────────

test("(R1) 同输入两次构建（同 sessionId、两个实例）→ 同一冻结对象、逐字节相等", () => {
  clearStablePrefixCaches();
  const sessionId = "wi10-freeze-shared";
  const builderA = createContextBuilder(baseConfig({ sessionId }));
  const resultA = builderA.build();

  // rebuildContextPrefix 每 turn 新建 builder：跨实例必须拿回同一冻结对象。
  const builderB = createContextBuilder(baseConfig({ sessionId }));
  const resultB = builderB.build();

  assert.equal(resultB, resultA, "同输入 ⇒ 同对象（同引用 ⇒ 同字节）");
  assert.equal(bytesOf(resultB), bytesOf(resultA));

  const cache = getStablePrefixCache(sessionId);
  assert.equal(cache.version, 1, "等价重建不涨 version");
  assert.equal(cache.built, true);
  clearStablePrefixCaches();
});

test("(R1) invalidate 后重建：新对象、version 递增、字节仍相等", () => {
  clearStablePrefixCaches();
  const sessionId = "wi10-freeze-invalidate";
  const resultA = createContextBuilder(baseConfig({ sessionId })).build();
  const cache = getStablePrefixCache(sessionId);

  assert.equal(invalidateStablePrefixCache(sessionId), true);
  assert.equal(invalidateStablePrefixCache("wi10-unknown-key"), false);

  const resultB = createContextBuilder(baseConfig({ sessionId })).build();
  assert.notEqual(resultB, resultA, "invalidate 后必须重拍快照");
  assert.equal(bytesOf(resultB), bytesOf(resultA), "等价重拍：字节不变");
  assert.equal(cache.version, 2);
  clearStablePrefixCaches();
});

test("(R1) 输入变化 → 新快照新字节、version 递增；旧持有者字节不被改写", () => {
  clearStablePrefixCaches();
  const sessionId = "wi10-freeze-drift";
  const resultA = createContextBuilder(baseConfig({ sessionId })).build();
  const bytesA = bytesOf(resultA);

  const resultB = createContextBuilder(
    baseConfig({ sessionId, currentDate: "2026-10-19" }),
  ).build();
  assert.notEqual(resultB, resultA);
  assert.notEqual(bytesOf(resultB), bytesA, "日期段变化必须体现在字节上");
  assert.equal(bytesOf(resultA), bytesA, "旧 result 持有者字节永不被原地改写");
  assert.equal(getStablePrefixCache(sessionId).version, 2);

  // 变回原输入：与 resultB 不同、与 resultA 字节相等（重新冻结为新对象）。
  const resultC = createContextBuilder(baseConfig({ sessionId })).build();
  assert.notEqual(resultC, resultA);
  assert.equal(bytesOf(resultC), bytesA);
  assert.equal(getStablePrefixCache(sessionId).version, 3);
  clearStablePrefixCaches();
});

test("(R1) sessionId 缺席 → 实例私有缓存：同实例稳定、跨实例不共享", () => {
  clearStablePrefixCaches();
  const builder = createContextBuilder(baseConfig());
  const first = builder.build();
  const second = builder.build();
  assert.equal(second, first, "同实例（私有缓存）⇒ 同对象");

  const other = createContextBuilder(baseConfig()).build();
  assert.notEqual(other, first, "无 sessionId 的实例之间绝不共享冻结字节");
  assert.equal(bytesOf(other), bytesOf(first));

  // 实例私有缓存也能显式失效（builder 门面）。
  builder.invalidateStablePrefix();
  assert.notEqual(builder.build(), first);
  clearStablePrefixCaches();
});

test("(R1) 注册表 LRU 上限：超量键逐出最久未用，正确性无损", async () => {
  clearStablePrefixCaches();
  for (let i = 0; i < 40; i++) {
    createContextBuilder(baseConfig({ sessionId: `wi10-lru-${i}` })).build();
  }
  // 最早的键已被逐出：invalidateStablePrefixCache 找不到条目。
  assert.equal(invalidateStablePrefixCache("wi10-lru-0"), false);
  // 最近的键仍在。
  assert.equal(invalidateStablePrefixCache("wi10-lru-39"), true);
  // 被逐出的键重建仍得到正确字节。
  const fresh = createContextBuilder(baseConfig({ sessionId: "wi10-lru-0" })).build();
  assert.equal(bytesOf(fresh), bytesOf(createContextBuilder(baseConfig()).build()));
  clearStablePrefixCaches();
});

// ── R2：追加不重序列化 ────────────────────────────────────────────

function seedHistory() {
  const history = createMessageHistory();
  history.init([
    { message: { role: "system", content: "SYSTEM BLOCK" } },
    systemReminderAttachmentEntry("skills_listing", "SKILLS LISTING"),
    systemReminderAttachmentEntry("context_prefix", "CONTEXT PREFIX"),
  ]);
  history.addUser("hello");
  history.addAssistant("hi there", [{ id: "tc1", name: "Read", input: {} }]);
  history.addToolResult("tc1", "Read", "file body", true, false);
  return history;
}

test("(R2) replaceMessages 身份复用：context-refresh 形态下会话尾部零重拷贝", () => {
  const history = seedHistory();
  const before = history.borrowReadOnlyRuntimeEntries();
  const conversationTail = before.slice(3);

  // 每 turn context-refresh 的确切形态：全新前缀 entries + 借出的会话尾部原引用。
  const freshPrefix = [
    { message: { role: "system", content: "SYSTEM BLOCK" } },
    systemReminderAttachmentEntry("skills_listing", "SKILLS LISTING"),
    systemReminderAttachmentEntry("context_prefix", "CONTEXT PREFIX REBUILT"),
  ];
  history.replaceMessages([...freshPrefix, ...conversationTail]);

  const after = history.borrowReadOnlyRuntimeEntries();
  assert.equal(after.length, 6);
  for (let i = 0; i < conversationTail.length; i++) {
    assert.equal(after[3 + i], conversationTail[i], `会话尾部第 ${i} 条必须保留原对象`);
  }
  assert.notEqual(after[2], before[2], "前缀条目是新克隆");
  assert.equal(after[2].content, "CONTEXT PREFIX REBUILT");
  // 内容逐字节不变（尾部）。
  assert.deepEqual(
    JSON.parse(JSON.stringify(after.slice(3))),
    JSON.parse(JSON.stringify(conversationTail)),
  );
});

test("(R2) replaceMessages 分叉点：引用不等处为新克隆，引用相等处按位保留身份", () => {
  const history = seedHistory();
  const before = [...history.borrowReadOnlyRuntimeEntries()];

  const diverged = [...before];
  diverged[4] = { message: { role: "assistant", content: "rewritten" } };
  history.replaceMessages(diverged);

  const after = history.borrowReadOnlyRuntimeEntries();
  assert.equal(after[0], before[0], "引用相等条目身份保留");
  assert.equal(after[3], before[3]);
  assert.notEqual(after[4], before[4], "分叉条目（新对象）为新克隆");
  assert.equal(after[4].message.content, "rewritten");
  // 身份复用是按位的：分叉点之后引用仍相等的条目同样保留原对象（实现语义，
  // 比 omp「截到最长稳定前缀再重放」复用面更宽；内容不变 ⇒ 字节不变）。
  assert.equal(after[5], before[5]);
});

test("(R2) add* 纯追加：既有 entry 对象身份不变（旧 turn 永不重序列化）", () => {
  const history = seedHistory();
  const before = [...history.borrowReadOnlyRuntimeEntries()];

  history.addUser("next question");
  history.addAssistant("answer");
  history.addToolResult("tc2", "Bash", "ok", true, false);
  history.addAttachment("todo_reminder", "reminder body");

  const after = history.borrowReadOnlyRuntimeEntries();
  assert.equal(after.length, before.length + 4);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i], before[i], `既有第 ${i} 条必须原对象不动`);
  }
});
