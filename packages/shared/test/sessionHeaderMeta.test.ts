import assert from "node:assert/strict";
import test from "node:test";

// 符号的唯一定义处（实测）：ACODE_AGENT_PROVIDER 在 acode-agent-policy.ts，
// ModelSelection 在 model-selection.ts——不在 acode-task-types-core.ts（后者只定义类型别名）。
import { ACODE_AGENT_PROVIDER } from "../src/acode-agent-policy.js";
import type { ModelSelection } from "../src/model-selection.js";
import {
  buildSessionHeaderMeta,
  v4SessionHeaderMetaParamsSchema,
  v4SessionHeaderMetaResultSchema,
  v4SessionHeaderMetaSchema,
  type SessionHeaderMetaSource,
} from "../src/acode-protocol-v4/session-header-meta.js";

/**
 * v4 归档会话 header 冷读的**纯投影**测试（apps/acode-cli/specs/v4-session-header-meta.md §7）。
 *
 * 覆盖 H1/H2/H4/H5/H6/H6b/H10（handler 侧的 H3/H7 与 UI 侧的 H8/H9 在各自包的测试里）。
 * 本文件只测 shared 叶子的纯函数与 schema——无 IO、无 CLI 依赖，故可离线断言。
 */

const GLM: ModelSelection = { providerId: "zai", modelId: "glm-4.7" };

function makeSource(overrides: Partial<SessionHeaderMetaSource> = {}): SessionHeaderMetaSource {
  return {
    sessionId: "sess_archived_1",
    title: "修复登录超时",
    traceId: "trace_persisted_abc",
    workspacePath: "/repo/fixture",
    workspaceIdentity: "remote://host/repo/fixture",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_060_000,
    permissionMode: "plan",
    modelSelection: GLM,
    goal: null,
    ...overrides,
  };
}

// H1：必填字段齐全且与持久事实逐项相等
test("H1: 身份/工作区/时间/模式字段逐一映射", () => {
  const meta = buildSessionHeaderMeta(makeSource());
  assert.equal(meta.taskId, "sess_archived_1");
  assert.equal(meta.traceId, "trace_persisted_abc");
  assert.equal(meta.title, "修复登录超时");
  assert.equal(meta.workspacePath, "/repo/fixture");
  assert.equal(meta.workspaceIdentity, "remote://host/repo/fixture");
  assert.equal(meta.createdAt, 1_700_000_000_000);
  assert.equal(meta.updatedAt, 1_700_000_060_000);
  assert.equal(meta.mode, "plan");
  assert.equal(meta.model, "zai/glm-4.7");
  assert.equal(meta.provider, ACODE_AGENT_PROVIDER);
});

// H1 补充：model_selection 带 reasoningLevel → thoughtLevel 映射
test("H1b: reasoningLevel 存在时 thoughtLevel 从 selection.options 取", () => {
  const meta = buildSessionHeaderMeta(
    makeSource({
      modelSelection: { ...GLM, options: { reasoningLevel: "high" } },
    }),
  );
  assert.equal(meta.model, "zai/glm-4.7:high");
  assert.equal(meta.thoughtLevel, "high");
});

// H2：字段集恰为 legacy 14 项的子集——titleOverridden/forkedFromTaskId/lastError 均缺席
test("H2: 不产出 titleOverridden / forkedFromTaskId / lastError（与 legacy 映射器字段集一致）", () => {
  const meta = buildSessionHeaderMeta(makeSource()) as Record<string, unknown>;
  // 这三者 legacy acodeSessionSnapshotToTaskMeta 不产出；多产出会让冷/热两路径的
  // areResolvedTaskMetasEqual（15 字段）永远判不等 → header 抖动（spec R8）。
  assert.equal("titleOverridden" in meta, false, "不得产出 titleOverridden");
  assert.equal("forkedFromTaskId" in meta, false, "不得产出 forkedFromTaskId");
  assert.equal("lastError" in meta, false, "不得产出 lastError");
  // 正向：确实在产出集里的键齐全（防止上面的断言因为整个对象为空而假过）。
  const expectedKeys = [
    "taskId",
    "traceId",
    "title",
    "workspacePath",
    "workspaceIdentity",
    "createdAt",
    "updatedAt",
    "mode",
    "model",
    "provider",
  ];
  for (const key of expectedKeys) {
    assert.ok(key in meta, `缺少应有字段 ${key}（上面的缺席断言不能靠空对象蒙混）`);
  }
});

// H2b：goal 直通（R12）
test("H2b: 持久 goal 逐字段直通，无 snake_case 转换/无非法值回落", () => {
  const goal = {
    sessionID: "sess_archived_1",
    targetID: "tgt_1",
    objective: "修完 review",
    summaryTitle: "评审收口",
    status: "paused" as const,
    tokenBudget: 5000,
    tokensUsed: 1200,
    timeUsedSeconds: 90,
    activeInputId: null,
    activeRunStartedAtMs: null,
    activeRunLastSeenAtMs: null,
    time: { created: 1_700_000_000_000, updated: 1_700_000_060_000 },
  };
  const meta = buildSessionHeaderMeta(makeSource({ goal }));
  assert.deepEqual(meta.target, goal);
});

test("H2c: goal 为 null / undefined 时 target 缺席（不伪造 goal）", () => {
  assert.equal("target" in (buildSessionHeaderMeta(makeSource({ goal: null })) as Record<string, unknown>), false);
  assert.equal(
    "target" in (buildSessionHeaderMeta(makeSource({ goal: undefined })) as Record<string, unknown>),
    false,
  );
});

// H4：无 model_selection → model/thoughtLevel 缺席，不补默认
test("H4: modelSelection 缺席 → model/thoughtLevel 缺席，不补默认模型", () => {
  const meta = buildSessionHeaderMeta(makeSource({ modelSelection: undefined })) as Record<string, unknown>;
  assert.equal("model" in meta, false);
  assert.equal("thoughtLevel" in meta, false);
  // 其余必填仍在（不因缺 model 就丢整份 meta）
  assert.equal(meta.taskId, "sess_archived_1");
});

// H5：traceID 缺席 → 确定性派生，非新 UUID
test("H5: traceId 缺席 → 'session-<id>' 确定性派生（非新 UUID）", () => {
  const meta = buildSessionHeaderMeta(makeSource({ traceId: undefined }));
  assert.equal(meta.traceId, "session-sess_archived_1");
  // 空串/纯空白同样视为缺席（trim 后判空）
  assert.equal(buildSessionHeaderMeta(makeSource({ traceId: "   " })).traceId, "session-sess_archived_1");
});

// H6：同输入两次调用深度相等（反 flake；legacy generateTraceId 的 UUID 会破坏这条）
test("H6: 同输入连续两次调用深度相等（等价判定成立，header 不抖）", () => {
  const first = buildSessionHeaderMeta(makeSource({ traceId: undefined }));
  const second = buildSessionHeaderMeta(makeSource({ traceId: undefined }));
  assert.deepEqual(first, second, "traceId 必须确定性派生，否则两次不等 → header 每次刷新重渲");
});

// H6b：归档冷读不猜测运行态（R11）
test("H6b: status 恒缺席（冷读不猜测运行态）", () => {
  const meta = buildSessionHeaderMeta(makeSource()) as Record<string, unknown>;
  assert.equal("status" in meta, false, "持久层无 status 权威源，冷读缺席而非猜测（spec R11）");
});

// R9：mode 值域回落
test("R9: permissionMode 缺失或非法 → 回落 build", () => {
  assert.equal(buildSessionHeaderMeta(makeSource({ permissionMode: undefined })).mode, "build");
  assert.equal(buildSessionHeaderMeta(makeSource({ permissionMode: "not-a-mode" })).mode, "build");
  // 合法值原样透传（CollaborationMode 是 ACodeTaskMode 子集）
  assert.equal(buildSessionHeaderMeta(makeSource({ permissionMode: "yolo" })).mode, "yolo");
  assert.equal(buildSessionHeaderMeta(makeSource({ permissionMode: "dontAsk" })).mode, "dontAsk");
});

// workspaceIdentity 空串处理
test("workspaceIdentity 纯空白 → 缺席（不产出空串键）", () => {
  const meta = buildSessionHeaderMeta(makeSource({ workspaceIdentity: "  " })) as Record<string, unknown>;
  assert.equal("workspaceIdentity" in meta, false);
});

// params schema：只有 sessionId，无 workspace 闸（spec §4.2）
test("params schema 只接受 sessionId；多余键被 .strict() 拒（含 workspacePath）", () => {
  assert.deepEqual(v4SessionHeaderMetaParamsSchema.parse({ sessionId: "s1" }), { sessionId: "s1" });
  assert.throws(
    () => v4SessionHeaderMetaParamsSchema.parse({ sessionId: "s1", workspacePath: "/x" }),
    /unrecognized|Unrecognized/,
    "params 不得接受 workspace 字段（R/§4.2：定域靠进程拓扑，不靠 params 比对，避免假阴性）",
  );
  assert.throws(() => v4SessionHeaderMetaParamsSchema.parse({ sessionId: "" }), /too small|min/);
});

// result schema：found 判别 + meta 可选
test("result schema：found=false 时 meta 缺席；found=true 时 meta 经严格校验", () => {
  const notFound = v4SessionHeaderMetaResultSchema.parse({ found: false });
  assert.deepEqual(notFound, { found: false });

  const meta = buildSessionHeaderMeta(makeSource());
  const found = v4SessionHeaderMetaResultSchema.parse({ found: true, meta });
  assert.equal(found.found, true);
  assert.deepEqual(found.meta, meta);

  // meta 走 strict：塞入 titleOverridden 应被拒（钉住 R8 在 wire 层也生效）
  assert.throws(
    () => v4SessionHeaderMetaSchema.parse({ ...meta, titleOverridden: true }),
    /unrecognized|Unrecognized/,
  );
});

// H10：类型层 parity——wire schema 的 infer 可赋值给 Pick<ACodeTaskMeta,…>
test("H10: V4SessionHeaderMeta 可赋值给 ACodeTaskMeta 的同名 Pick（编译期 parity，运行时兜底断言）", async () => {
  // sessionHeaderMetaIsTaskMetaCompatible 是一条编译期赋值断言（shared 叶子内）。
  // 这里 import 它并对真实产物调用一次，确保：① 它确实存在（没被 tree-shake 掉后静默失效）；
  // ② 对合法 meta 运行时不抛。真正的「ACodeTaskMeta 改名即红」由 tsc 在该叶子的类型断言处保证。
  const { sessionHeaderMetaIsTaskMetaCompatible } = await import(
    "../src/acode-protocol-v4/session-header-meta.js"
  );
  const meta = buildSessionHeaderMeta(makeSource());
  const picked = sessionHeaderMetaIsTaskMetaCompatible(meta);
  assert.equal(picked.taskId, meta.taskId);
  assert.equal(picked.mode, meta.mode);
});
