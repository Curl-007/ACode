import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";

/**
 * Supervisor 更新就绪门与状态快照持久化守护（review 测试专项 P2：supervisor 生命周期覆盖偏薄）。
 *
 * 这两个模块是 applyUpdate 回滚状态机的关键零件：
 * - waitForUpdateReady：更新后轮询 Core 状态，ready 即返回；crashed/crash-loop-stopped 立即抛错
 *   （触发回滚）；超时抛错（触发回滚）。是「更新失败必须回滚」的判据来源。
 * - statusSnapshot：readPersistedStatusDetailed 区分 missing / invalid / unreadable / valid 四态——
 *   uninstall/stop 依赖它把「无法确认已停止」与「已经停止」分开，不能折叠成同一个 null。
 *   createStatusPersister 单次写失败不得永久 reject 排队链。
 *
 * 用有界轮询与小超时（无固定 sleep 时序依赖），真临时文件 + t.after 清理。
 */
const { waitForUpdateReady } = await import("../src/runtime/updateReadiness.ts");
const {
  readPersistedStatusDetailed,
  createStatusPersister,
} = await import("../src/runtime/statusSnapshot.ts");
const { resolveServerLayout } = await import("../src/runtime/paths.ts");

async function until(read, predicate, message, budgetMs = 3_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

// ── waitForUpdateReady ────────────────────────────────────────────

test("waitForUpdateReady：状态变 ready 即返回", async () => {
  let state = "starting";
  const wait = waitForUpdateReady(() => state, 2_000);
  // 异步把状态推进到 ready；轮询应捕获并 resolve。
  setTimeout(() => {
    state = "ready";
  }, 30);
  await wait;
  assert.equal(state, "ready");
});

test("waitForUpdateReady：crashed / crash-loop-stopped 立即抛错（触发回滚）", async () => {
  for (const badState of ["crashed", "crash-loop-stopped"]) {
    await assert.rejects(
      () => waitForUpdateReady(() => badState, 2_000),
      /failed while applying update/,
      `${badState} 必须立即抛错`,
    );
  }
});

test("waitForUpdateReady：始终非 ready 时超时抛错", async () => {
  await assert.rejects(
    () => waitForUpdateReady(() => "starting", 150),
    /Timed out waiting for Server Core ready/,
  );
});

// ── statusSnapshot 四态 ───────────────────────────────────────────

test("readPersistedStatusDetailed：文件缺失 → missing（区别于损坏）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveServerLayout(root);
  const result = await readPersistedStatusDetailed(layout);
  assert.equal(result.state, "missing");
  assert.equal(result.status, null);
});

test("readPersistedStatusDetailed：损坏 JSON → invalid；合法快照 → valid", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = resolveServerLayout(root);
  await mkdir(dirname(layout.statusFile), { recursive: true });

  // 损坏 JSON：必须是 invalid（不是 missing），否则 stop/uninstall 会误判「已停止」。
  await writeFile(layout.statusFile, "{not json", "utf8");
  const corrupt = await readPersistedStatusDetailed(layout);
  assert.equal(corrupt.state, "invalid");
  assert.equal(corrupt.status, null);

  // schema 不合法（缺字段）同样归 invalid。
  await writeFile(layout.statusFile, JSON.stringify({ bogus: true }), "utf8");
  const schemaBad = await readPersistedStatusDetailed(layout);
  assert.equal(schemaBad.state, "invalid");

  // 合法快照 → valid 且可解析。
  const valid = {
    protocolVersion: 1,
    state: "ready",
    pid: 42,
    port: 1234,
    host: "127.0.0.1",
    version: "test",
    generation: 1,
    startedAt: 1_000,
    lastExitReason: null,
    serviceRegistered: false,
    runningTaskCount: 0,
    crashBudget: { crashCount: 0, nextRestartDelayMs: 1_000, exhausted: false },
    updatedAt: 1_000,
  };
  await writeFile(layout.statusFile, JSON.stringify(valid), "utf8");
  const parsed = await readPersistedStatusDetailed(layout);
  assert.equal(parsed.state, "valid");
  assert.equal(parsed.status.pid, 42);
  assert.equal(parsed.status.state, "ready");
});

test("createStatusPersister：单次写失败不永久 reject 排队链，后续写仍成功", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-persist-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statusFile = join(root, "status.json");
  const errors = [];
  let payload = { n: 1 };
  // getStatus 第一次抛错（模拟瞬时序列化/状态异常），之后正常。
  let first = true;
  const persist = createStatusPersister(
    statusFile,
    () => {
      if (first) {
        first = false;
        throw new Error("transient status failure");
      }
      return payload;
    },
    (error) => errors.push(error),
  );

  await persist(); // 失败被 onError 吞掉，不 reject
  assert.equal(errors.length, 1, "失败必须经 onError 上报");
  payload = { n: 2 };
  await persist(); // 排队链未被永久 reject，第二次应成功落盘
  await until(
    async () => {
      try {
        const { readFile } = await import("node:fs/promises");
        return JSON.parse(await readFile(statusFile, "utf8"));
      } catch {
        return null;
      }
    },
    (value) => value?.n === 2,
    "第二次写必须落盘",
  );
  assert.equal(errors.length, 1, "第二次写不得再报错");
});
