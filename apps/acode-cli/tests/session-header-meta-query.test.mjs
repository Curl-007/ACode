import assert from "node:assert/strict";
import test from "node:test";

const { querySessionHeaderMeta } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/session-header-meta-query.ts"
);

/**
 * `querySessionHeaderMeta` handler 测试（apps/acode-cli/specs/v4-session-header-meta.md §7 的
 * H3 / H7，以及 handler 侧的持久事实收窄逻辑）。
 *
 * 共享叶子的纯投影（H1/H2/H4/H5/H6/H6b/H10）在
 * `packages/shared/test/sessionHeaderMeta.test.ts`；本文件只测**handler 从持久层取数并收窄**
 * 这一段——即 shared 叶子测不到的部分：store 缺席、会话不存在、path/directory 回落、
 * permission.mode 取位、SessionGoal→ACodeTaskGoal 直通、以及「不碰 live record」。
 */

function makeSession(overrides = {}) {
  return {
    id: "sess_archived",
    title: "归档会话标题",
    traceID: "trace_persisted",
    workspaceID: "remote://host/repo",
    path: "/repo/worktree",
    directory: "/repo/worktree",
    permission: { mode: "yolo" },
    time: { created: 1_700_000_000_000, updated: 1_700_000_060_000 },
    ...overrides,
  };
}

function makeContext({ session, goal = null, modelEntryData = null, calls } = {}) {
  const store = {
    getSession: async () => {
      calls?.push("getSession");
      return session ?? null;
    },
    readTarget: async () => {
      calls?.push("readTarget");
      return goal;
    },
    sessionEntries: async () => {
      calls?.push("sessionEntries");
      // readSessionModelSelection 读 entries.at(-1)?.data
      return modelEntryData === null ? [] : [{ data: modelEntryData }];
    },
  };
  return { context: { deps: { sessionStore: store } }, store };
}

// H3：会话不存在 → found=false，不抛协议错误，不打 warn
test("H3: sessionId 不存在 → found=false 且不抛错（正常竞态不当错误）", async () => {
  const { context } = makeContext({ session: null });
  const result = await querySessionHeaderMeta(context, { sessionId: "sess_gone" });
  assert.deepEqual(result, { found: false }, "found=false 且 meta 缺席");
  assert.equal("meta" in result, false);
});

// 无 sessionStore（极端形态）→ 同样 found=false，不抛
test("无 sessionStore 时 found=false（不抛错，与 H3 同一纪律）", async () => {
  const result = await querySessionHeaderMeta({ deps: {} }, { sessionId: "sess_x" });
  assert.deepEqual(result, { found: false });
});

// params 校验：sessionId 必填、多余键被拒
test("params 经 strict schema 校验：空 sessionId 与多余键都被拒", async () => {
  const { context } = makeContext({ session: makeSession() });
  await assert.rejects(() => querySessionHeaderMeta(context, { sessionId: "" }), /too small|min|Invalid/);
  await assert.rejects(
    () => querySessionHeaderMeta(context, { sessionId: "s", workspacePath: "/x" }),
    /unrecognized|Unrecognized/,
  );
});

// H7：走持久层而非 live record —— context.sessions 里没有任何记录也照样 found=true
test("H7: 不依赖 context.sessions 的 live record（归档会话仍 found=true）", async () => {
  // 关键：context 里**没有** sessions Map，也没有任何 live record 概念。
  // 若 handler 误用 requireSession（要求 live record），这里会抛 sessionUnavailable。
  const { context } = makeContext({ session: makeSession() });
  const result = await querySessionHeaderMeta(context, { sessionId: "sess_archived" });
  assert.equal(result.found, true);
  assert.equal(result.meta.taskId, "sess_archived");
  assert.equal(
    "sessions" in context,
    false,
    "本 handler 的 context 里根本没有 sessions Map，证明它不读 live record",
  );
});

// 取数并发：三个持久读取都要发生（getSession + readTarget + sessionEntries）
test("持久层三个读取都发生（getSession / readTarget / sessionEntries）", async () => {
  const calls = [];
  const { context } = makeContext({ session: makeSession(), calls });
  await querySessionHeaderMeta(context, { sessionId: "sess_archived" });
  assert.deepEqual([...calls].sort(), ["getSession", "readTarget", "sessionEntries"]);
});

// workspacePath 回落：path 优先，空白时回落 directory
test("workspacePath: path 优先；path 空白时回落 directory", async () => {
  const withPath = makeContext({ session: makeSession({ path: "/repo/real", directory: "/repo/dir" }) });
  assert.equal(
    (await querySessionHeaderMeta(withPath.context, { sessionId: "s" })).meta.workspacePath,
    "/repo/real",
  );

  const noPath = makeContext({ session: makeSession({ path: undefined, directory: "/repo/dir" }) });
  assert.equal(
    (await querySessionHeaderMeta(noPath.context, { sessionId: "s" })).meta.workspacePath,
    "/repo/dir",
  );

  const blankPath = makeContext({ session: makeSession({ path: "   ", directory: "/repo/dir" }) });
  assert.equal(
    (await querySessionHeaderMeta(blankPath.context, { sessionId: "s" })).meta.workspacePath,
    "/repo/dir",
    "纯空白 path 视为缺席（trim 判空）",
  );
});

// permission.mode 取位
test("mode 来自 SessionInfo.permission.mode；permission 缺席时回落 build", async () => {
  const withMode = makeContext({ session: makeSession({ permission: { mode: "edit" } }) });
  assert.equal((await querySessionHeaderMeta(withMode.context, { sessionId: "s" })).meta.mode, "edit");

  const noPermission = makeContext({ session: makeSession({ permission: undefined }) });
  assert.equal(
    (await querySessionHeaderMeta(noPermission.context, { sessionId: "s" })).meta.mode,
    "build",
  );
});

// model_selection entry 收窄
test("model_selection entry 存在 → model 映射；缺席 → model 缺席", async () => {
  const withModel = makeContext({
    session: makeSession(),
    modelEntryData: { providerId: "zai", modelId: "glm-4.7" },
  });
  const meta = (await querySessionHeaderMeta(withModel.context, { sessionId: "s" })).meta;
  assert.equal(meta.model, "zai/glm-4.7");

  const withoutModel = makeContext({ session: makeSession() });
  const meta2 = (await querySessionHeaderMeta(withoutModel.context, { sessionId: "s" })).meta;
  assert.equal("model" in meta2, false);
});

// R12：SessionGoal → ACodeTaskGoal 逐字段直通（含 camelCase sessionID/targetID）
test("R12: 持久 SessionGoal 逐字段直通成 target（无 snake_case 转换、无非法值回落）", async () => {
  const goal = {
    sessionID: "sess_archived",
    targetID: "tgt_9",
    objective: "收口 legacy M1",
    summaryTitle: null,
    status: "complete",
    tokenBudget: null,
    tokensUsed: 42,
    timeUsedSeconds: 7,
    activeInputId: null,
    activeRunStartedAtMs: null,
    activeRunLastSeenAtMs: null,
    time: { created: 10, updated: 20 },
  };
  const { context } = makeContext({ session: makeSession(), goal });
  const meta = (await querySessionHeaderMeta(context, { sessionId: "sess_archived" })).meta;
  assert.deepEqual(meta.target, {
    sessionID: "sess_archived",
    targetID: "tgt_9",
    objective: "收口 legacy M1",
    summaryTitle: null,
    status: "complete",
    tokenBudget: null,
    tokensUsed: 42,
    timeUsedSeconds: 7,
    activeInputId: null,
    activeRunStartedAtMs: null,
    activeRunLastSeenAtMs: null,
    time: { created: 10, updated: 20 },
  });
});

test("goal 为 null → target 缺席（不伪造 goal）", async () => {
  const { context } = makeContext({ session: makeSession(), goal: null });
  const meta = (await querySessionHeaderMeta(context, { sessionId: "sess_archived" })).meta;
  assert.equal("target" in meta, false);
});

// 端到端形状：found=true 的响应通过 wire result schema
test("found=true 响应通过 v4SessionHeaderMetaResultSchema 校验（wire 契约闭环）", async () => {
  // 走相对路径到 shared 源码（同 handler 测试的 import 方式）：CLI 测试目录不解析
  // @acode/shared 这个 workspace 包名，但 tsx 能直接吃 shared 的 .ts 源文件。
  const { v4SessionHeaderMetaResultSchema } = await import(
    "../../../packages/shared/src/acode-protocol-v4/session-header-meta.ts"
  );
  const { context } = makeContext({ session: makeSession() });
  const result = await querySessionHeaderMeta(context, { sessionId: "sess_archived" });
  const parsed = v4SessionHeaderMetaResultSchema.safeParse(result);
  assert.ok(
    parsed.success,
    `handler 产物必须通过 wire schema：${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`,
  );
});
