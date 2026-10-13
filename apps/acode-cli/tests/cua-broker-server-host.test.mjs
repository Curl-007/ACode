/**
 * broker-server.js host 编排面测试——角色 B 增量 2。
 *
 * 覆盖 §7.8 裁决并入角色 B 的 host 侧纯 JS 编排函数中「机械可定」的两组：
 * - marker 三件套 mark/has/clearCuaProductHelperAgentEnvUnavailable（§7.7 回退门槛的强制机制，
 *   占位 has 恒 false 曾使 node.ts 七处 BROKER_UNAVAILABLE 门控全部失效）；
 * - waitForCuaHelperStartup（有界 deadline race，占位曾忽略 deadlineMs 直接 await）。
 *
 * isPotentialACodeCuaAgentMcpServer 已随角色 B 增量 4 补实（测试见同目录
 * cua-agent-mcp-predicate.test.mjs 与 packages/services/test/cuaAgentMcpPredicateParity.test.ts），
 * 不再属本文件注释的 fail-closed 面。isOfficialCuaPluginEnabledForWorkspace /
 * createCuaProductMcpServerResolver / CuaProductHelperWorkspaceRegistry 仍 fail-closed
 * （最小可用集延后，见 module-boundary.md），本文件不测其补实。
 *
 * 落 apps/acode-cli/tests/（packages/acode-cua 无 test 脚本）；深路径 import broker-server.js。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearCuaProductHelperAgentEnvUnavailable,
  hasCuaProductHelperAgentEnvUnavailable,
  markCuaProductHelperAgentEnvUnavailable,
  waitForCuaHelperStartup,
} from "../../../packages/acode-cua/broker-server.js";
import { isCuaHelperError } from "../../../packages/acode-cua/broker.js";

// ─────────────────────────────────────────────────────────────────────────────
// 组 1：marker 三件套——host-keyed fail-closed 标志
// ─────────────────────────────────────────────────────────────────────────────

test("marker：初始未标记 → has 为 false", () => {
  const host = { start() {} };
  assert.equal(hasCuaProductHelperAgentEnvUnavailable(host), false);
});

test("marker：mark 后 has 为 true，clear 后回到 false", () => {
  const host = { start() {} };
  markCuaProductHelperAgentEnvUnavailable(host);
  assert.equal(hasCuaProductHelperAgentEnvUnavailable(host), true);
  clearCuaProductHelperAgentEnvUnavailable(host);
  assert.equal(hasCuaProductHelperAgentEnvUnavailable(host), false);
});

test("marker：host-keyed——标记 hostA 不影响 hostB（不同 host 互不串扰）", () => {
  const hostA = { start() {} };
  const hostB = { start() {} };
  markCuaProductHelperAgentEnvUnavailable(hostA);
  assert.equal(hasCuaProductHelperAgentEnvUnavailable(hostA), true);
  assert.equal(hasCuaProductHelperAgentEnvUnavailable(hostB), false, "标记 A 不得让 B 也 fail-closed");
  clearCuaProductHelperAgentEnvUnavailable(hostA);
});

test("marker：同一 host 重复 mark 幂等，clear 后才解除", () => {
  const host = { start() {} };
  markCuaProductHelperAgentEnvUnavailable(host);
  markCuaProductHelperAgentEnvUnavailable(host);
  assert.equal(hasCuaProductHelperAgentEnvUnavailable(host), true);
  clearCuaProductHelperAgentEnvUnavailable(host);
  assert.equal(hasCuaProductHelperAgentEnvUnavailable(host), false, "一次 clear 即解除（非计数）");
});

test("marker：非对象入参（null/undefined/原始值）→ has false、mark/clear 不抛（fail-closed 不崩）", () => {
  for (const bad of [null, undefined, 0, "", false, 42, "host"]) {
    assert.equal(hasCuaProductHelperAgentEnvUnavailable(bad), false, `has(${String(bad)}) 应 false`);
    // mark/clear 对非对象必须静默忽略，不得抛（node.ts 在 catch 路径调 mark，抛会掩盖原错误）
    assert.doesNotThrow(() => markCuaProductHelperAgentEnvUnavailable(bad));
    assert.doesNotThrow(() => clearCuaProductHelperAgentEnvUnavailable(bad));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 2：waitForCuaHelperStartup——有界 deadline race
// ─────────────────────────────────────────────────────────────────────────────

test("waitForCuaHelperStartup：无 deadline（undefined/0/负/非有限）→ 直接 await startup（向后兼容占位语义）", async () => {
  assert.equal(await waitForCuaHelperStartup(Promise.resolve("ok"), undefined), "ok");
  assert.equal(await waitForCuaHelperStartup(Promise.resolve("ok"), 0), "ok");
  assert.equal(await waitForCuaHelperStartup(Promise.resolve("ok"), -1), "ok");
  assert.equal(await waitForCuaHelperStartup(Promise.resolve("ok"), Number.NaN), "ok");
  // 非 Promise 值也能 await（node.ts 传的是 host.start()/waitForTransport()，但契约是 startup: Promise<T>）
  assert.equal(await waitForCuaHelperStartup(Promise.resolve(42)), 42);
});

test("waitForCuaHelperStartup：startup 在 deadline 内完成 → 返回 startup 结果", async () => {
  const result = await waitForCuaHelperStartup(
    new Promise((resolve) => setTimeout(() => resolve("fast"), 10)),
    2000,
  );
  assert.equal(result, "fast");
});

test("waitForCuaHelperStartup：startup 超过 deadline → 抛 CuaHelperError code caller_timeout（node.ts:1211 精确判定）", async () => {
  const never = new Promise(() => {}); // 永不 resolve
  const startedAt = Date.now();
  await assert.rejects(
    waitForCuaHelperStartup(never, 80),
    (e) => {
      assert.ok(isCuaHelperError(e), "错误类型是 CuaHelperError");
      assert.equal(e.code, "caller_timeout", "code 必须是 caller_timeout（node.ts:1211 据此判 isCallerTimeout）");
      return true;
    },
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 70 && elapsed < 500, `应在 deadline(~80ms) 附近抛，实际 ${elapsed}ms（不得等满永不 resolve）`);
});

test("waitForCuaHelperStartup：startup 在 deadline 内先失败 → 透传 startup 的错误（非 caller_timeout）", async () => {
  const boom = new Error("startup-boom");
  await assert.rejects(
    waitForCuaHelperStartup(Promise.reject(boom), 5000),
    (e) => {
      assert.equal(e, boom, "透传原始 startup 错误对象");
      assert.ok(!isCuaHelperError(e) || e.code !== "caller_timeout", "不是 caller_timeout——startup 自身失败");
      return true;
    },
  );
});

test("waitForCuaHelperStartup：超时不取消 startup——race 后 startup 仍在后台（迟到 resolve 不炸、不 unhandled）", async () => {
  let resolved = false;
  const slow = new Promise((resolve) => setTimeout(() => { resolved = true; resolve("late"); }, 120));
  await assert.rejects(waitForCuaHelperStartup(slow, 40), (e) => isCuaHelperError(e) && e.code === "caller_timeout");
  // startup 未被取消：等它自然完成，确认迟到 resolve 安全落地（race 已挂 handler，无 unhandled rejection）
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(resolved, true, "startup 应在后台继续跑完（waitForCuaHelperStartup 不取消它）");
});

test("waitForCuaHelperStartup：deadline 边界——恰好赶上不超时", async () => {
  // startup 30ms、deadline 2000ms：充裕，必须返回结果而非超时
  const result = await waitForCuaHelperStartup(
    new Promise((resolve) => setTimeout(() => resolve("in-time"), 30)),
    2000,
  );
  assert.equal(result, "in-time");
});
