import assert from "node:assert/strict";
import test from "node:test";
import {
  ACODE_AGENT_IDLE_EXIT_CODE,
  ACODE_AGENT_IDLE_EXIT_DEFAULT_MS,
  ACODE_AGENT_IDLE_EXIT_ENV_KEY,
  createACodeAgentIdleExitEvaluator,
  resolveACodeAgentIdleExitConfig,
  type ACodeAgentQuiescenceFacts,
} from "../src/acode-agent-idle-exit.js";

const QUIET: ACodeAgentQuiescenceFacts = { quiescent: true, reasons: [] };
const BUSY: ACodeAgentQuiescenceFacts = { quiescent: false, reasons: ["subscribers"] };

test("resolveACodeAgentIdleExitConfig: 缺省启用并使用默认阈值", () => {
  assert.deepEqual(resolveACodeAgentIdleExitConfig({}), {
    enabled: true,
    idleExitMs: ACODE_AGENT_IDLE_EXIT_DEFAULT_MS,
  });
});

test("resolveACodeAgentIdleExitConfig: 0 显式禁用(plugin/mcp-status lane 注入值)", () => {
  assert.deepEqual(resolveACodeAgentIdleExitConfig({ [ACODE_AGENT_IDLE_EXIT_ENV_KEY]: "0" }), {
    enabled: false,
    idleExitMs: 0,
  });
});

test("resolveACodeAgentIdleExitConfig: 正整数自定义阈值,容忍空白", () => {
  assert.deepEqual(
    resolveACodeAgentIdleExitConfig({ [ACODE_AGENT_IDLE_EXIT_ENV_KEY]: " 60000 " }),
    {
      enabled: true,
      idleExitMs: 60000,
    },
  );
});

test("resolveACodeAgentIdleExitConfig: 非法值 fail-safe 禁用并携带原值", () => {
  for (const raw of ["abc", "-5", "1.5", "", "1e3"]) {
    const config = resolveACodeAgentIdleExitConfig({ [ACODE_AGENT_IDLE_EXIT_ENV_KEY]: raw });
    assert.equal(config.enabled, false, `raw=${raw}`);
    assert.equal(config.parseError, raw, `raw=${raw}`);
  }
});

interface HarnessOptions {
  idleExitMs: number;
  facts?: ACodeAgentQuiescenceFacts[];
}

function createHarness(options: HarnessOptions) {
  let clock = 0;
  const tickMs = 60_000;
  const factsQueue = [...(options.facts ?? [])];
  const announced: Array<{ quiescentMs: number }> = [];
  const shutdowns: number[] = [];
  const events: Array<{ kind: string; reasons?: readonly string[] }> = [];
  const evaluator = createACodeAgentIdleExitEvaluator({
    idleExitMs: options.idleExitMs,
    collectFacts: () => factsQueue.shift() ?? QUIET,
    announce: (params) => announced.push(params),
    requestShutdown: (code) => shutdowns.push(code),
    now: () => clock,
    onEvent: (event) => events.push(event),
  });
  return {
    evaluator,
    announced,
    shutdowns,
    events,
    tick(times = 1) {
      for (let i = 0; i < times; i += 1) {
        clock += tickMs;
        evaluator.onTick();
      }
    },
  };
}

test("evaluator: 连续静默满阈值才宣告,携带 quiescentMs,退出码为保留值", () => {
  const h = createHarness({ idleExitMs: 3 * 60_000 });
  h.tick(3); // t=60s 首次观察到静默(起点),t=120s、180s 累计
  assert.deepEqual(h.announced, []);
  assert.deepEqual(h.shutdowns, []);
  h.tick(1); // t=240s: 240-60=180s? 不——起点是 t=60s,elapsed=180s ≥ 3min → 触发
  assert.equal(h.announced.length, 1);
  assert.equal(h.announced[0].quiescentMs, 180_000);
  assert.deepEqual(h.shutdowns, [ACODE_AGENT_IDLE_EXIT_CODE]);
  assert.deepEqual(h.events[h.events.length - 1], {
    kind: "announced",
    quiescentMs: 180_000,
  });
});

test("evaluator: 任一非静默 tick 清零重计", () => {
  const h = createHarness({ idleExitMs: 3 * 60_000, facts: [QUIET, QUIET, BUSY, QUIET, QUIET] });
  h.tick(5);
  assert.deepEqual(h.announced, []);
  assert.deepEqual(h.shutdowns, []);
  assert.ok(h.events.some((event) => event.kind === "quiescence-broken"));
  // 重计后:t=300s 清零,t=360s 新起点,再满 3 分钟 → t=540s 触发
  h.tick(3);
  assert.equal(h.announced.length, 1);
  assert.equal(h.announced[0].quiescentMs, 180_000);
});

test("evaluator: 只宣告一次,终态后 tick 无副作用", () => {
  const h = createHarness({ idleExitMs: 60_000 });
  h.tick(2); // t=60s 起点,t=120s elapsed=60s ≥ 1min → 触发
  assert.equal(h.shutdowns.length, 1);
  h.tick(5);
  assert.equal(h.announced.length, 1);
  assert.equal(h.shutdowns.length, 1);
});

test("evaluator: 计数器反映静默时长与终态", () => {
  const h = createHarness({ idleExitMs: 2 * 60_000 });
  assert.deepEqual(h.evaluator.collectCounters(), {
    "idleExit.quiescentMs": 0,
    "idleExit.announced": 0,
  });
  h.tick(2);
  assert.deepEqual(h.evaluator.collectCounters(), {
    "idleExit.quiescentMs": 60_000,
    "idleExit.announced": 0,
  });
  h.tick(1);
  assert.equal(h.evaluator.collectCounters()["idleExit.announced"], 1);
});

test("evaluator: 非正阈值直接拒绝(0 语义只存在于 config 层)", () => {
  assert.throws(
    () =>
      createACodeAgentIdleExitEvaluator({
        idleExitMs: 0,
        collectFacts: () => QUIET,
        announce: () => {},
        requestShutdown: () => {},
      }),
    RangeError,
  );
});
