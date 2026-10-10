import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * 编排方案 Phase 1 的不变量守护（specs/subagent-topology-persistence.md R1/R7/R8 +
 * 验收场景 8，负向断言，仿 tests/no-telemetry.test.mjs 模式）：
 * - 契约面不新增边表方法（duck-typing 纪律，swarm K4 先例）；
 * - 边表不是准入判定源（准入/权限/计费路径零引用）；
 * - repository 不反向依赖 core；迁移无 down/drop；
 * - 写入单点与收敛单点确实在场（正向锚定，防止未来重构把钩子散落回八个发射点）。
 */

const root = new URL("../", import.meta.url);
// core.autocrlf=true 的机器上工作区是 CRLF；统一归一为 LF 再做位置敏感断言。
const read = (path) =>
  readFile(new URL(path, root), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

const PORT = "packages/contracts/src/interfaces/session-store.port.ts";
const REPO = "packages/adapters/src/storage/session-store/repositories/subagent-edges.ts";
const MIGRATION = "packages/adapters/src/storage/session-store/migrations/0030-subagent-edge.ts";
const STORE = "packages/adapters/src/storage/session-store/sqlite-session-store.ts";
const AGENT_HANDLER = "packages/core/src/tool/handlers/agent.ts";
const PERMISSION_SERVICE = "packages/core/src/permission/service.ts";
const POLICY_FLOOR = "packages/core/src/permission/process-policy-floor.ts";
const RUNNER = "packages/core/src/subagent/runner.ts";
const SUBAGENT_METHODS = "packages/core/src/runtime/methods/subagent.ts";
const RESUME = "packages/core/src/runtime/methods/resume.ts";
const SERVER_OPS = "packages/bootstrap/src/acode-protocol/server-operations.ts";
const OBSERVATION = "packages/bootstrap/src/app/subagent-observation.ts";

test("R8: SessionStorePort gains no subagent edge methods (contract face stays duck-typed)", async () => {
  const port = await read(PORT);
  assert.equal(/SubagentEdge/i.test(port), false, "contracts port 面出现 SubagentEdge 方法/类型");
  assert.equal(/subagent_edge/.test(port), false, "contracts port 面出现 subagent_edge");
  assert.equal(/convergeSubagentEdges/.test(port), false);
  assert.equal(/readSubagentEdges/.test(port), false);
});

test("R1: admission/permission/billing paths never read the edge table", async () => {
  for (const path of [AGENT_HANDLER, PERMISSION_SERVICE, POLICY_FLOOR]) {
    const source = await read(path);
    assert.equal(
      /SubagentEdge|subagent_edge|readSubagentEdges/i.test(source),
      false,
      `${path} 引用了边表——边表是事后审计/恢复权威，不是准入判定源（spec R1）`,
    );
  }
});

test("layering: the edges repository does not import core", async () => {
  const repo = await read(REPO);
  assert.equal(/@acode\/core/.test(repo), false, "repository 反向依赖 core");
});

test("R7: migration 0030 has no down/drop shape", async () => {
  const migration = await read(MIGRATION);
  assert.equal(/drop\s+table/i.test(migration), false, "0030 出现 drop table");
  assert.equal(/export const \w*DOWN/i.test(migration), false, "0030 导出 down migration");
  assert.ok(/export const SUBAGENT_EDGE_MIGRATION_SQL/.test(migration));
});

test("R2 single write point: emitSubagentEvent carries the edge hook and the port wiring exists", async () => {
  const runner = await read(RUNNER);
  assert.ok(/persistSubagentEdge/.test(runner), "runner 缺少 persistSubagentEdge 钩子");
  assert.ok(
    /subagentEdgeCommandFromEvent/.test(runner),
    "runner 缺少事件→边派生（八个发射点必须经单点铸边）",
  );
  const methods = await read(SUBAGENT_METHODS);
  assert.ok(
    /bindSubagentEdgePersistence\(this\.sessionStore\)/.test(methods),
    "createDefaultSubagentPort 未接边持久化能力探测",
  );
});

test("R4 single convergence point: resume sweep calls the convergence entry", async () => {
  const resume = await read(RESUME);
  assert.ok(
    /convergeSubagentEdgesOnResume\(this\.sessionStore/.test(resume),
    "resume 未挂非终态边收敛",
  );
});

test("store delegation and both read-side callers are wired", async () => {
  const store = await read(STORE);
  for (const method of [
    "readSubagentEdges",
    "upsertSubagentEdge",
    "settleSubagentEdge",
    "convergeSubagentEdges",
    "listSubagentDescendants",
  ]) {
    assert.ok(store.includes(method), `sqlite-session-store 缺少委托方法 ${method}`);
  }
  for (const path of [SERVER_OPS, OBSERVATION]) {
    const source = await read(path);
    assert.ok(
      /readPersistedSubagentEdges/.test(source),
      `${path} 未接入持久化边读取（冷目录会退回全 lost）`,
    );
  }
});
