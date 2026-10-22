import assert from "node:assert/strict";
import test from "node:test";

/**
 * speed 两档错误消息与协议映射守护测试（review 测试专项 P2 / 提交 8122e200 的配套测试）。
 *
 * 根因：8122e200 给 `createRegistrySelectionProtocolError` 的 switch 补了
 * `speed-missing` / `speed-not-supported` 两条（此前穷举不全导致 TS2366「函数缺 ending return」），
 * 但该提交 `git show --stat` 无任何 `.test.*`，违反 AGENTS.md「有行为改动先补对应测试」。
 * 本测试钉住这条映射的错误码闭集与消息形状：
 * - 两档 speed 各自映射到 `ModelErrorCode.InvalidModelRequest`（与 reasoning-level 两条对称）；
 * - 消息含 providerId/modelId 与被拒的 speed 值，便于前端定位；
 * - 顺带钉住其余分支的错误码映射（provider-not-found / model-not-found / reasoning-level-*），
 *   防止「删一个分支又加一个」式的静默漂移。
 *
 * 被测源码在 bootstrap 包（另一代理所有权范围），本测试只读导入、不改源码。
 */
const { createRegistrySelectionProtocolError } = await import(
  "../packages/bootstrap/src/app/provider-registry-selection.ts"
);
// ModelErrorCode 从 contracts src 取（枚举值是稳定字符串）；不对 ModelProtocolError 用
// instanceof：被测源码经 `@acode/contracts`（dist barrel）导入类，本测试从 src 导入是另一个
// 类实例，跨模块 instanceof 恒 false。改断言 `name === "ModelProtocolError"` + `instanceof Error`。
const { ModelErrorCode } = await import("../packages/contracts/src/index.ts");

// 8122e200 的第二处改动：core 的 SUBAGENT_SELECTION_MESSAGES 用 `satisfies Record` 约束，
// 缺 speed 两 key 会 TS1360。运行时经 resolveSubagentSelection 把 selectionIssue 映射为
// 面向用户的错误消息；这里钉住两档 speed 的消息与 reason 投影（术语「模型速度」）。
const { resolveSubagentSelection } = await import(
  "../packages/core/src/runtime/helpers/subagent-selection.ts"
);

/** 全部合法 validation 分支到期望错误码/消息片段的闭集登记。 */
const EXPECTED_MAPPING = [
  {
    validation: { ok: false, code: "provider-not-found", providerId: "prov" },
    code: ModelErrorCode.ProviderNotFound,
    messageIncludes: ["prov"],
  },
  {
    validation: { ok: false, code: "model-not-found", providerId: "prov", modelId: "mdl" },
    code: ModelErrorCode.ModelNotFound,
    messageIncludes: ["prov", "mdl"],
  },
  {
    validation: {
      ok: false,
      code: "reasoning-level-missing",
      providerId: "prov",
      modelId: "mdl",
    },
    code: ModelErrorCode.InvalidModelRequest,
    messageIncludes: ["Reasoning level is required", "prov", "mdl"],
  },
  {
    validation: {
      ok: false,
      code: "reasoning-level-not-supported",
      providerId: "prov",
      modelId: "mdl",
      reasoningLevel: "extreme",
      supportedLevels: ["low", "high"],
    },
    code: ModelErrorCode.InvalidModelRequest,
    messageIncludes: ['Reasoning effort "extreme" is not supported', "prov", "mdl"],
  },
  // —— 8122e200 新增的两档 speed ——
  {
    validation: { ok: false, code: "speed-missing", providerId: "prov", modelId: "mdl" },
    code: ModelErrorCode.InvalidModelRequest,
    messageIncludes: ["Model speed is required", "prov", "mdl"],
  },
  {
    validation: {
      ok: false,
      code: "speed-not-supported",
      providerId: "prov",
      modelId: "mdl",
      speed: "turbo",
      supportedSpeeds: ["normal", "fast"],
    },
    code: ModelErrorCode.InvalidModelRequest,
    messageIncludes: ['Model speed "turbo" is not supported', "prov", "mdl"],
  },
];

test("createRegistrySelectionProtocolError 全分支映射到稳定错误码闭集", () => {
  const seenCodes = new Set();
  for (const { validation, code, messageIncludes } of EXPECTED_MAPPING) {
    const error = createRegistrySelectionProtocolError(validation);
    assert.ok(error instanceof Error, `${validation.code} 必须返回 Error 实例`);
    assert.equal(error.name, "ModelProtocolError", `${validation.code} 必须是 ModelProtocolError`);
    assert.equal(error.code, code, `${validation.code} 错误码映射不符`);
    for (const fragment of messageIncludes) {
      assert.ok(
        error.message.includes(fragment),
        `${validation.code} 消息应包含 "${fragment}"，实际 "${error.message}"`,
      );
    }
    seenCodes.add(error.code);
  }
  // 闭集钉桩：这 6 条分支只允许映射到 3 个错误码；出现第 4 个说明新增了未评审的映射。
  assert.deepEqual(
    [...seenCodes].sort(),
    [
      ModelErrorCode.InvalidModelRequest,
      ModelErrorCode.ModelNotFound,
      ModelErrorCode.ProviderNotFound,
    ].sort(),
    "映射错误码闭集漂移",
  );
});

test("speed 两档消息与 reasoning-level 两条对称（术语取「模型速度」）", () => {
  const speedMissing = createRegistrySelectionProtocolError({
    ok: false,
    code: "speed-missing",
    providerId: "p",
    modelId: "m",
  });
  const speedUnsupported = createRegistrySelectionProtocolError({
    ok: false,
    code: "speed-not-supported",
    providerId: "p",
    modelId: "m",
    speed: "ludicrous",
    supportedSpeeds: ["normal"],
  });
  // missing 与 not-supported 是两条不同消息（不是同一条兜底），且都带 providerId/modelId。
  assert.notEqual(speedMissing.message, speedUnsupported.message);
  assert.match(speedMissing.message, /Model speed is required for p\/m/);
  assert.match(speedUnsupported.message, /Model speed "ludicrous" is not supported by p\/m/);
  assert.equal(speedMissing.code, speedUnsupported.code, "两档 speed 共用 InvalidModelRequest");
});

test("SUBAGENT_SELECTION_MESSAGES 覆盖 speed 两档（resolveSubagentSelection 用户消息投影）", () => {
  const run = (selectionIssue) =>
    assert.throws(
      () =>
        resolveSubagentSelection({
          profileSelection: { providerId: "p", modelId: "m" },
          // resolveSelection 返回带 issue 的结果 → 走消息映射分支并抛 ConfigurationError。
          resolveSelection: () => ({ effectiveSelection: null, selectionIssue }),
        }),
      (error) => {
        assert.equal(error.type, "configuration_error");
        // 消息必须同时带 reason 与 selection 身份，公共投影与后台日志两条路径都能定位。
        assert.match(error.message, new RegExp(`reason=${selectionIssue}`));
        assert.match(error.message, /selection=p\/m/);
        return true;
      },
      `${selectionIssue} 应抛 ConfigurationError`,
    );

  run("speed-missing");
  run("speed-not-supported");

  // 两档消息文本对称（术语「模型速度」），且与 reasoning-level 两条区分开。
  const captureMessage = (selectionIssue) => {
    try {
      resolveSubagentSelection({
        profileSelection: { providerId: "p", modelId: "m" },
        resolveSelection: () => ({ effectiveSelection: null, selectionIssue }),
      });
      return "";
    } catch (error) {
      return error.message;
    }
  };
  assert.match(captureMessage("speed-missing"), /未选择模型速度/);
  assert.match(captureMessage("speed-not-supported"), /不支持所选模型速度/);
});
