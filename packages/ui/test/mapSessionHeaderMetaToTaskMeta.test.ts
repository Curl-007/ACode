import assert from "node:assert/strict";
import test from "node:test";

import type { ACodeTaskMeta, TraceId } from "@acode/shared";
import type { V4SessionHeaderMeta } from "@acode/shared/acode-protocol-v4";
import { mapSessionHeaderMetaToTaskMeta } from "../src/v4/mapSessionHeaderMetaToTaskMeta.js";

/**
 * header meta → ACodeTaskMeta 映射器测试（apps/acode-cli/specs/v4-session-header-meta.md §4.4 / H8）。
 *
 * 迁移正确性的判据是**与 legacy acodeSessionSnapshotToTaskMeta 逐字段 parity**（spec R8）：
 * 这个 hook 的下游（useWorkspaceActiveTaskState）只读 taskId/traceId/title/provider/forkedFromTaskId，
 * 但 areResolvedTaskMetasEqual 按 15 字段判等价以稳定 memo 引用。故映射产物必须：
 * ① 字段集 = legacy 14 项子集（不含 titleOverridden/forkedFromTaskId/lastError）；
 * ② 对同输入**幂等**（否则等价判定不成立 → header 每次刷新重渲）。
 */

function makeMeta(overrides: Partial<V4SessionHeaderMeta> = {}): V4SessionHeaderMeta {
  return {
    taskId: "sess_archived",
    traceId: "trace_persisted",
    title: "归档会话标题",
    workspacePath: "/repo/worktree",
    workspaceIdentity: "remote://host/repo",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_060_000,
    mode: "yolo",
    model: "zai/glm-4.7",
    thoughtLevel: "high",
    provider: "glm",
    ...overrides,
  };
}

// H8：映射产物通过 ACodeTaskMeta 类型（编译期）且字段搬运正确（运行期）
test("H8: header meta 各字段搬运到 ACodeTaskMeta", () => {
  const meta = makeMeta();
  const taskMeta: ACodeTaskMeta = mapSessionHeaderMetaToTaskMeta(meta);
  assert.equal(taskMeta.taskId, "sess_archived");
  assert.equal(taskMeta.traceId, "trace_persisted");
  assert.equal(taskMeta.title, "归档会话标题");
  assert.equal(taskMeta.workspacePath, "/repo/worktree");
  assert.equal(taskMeta.workspaceIdentity, "remote://host/repo");
  assert.equal(taskMeta.createdAt, 1_700_000_000_000);
  assert.equal(taskMeta.updatedAt, 1_700_000_060_000);
  assert.equal(taskMeta.mode, "yolo");
  assert.equal(taskMeta.model, "zai/glm-4.7");
  assert.equal(taskMeta.thoughtLevel, "high");
  assert.equal(taskMeta.provider, "glm");
});

// R8：字段集是 legacy 14 项子集，不产出 titleOverridden/forkedFromTaskId/lastError
test("R8: 不产出 titleOverridden / forkedFromTaskId / lastError（与 legacy parity）", () => {
  const taskMeta = mapSessionHeaderMetaToTaskMeta(makeMeta()) as Record<string, unknown>;
  assert.equal("titleOverridden" in taskMeta, false);
  assert.equal("forkedFromTaskId" in taskMeta, false);
  assert.equal("lastError" in taskMeta, false);
  // 正向：应有字段齐全，防上面因空对象假过。
  for (const key of ["taskId", "traceId", "title", "workspacePath", "createdAt", "updatedAt", "mode", "provider"]) {
    assert.ok(key in taskMeta, `缺少应有字段 ${key}`);
  }
});

// H8 幂等：同输入两次映射深度相等（areResolvedTaskMetasEqual 成立的前提）
test("H8: 同输入连续两次映射深度相等（幂等 → header 不抖）", () => {
  const first = mapSessionHeaderMetaToTaskMeta(makeMeta());
  const second = mapSessionHeaderMetaToTaskMeta(makeMeta());
  assert.deepEqual(first, second, "映射必须幂等；traceId 是 meta 里的确定性值，不是每次新生成");
});

// 可选字段缺席时不补默认（R5/R11）
test("可选字段缺席 → 产出里同样缺席（不补默认，不伪造）", () => {
  const taskMeta = mapSessionHeaderMetaToTaskMeta(
    makeMeta({
      workspaceIdentity: undefined,
      model: undefined,
      thoughtLevel: undefined,
      status: undefined,
      target: undefined,
    }),
  ) as Record<string, unknown>;
  assert.equal("workspaceIdentity" in taskMeta, false);
  assert.equal("model" in taskMeta, false);
  assert.equal("thoughtLevel" in taskMeta, false);
  assert.equal("status" in taskMeta, false);
  assert.equal("target" in taskMeta, false);
  // 必填仍在
  assert.equal(taskMeta.taskId, "sess_archived");
  assert.equal(taskMeta.mode, "yolo");
});

// status 透传（归档冷读通常缺席，但若 wire 给了就如实带上）
test("status 有值时透传，target 非 null 时透传", () => {
  const taskMeta = mapSessionHeaderMetaToTaskMeta(
    makeMeta({ status: "completed", target: { sessionID: "s", targetID: "t", objective: "o", summaryTitle: null, status: "complete", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, time: { created: 0, updated: 0 } } }),
  );
  assert.equal(taskMeta.status, "completed");
  assert.equal(taskMeta.target?.targetID, "t");
});

// target 为 null 时缺席（不产出 target:null，与 legacy fromACodeGoal 的 null 透传不同——
// legacy 会把 projection.target=null 透传成 target:null；header 冷读把 null 视作「无 goal」缺席。
// 这条差异是有意的：ACodeTaskMeta.target 是 optional，缺席比显式 null 更贴合「未知」语义，
// 且下游 areResolvedTaskMetasEqual 对 undefined 与 null 都判「不在」，不引入抖动。）
test("target 为 null → 产出里 target 缺席（不是 target:null）", () => {
  const taskMeta = mapSessionHeaderMetaToTaskMeta(makeMeta({ target: null })) as Record<string, unknown>;
  assert.equal("target" in taskMeta, false);
});

// traceId 类型断言（TraceId 是 branded-ish string 别名；映射里 as TraceId）
test("traceId 作为 TraceId 透传（保留 meta 的确定性派生值）", () => {
  const taskMeta = mapSessionHeaderMetaToTaskMeta(makeMeta({ traceId: "session-sess_x" }));
  assert.equal(taskMeta.traceId as TraceId, "session-sess_x");
});
