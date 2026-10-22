import assert from "node:assert/strict";
import test from "node:test";

/**
 * model-option-map 边界与守护测试（review 测试专项 P3：包无 test 脚本 + compiler 缓存无界）。
 *
 * 覆盖：
 * - evaluator：除零/取模零 → Infinity 非 JSON-safe 抛错、未知标识符、非安全整数、
 *   原型污染防护（__proto__ 成普通自有键，不污染 Object.prototype）、freezeJson 深冻结；
 * - compiler：空源抛错、map 必返对象、编译缓存淘汰后语义不变（有界 LRU 兜底）；
 * - merge-patch：路径冲突（pathsOverlap，父子路径重叠）、null 删除、disjoint 合并；
 * - bounded-cache：LRU 淘汰生效、命中刷新新近度、size/clear、非法上限拒绝。
 */
const {
  compileRestrictedCel,
  compileModelOptionMap,
  applyOrderedJsonMergePatches,
} = await import("../src/index.ts");
const { RestrictedCelError, ModelOptionMapError } = await import("../src/types.ts");
const { createBoundedCache } = await import("../src/bounded-cache.ts");

/** 断言 fn 抛 RestrictedCelError 且消息含 needle。 */
function throwsCel(fn, needle) {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof RestrictedCelError, `期望 RestrictedCelError，实际 ${error?.name}`);
      assert.match(error.message, new RegExp(needle));
      return true;
    },
  );
}

/**
 * 求值/合并结果是 null-prototype 对象（Object.create(null)，原型污染防护的一部分），
 * 而字面量期望值是 Object.prototype。strict deepEqual 会比较原型，故先把结果深归一为
 * 普通对象再比较值——这只影响断言的可读性，不改变被测产物。
 */
function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = plain(entry);
    return out;
  }
  return value;
}

// ── evaluator 边界 ────────────────────────────────────────────────

test("除零与取模零产生 Infinity → 非 JSON-safe 抛错（不静默返回 Infinity）", () => {
  throwsCel(() => compileRestrictedCel("1 / 0", "reasoningLevel").evaluate(1), "not JSON-safe");
  throwsCel(() => compileRestrictedCel("10 % 0", "reasoningLevel").evaluate(1), "not JSON-safe");
  // 输入本身非有限数也拒绝（assertRestrictedCelValue 走 assertNumber）。
  throwsCel(
    () => compileRestrictedCel("maxOutputTokens", "maxOutputTokens").evaluate(Number.POSITIVE_INFINITY),
    "not JSON-safe",
  );
});

test("未知标识符抛错（受限 CEL 不解析自由变量）", () => {
  throwsCel(() => compileRestrictedCel("foo", "reasoningLevel").evaluate(1), 'unknown identifier "foo"');
});

test("非安全整数字面量抛错（超出 JSON 安全整数范围）", () => {
  throwsCel(
    () => compileRestrictedCel("9007199254740993", "reasoningLevel").evaluate(1),
    "not JSON-safe",
  );
});

test("原型污染防护：__proto__ 作为普通自有键，不污染 Object.prototype", () => {
  const result = compileRestrictedCel(
    '{"__proto__": {"polluted": 1}}',
    "reasoningLevel",
  ).evaluate("x");
  // 结果是 null-proto 对象，__proto__ 只是一个普通枚举键，不触发原型链写入。
  assert.deepEqual(Object.keys(result), ["__proto__"]);
  assert.equal({}.polluted, undefined, "Object.prototype 必须未被污染");
  assert.equal(Object.getPrototypeOf({}).polluted, undefined);
});

test("freezeJson 深冻结：顶层、嵌套对象、数组都不可写", () => {
  const result = compileRestrictedCel('{"a": {"b": [1, 2]}}', "reasoningLevel").evaluate(1);
  assert.equal(Object.isFrozen(result), true, "顶层对象必须冻结");
  assert.equal(Object.isFrozen(result.a), true, "嵌套对象必须冻结");
  assert.equal(Object.isFrozen(result.a.b), true, "嵌套数组必须冻结");
});

// ── compiler 边界 ─────────────────────────────────────────────────

test("空源（含纯空白）抛错", () => {
  throwsCel(() => compileRestrictedCel("", "reasoningLevel"), "must not be empty");
  throwsCel(() => compileRestrictedCel("   \n\t ", "reasoningLevel"), "must not be empty");
  throwsCel(() => compileModelOptionMap("  ", "reasoningLevel"), "must not be empty");
});

test("model option map 必须返回 JSON 对象（标量/数组编译期即拒）", () => {
  throwsCel(() => compileModelOptionMap("42", "reasoningLevel"), "must return a JSON object");
  throwsCel(() => compileModelOptionMap("[1,2]", "reasoningLevel"), "must return a JSON object");
  // 条件表达式两支都必须返对象：任一非对象在编译期拒绝（assertObjectResultExpression 递归）。
  throwsCel(
    () => compileModelOptionMap('reasoningLevel == "a" ? {"x":1} : 5', "reasoningLevel"),
    "must return a JSON object",
  );
  // 合法对象映射正常求值。
  assert.deepEqual(
    plain(compileModelOptionMap('{"a": reasoningLevel}', "reasoningLevel").evaluate("hi")),
    { a: "hi" },
  );
});

test("member access 与 function call 被拒（受限 CEL 无属性访问/调用）", () => {
  throwsCel(() => compileRestrictedCel("a.b", "reasoningLevel").evaluate(1), /unknown identifier|member access/);
  throwsCel(() => compileRestrictedCel("f(1)", "reasoningLevel").evaluate(1), "function calls are not supported");
});

test("编译缓存淘汰后语义不变：编译远超上限的不同源，回头求值仍正确", () => {
  // 缓存上限 512（compiler 内部常量）。编译 600 个互不相同的表达式强制 LRU 淘汰，
  // 再回头求值最早编译过的几个——若淘汰破坏了语义（例如返回了错误缓存条目），这里会失配。
  const sources = [];
  for (let i = 0; i < 600; i += 1) {
    const program = compileRestrictedCel(`{"v": ${i}}`, "reasoningLevel");
    assert.deepEqual(plain(program.evaluate("x")), { v: i }, `第 ${i} 个编译结果即时校验失败`);
    sources.push(i);
  }
  // 回头重新编译最早的若干源：结果必须与首次逐字节一致（缓存命中或未命中都同结果）。
  for (const i of [0, 1, 2, 300, 599]) {
    assert.deepEqual(
      plain(compileRestrictedCel(`{"v": ${i}}`, "reasoningLevel").evaluate("x")),
      { v: i },
      `淘汰后重编译源 ${i} 语义漂移`,
    );
  }
  assert.ok(sources.length === 600);
});

// ── merge-patch 边界 ──────────────────────────────────────────────

test("pathsOverlap：父子路径重叠（一个写 $.deep.x，一个写 $.deep）判冲突", () => {
  assert.throws(
    () =>
      applyOrderedJsonMergePatches({}, [
        { option: "a", patch: { deep: { x: 1 } } },
        { option: "b", patch: { deep: 2 } },
      ]),
    (error) => {
      assert.ok(error instanceof ModelOptionMapError, `期望 ModelOptionMapError，实际 ${error?.name}`);
      assert.match(error.message, /conflicting JSON path \$\.deep/);
      assert.match(error.message, /a and b/);
      return true;
    },
  );
});

test("disjoint 路径合并不冲突；null 值删除既有键", () => {
  assert.deepEqual(
    plain(
      applyOrderedJsonMergePatches({}, [
        { option: "a", patch: { p: 1 } },
        { option: "b", patch: { q: 2 } },
      ]),
    ),
    { p: 1, q: 2 },
  );
  assert.deepEqual(
    plain(applyOrderedJsonMergePatches({ keep: 1, drop: 2 }, [{ option: "a", patch: { drop: null } }])),
    { keep: 1 },
    "null 补丁必须删除目标键",
  );
});

// ── bounded-cache LRU ─────────────────────────────────────────────

test("LRU：超限淘汰最久未用键；get 命中刷新新近度", () => {
  const cache = createBoundedCache(2);
  cache.set("k1", "v1");
  cache.set("k2", "v2");
  cache.get("k1"); // k1 变为最近使用 → k2 成为最久未用
  cache.set("k3", "v3"); // 淘汰 k2
  assert.equal(cache.size, 2, "size 必须钉在上限");
  assert.equal(cache.get("k1"), "v1", "最近使用的 k1 必须存活");
  assert.equal(cache.get("k2"), undefined, "最久未用的 k2 必须被淘汰");
  assert.equal(cache.get("k3"), "v3");
});

test("LRU：覆盖已有键不增长 size；clear 清空", () => {
  const cache = createBoundedCache(3);
  cache.set("a", 1);
  cache.set("a", 2);
  assert.equal(cache.size, 1);
  assert.equal(cache.get("a"), 2);
  cache.set("b", 3);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get("a"), undefined);
});

test("LRU：非法上限（0 / 负数 / 非整数）构造即拒绝", () => {
  assert.throws(() => createBoundedCache(0), /positive integer/);
  assert.throws(() => createBoundedCache(-1), /positive integer/);
  assert.throws(() => createBoundedCache(1.5), /positive integer/);
});
