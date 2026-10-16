// spare prewarm 的闭集词表与 env 配置解析(spec: packages/services/specs/agent-process-prewarm.md R3/R6)。
// 纯函数测试:无进程、无 IO。词表纪律对齐波次 1 error-taxonomy-injection-defense 的双收窄。
import assert from "node:assert/strict";
import test from "node:test";
import {
  ACODE_AGENT_SPARE_POOL_SIZE_ENV_KEY,
  ACODE_AGENT_SPARE_PREWARM_ENV_KEY,
  AGENT_SPARE_POOL_SIZE_DEFAULT,
  AGENT_SPARE_POOL_SIZE_MAX,
  AGENT_SPARE_START_OUTCOMES,
  narrowAgentSpareErrorName,
  narrowAgentSpareStartOutcome,
  resolveAgentSparePrewarmConfig,
} from "../src/acode-agent/acodeAgentSparePrewarm.js";

test("outcome 词表是封闭的 6 值集,与 spec R3 表一致", () => {
  assert.deepEqual(
    [...AGENT_SPARE_START_OUTCOMES],
    [
      "spare_hit",
      "spare_miss_not_warmed",
      "spare_miss_consumed_race",
      "spare_miss_spawn_failed",
      "spare_miss_disabled",
      "spare_miss_ineligible",
    ],
  );
});

test("narrowAgentSpareStartOutcome 只认闭集字面量(验收场景 4)", () => {
  for (const outcome of AGENT_SPARE_START_OUTCOMES) {
    assert.equal(narrowAgentSpareStartOutcome(outcome), outcome);
  }
  // 注入样本:拼接、大小写、非字符串一律 null,调用方省略字段而不是透传。
  assert.equal(narrowAgentSpareStartOutcome("spare_hit; DROP TABLE sessions"), null);
  assert.equal(narrowAgentSpareStartOutcome("SPARE_HIT"), null);
  assert.equal(narrowAgentSpareStartOutcome("spare_hit "), null);
  assert.equal(narrowAgentSpareStartOutcome(""), null);
  assert.equal(narrowAgentSpareStartOutcome(42), null);
  assert.equal(narrowAgentSpareStartOutcome(undefined), null);
  assert.equal(narrowAgentSpareStartOutcome({ outcome: "spare_hit" }), null);
});

test("narrowAgentSpareErrorName 白名单收窄自由文本(验收场景 4)", () => {
  assert.equal(narrowAgentSpareErrorName("ENOENT"), "ENOENT");
  assert.equal(narrowAgentSpareErrorName("Error"), "Error");
  assert.equal(narrowAgentSpareErrorName("E2E_AGAIN"), "E2E_AGAIN");
  // 多行/带消息/带空格的 error name 不得进日志字段。
  assert.equal(narrowAgentSpareErrorName("Error: boom\ninjected"), "unknown_error");
  assert.equal(narrowAgentSpareErrorName("spawn ENOENT"), "unknown_error");
  assert.equal(narrowAgentSpareErrorName(""), "unknown_error");
  assert.equal(narrowAgentSpareErrorName("1NVALID"), "unknown_error");
  assert.equal(narrowAgentSpareErrorName("x".repeat(65)), "unknown_error");
  assert.equal(narrowAgentSpareErrorName(undefined), "unknown_error");
  assert.equal(narrowAgentSpareErrorName(null), "unknown_error");
  // 3 字符是白名单下限(^[A-Za-z][A-Za-z0-9_]{2,63}$)。
  assert.equal(narrowAgentSpareErrorName("Eio"), "Eio");
  assert.equal(narrowAgentSpareErrorName("ab"), "unknown_error");
});

test("缺省策略:仅 desktop-local 启用,池大小 1(spec R6)", () => {
  assert.deepEqual(resolveAgentSparePrewarmConfig({}, { isDesktopLocalAuthority: true }), {
    enabled: true,
    poolSize: AGENT_SPARE_POOL_SIZE_DEFAULT,
  });
  assert.deepEqual(resolveAgentSparePrewarmConfig({}, {}), {
    enabled: false,
    poolSize: AGENT_SPARE_POOL_SIZE_DEFAULT,
    disabledReason: "policy_default_off",
  });
  assert.deepEqual(resolveAgentSparePrewarmConfig({}, { isDesktopLocalAuthority: false }), {
    enabled: false,
    poolSize: AGENT_SPARE_POOL_SIZE_DEFAULT,
    disabledReason: "policy_default_off",
  });
});

test("kill switch:显式 0 关闭(含 desktop-local),显式 1 强制开启(含远程)", () => {
  assert.deepEqual(
    resolveAgentSparePrewarmConfig(
      { [ACODE_AGENT_SPARE_PREWARM_ENV_KEY]: "0" },
      { isDesktopLocalAuthority: true },
    ),
    { enabled: false, poolSize: AGENT_SPARE_POOL_SIZE_DEFAULT, disabledReason: "kill_switch" },
  );
  assert.deepEqual(
    resolveAgentSparePrewarmConfig(
      { [ACODE_AGENT_SPARE_PREWARM_ENV_KEY]: " 0 " },
      { isDesktopLocalAuthority: true },
    ),
    { enabled: false, poolSize: AGENT_SPARE_POOL_SIZE_DEFAULT, disabledReason: "kill_switch" },
  );
  assert.deepEqual(
    resolveAgentSparePrewarmConfig({ [ACODE_AGENT_SPARE_PREWARM_ENV_KEY]: "1" }, {}),
    { enabled: true, poolSize: AGENT_SPARE_POOL_SIZE_DEFAULT },
  );
  // 非法开关值视同未设置,回落 authority 缺省策略。
  assert.deepEqual(
    resolveAgentSparePrewarmConfig({ [ACODE_AGENT_SPARE_PREWARM_ENV_KEY]: "yes" }, {}),
    {
      enabled: false,
      poolSize: AGENT_SPARE_POOL_SIZE_DEFAULT,
      disabledReason: "policy_default_off",
    },
  );
});

test("池大小:十进制整数,clamp [0,4],0=关闭,非法值 fail-safe 关闭(spec R6)", () => {
  assert.deepEqual(
    resolveAgentSparePrewarmConfig(
      { [ACODE_AGENT_SPARE_POOL_SIZE_ENV_KEY]: "3" },
      { isDesktopLocalAuthority: true },
    ),
    { enabled: true, poolSize: 3 },
  );
  assert.deepEqual(
    resolveAgentSparePrewarmConfig(
      { [ACODE_AGENT_SPARE_POOL_SIZE_ENV_KEY]: "99" },
      { isDesktopLocalAuthority: true },
    ),
    { enabled: true, poolSize: AGENT_SPARE_POOL_SIZE_MAX },
  );
  assert.deepEqual(
    resolveAgentSparePrewarmConfig(
      { [ACODE_AGENT_SPARE_POOL_SIZE_ENV_KEY]: "0" },
      { isDesktopLocalAuthority: true },
    ),
    { enabled: false, poolSize: 0, disabledReason: "size_zero" },
  );
  // 与 resolveACodeAgentIdleExitConfig 同纪律:科学计数法/负数/垃圾一律 fail-safe 关闭。
  for (const invalid of ["1e3", "-2", "abc", "1.5"]) {
    assert.deepEqual(
      resolveAgentSparePrewarmConfig(
        { [ACODE_AGENT_SPARE_POOL_SIZE_ENV_KEY]: invalid },
        { isDesktopLocalAuthority: true },
      ),
      { enabled: false, poolSize: 0, disabledReason: "invalid_size" },
      `size=${invalid} 应 fail-safe 关闭`,
    );
  }
  // kill switch 优先于强制开启的 size。
  assert.deepEqual(
    resolveAgentSparePrewarmConfig(
      {
        [ACODE_AGENT_SPARE_PREWARM_ENV_KEY]: "0",
        [ACODE_AGENT_SPARE_POOL_SIZE_ENV_KEY]: "2",
      },
      { isDesktopLocalAuthority: true },
    ),
    { enabled: false, poolSize: 2, disabledReason: "kill_switch" },
  );
});
