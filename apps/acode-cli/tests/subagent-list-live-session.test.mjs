// listSessionSubagents 的会话存在性语义守护（specs/v4-deferred-session-hydration.md）。
//
// 2026-10-11「任务对话被吞」事故根因：deferred 持久化新任务（live record 在、持久行尚未
// 写入）触发 hydrate 复用本函数读取子代理种子，旧实现直接抛 "Session not found"，把整个
// loadPersistedEvents reject 掉，gateway 退回空事件 + sourceEventSeq=0 的序列基线，
// 后续 live 事件全部滞留 gap buffer。本测试钉住：live 存在 → 空种子；两边都没有 → 仍抛错。

import assert from "node:assert/strict";
import test from "node:test";

const { listSessionSubagents } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/server-operations.ts"
);

function createContext({ liveRecord }) {
  const sessions = new Map();
  if (liveRecord) {
    sessions.set("sess_live_deferred", { stateRevision: 7 });
  }
  return {
    sessions,
    logger: {
      warn: (message, fields) => {
        contextWarns.push({ message, fields });
      },
    },
    deps: {
      sessionStore: {
        getSession: async () => null,
      },
    },
  };
}

const contextWarns = [];

test("live record 存在而持久行缺失（deferred 新任务）：返回空种子，不抛错", async () => {
  const context = createContext({ liveRecord: true });
  const result = await listSessionSubagents(context, { sessionId: "sess_live_deferred" });
  assert.deepEqual(
    { childSessionIds: result.childSessionIds, running: result.running },
    { childSessionIds: [], running: [] },
    "live+deferred 会话的子代理种子必须是空列表",
  );
  assert.equal(result.revision, 7, "revision 取 live record 的 stateRevision");
  assert.ok(
    contextWarns.some((entry) => entry.fields?.event === "acode_protocol.session.persisted_missing"),
    "诊断 warn 必须留痕（不能静默吞掉存在性分歧）",
  );
});

test("既无 live record 也无持久行（无效 ID）：保留 Session not found 错误", async () => {
  const context = createContext({ liveRecord: false });
  await assert.rejects(
    () => listSessionSubagents(context, { sessionId: "sess_ghost" }),
    (error) => String(error.message).includes("Session not found: sess_ghost"),
    "task index 残留无效 ID 的诊断路径不得被此修复放宽",
  );
});
