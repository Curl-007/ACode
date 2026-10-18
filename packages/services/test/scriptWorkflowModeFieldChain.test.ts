// scriptWorkflowMode 字段链的 services 侧落点：折叠出口单点、会话门极性、信封注入、
// legacy 面零新增。依据：apps/acode-cli/specs/script-workflow-management-surface.md
// §4.3/§4.4/§5 行 7-8 与 §8.1 时序不变式。
//
// 断言分两类（仓库既有风格，见 apps/acode-cli/tests/run-workflow-tool.test.mjs 头注）：
//   - 纯函数部分（归一化/布尔折叠）已在 packages/shared/test 覆盖，这里不重复；
//   - 折叠出口与会话门是装配闭包里的模块私有函数，没有导出面可测——源码断言钉住
//     「分支与极性还在不在」，防止后续改动悄悄把 memoize 加回来或把异常方向翻转。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("折叠出口：node.ts 只有 resolveScriptWorkflowModeWithLocalOverride 一个 script 折叠口", () => {
  const source = readSource("../src/node.ts");
  assert.match(
    source,
    /const resolveScriptWorkflowModeWithLocalOverride = async/,
    "折叠出口必须存在（唯一消费口纪律，spec §5 行 7）",
  );
  assert.match(
    source,
    /normalizeScriptWorkflowMode\(\(await settingService\.get\(\)\)\.scriptWorkflowMode\) \?\?\s*\n?\s*DEFAULT_SCRIPT_WORKFLOW_MODE/,
    "缺省/非法值必须落 DEFAULT_SCRIPT_WORKFLOW_MODE",
  );
  // 读取失败 fail 到缺省档（开），不阻断装配。
  assert.match(
    source,
    /catch \{\s*\n\s*\/\/ 设置读取失败不阻断：fail 到缺省档（开），与 dwf 折叠出口的容错方向同理。\s*\n\s*return DEFAULT_SCRIPT_WORKFLOW_MODE;/,
  );
  // 会话门必须走折叠出口，不允许第二处直接读 settings。
  const gatePasses = /resolveScriptWorkflowMode: \(\) => resolveScriptWorkflowModeWithLocalOverride\(\)/.test(
    source,
  );
  assert.ok(gatePasses, "agent service 工厂必须接折叠出口");
  const directReads = [
    ...source.matchAll(/settingService\.get\(\)\)\.scriptWorkflowMode/g),
  ].length;
  assert.equal(directReads, 1, "AppSettings.scriptWorkflowMode 只允许折叠出口一处读取");
});

test("会话门：acodeAgentService 不 memoize、异常按 enabled=true、信封 true/false 都写", () => {
  const source = readSource("../src/acode-agent/acodeAgentService.ts");
  const gate = source.slice(
    source.indexOf("async function resolveScriptWorkflowGate"),
    source.indexOf("async function buildConversationCommandEnvelope"),
  );
  assert.ok(gate.length > 0, "resolveScriptWorkflowGate 必须存在");
  assert.ok(
    !gate.includes("??="),
    "script 会话门禁止 memoize（§8.1：每次判定现读，无缓存；dwf 的 ??= 模式不可照抄）",
  );
  assert.match(gate, /if \(!resolve\) return true;/, "resolver 缺席 = 按缺省档（开）");
  assert.match(
    gate,
    /catch \(error\) \{[\s\S]*?return true;/,
    "读取异常 fail 到缺省档（开）——与 dwf 的「异常按 false」方向相反（§4.4）",
  );
  const envelope = source.slice(
    source.indexOf("async function buildConversationCommandEnvelope"),
    source.indexOf('if (envelope.type !== "sendText") return envelope;'),
  );
  assert.match(
    envelope,
    /scriptWorkflowEnabled,/,
    "v4 createSession 信封必须显式写 scriptWorkflowEnabled（true/false 都写，缺席=开启的 CLI 极性）",
  );
  assert.ok(
    !/scriptWorkflowEnabled === false[\s\S]{0,80}return envelope/.test(envelope),
    "门禁 false 不得走「不写字段」的 early return（那是 dwf 的极性）",
  );
});

test("legacy 面零新增：session create/resume 参数构造不携带 scriptWorkflowEnabled（spec §4.3）", () => {
  const source = readSource("../src/acode-agent/acodeAgentService.ts");
  // 按 legacy 参数构造函数的区域切分（buildSessionCreateParams → buildSessionResumeParams →
  // 其后第一个函数边界），v4 信封注入点不在这两个函数里，不参与本断言。
  const createStart = source.indexOf("function buildSessionCreateParams");
  const resumeStart = source.indexOf("function buildSessionResumeParams");
  assert.ok(createStart > 0 && resumeStart > createStart, "legacy 参数构造函数仍在");
  const legacyRegion = source.slice(createStart, resumeStart + 2500);
  assert.match(
    legacyRegion,
    /dynamicWorkflowEnabled: true/,
    "legacy 的 dwf 注入点仍在（现状保持）",
  );
  assert.ok(
    !legacyRegion.includes("scriptWorkflowEnabled"),
    "legacy session create/resume 参数构造不得出现 scriptWorkflowEnabled（legacy 只删不增；legacy 会话缺席=按本机缺省档 onDemand）",
  );
});
