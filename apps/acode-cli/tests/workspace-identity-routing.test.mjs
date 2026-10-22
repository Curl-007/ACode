import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * review §7 盲区 3：远程 identity 一致性的专门覆盖。
 *
 * AGENTS.md「Workspace Identity」核心不变量：
 *   - `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作/展示；
 *   - 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、
 *     队列、持久化、请求关联；
 *   - 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
 *
 * 断言面：
 *   1. resolveWorkspaceKey 的 fallback 规则（trim / 空串 / 空白 / 缺席 / 大小写敏感）；
 *   2. 同路径不同 identity 不串线（两个 key 必须不同）；
 *   3. 同 identity 不同路径正确归并（两个 key 必须相同）；
 *   4. wire schema 强制 workspaceKey === resolveWorkspaceKey（仅按路径匹配 = 被拒绝的负向测试）；
 *   5. remoteSessionId 贯穿时 identity 不丢——远程地址/命令缺 workspaceIdentity 一律拒绝。
 *
 * 纯 schema/纯函数，无 IO、无子进程、无 sleep。真负向：每条断言都对照一个「改坏会红」的变体。
 */

const { resolveWorkspaceKey, taskRealtimeEventSchema, taskOwnerCommandRequestSchema } = await import(
  "../../../packages/shared/src/task-realtime-core.ts"
);
const {
  windowHostTaskAddressSchema,
  windowHostControllerWorkspaceFactSchema,
  windowHostControllerTaskRowSchema,
} = await import("../../../packages/shared/src/acode-protocol-v4/controller.ts");

const PATH = "/repo/acode";
const OTHER_PATH = "/repo/other";
const IDENTITY = "ws-identity-abc";

// ── 1. resolveWorkspaceKey 的 fallback 规则 ──────────────────────────────────

test("identity(1): resolveWorkspaceKey = workspaceIdentity?.trim() || workspacePath", () => {
  // 有 identity：用 trim 后的 identity，忽略 path。
  assert.equal(resolveWorkspaceKey({ workspacePath: PATH, workspaceIdentity: IDENTITY }), IDENTITY);
  // identity 带前后空白：trim 后作为 key（去重/绑定/缓存的统一口径）。
  assert.equal(
    resolveWorkspaceKey({ workspacePath: PATH, workspaceIdentity: `  ${IDENTITY}  ` }),
    IDENTITY,
    "identity 必须 trim",
  );
  // 缺席 identity：回落到 path。
  assert.equal(resolveWorkspaceKey({ workspacePath: PATH }), PATH);
  // 空白 identity：trim 后为空 → 回落到 path（不能拿空串当身份）。
  assert.equal(resolveWorkspaceKey({ workspacePath: PATH, workspaceIdentity: "   " }), PATH);
  assert.equal(resolveWorkspaceKey({ workspacePath: PATH, workspaceIdentity: "" }), PATH);
  // identity 大小写敏感：不同大小写是不同身份（不得折叠）。
  assert.notEqual(
    resolveWorkspaceKey({ workspacePath: PATH, workspaceIdentity: IDENTITY }),
    resolveWorkspaceKey({ workspacePath: PATH, workspaceIdentity: IDENTITY.toUpperCase() }),
    "identity key 必须大小写敏感",
  );
});

// ── 2 & 3. 隔离与归并 ────────────────────────────────────────────────────────

test("identity(2): 同路径不同 identity 不串线——两个 key 必须不同", () => {
  const keyA = resolveWorkspaceKey({ workspacePath: PATH, workspaceIdentity: "identity-A" });
  const keyB = resolveWorkspaceKey({ workspacePath: PATH, workspaceIdentity: "identity-B" });
  assert.notEqual(keyA, keyB, "同路径不同 identity 落到同一个 key = 串线（身份隔离失效）");
  // 且都不等于裸 path（有 identity 时不得回落到 path）。
  assert.notEqual(keyA, PATH);
  assert.notEqual(keyB, PATH);
});

test("identity(3): 同 identity 不同路径正确归并——两个 key 必须相同", () => {
  const key1 = resolveWorkspaceKey({ workspacePath: PATH, workspaceIdentity: IDENTITY });
  const key2 = resolveWorkspaceKey({ workspacePath: OTHER_PATH, workspaceIdentity: IDENTITY });
  assert.equal(key1, key2, "同 identity 不同路径应归并到同一个 key（远程/本地同一身份）");
  assert.equal(key1, IDENTITY);
});

// ── 4. wire schema 强制 workspaceKey 与 fallback 规则一致（仅按路径匹配被拒）──

function realtimeEnvelope(overrides) {
  return {
    createdAt: 1_700_000_000_000,
    eventId: "evt-1",
    taskId: "task-1",
    traceId: "trace-1",
    type: "task_snapshot_invalidated",
    workspacePath: PATH,
    ...overrides,
  };
}

test("identity(4): 事件 workspaceKey 必须 === resolveWorkspaceKey；仅按路径匹配被拒", () => {
  // 正例：有 identity，workspaceKey = identity。
  const withIdentity = taskRealtimeEventSchema.safeParse(
    realtimeEnvelope({ reason: "task_created", workspaceIdentity: IDENTITY, workspaceKey: IDENTITY }),
  );
  assert.equal(withIdentity.success, true, withIdentity.error?.message);

  // 负例：带了 identity 却把 workspaceKey 填成 path（= 仅按路径匹配，忽略 identity）。
  const pathOnlyDespiteIdentity = taskRealtimeEventSchema.safeParse(
    realtimeEnvelope({ reason: "task_created", workspaceIdentity: IDENTITY, workspaceKey: PATH }),
  );
  assert.equal(pathOnlyDespiteIdentity.success, false, "有 identity 却按 path 填 key 必须被拒");
  assert.match(
    pathOnlyDespiteIdentity.error?.issues?.[0]?.message ?? "",
    /workspaceKey must match workspaceIdentity fallback rule/u,
    "拒绝原因必须是 fallback 规则失配",
  );

  // 负例：workspaceKey 与 path/identity 都不符。
  const wrongKey = taskRealtimeEventSchema.safeParse(
    realtimeEnvelope({ reason: "task_created", workspaceKey: "totally-wrong" }),
  );
  assert.equal(wrongKey.success, false, "workspaceKey 与 fallback 结果不符必须被拒");

  // 正例：无 identity，workspaceKey = path（本地任务合法回落）。
  const noIdentity = taskRealtimeEventSchema.safeParse(
    realtimeEnvelope({ reason: "task_created", workspaceKey: PATH }),
  );
  assert.equal(noIdentity.success, true, noIdentity.error?.message);
});

// ── 5. remoteSessionId 贯穿时 identity 不丢（远程地址/命令强制携带 identity）──

test("identity(5a): 远程任务地址带 remoteSessionId 却缺 workspaceIdentity → 拒绝", () => {
  // 负例：remoteSessionId 在场但只按路径匹配（identity 丢了）。
  const remoteNoIdentity = windowHostTaskAddressSchema.safeParse({
    remoteSessionId: "rsess-1",
    taskId: "task-1",
    workspacePath: PATH,
  });
  assert.equal(remoteNoIdentity.success, false, "远程地址缺 workspaceIdentity 必须被拒");
  assert.match(
    remoteNoIdentity.error?.issues?.[0]?.message ?? "",
    /remote task address requires workspaceIdentity/u,
  );

  // 正例：remoteSessionId + workspaceIdentity 齐备。
  const remoteWithIdentity = windowHostTaskAddressSchema.safeParse({
    remoteSessionId: "rsess-1",
    taskId: "task-1",
    workspaceIdentity: IDENTITY,
    workspacePath: PATH,
  });
  assert.equal(remoteWithIdentity.success, true, remoteWithIdentity.error?.message);

  // 正例：纯本地地址（无 remoteSessionId）允许缺 identity，回落到 path。
  const localNoIdentity = windowHostTaskAddressSchema.safeParse({ taskId: "task-1", workspacePath: PATH });
  assert.equal(localNoIdentity.success, true, localNoIdentity.error?.message);
});

test("identity(5b): 远程 workspace fact 带 remoteSessionId 缺 identity → 拒绝；offline 态约束独立", () => {
  const base = {
    connectionState: "online",
    remoteSessionId: "rsess-2",
    sourceAvailability: "online",
    workspacePath: PATH,
  };
  // 负例：远程 fact 丢了 identity。
  assert.equal(windowHostControllerWorkspaceFactSchema.safeParse(base).success, false);
  // 正例：补上 identity。
  assert.equal(
    windowHostControllerWorkspaceFactSchema.safeParse({ ...base, workspaceIdentity: IDENTITY }).success,
    true,
  );
});

test("identity(5c): owner command 的 workspaceKey 与 identity 一致——path-only 被拒", () => {
  const base = {
    commandRequestId: "creq-1",
    runId: "trace-1",
    taskId: "task-1",
    type: "stop_generation",
    workspaceIdentity: IDENTITY,
    workspacePath: PATH,
  };
  // 正例：workspaceKey = identity。
  assert.equal(
    taskOwnerCommandRequestSchema.safeParse({ ...base, workspaceKey: IDENTITY }).success,
    true,
  );
  // 负例：带 identity 却按 path 填 key。
  const pathOnly = taskOwnerCommandRequestSchema.safeParse({ ...base, workspaceKey: PATH });
  assert.equal(pathOnly.success, false, "owner command 仅按路径匹配必须被拒");
  assert.match(
    pathOnly.error?.issues?.[0]?.message ?? "",
    /workspaceKey must match workspaceIdentity fallback rule/u,
  );
});

test("identity(5d): controller task row——address 与 meta 的 identity 必须一致", () => {
  const meta = {
    createdAt: 1_700_000_000_000,
    mode: "build",
    taskId: "task-1",
    title: "t",
    traceId: "trace-1",
    updatedAt: 1_700_000_000_000,
    workspaceIdentity: IDENTITY,
    workspacePath: PATH,
  };
  const row = {
    address: { taskId: "task-1", workspaceIdentity: IDENTITY, workspacePath: PATH },
    liveStatus: "idle",
    membership: { active: true, archived: false, pinned: false },
    meta,
    sourceAvailability: "online",
  };
  // 正例：address 与 meta 同 identity。
  assert.equal(windowHostControllerTaskRowSchema.safeParse(row).success, true);
  // 负例：address 有 identity 但 meta 的 identity 不同（跨 Host 路由身份不一致）。
  const mismatched = windowHostControllerTaskRowSchema.safeParse({
    ...row,
    meta: { ...meta, workspaceIdentity: "different-identity" },
  });
  assert.equal(mismatched.success, false, "address/meta identity 不一致必须被拒");
  assert.match(
    mismatched.error?.issues?.[0]?.message ?? "",
    /task address and meta identity must match/u,
  );
});
