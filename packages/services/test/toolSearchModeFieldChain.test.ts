// toolSearchMode 物化链的 services 侧落点：折叠出口单点、会话门三态、信封条件写入、
// legacy 面零新增。依据：apps/acode-cli/specs/tool-search.md R3/R11 与
// 「设置修改不广播运行态」裁决。
//
// 断言分两类（同 scriptWorkflowModeFieldChain.test.ts 的仓库既有风格）：
//   - 纯函数部分（三值归一化/缺省档）已在 packages/shared/test 覆盖，这里不重复；
//   - 折叠出口与会话门是装配闭包里的模块私有函数，没有导出面可测——源码断言钉住
//     「分支与极性还在不在」，防止后续改动悄悄加 memoize 或翻转 fail 方向。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("折叠出口：node.ts 只有 resolveToolSearchModeFromSettings 一个 tool-search 折叠口", () => {
  const source = readSource("../src/node.ts");
  assert.match(
    source,
    /const resolveToolSearchModeFromSettings = async/,
    "折叠出口必须存在（唯一消费口纪律，spec R11）",
  );
  assert.match(
    source,
    /normalizeToolSearchAppMode\(\(await settingService\.get\(\)\)\.toolSearchMode\) \?\?\s*\n?\s*DEFAULT_TOOL_SEARCH_APP_MODE/,
    "缺省/非法值必须落 DEFAULT_TOOL_SEARCH_APP_MODE（off）",
  );
  // 读取失败 fail 到 off + warn 一次，不阻断 runtime 创建。
  assert.match(
    source,
    /catch \(error\) \{[\s\S]{0,600}?toolSearchSettingsWarned = true;[\s\S]{0,600}?return DEFAULT_TOOL_SEARCH_APP_MODE;/,
    "设置读取失败必须落 off 并 warn 一次（warn-once 闩在位）",
  );
  assert.match(
    source,
    /if \(!toolSearchSettingsWarned\) \{/,
    "warn 必须有 once 闩，防每会话刷日志",
  );
  // 会话门必须走折叠出口，不允许第二处直接读 settings。
  assert.match(
    source,
    /resolveToolSearchMode: \(\) => resolveToolSearchModeFromSettings\(\)/,
    "agent service 工厂必须接折叠出口",
  );
  const directReads = [...source.matchAll(/settingService\.get\(\)\)\.toolSearchMode/g)].length;
  assert.equal(directReads, 1, "AppSettings.toolSearchMode 只允许折叠出口一处读取");
});

test("会话门：acodeAgentService 不 memoize、resolver 缺席回 undefined、异常按 off、信封条件写", () => {
  const source = readSource("../src/acode-agent/acodeAgentService.ts");
  const gateStart = source.indexOf("async function resolveToolSearchGate");
  const gateEnd = source.indexOf("async function buildConversationCommandEnvelope");
  assert.ok(gateStart > 0 && gateEnd > gateStart, "resolveToolSearchGate 必须存在");
  const gate = source.slice(gateStart, gateEnd);
  assert.ok(
    !gate.includes("??="),
    "tool-search 会话门禁止 memoize（每次 createSession 现读，无会话中途改档通道）",
  );
  assert.match(
    gate,
    /if \(!resolve\) return undefined;/,
    "resolver 缺席（纯 CLI 装配）= undefined = 信封不写字段（缺席即 off）",
  );
  assert.match(
    gate,
    /catch \(error\) \{[\s\S]*?return "off";/,
    '读取异常 fail 到 "off"（零行为变化红线，与 script 的 fail-open 方向相反）',
  );
  const envelope = source.slice(
    gateEnd,
    source.indexOf('if (envelope.type !== "sendText") return envelope;'),
  );
  assert.match(
    envelope,
    /\.\.\.\(toolSearchMode === undefined \? \{\} : \{ toolSearchMode \}\)/,
    "v4 createSession 信封必须条件写入 toolSearchMode（undefined 不写、三档含 off 都写）",
  );
});

test("legacy 面零新增：session create/resume 参数构造不携带 toolSearchMode（legacy 只删不增）", () => {
  const source = readSource("../src/acode-agent/acodeAgentService.ts");
  // 按 legacy 参数构造函数的区域切分（同 scriptWorkflowModeFieldChain 的钉法），
  // v4 信封注入点不在这两个函数里，不参与本断言。
  const createStart = source.indexOf("function buildSessionCreateParams");
  const resumeStart = source.indexOf("function buildSessionResumeParams");
  assert.ok(createStart > 0 && resumeStart > createStart, "legacy 参数构造函数仍在");
  const legacyRegion = source.slice(createStart, resumeStart + 2500);
  assert.ok(
    !legacyRegion.includes("toolSearchMode"),
    "legacy session create/resume 参数构造不得出现 toolSearchMode（legacy 会话缺席 = off）",
  );
});
