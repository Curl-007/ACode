import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 空选择（「继承默认」）默认模型继承链（apps/acode-cli/specs/agent-teams-derived-config.md
 * R4.1，2026-11-03 修订）。真实环境回归来源：GUI 演练中 AgentTeams 成员「继承默认」+
 * 无全局默认模型 → 修订前 R4 在父会话环之前 fail-closed，首 spawn 必失败。
 * 本测试钉住修订后链序与可见性义务标记（notice 发射在调用方，见 methods/subagent.ts）。
 */
const { resolveSubagentSelection } = await import(
  "../packages/core/src/runtime/helpers/subagent-selection.ts"
);

const parent = { providerId: "cap-prov", modelId: "cap-model" };
const appDefault = { providerId: "app-prov", modelId: "app-model" };
const profileSel = { providerId: "prof-prov", modelId: "prof-model" };
const ok = (selection) => ({ effectiveSelection: selection });

test("链环 1：profile 显式选择优先，无继承标记", () => {
  const result = resolveSubagentSelection({
    profileSelection: profileSel,
    parentSelection: parent,
    appDefaultSelection: appDefault,
    resolveSelection: ok,
  });
  assert.deepEqual(result.selection, profileSel);
  assert.equal(result.hasConcreteModel, true);
  assert.equal(result.inheritance, undefined);
});

test("override 优先于一切链环", () => {
  const override = { providerId: "ov-prov", modelId: "ov-model" };
  const result = resolveSubagentSelection({
    profileSelection: profileSel,
    parentSelection: parent,
    appDefaultSelection: appDefault,
    overrideSelection: override,
    resolveSelection: ok,
  });
  assert.deepEqual(result.selection, override);
  assert.equal(result.inheritance, undefined);
});

test("链环 2：空选择 + 应用配置默认模型 → app-default 环", () => {
  const result = resolveSubagentSelection({
    parentSelection: parent,
    appDefaultSelection: appDefault,
    resolveSelection: ok,
  });
  assert.deepEqual(result.selection, appDefault);
  assert.equal(result.hasConcreteModel, false);
  assert.deepEqual(result.inheritance, { source: "app-default" });
});

test("链环 2 解析失败落链环 3：app-default 带 issue → 父会话环", () => {
  const result = resolveSubagentSelection({
    parentSelection: parent,
    appDefaultSelection: appDefault,
    resolveSelection: (selection) =>
      selection.providerId === "app-prov"
        ? { effectiveSelection: null, selectionIssue: "model-not-found" }
        : ok(selection),
  });
  assert.deepEqual(result.selection, parent);
  assert.deepEqual(result.inheritance, { source: "parent-session" });
});

test("链环 3：空选择 + 仅父会话模型 → parent-session 环（非成员静默语义不变）", () => {
  const result = resolveSubagentSelection({ parentSelection: parent });
  assert.deepEqual(result.selection, parent);
  assert.deepEqual(result.inheritance, { source: "parent-session" });
});

test("R4.1：requireExplicit 成员空选择 + 父会话模型 → 不再立即 fail-closed，落 parent-session 环", () => {
  const result = resolveSubagentSelection({
    parentSelection: parent,
    requireExplicitModelSelection: true,
  });
  assert.deepEqual(result.selection, parent);
  assert.deepEqual(result.inheritance, { source: "parent-session" });
});

test("R4.1：requireExplicit 成员空选择 + 应用默认模型 → app-default 环（无需 notice 的显式配置）", () => {
  const result = resolveSubagentSelection({
    parentSelection: parent,
    appDefaultSelection: appDefault,
    requireExplicitModelSelection: true,
    resolveSelection: ok,
  });
  assert.deepEqual(result.selection, appDefault);
  assert.deepEqual(result.inheritance, { source: "app-default" });
});

test("R4.1：requireExplicit 成员全链皆空 → fail-closed 且消息列举全部配置途径", () => {
  assert.throws(
    () => resolveSubagentSelection({ requireExplicitModelSelection: true }),
    (error) => {
      assert.equal(error.type, "configuration_error");
      assert.match(error.message, /app default model/);
      assert.match(error.message, /inheritCaptainModel/);
      assert.match(error.message, /general-purpose/);
      return true;
    },
  );
});

test("非成员全链皆空 → 既有 selection-missing 消息口径不变", () => {
  assert.throws(
    () => resolveSubagentSelection({}),
    (error) => {
      assert.equal(error.type, "configuration_error");
      assert.match(error.message, /reason=selection-missing/);
      assert.match(error.message, /未选择模型/);
      return true;
    },
  );
});

test("显式选择解析失败 → 既有 reason/身份消息口径不变", () => {
  assert.throws(
    () =>
      resolveSubagentSelection({
        profileSelection: { providerId: "p", modelId: "m" },
        resolveSelection: () => ({ effectiveSelection: null, selectionIssue: "speed-missing" }),
      }),
    (error) => {
      assert.match(error.message, /reason=speed-missing/);
      assert.match(error.message, /selection=p\/m/);
      return true;
    },
  );
});
