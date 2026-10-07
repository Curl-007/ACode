import assert from "node:assert/strict";
import test from "node:test";
import {
  ACODE_DYNAMIC_WORKFLOW_MODE_ENV,
  DEFAULT_DYNAMIC_WORKFLOW_MODE,
  DYNAMIC_WORKFLOW_MODES,
  createDynamicWorkflowClientConfig,
  isDynamicWorkflowModeEnabled,
  normalizeDynamicWorkflowMode,
  resolveDynamicWorkflowClientConfig,
} from "../src/dynamic-workflow-feature.js";

// 行为规格见 specs/dynamic-workflow-availability.md；下面的用例编号对应「验收场景」小节。

/** 环境覆盖的键名在测试里只出现一次，避免各处手抄字符串。 */
function envWith(mode: string): Record<string, string | undefined> {
  return { [ACODE_DYNAMIC_WORKFLOW_MODE_ENV]: mode };
}

test("R1 取值域是闭集，非法与形状错误的输入都归一化为 undefined", () => {
  assert.deepEqual([...DYNAMIC_WORKFLOW_MODES], ["disabled", "onDemand", "alwaysOn"]);
  for (const mode of DYNAMIC_WORKFLOW_MODES) {
    assert.equal(normalizeDynamicWorkflowMode(mode), mode);
  }
  assert.equal(normalizeDynamicWorkflowMode("nonsense"), undefined);
  assert.equal(normalizeDynamicWorkflowMode(42), undefined);
  assert.equal(normalizeDynamicWorkflowMode(undefined), undefined);
  assert.equal(normalizeDynamicWorkflowMode(null), undefined);
  assert.equal(normalizeDynamicWorkflowMode({ mode: "alwaysOn" }), undefined);
});

test("R1 归一化容忍两端空白，但不容忍大小写差异", () => {
  assert.equal(normalizeDynamicWorkflowMode("  alwaysOn  "), "alwaysOn");
  assert.equal(normalizeDynamicWorkflowMode("alwayson"), undefined);
});

test("场景 1（R2）远端什么都没说 → 落缺省档位并可用", () => {
  assert.equal(DEFAULT_DYNAMIC_WORKFLOW_MODE, "alwaysOn");
  assert.deepEqual(resolveDynamicWorkflowClientConfig({ remote: undefined, env: {} }), {
    enabled: true,
    mode: "alwaysOn",
    source: "default",
  });
});

test("场景 2（R2）远端下发非法值或形状不对 → 落缺省，不当成远端裁决", () => {
  for (const remote of [{ mode: "nonsense" }, { mode: 42 }, { mode: {} }, "alwaysOn", null, 7]) {
    const resolved = resolveDynamicWorkflowClientConfig({ remote: remote as unknown, env: {} });
    assert.deepEqual(resolved, { enabled: true, mode: "alwaysOn", source: "default" }, `${remote}`);
  }
});

test("场景 3（R4）远端显式 disabled → 不可用，缺省反转不削弱远端否决权", () => {
  assert.deepEqual(resolveDynamicWorkflowClientConfig({ remote: { mode: "disabled" }, env: {} }), {
    enabled: false,
    mode: "disabled",
    source: "remote",
  });
});

test("场景 4（R3）环境覆盖压过远端，两个方向都成立", () => {
  // 环境关、远端开 → 关
  assert.deepEqual(
    resolveDynamicWorkflowClientConfig({
      env: envWith("disabled"),
      remote: { mode: "alwaysOn" },
    }),
    { enabled: false, mode: "disabled", source: "override" },
  );
  // 环境开、远端关 → 开。这一条正是「production 档不能写入 alwaysOn」的原因：
  // override 压过 remote，写进去就等于剥夺服务端的否决权。
  assert.deepEqual(
    resolveDynamicWorkflowClientConfig({
      env: envWith("alwaysOn"),
      remote: { mode: "disabled" },
    }),
    { enabled: true, mode: "alwaysOn", source: "override" },
  );
});

test("场景 5（R3）非法环境覆盖不参与裁决，source 必须是 default 而不是 override", () => {
  for (const value of ["", "   ", "nope", "AlwaysOn"]) {
    const resolved = resolveDynamicWorkflowClientConfig({ env: envWith(value), remote: undefined });
    assert.deepEqual(resolved, { enabled: true, mode: "alwaysOn", source: "default" }, value);
  }
});

test("场景 6（R5）onDemand 折叠为可用，但 mode 原样保留三态信息", () => {
  const resolved = resolveDynamicWorkflowClientConfig({
    env: {},
    remote: { mode: "onDemand" },
  });
  assert.deepEqual(resolved, { enabled: true, mode: "onDemand", source: "remote" });
  assert.equal(isDynamicWorkflowModeEnabled("onDemand"), true);
  assert.equal(isDynamicWorkflowModeEnabled("alwaysOn"), true);
  assert.equal(isDynamicWorkflowModeEnabled("disabled"), false);
});

test("R5 布尔折叠只有一份实现：enabled 恒等于 isDynamicWorkflowModeEnabled(mode)", () => {
  for (const mode of DYNAMIC_WORKFLOW_MODES) {
    for (const source of ["remote", "override", "default"] as const) {
      const snapshot = createDynamicWorkflowClientConfig(mode, source);
      assert.equal(snapshot.enabled, isDynamicWorkflowModeEnabled(mode));
      assert.equal(snapshot.mode, mode);
      assert.equal(snapshot.source, source);
    }
  }
});

test("场景 9（R8）远端缺席但环境合法 → override，不发网络请求也能裁决", () => {
  // provider 的短路路径就是拿 remote: undefined + 合法 env 调这个纯函数。
  assert.deepEqual(
    resolveDynamicWorkflowClientConfig({ env: envWith("onDemand"), remote: undefined }),
    { enabled: true, mode: "onDemand", source: "override" },
  );
});

test("纯函数契约：不读 process.env，只认注入的 env", () => {
  const previous = process.env[ACODE_DYNAMIC_WORKFLOW_MODE_ENV];
  process.env[ACODE_DYNAMIC_WORKFLOW_MODE_ENV] = "disabled";
  try {
    // 注入空 env 时必须无视进程环境——否则三端各自的 owner 就没法独立裁决。
    assert.deepEqual(resolveDynamicWorkflowClientConfig({ env: {}, remote: undefined }), {
      enabled: true,
      mode: "alwaysOn",
      source: "default",
    });
    assert.equal(resolveDynamicWorkflowClientConfig({ remote: undefined }).source, "default");
  } finally {
    if (previous === undefined) delete process.env[ACODE_DYNAMIC_WORKFLOW_MODE_ENV];
    else process.env[ACODE_DYNAMIC_WORKFLOW_MODE_ENV] = previous;
  }
});
