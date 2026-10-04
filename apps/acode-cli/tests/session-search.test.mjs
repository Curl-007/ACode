import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * K4 验收测试：跨会话搜索（specs/session-search.md 验收场景 1-7）。
 * 全部跑在临时目录的真实 SQLite 库上（node:sqlite DatabaseSync + FTS5 trigram，
 * 迁移 0025 之后的 schema），不 mock 存储层。
 *
 * - 场景 1：中文 trigram 命中（「主密钥」3 字 MATCH）与「凭据」2 字 LIKE 兜底两路；
 *   混合段「凭据 401」；拉丁词/版本号；
 * - 场景 2：噪音排除（tool 结果体 / synthetic reminder 不进索引，投影单测 + 集成双钉）；
 *   thinking 与 bash 命令行可搜；
 * - 场景 3：同事务性（写成功即可搜；FTS 桩失败 → 主表回滚）；
 * - 场景 4：默认隐藏当前会话；includeCurrentTask:true 可见；能力缺席报配置错误；
 * - 场景 5：snippet 转义（`<script>` 不产生标签）+ 不可信声明在场；
 * - 场景 6：查询归一三规则 + 超时部分返回 + limit 截断 truncated；
 * - 场景 7：迁移幂等（二次跑 no-op）+ 存量回填中断续跑终态一致 + 孤儿清理（R5）。
 */

const { DatabaseSync } = await import("node:sqlite");
const { createSqliteSessionStore } = await import(
  "../packages/adapters/src/storage/session-store/sqlite-session-store.ts"
);
const {
  projectSessionMessageBody,
  planSessionSearchQuery,
  searchSessionMessages,
  backfillSessionMessageFts,
  reconcileSessionMessageFtsIndex,
  scheduleSessionMessageFtsPreheat,
  FTS_BODY_MAX_CHARS,
} = await import("../packages/adapters/src/storage/session-store/fts.ts");
const { runSqliteSessionMigrations } = await import(
  "../packages/adapters/src/storage/session-store/migration-runner.ts"
);
const { SESSION_MESSAGE_FTS_MIGRATION_SQL } = await import(
  "../packages/adapters/src/storage/session-store/migrations/0025-session-message-fts.ts"
);
const { sessionSearchToolEntry, normalizeSessionSearchQuery } = await import(
  "../packages/core/src/tool/handlers/session-search.ts"
);

// —— 测试基建 ——

/** Windows 下 WAL 句柄释放有延迟，目录清理是尽力而为：失败只留下临时目录，不算测试失败。 */
function bestEffortRm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* EPERM: 句柄尚未释放 */
  }
}

function openTempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "k4-session-search-"));
  const dbPath = join(dir, "sessions.db");
  const store = createSqliteSessionStore({ dbPath });
  t.after(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    bestEffortRm(dir);
  });
  return { store, dbPath };
}

let sessionSeq = 0;
let messageSeq = 0;

async function createSession(store, title) {
  sessionSeq += 1;
  const id = `sess_k4_${sessionSeq}`;
  await store.createSession({
    id,
    projectID: "proj_k4",
    slug: id,
    directory: "C:\\k4\\workspace",
    title,
    version: "v4",
  });
  return id;
}

async function saveUserMessage(store, sessionId, text, created = Date.now()) {
  messageSeq += 1;
  const messageId = `msg_k4_${messageSeq}`;
  await store.saveMessage({
    id: messageId,
    sessionID: sessionId,
    role: "user",
    time: { created },
    agent: "k4-test",
  });
  await store.savePart({
    id: `part_${messageId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    time: { start: created, end: created },
  });
  return messageId;
}

async function saveAssistantMessage(store, sessionId, created = Date.now()) {
  messageSeq += 1;
  const messageId = `msg_k4_${messageSeq}`;
  await store.saveMessage({
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    parentID: `parent_${messageId}`,
    time: { created },
    mode: "build",
    agent: "k4-test",
  });
  return messageId;
}

function textPart(sessionId, messageId, text, extra = {}) {
  return {
    id: `part_${messageId}_${Math.random().toString(36).slice(2, 8)}`,
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    time: { start: Date.now(), end: Date.now() },
    ...extra,
  };
}

function toolPart(sessionId, messageId, tool, input, output) {
  return {
    id: `part_${messageId}_${Math.random().toString(36).slice(2, 8)}`,
    sessionID: sessionId,
    messageID: messageId,
    type: "tool",
    callID: `call_${Math.random().toString(36).slice(2, 8)}`,
    tool,
    state: {
      status: "completed",
      input,
      output,
      title: tool,
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  };
}

function handlerContext(sessionId, sessionStore) {
  return {
    sessionId,
    sessionStore,
    toolCallId: "tc_k4_test",
    abortSignal: new AbortController().signal,
  };
}

// —— 场景 1：中文 trigram + 短段 LIKE 兜底 + 拉丁/版本号 ——

test("scenario 1: CJK trigram match, 2-char LIKE fallback, mixed segments, latin/version", async (t) => {
  const { store } = openTempStore(t);
  const sessionId = await createSession(store, "修复 401 会话");
  await saveUserMessage(store, sessionId, "线上 401 是因为凭据主密钥轮换后没同步配置");
  await saveUserMessage(store, sessionId, "pnpm typecheck 通过，锁定了 1.2.3 版本");

  // 3 字 CJK：trigram MATCH 路径
  const hitMainKey = store.searchSessionMessages({ query: "主密钥" });
  assert.equal(hitMainKey.truncated, false);
  assert.ok(hitMainKey.rows.length >= 1, "主密钥 (3-char) must hit via MATCH");
  assert.ok(hitMainKey.rows.every((row) => row.taskId === sessionId));
  assert.ok(hitMainKey.rows[0].matchCount >= 1);
  assert.equal(hitMainKey.rows[0].taskTitle, "修复 401 会话");

  // 2 字 CJK：trigram MATCH 不命中（spec 附录实测），走 LIKE 兜底
  const plan = planSessionSearchQuery("凭据");
  assert.equal(plan.matchExpr, null);
  assert.deepEqual(plan.likePatterns, ["%凭据%"]);
  const hitCredentials = store.searchSessionMessages({ query: "凭据" });
  assert.ok(hitCredentials.rows.length >= 1, "凭据 (2-char) must hit via LIKE fallback");

  // 混合段：「凭据」(<3) LIKE + 「401」(=3) MATCH，多段 OR 组合
  const mixed = planSessionSearchQuery("凭据 401");
  assert.equal(mixed.matchExpr, '"401"');
  assert.deepEqual(mixed.likePatterns, ["%凭据%"]);
  const mixedHit = store.searchSessionMessages({ query: "凭据 401" });
  assert.ok(mixedHit.rows.some((row) => row.sessionId === sessionId));

  // 拉丁词与版本号
  for (const query of ["pnpm", "typecheck", "1.2.3"]) {
    const latinHit = store.searchSessionMessages({ query });
    assert.ok(latinHit.rows.length >= 1, `latin query ${query} must hit`);
  }

  // 引号短语（多词 phrase）
  const phrase = store.searchSessionMessages({ query: '"主密钥轮换"' });
  assert.ok(phrase.rows.length >= 1, "quoted phrase must hit");

  // 未命中词
  const none = store.searchSessionMessages({ query: "不存在的检索词组" });
  assert.equal(none.rows.length, 0);
  assert.equal(none.truncated, false);
});

// —— 场景 2：噪音排除（tool 结果体 / reminders）+ thinking / 命令行可搜 ——

test("scenario 2: tool output and reminder noise excluded; thinking and command line searchable", async (t) => {
  const { store } = openTempStore(t);
  const sessionId = await createSession(store, "噪音排除");
  const messageId = await saveAssistantMessage(store, sessionId);

  const reasoning = {
    id: `part_${messageId}_reasoning`,
    sessionID: sessionId,
    messageID: messageId,
    type: "reasoning",
    text: "先排查凭据泄漏路径，再决定是否轮换主密钥",
    time: { start: Date.now(), end: Date.now() },
  };
  const bash = toolPart(
    sessionId,
    messageId,
    "Bash",
    { command: "pnpm audit --prod" },
    "AUDITNOISETOKEN high severity advisory noise output",
  );
  const webfetch = toolPart(
    sessionId,
    messageId,
    "WebFetch",
    { url: "https://example.com/credentials-guide" },
    "WEBFETCHNOISETOKEN page body noise",
  );
  const reminder = textPart(
    sessionId,
    messageId,
    "<system-reminder>TODOREMINDERTOKEN keep the plan short</system-reminder>",
    { synthetic: true },
  );
  const conclusion = textPart(sessionId, messageId, "结论：必须先轮换凭据再重试请求");
  for (const part of [reasoning, bash, webfetch, reminder, conclusion]) {
    await store.savePart(part);
  }

  // 投影单测：唯一实现的收录/排除规则
  const info = { id: messageId, sessionID: sessionId, role: "assistant", time: { created: 1 } };
  const body = projectSessionMessageBody(info, [
    conclusion,
    reasoning,
    bash,
    webfetch,
    reminder,
  ]);
  assert.ok(body.includes("必须先轮换凭据"), "text block indexed");
  assert.ok(body.includes("凭据泄漏路径"), "thinking block indexed");
  assert.ok(body.includes("pnpm audit --prod"), "tool command line indexed");
  assert.ok(body.includes("credentials-guide"), "tool url summary indexed");
  assert.ok(!body.includes("AUDITNOISETOKEN"), "tool result body excluded");
  assert.ok(!body.includes("WEBFETCHNOISETOKEN"), "tool result body excluded");
  assert.ok(!body.includes("TODOREMINDERTOKEN"), "synthetic reminder excluded");

  // 集成双钉
  assert.ok(store.searchSessionMessages({ query: "audit" }).rows.length >= 1);
  assert.ok(store.searchSessionMessages({ query: "泄漏路径" }).rows.length >= 1);
  assert.equal(store.searchSessionMessages({ query: "AUDITNOISETOKEN" }).rows.length, 0);
  assert.equal(store.searchSessionMessages({ query: "WEBFETCHNOISETOKEN" }).rows.length, 0);
  assert.equal(store.searchSessionMessages({ query: "TODOREMINDERTOKEN" }).rows.length, 0);

  // 超长投影截断：尾部标记 …[truncated]，总长不超上限
  const longText = "长".repeat(FTS_BODY_MAX_CHARS + 100);
  const truncatedBody = projectSessionMessageBody(info, [
    textPart(sessionId, messageId, longText),
  ]);
  assert.equal(truncatedBody.length, FTS_BODY_MAX_CHARS);
  assert.ok(truncatedBody.endsWith("…[truncated]"));
});

// —— 场景 3：同事务性（写成功即可搜；FTS 失败 → 主表回滚） ——

test("scenario 3: message write and FTS maintenance share one transaction", async (t) => {
  const { store, dbPath } = openTempStore(t);
  const sessionId = await createSession(store, "同事务");

  // 正向：写提交后立即可搜（主表写成功 FTS 必在）
  const messageId = await saveUserMessage(store, sessionId, "同事务正向验证 TOKENINLINE");
  assert.ok(store.searchSessionMessages({ query: "TOKENINLINE" }).rows.length >= 1);
  const afterFirst = await store.messages({ sessionID: sessionId });
  assert.equal(afterFirst.length, 1);

  // 反向（FTS 桩失败）：第二个连接删掉 fts 虚表 → 投影维护必然失败 → 整个写回滚
  const raw = new DatabaseSync(dbPath, { timeout: 5_000 });
  t.after(() => {
    try {
      raw.close();
    } catch {
      /* 已关闭 */
    }
  });
  raw.exec("drop table session_message_fts");
  await assert.rejects(
    saveUserMessage(store, sessionId, "不应落库的回滚验证 TOKENROLLBACK"),
    /session_message_fts|no such table/i,
  );
  // 主表与投影都被回滚：消息数不变，新消息检索不到
  const messagesAfterFailure = await store.messages({ sessionID: sessionId });
  assert.equal(messagesAfterFailure.length, 1, "main table write must roll back with FTS failure");
  const rawCount = raw
    .prepare("select count(*) as count from session_message_doc where body like ?")
    .get("%TOKENROLLBACK%");
  assert.equal(Number(rawCount.count), 0, "projection row must roll back too");

  // 恢复虚表（同款 DDL，幂等），后续写路径恢复可用
  raw.exec(SESSION_MESSAGE_FTS_MIGRATION_SQL);
  const recoveredId = await saveUserMessage(store, sessionId, "恢复后写入 TOKENRECOVER");
  assert.ok(store.searchSessionMessages({ query: "TOKENRECOVER" }).rows.length >= 1);
  assert.notEqual(recoveredId, messageId);

  // removeMessage 同事务删除投影
  await store.removeMessage({ sessionID: sessionId, messageID: recoveredId });
  assert.equal(store.searchSessionMessages({ query: "TOKENRECOVER" }).rows.length, 0);

  // 外层事务路径（promoteSessionInput 自带 begin immediate）：FTS 接线必须内联进外层
  // 事务而不是嵌套开事务；promotion 提交后立即可搜
  await store.saveSessionInput({
    id: "input_k4_1",
    sessionID: sessionId,
    kind: "conversation",
    delivery: "queue",
    payload: { text: "外层事务验证 TOKENPROMOTE" },
  });
  const promotedMessageId = "msg_k4_promoted";
  await store.promoteSessionInput({
    id: "input_k4_1",
    sessionID: sessionId,
    message: {
      id: promotedMessageId,
      sessionID: sessionId,
      role: "user",
      time: { created: Date.now() },
      agent: "k4-test",
    },
    parts: [
      {
        id: `part_${promotedMessageId}`,
        sessionID: sessionId,
        messageID: promotedMessageId,
        type: "text",
        text: "外层事务验证 TOKENPROMOTE",
        time: { start: Date.now(), end: Date.now() },
      },
    ],
  });
  assert.ok(
    store.searchSessionMessages({ query: "TOKENPROMOTE" }).rows.length >= 1,
    "promotion transaction maintains FTS inline",
  );
});

// —— 场景 4：默认隐藏当前会话；includeCurrentTask 可见；能力缺席报错 ——

test("scenario 4: current session hidden by default; includeCurrentTask reveals it", async (t) => {
  const { store } = openTempStore(t);
  const currentSession = await createSession(store, "当前会话");
  const otherSession = await createSession(store, "历史会话");
  await saveUserMessage(store, currentSession, "部署回滚脚本 rollback-plan-alpha");
  await saveUserMessage(store, otherSession, "部署回滚脚本 rollback-plan-alpha");

  // handler 层：默认隐藏当前会话
  const defaultOutput = await sessionSearchToolEntry.handler(
    { query: "rollback-plan-alpha" },
    handlerContext(currentSession, store),
  );
  assert.ok(defaultOutput.results.length >= 1);
  assert.ok(defaultOutput.results.every((item) => item.taskId !== currentSession));

  // includeCurrentTask: true 时可见
  const includedOutput = await sessionSearchToolEntry.handler(
    { query: "rollback-plan-alpha", includeCurrentTask: true },
    handlerContext(currentSession, store),
  );
  assert.ok(includedOutput.results.some((item) => item.taskId === currentSession));
  assert.ok(includedOutput.results.some((item) => item.taskId === otherSession));

  // 存储层等价参数：excludeTaskId
  const adapterLevel = store.searchSessionMessages({
    query: "rollback-plan-alpha",
    excludeTaskId: currentSession,
  });
  assert.ok(adapterLevel.rows.every((row) => row.sessionId !== currentSession));

  // 能力缺席（端口形态没有 FTS 检索）：配置错误，不伪装成空结果
  await assert.rejects(
    sessionSearchToolEntry.handler(
      { query: "rollback-plan-alpha" },
      handlerContext(currentSession, {}),
    ),
    (error) => {
      assert.match(String(error.message), /session message search|K4/i);
      return true;
    },
  );
});

// —— 场景 5：snippet 转义 + 不可信声明 ——

test("scenario 5: snippet escaping and untrusted notice", async (t) => {
  const { store } = openTempStore(t);
  const sessionId = await createSession(store, "注入面");
  // 短段「凭据」走 LIKE 兜底：JS 侧 ±64 字符窗口确定覆盖标签，转义断言可稳定成立
  await saveUserMessage(
    store,
    sessionId,
    "<script>alert(1)</script> 附近的凭据泄露点，必须转义后展示",
  );

  const output = await sessionSearchToolEntry.handler(
    { query: "凭据" },
    handlerContext("sess_other", store),
  );
  assert.equal(output.results.length, 1);
  const snippet = output.results[0].snippet;
  // 正文中的标签只能以实体形态出现；高亮标记本身用真实 < >（形态 <match>）
  assert.ok(snippet.includes("&lt;script&gt;"), `snippet must escape tags: ${snippet}`);
  assert.ok(!snippet.includes("<script>"), "raw tag must not survive");
  assert.ok(snippet.includes("<凭据>"), `highlight marker present: ${snippet}`);

  // MATCH 路径（FTS5 snippet）同样带 <match> 高亮形态
  const matchOutput = store.searchSessionMessages({ query: "泄露点" });
  assert.equal(matchOutput.rows.length, 1);
  assert.ok(matchOutput.rows[0].snippet.includes("<泄露点>"), matchOutput.rows[0].snippet);

  // 不可信声明在场（工具输出本身是给模型看的不可信数据）
  assert.ok(output.notice && output.notice.length > 0);
  assert.match(output.notice, /untrusted/i);
  const modelContent = sessionSearchToolEntry.formatModelContent(output);
  assert.match(modelContent, /untrusted/i);
  assert.ok(!modelContent.includes("<script>alert"));
});

// —— 场景 6：查询归一三规则 + 超时部分返回 + limit 截断 ——

test("scenario 6: query normalization, timeout partial results, limit truncation", async (t) => {
  // 三条归一规则（handler 唯一实现）
  assert.equal(normalizeSessionSearchQuery("x".repeat(300)).length, 256);
  assert.equal(normalizeSessionSearchQuery('"未闭合短语'), '"未闭合短语"');
  assert.equal(normalizeSessionSearchQuery("*foo"), "foo");
  assert.equal(normalizeSessionSearchQuery("**bar"), "bar");
  // 多余引号闭合后（4 个引号平衡）不再追加
  assert.equal(normalizeSessionSearchQuery('"a" "b"'), '"a" "b"');

  const { store } = openTempStore(t);
  for (let index = 0; index < 3; index += 1) {
    const sessionId = await createSession(store, `limit-cut-${index}`);
    await saveUserMessage(store, sessionId, `批量验证 LIMITCUTTERM 第 ${index} 条`);
  }

  // 超时（timeoutMs 0）：两阶段都在期限外 → 空结果 + truncated（部分返回语义，不 fail）
  const timedOut = store.searchSessionMessages({ query: "LIMITCUTTERM", timeoutMs: 0 });
  assert.equal(timedOut.rows.length, 0);
  assert.equal(timedOut.truncated, true);
  const timedOutLike = store.searchSessionMessages({ query: "凭据", timeoutMs: 0 });
  assert.equal(timedOutLike.truncated, true);

  // limit 截断：3 条命中、limit 2 → 2 条 + truncated；limit 默认 10 → 全量
  const cut = store.searchSessionMessages({ query: "LIMITCUTTERM", limit: 2 });
  assert.equal(cut.rows.length, 2);
  assert.equal(cut.truncated, true);
  const full = store.searchSessionMessages({ query: "LIMITCUTTERM" });
  assert.equal(full.rows.length, 3);
  assert.equal(full.truncated, false);
});

// —— 场景 7：迁移幂等 + 存量回填中断续跑 + 孤儿清理/预热 ——

test("scenario 7: migration idempotency, resumable backfill, orphan purge and preheat", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "k4-session-search-backfill-"));
  const dbPath = join(dir, "sessions.db");
  t.after(() => bestEffortRm(dir));

  const terms = ["存量回填甲", "存量回填乙", "存量回填丙", "存量回填丁", "存量回填戊"];
  {
    const store = createSqliteSessionStore({ dbPath });
    const sessionId = await createSession(store, "存量库");
    for (const term of terms) await saveUserMessage(store, sessionId, `${term} 的历史消息`);
    // 迁移账本已含 0025（顺延 0024 编号）
    assert.ok(store.debugMigrationIds().includes("0025_session_message_fts"));
    store.close();
  }

  const raw = new DatabaseSync(dbPath, { timeout: 5_000 });
  raw.exec("pragma foreign_keys = on");
  t.after(() => {
    try {
      raw.close();
    } catch {
      /* 已关闭 */
    }
  });

  // 幂等：对已迁移库二次跑迁移 → no-op（checksum 不变、账本不重复）
  runSqliteSessionMigrations(raw, dbPath);
  const migrationCount = raw
    .prepare("select count(*) as count from schema_migration where id = '0025_session_message_fts'")
    .get();
  assert.equal(Number(migrationCount.count), 1);

  // 构造「迁移建表完成、回填未开始」的存量库形态：清掉全部投影行并重置账本
  const docs = raw.prepare("select * from session_message_doc").all();
  for (const doc of docs) {
    raw
      .prepare(
        "insert into session_message_fts (session_message_fts, rowid, body, session_id, task_id, role, message_ts) values ('delete', ?, ?, ?, ?, ?, ?)",
      )
      .run(doc.id, doc.body, doc.session_id, doc.task_id, doc.role, doc.message_ts);
    raw.prepare("delete from session_message_doc where id = ?").run(doc.id);
  }
  raw
    .prepare(
      "update session_message_fts_backfill set last_message_rowid = 0, done = 0, processed = 0",
    )
    .run();
  assert.equal(searchSessionMessages(raw, { query: "存量回填甲" }).rows.length, 0);

  // 回填中断续跑：batchRows=2 + maxBatches=1 模拟第一批提交后进程被 kill
  const firstRun = backfillSessionMessageFts(raw, { batchRows: 2, maxBatches: 1 });
  assert.equal(firstRun.processed, 2);
  assert.equal(firstRun.exhausted, false);
  const ledgerMid = raw
    .prepare("select last_message_rowid, done from session_message_fts_backfill where id = 1")
    .get();
  assert.equal(ledgerMid.done, 0);
  assert.ok(Number(ledgerMid.last_message_rowid) > 0, "ledger cursor persisted between batches");
  // 中断态：只有已回填的子集可搜
  const midHits = terms.filter(
    (term) => searchSessionMessages(raw, { query: term }).rows.length > 0,
  );
  assert.equal(midHits.length, 2);

  // 续跑至完成：终态与一次跑完一致
  const resume = backfillSessionMessageFts(raw, { batchRows: 2 });
  assert.equal(resume.processed, 3);
  assert.equal(resume.exhausted, true);
  for (const term of terms) {
    assert.equal(searchSessionMessages(raw, { query: term }).rows.length, 1, `${term} searchable`);
  }
  // 幂等：已完成后再跑为 no-op
  const rerun = backfillSessionMessageFts(raw, { batchRows: 2 });
  assert.equal(rerun.processed, 0);

  // 孤儿清理（R5 reconcile）：绕过 removeMessage 的级联删除留下孤儿投影
  const orphanMessageId = raw.prepare("select id from message order by rowid limit 1").get().id;
  raw.prepare("delete from message where id = ?").run(orphanMessageId);
  const reconciled = reconcileSessionMessageFtsIndex(raw);
  assert.ok(reconciled.purgedOrphans >= 1, "orphan projection purged");
  const remaining = raw.prepare("select count(*) as count from session_message_doc").get();
  const remainingMessages = raw.prepare("select count(*) as count from message").get();
  assert.equal(Number(remaining.count), Number(remainingMessages.count));

  // R5 预热：scheduleSessionMessageFtsPreheat 在延迟后台任务中补缺口
  raw.prepare("delete from session_message_doc where message_id = (select id from message limit 1)").run();
  raw.prepare("update session_message_fts_backfill set done = 0").run();
  scheduleSessionMessageFtsPreheat(raw);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const gap = raw
    .prepare(
      "select count(*) as count from message m where not exists (select 1 from session_message_doc d where d.message_id = m.id)",
    )
    .get();
  assert.equal(Number(gap.count), 0, "preheat closes the gap in background");
  // 测试体内显式关闭，避免 Windows 句柄延迟导致目录清理 EPERM
  raw.close();
});

// —— 对抗复核回归：M2 LIKE 兜底打 FTS5 虚表 + 超期如实 truncated ——

test("M2 regression: short CJK LIKE fallback targets the fts virtual table, not the doc table", async (t) => {
  const { store } = openTempStore(t);
  const sessionId = await createSession(store, "M2 虚表 LIKE");
  await saveUserMessage(store, sessionId, "第一条：凭据轮换之后需要同步更新客户端配置");
  await saveUserMessage(store, sessionId, "第二条：凭据轮换之后还需要重启服务进程");

  // 行为断言：>1 条消息 + 短 CJK 查询（<3 字符 → LIKE 兜底）全部命中
  const hit = store.searchSessionMessages({ query: "凭据" });
  assert.equal(hit.truncated, false);
  assert.equal(hit.rows.length, 2, "both LIKE fallback hits returned via virtual table");
  assert.ok(hit.rows.every((row) => row.sessionId === sessionId));
  assert.ok(hit.rows.every((row) => row.matchCount >= 1));

  // 源码断言：LIKE 段的 FROM 目标是 session_message_fts 虚表（M2：不再全表扫
  // session_message_doc 普通表），LIKE 谓词打在虚表 body 列上。
  const ftsSource = readFileSync(
    new URL("../packages/adapters/src/storage/session-store/fts.ts", import.meta.url),
    "utf8",
  );
  const likePhase = ftsSource.slice(
    ftsSource.indexOf("function queryLikePhase"),
    ftsSource.indexOf("export function searchSessionMessages"),
  );
  assert.ok(likePhase.includes("from session_message_fts"), "LIKE phase FROM must be the fts virtual table");
  assert.ok(
    likePhase.includes("session_message_fts.body like"),
    "LIKE predicate must run on the virtual table body column",
  );
  assert.ok(
    !/\bfrom\s+session_message_doc\b/.test(likePhase),
    "LIKE phase must not scan the plain doc table as its FROM source",
  );

  // 超时段被期限截断 → 如实 truncated（时钟桩：前两次读钟在期限内放行 LIKE 段，
  // 段跑完后第三次读钟已超期——旧实现此时仍报 truncated=false）
  const realNow = Date.now;
  let clockCalls = 0;
  let overran;
  try {
    Date.now = () => {
      clockCalls += 1;
      // startedAt 与 LIKE 段前检查在期限内；段后超期检查超期 60s
      return clockCalls <= 2 ? realNow() : realNow() + 60_000;
    };
    overran = store.searchSessionMessages({ query: "凭据", timeoutMs: 500 });
  } finally {
    Date.now = realNow;
  }
  assert.equal(overran.rows.length, 2, "completed portion is returned on overrun");
  assert.equal(overran.truncated, true, "deadline overrun during LIKE phase must report truncated (M2)");
});

// —— 对抗复核回归：L1 正文哨兵不可伪造高亮 ——

test("L1 regression: body-borne snippet sentinels cannot forge real bracket pairs", async (t) => {
  const { store } = openTempStore(t);
  const sessionId = await createSession(store, "L1 哨兵伪造");
  const SENTINEL_START = String.fromCharCode(1);
  const SENTINEL_END = String.fromCharCode(2);

  // LIKE 路径：正文含字面 \u0001b\u0002，短查询「凭据」
  await saveUserMessage(
    store,
    sessionId,
    `${SENTINEL_START}b${SENTINEL_END} 正文里的凭据内容，必须安全渲染`,
  );
  // MATCH 路径：伪造对紧邻 4 字命中词，确保落进 FTS5 snippet() 窗口
  await saveUserMessage(
    store,
    sessionId,
    `${SENTINEL_START}script${SENTINEL_END}紧邻注入载荷的说明凭据`,
  );

  const likeHit = store.searchSessionMessages({ query: "凭据" });
  assert.equal(likeHit.rows.length, 2);
  for (const row of likeHit.rows) {
    assert.ok(!row.snippet.includes("<b>"), `forged tag must not survive (LIKE): ${row.snippet}`);
    assert.ok(!row.snippet.includes("<script"), `forged tag must not survive (LIKE): ${row.snippet}`);
    assert.ok(!row.snippet.includes(SENTINEL_START) && !row.snippet.includes(SENTINEL_END));
    assert.ok(row.snippet.includes("<凭据>"), `legit highlight preserved (LIKE): ${row.snippet}`);
  }

  const matchHit = store.searchSessionMessages({ query: "注入载荷" });
  assert.equal(matchHit.rows.length, 1);
  const matchSnippet = matchHit.rows[0].snippet;
  assert.ok(!matchSnippet.includes("<script"), `forged tag must not survive (MATCH): ${matchSnippet}`);
  assert.ok(!matchSnippet.includes(SENTINEL_START) && !matchSnippet.includes(SENTINEL_END));
  assert.ok(matchSnippet.includes("<注入载荷>"), `legit highlight preserved (MATCH): ${matchSnippet}`);
});

// —— 对抗复核回归：L3 removeMessage 的 FTS 删除以主表删除生效为前置 ——

test("L3 regression: removeMessage with wrong sessionID leaves main table and FTS untouched", async (t) => {
  const { store } = openTempStore(t);
  const sessionId = await createSession(store, "L3 删除门控");
  const otherSession = await createSession(store, "L3 旁观会话");
  const messageId = await saveUserMessage(store, sessionId, "L3 删除门控验证 TOKENL3ALIVE");

  // 传错的 sessionID：主表删除命中 0 行 → FTS 投影不得随删（活消息必须仍可搜到）
  await store.removeMessage({ sessionID: otherSession, messageID: messageId });
  assert.equal((await store.messages({ sessionID: sessionId })).length, 1, "main row survives");
  assert.ok(
    store.searchSessionMessages({ query: "TOKENL3ALIVE" }).rows.length >= 1,
    "live message stays searchable (FTS projection intact)",
  );

  // 正确 sessionID 仍然正常删除（主表 + FTS 同事务）
  await store.removeMessage({ sessionID: sessionId, messageID: messageId });
  assert.equal((await store.messages({ sessionID: sessionId })).length, 0);
  assert.equal(store.searchSessionMessages({ query: "TOKENL3ALIVE" }).rows.length, 0);
});
