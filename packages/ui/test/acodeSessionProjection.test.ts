import assert from "node:assert/strict";
import test from "node:test";

import {
  acodeSessionStateSnapshotSchema,
  ACODE_PROTOCOL_NAME,
  ACODE_PROTOCOL_VERSION,
  ACODE_AGENT_PROVIDER,
  type ACodeSessionStateSnapshot,
  type ModelSelection,
} from "@acode/shared";
import {
  acodeSessionSettingsToConfigOptions,
  acodeSessionSnapshotToTaskMeta,
  acodeWorkspacePresentationToConfigOptions,
} from "../src/lib/acodeSessionProjection.js";

/**
 * `acodeSessionProjection` 三个投影函数的行为网（legacy M1 迁移的**前置件**）。
 *
 * 为什么这批测试是 M1 的先决条件而非可选项：review 2026-10-26 的 M1 调研实测，全仓
 * **没有任何**测试引用本桥或它的导出，故 `pnpm --filter @acode/ui test` 对 M1 迁移的
 * 对错恒绿——那道验收门提供零保护力。M1 要换掉本桥的读路径，必须先有网兜住它现在的语义。
 *
 * 覆盖本桥现存的 3 个导出：`acodeSessionSettingsToConfigOptions`、
 * `acodeWorkspacePresentationToConfigOptions`、`acodeSessionSnapshotToTaskMeta`。
 *
 * **模型选择器字符串工具（`parseModelPickerValue`/`formatModelPickerValue`）已随 legacy M1
 * 第一批消费方迁移搬到 `lib/modelPickerValue.ts`**，其测试（含 M1 头号陷阱「custom: 展示态
 * UI 解码 vs shared 抛错」）见 `packages/ui/test/modelPickerValue.test.ts`。本桥不再定义它们，
 * 只从那里 import `formatModelPickerValue` 供投影内部使用。
 *
 * fixture 一律经真实 `acodeSessionStateSnapshotSchema` 校验（见下），防止 fixture 与协议漂移后
 * 测试仍假绿。
 */

// ── fixtures：一律经真实 zod schema 校验，防止 fixture 与协议漂移后测试仍假绿 ──────────

/** 模型选项的 `properties` 是必填（acodeModelFormatPropertiesSchema），漏了会被 schema 拒。 */
const MODEL_PROPERTIES = {
  inputFormat: {
    supportsText: true,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
  },
  outputFormat: { supportsText: true },
} as const;

const GLM_REF: ModelSelection = { providerId: "zai", modelId: "glm-4.7" };

function buildSnapshot(
  overrides: {
    sessionStatus?: "idle" | "running" | "waiting" | "paused" | "completed" | "error";
    sessionMode?: "plan" | "build" | "edit" | "yolo" | "auto" | "dontAsk";
    title?: string;
    settingsModel?: ModelSelection | undefined;
    thoughtLevel?: {
      enabled: boolean;
      current?: string;
      available?: { value: string; label: string }[];
    };
    lastError?: { type: string; code?: string; message: string; detail?: string };
    goal?: Record<string, unknown> | null;
    messages?: ACodeSessionStateSnapshot["messages"];
  } = {},
): ACodeSessionStateSnapshot {
  const candidate = {
    protocol: { name: ACODE_PROTOCOL_NAME, version: ACODE_PROTOCOL_VERSION },
    session: {
      sessionId: "sess_fixture",
      workspace: { workspacePath: "/repo/fixture", workspaceKey: "/repo/fixture" },
      sessionKind: "interactive",
      title: overrides.title ?? "未命名会话",
      mode: overrides.sessionMode ?? "build",
      status: overrides.sessionStatus ?? "idle",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_060_000,
    },
    settings: {
      model: {
        ...(overrides.settingsModel === undefined
          ? { current: GLM_REF }
          : overrides.settingsModel
            ? { current: overrides.settingsModel }
            : {}),
        available: [
          { ref: GLM_REF, label: "GLM 4.7", providerLabel: "智谱", properties: MODEL_PROPERTIES },
        ],
      },
      thoughtLevel: {
        enabled: overrides.thoughtLevel?.enabled ?? false,
        ...(overrides.thoughtLevel?.current ? { current: overrides.thoughtLevel.current } : {}),
        available: overrides.thoughtLevel?.available ?? [],
      },
      mode: { current: overrides.sessionMode ?? "build" },
    },
    projection: {
      sessionId: "sess_fixture",
      status: overrides.sessionStatus ?? "idle",
      mode: overrides.sessionMode ?? "build",
      turnCount: 1,
      totalTokenCount: 1200,
      contextUsed: 1200,
      contextWindow: 128_000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
      ...(overrides.lastError ? { lastError: overrides.lastError } : {}),
      ...(overrides.goal !== undefined ? { target: overrides.goal } : {}),
    },
    runtime: { eventSeq: 3, stateRevision: 1, pendingRequestIds: [] },
    messages: overrides.messages ?? [],
  };
  const parsed = acodeSessionStateSnapshotSchema.safeParse(candidate);
  // fixture 本身必须合法：schema 演进导致 fixture 过时，本断言会立刻红，而不是让下游断言假绿。
  assert.ok(
    parsed.success,
    `fixture 未通过 acodeSessionStateSnapshotSchema 校验（协议演进？请同步 fixture）：` +
      (parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 8), null, 2)),
  );
  return parsed.data;
}

test("fixture 自身合法（schema 校验网的第一道）", () => {
  assert.equal(buildSnapshot().session.sessionId, "sess_fixture");
});

// ── acodeWorkspacePresentationToConfigOptions ──────────────────────────────────

test("acodeWorkspacePresentationToConfigOptions: 只产 mode 一项，选项集为 4 档", () => {
  const options = acodeWorkspacePresentationToConfigOptions("plan");
  assert.equal(options.length, 1);
  const mode = options[0]!;
  assert.equal(mode.id, "mode");
  assert.equal(mode.category, "mode");
  assert.equal(mode.type, "select");
  assert.equal(mode.currentValue, "plan");
  assert.deepEqual(
    mode.options?.map((o) => o.value),
    ["build", "edit", "plan", "yolo"],
  );
});

test("acodeWorkspacePresentationToConfigOptions: 未知/auto 档位归一到 build（不产出空 currentValue）", () => {
  // normalizeAvailableACodeMode 的兜底：v4 值域刻意排除 auto（acode-protocol/index.ts:3529），
  // 故 'auto' 落到这里必须归一，否则工具栏会拿到没有档位被选中的 UI。
  assert.equal(acodeWorkspacePresentationToConfigOptions("auto")[0]!.currentValue, "build");
  assert.equal(
    acodeWorkspacePresentationToConfigOptions("dontAsk")[0]!.currentValue,
    "build",
    "dontAsk 不在 4 档内，同样归一",
  );
});

// ── acodeSessionSettingsToConfigOptions ────────────────────────────────────────

test("acodeSessionSettingsToConfigOptions: thoughtLevel.enabled=false → 只 model + mode 两项", () => {
  const options = acodeSessionSettingsToConfigOptions(buildSnapshot().settings);
  assert.deepEqual(
    options.map((o) => o.id),
    ["model", "mode"],
  );
  const model = options[0]!;
  assert.equal(model.currentValue, "zai/glm-4.7");
  assert.equal(model.options?.[0]?.modelProviderName, "智谱", "providerLabel 优先于 providerId");
});

test("acodeSessionSettingsToConfigOptions: thoughtLevel.enabled=true → 追加第三项且 current 缺失时回落 defaultLevel", () => {
  const options = acodeSessionSettingsToConfigOptions(
    buildSnapshot({
      thoughtLevel: {
        enabled: true,
        available: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
      },
    }).settings,
  );
  assert.deepEqual(
    options.map((o) => o.id),
    ["model", "mode", "thought_level"],
  );
  const thought = options[2]!;
  // current 与 defaultLevel 都缺席时回落 available[0]，避免工具栏空 currentValue（见源码注释）。
  assert.equal(thought.currentValue, "low");
});

test("acodeSessionSettingsToConfigOptions: current 不在 available 内时回落 defaultLevel，再回落首项", () => {
  const settings = buildSnapshot({
    thoughtLevel: {
      enabled: true,
      current: "ghost-level",
      available: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
    },
  }).settings;
  // current 'ghost-level' 不在 available → 回落；defaultLevel 也缺席 → available[0]。
  assert.equal(acodeSessionSettingsToConfigOptions(settings)[2]!.currentValue, "low");
});

// ── acodeSessionSnapshotToTaskMeta ─────────────────────────────────────────────

test("acodeSessionSnapshotToTaskMeta: 身份/工作区/时间/模式字段逐一映射", () => {
  const meta = acodeSessionSnapshotToTaskMeta(buildSnapshot({ title: "登录超时修复" }));
  assert.equal(meta.taskId, "sess_fixture");
  assert.equal(meta.title, "登录超时修复");
  assert.equal(meta.workspacePath, "/repo/fixture");
  assert.equal(meta.createdAt, 1_700_000_000_000);
  assert.equal(meta.updatedAt, 1_700_000_060_000);
  assert.equal(meta.mode, "build");
  assert.equal(meta.model, "zai/glm-4.7");
  // provider 是硬编码常量（不取自 snapshot——snapshot 无 provider 字段）。断言等于共享常量
  // 而非字面量 "glm"，避免常量演进时本测试变成第二处需要同步的魔法字符串。
  assert.equal(meta.provider, ACODE_AGENT_PROVIDER);
});

test("acodeSessionSnapshotToTaskMeta: traceId 是每次调用新生成的 UUID（非确定值，只断形态）", () => {
  // generateTraceId 内部是 createUuid()，不派生自 taskId——故只能断言形态与两次不同，
  // 不能断言等值（否则测试会 flake）。
  const first = acodeSessionSnapshotToTaskMeta(buildSnapshot()).traceId;
  const second = acodeSessionSnapshotToTaskMeta(buildSnapshot()).traceId;
  assert.match(String(first), /^[0-9a-f-]{36}$/i);
  assert.notEqual(first, second, "每次调用生成新 traceId（现状语义，迁移不得改成派生值）");
});

test("acodeSessionSnapshotToTaskMeta: 模型取自最近消息的 info.model，而非 settings.model.current（污染自愈）", () => {
  // 源码注释：历史 resume 被错误 runtimeModel 覆盖时 settings.current 会变成 app 默认模型，
  // 但消息 info.model 仍记录真实使用模型；task meta 作为下次冷恢复 hint，故消息优先。
  const pollutedSettingsModel: ModelSelection = { providerId: "wrong", modelId: "default-model" };
  const snapshot = buildSnapshot({
    settingsModel: pollutedSettingsModel,
    messages: [
      {
        info: {
          role: "user",
          messageId: "m1",
          sessionId: "sess_fixture",
          agent: "acode",
          time: { created: 1_700_000_000_000 },
          model: { providerId: "zai", modelId: "glm-4.7" },
        },
        parts: [],
      },
    ],
  });
  assert.equal(
    acodeSessionSnapshotToTaskMeta(snapshot).model,
    "zai/glm-4.7",
    "必须取消息里的真实模型，不是被污染的 settings.current",
  );
});

test("acodeSessionSnapshotToTaskMeta: 无消息模型时回落 settings.model.current；两者皆缺则空串", () => {
  assert.equal(acodeSessionSnapshotToTaskMeta(buildSnapshot()).model, "zai/glm-4.7");
  assert.equal(
    acodeSessionSnapshotToTaskMeta(buildSnapshot({ settingsModel: null })).model,
    "",
    "未绑定模型是合法恢复状态，不得伪造（源码注释：不能为满足协议而伪造模型）",
  );
});

test("acodeSessionSnapshotToTaskMeta: lastError 映射为 code 优先于 type，detail/attribution 可选透传", () => {
  const withCode = acodeSessionSnapshotToTaskMeta(
    buildSnapshot({ lastError: { type: "provider_error", code: "E429", message: "限流" } }),
  );
  assert.deepEqual(withCode.lastError, { code: "E429", message: "限流" });
  assert.equal(
    withCode.status,
    "error",
    "lastError 在场即判 error（deriveACodeTaskStatus 首条规则）",
  );

  const withoutCode = acodeSessionSnapshotToTaskMeta(
    buildSnapshot({ lastError: { type: "provider_error", message: "限流", detail: "重试中" } }),
  );
  assert.deepEqual(withoutCode.lastError, {
    code: "provider_error",
    detail: "重试中",
    message: "限流",
  });
});

test("acodeSessionSnapshotToTaskMeta: 无 lastError 时该字段为 undefined（不产出空对象）", () => {
  assert.equal(acodeSessionSnapshotToTaskMeta(buildSnapshot()).lastError, undefined);
});

test("acodeSessionSnapshotToTaskMeta: goal 投影为 ACodeTaskGoal 形态（snake_case 输出 + time 嵌套）", () => {
  const meta = acodeSessionSnapshotToTaskMeta(
    buildSnapshot({
      goal: {
        sessionId: "sess_fixture",
        targetId: "tgt_1",
        objective: "修完 review",
        status: "paused",
        tokenBudget: 5000,
        tokensUsed: 1200,
        timeUsedSeconds: 90,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_060_000,
      },
    }),
  );
  assert.deepEqual(meta.target, {
    sessionID: "sess_fixture",
    targetID: "tgt_1",
    objective: "修完 review",
    summaryTitle: null,
    status: "paused",
    tokenBudget: 5000,
    tokensUsed: 1200,
    timeUsedSeconds: 90,
    activeInputId: null,
    activeRunStartedAtMs: null,
    activeRunLastSeenAtMs: null,
    // fromACodeGoal 先找 record.time.created，goal schema 无嵌套 time 故回落顶层 createdAt。
    time: { created: 1_700_000_000_000, updated: 1_700_000_060_000 },
  });
});

test("acodeSessionSnapshotToTaskMeta: goal 的 summaryTitle 有值时透传（非一律 null）", () => {
  const meta = acodeSessionSnapshotToTaskMeta(
    buildSnapshot({
      goal: {
        sessionId: "sess_fixture",
        targetId: "tgt_1",
        objective: "修完 review",
        summaryTitle: "评审收口",
        status: "complete",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    }),
  );
  assert.equal(meta.target?.summaryTitle, "评审收口");
  assert.equal(meta.target?.status, "complete");
  assert.equal(
    meta.target?.tokenBudget,
    null,
    "tokenBudget 可为 null（schema 允许），不得被回落成 0",
  );
});

test("【M1 迁移情报】fromACodeGoal 的 snake_case 与非法 status 兜底分支经 schema 校验后不可达", () => {
  // 这条不是行为断言，是**给 M1 迁移的结构性情报**：acodeSessionGoalSchema 是 .strict()，
  // 只接受 camelCase 的 sessionId/targetId，且 status 是闭集 enum(["active","paused",
  // "budget_limited","complete"])。故 fromACodeGoal 里的三处防御分支——
  //   ① `stringValue(record.sessionID)`（snake_case 读取）
  //   ② `stringValue(record.targetID)`
  //   ③ `isACodeTaskGoalStatus(status) ? status : "active"`（非法值回落）
  // 对**任何通过 schema 校验的 snapshot** 都不可能命中：schema 已在边界处挡掉这些形态。
  //
  // 验证方式：把 snake_case 形态喂给 schema，必须被拒（证明不可达不是「恰好没测到」）。
  const snakeCaseGoal = acodeSessionStateSnapshotSchema.shape.projection.safeParse({
    sessionId: "sess_fixture",
    status: "idle",
    mode: "build",
    turnCount: 0,
    totalTokenCount: 0,
    contextUsed: 0,
    contextWindow: 1,
    pendingPermissions: [],
    activeToolCalls: [],
    backgroundJobs: [],
    target: {
      sessionID: "sess_fixture", // snake_case：schema 不认
      targetID: "tgt_1",
      objective: "x",
      summaryTitle: null,
      status: "not-a-real-status", // 非法枚举：schema 不认
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 2,
    },
  });
  assert.equal(snakeCaseGoal.success, false, "snake_case + 非法 status 必须被 schema 拒绝");
  const unknownKeys = snakeCaseGoal.success ? [] : snakeCaseGoal.error.issues.map((i) => i.code);
  assert.ok(
    unknownKeys.includes("unrecognized_keys") || unknownKeys.includes("invalid_value"),
    `拒绝原因应是未知键或非法枚举值，实测：${unknownKeys.join(", ")}`,
  );
  // 结论（写进本测试以便 M1 施工者看见）：迁移到 v4 ConversationSnapshot→TaskMeta 映射器时，
  // 这三处兜底**不需要照搬**——除非新映射器的输入不经 strict schema 校验。照搬等于把死代码
  // 带进新面，违反 AGENTS.md「不不断增加兜底分支」。
});

test("acodeSessionSnapshotToTaskMeta: goal 为 null 时 target 保持 null（不伪造 goal）", () => {
  assert.equal(acodeSessionSnapshotToTaskMeta(buildSnapshot({ goal: null })).target, null);
});
