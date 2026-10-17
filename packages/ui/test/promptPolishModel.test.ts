import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPromptPolishMessages,
  isPromptPolishModelAvailable,
  isSamePromptPolishModel,
  preparePromptPolishRequest,
  PROMPT_POLISH_DEFAULT_MAX_OUTPUT_TOKENS,
  PROMPT_POLISH_QUERY_SOURCE,
  PROMPT_POLISH_SYSTEM_INSTRUCTION,
  resolvePromptPolishModel,
  type PromptPolishCatalog,
} from "../src/v4/composer/promptPolishModel.js";

/**
 * 润色模型解析契约（specs/prompt-polish.md 验收场景 1）：阶梯各档命中、
 * 「已解析则不覆盖」守卫回归钉住、无可用候选给可读错误且零请求发出。
 */

const catalog: PromptPolishCatalog = {
  providers: [
    {
      providerId: "zhipu",
      models: [
        { modelId: "glm-a", config: { enabled: true } },
        { modelId: "glm-b", config: { enabled: true } },
        { modelId: "glm-off", config: { enabled: false } },
      ],
    },
    {
      providerId: "other",
      models: [{ modelId: "m1", config: { enabled: true } }],
    },
  ],
};

const zhipuA = { providerId: "zhipu", modelId: "glm-a" };
const zhipuB = { providerId: "zhipu", modelId: "glm-b" };
const zhipuOff = { providerId: "zhipu", modelId: "glm-off" };
const otherM1 = { providerId: "other", modelId: "m1" };

test("可用性判定：目录内且未禁用才可用", () => {
  assert.equal(isPromptPolishModelAvailable(catalog, zhipuA), true);
  assert.equal(isPromptPolishModelAvailable(catalog, zhipuOff), false);
  assert.equal(isPromptPolishModelAvailable(catalog, { providerId: "zhipu", modelId: "ghost" }), false);
  assert.equal(isPromptPolishModelAvailable(catalog, { providerId: "ghost", modelId: "glm-a" }), false);
  assert.equal(isPromptPolishModelAvailable(null, zhipuA), false);
  assert.equal(isPromptPolishModelAvailable(catalog, null), false);
  // config 缺失 = 目录未声明禁用，视为可用（结构兼容 ModelSelectionView 的可选投影）。
  assert.equal(
    isPromptPolishModelAvailable({ providers: [{ providerId: "p", models: [{ modelId: "m" }] }] }, {
      providerId: "p",
      modelId: "m",
    }),
    true,
  );
});

test("阶梯各档命中：explicit → persisted → session，逐档降级", () => {
  assert.deepEqual(resolvePromptPolishModel({ explicit: zhipuA, catalog }), {
    status: "resolved",
    selection: zhipuA,
    source: "explicit",
  });
  assert.deepEqual(resolvePromptPolishModel({ persisted: zhipuB, catalog }), {
    status: "resolved",
    selection: zhipuB,
    source: "persisted",
  });
  assert.deepEqual(resolvePromptPolishModel({ session: otherM1, catalog }), {
    status: "resolved",
    selection: otherM1,
    source: "session",
  });
});

test("守卫回归：已解析档位绝不被低档覆盖（源项目静默覆盖教训）", () => {
  // 三档全可用 → 必须取 explicit，persisted/session 不得改写结果。
  const resolution = resolvePromptPolishModel({
    explicit: zhipuA,
    persisted: zhipuB,
    session: otherM1,
    catalog,
  });
  assert.deepEqual(resolution, { status: "resolved", selection: zhipuA, source: "explicit" });
  // explicit 缺席 → persisted 命中后 session 不得覆盖。
  assert.deepEqual(resolvePromptPolishModel({ persisted: zhipuB, session: otherM1, catalog }), {
    status: "resolved",
    selection: zhipuB,
    source: "persisted",
  });
});

test("档位不可用降档：不可用档进 rejectedTiers，绝不发静默改写的高档结果", () => {
  const resolution = resolvePromptPolishModel({
    explicit: zhipuOff,
    persisted: zhipuB,
    catalog,
  });
  assert.deepEqual(resolution, { status: "resolved", selection: zhipuB, source: "persisted" });
  const sessionFallback = resolvePromptPolishModel({
    explicit: { providerId: "gone", modelId: "gone" },
    session: otherM1,
    catalog,
  });
  assert.deepEqual(sessionFallback, {
    status: "resolved",
    selection: otherM1,
    source: "session",
  });
});

test("无可用候选：可读 unavailable，reason 区分目录空与档位落空", () => {
  const noCandidates = resolvePromptPolishModel({ catalog: { providers: [] } });
  assert.equal(noCandidates.status, "unavailable");
  assert.equal(noCandidates.status === "unavailable" && noCandidates.reason, "no-candidates");

  const tierMiss = resolvePromptPolishModel({ explicit: zhipuOff, catalog });
  assert.equal(tierMiss.status, "unavailable");
  if (tierMiss.status === "unavailable") {
    assert.equal(tierMiss.reason, "tier-miss");
    assert.deepEqual(tierMiss.rejectedTiers, ["explicit"]);
  }

  // 目录里只有禁用模型也算无候选。
  const allDisabled = resolvePromptPolishModel({
    catalog: { providers: [{ providerId: "p", models: [{ modelId: "m", config: { enabled: false } }] }] },
  });
  assert.equal(allDisabled.status, "unavailable");
  assert.equal(allDisabled.status === "unavailable" && allDisabled.reason, "no-candidates");
});

test("垃圾值归一：非法档位对象视同未提供，不污染阶梯", () => {
  const resolution = resolvePromptPolishModel({
    explicit: { providerId: "  ", modelId: "glm-a" } as never,
    persisted: "nonsense" as never,
    session: zhipuA,
    catalog,
  });
  assert.deepEqual(resolution, { status: "resolved", selection: zhipuA, source: "session" });
});

test("请求预检：空/纯空白草稿与无模型都零请求发出", () => {
  const resolved = resolvePromptPolishModel({ explicit: zhipuA, catalog });
  for (const draftText of ["", "   ", "\n\t "]) {
    const prepared = preparePromptPolishRequest({ draftText, resolution: resolved });
    assert.deepEqual(prepared, { ok: false, issue: "empty-draft" });
  }
  const unavailable = resolvePromptPolishModel({ catalog: { providers: [] } });
  const blocked = preparePromptPolishRequest({ draftText: "帮我改代码", resolution: unavailable });
  assert.deepEqual(blocked, { ok: false, issue: "no-model" });
  // issue 形态不携带任何可发请求的字段（selection/messages 缺席即零请求）。
  assert.equal("selection" in blocked, false);
  assert.equal("messages" in blocked, false);
});

test("请求预检：可用时产出完整请求载荷，querySource 固定 prompt_polish（红线：不复活 legacy prompt/enhance）", () => {
  const resolved = resolvePromptPolishModel({ explicit: zhipuA, catalog });
  const prepared = preparePromptPolishRequest({ draftText: "  修一下登录 bug  ", resolution: resolved });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.deepEqual(prepared.selection, zhipuA);
  assert.equal(prepared.querySource, "prompt_polish");
  assert.equal(prepared.querySource, PROMPT_POLISH_QUERY_SOURCE);
  assert.notEqual(prepared.querySource, "prompt/enhance");
  assert.equal(prepared.maxOutputTokens, PROMPT_POLISH_DEFAULT_MAX_OUTPUT_TOKENS);
  // 草稿正文原样进 user message（trim 由调用方决定，指令不吞正文）。
  assert.deepEqual(prepared.messages[1], { role: "user", content: "  修一下登录 bug  " });

  const overridden = preparePromptPolishRequest({
    draftText: "x",
    resolution: resolved,
    maxOutputTokens: 1024,
  });
  assert.equal(overridden.ok && overridden.maxOutputTokens, 1024);
});

test("润色指令：保留原意/语言/专名，输出仅含润色后正文", () => {
  const messages = buildPromptPolishMessages("保持这段草稿");
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");
  assert.equal(messages[1]?.content, "保持这段草稿");
  const instruction = String(messages[0]?.content);
  assert.equal(instruction, PROMPT_POLISH_SYSTEM_INSTRUCTION);
  for (const required of ["preserving", "never translate", "Output only the polished draft text"]) {
    assert.ok(instruction.includes(required), `指令缺少语义要素: ${required}`);
  }
});

test("选择比较：null 与字段级相等", () => {
  assert.equal(isSamePromptPolishModel(null, null), true);
  assert.equal(isSamePromptPolishModel(undefined, null), true);
  assert.equal(isSamePromptPolishModel(zhipuA, null), false);
  assert.equal(isSamePromptPolishModel(zhipuA, { ...zhipuA }), true);
  assert.equal(isSamePromptPolishModel(zhipuA, zhipuB), false);
});
