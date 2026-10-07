// ultracode 关键词触发的判定、正文与生命周期档位。
// 依据：apps/acode-cli/specs/script-workflow-revival.md 批次 C2。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CORE = "../packages/core/src";

const {
  ULTRACODE_KEYWORD,
  buildUltracodeKeywordReminderBody,
  containsUltracodeKeyword,
  shouldEmitUltracodeKeywordReminder,
} = await import(`${CORE}/runtime/helpers/ultracode-keyword.ts`);
const {
  SYSTEM_REMINDER_PER_REQUEST_SOURCES,
  SYSTEM_REMINDER_PERSISTED_SOURCES,
} = await import(`${CORE}/system-reminder/source.ts`);

/** 造一条真实用户消息 entry；形状按 latestRealUserPlainTextQuery 的判据（role + metadata.source）。 */
function userEntry(text) {
  return { message: { content: text, role: "user" }, metadata: { source: "real_user" } };
}

// ---------------------------------------------------------------------------
// 关键词判定
// ---------------------------------------------------------------------------

test("整词匹配，大小写不敏感", () => {
  assert.equal(ULTRACODE_KEYWORD, "ultracode");
  for (const text of [
    "ultracode this migration",
    "please ULTRACODE the audit",
    "用 ultracode 跑一遍",
    "ultracode",
    "  ultracode  ",
    "run it, ultracode, thoroughly",
  ]) {
    assert.equal(containsUltracodeKeyword(text), true, text);
  }
});

test("不做子串匹配：误判方向是不对称的", () => {
  // 子串匹配会把一次无意的提及变成「用户要求起几十个 agent」——多起一次编排是真实的钱与时间。
  for (const text of [
    "ultracodegen",
    "ultracoder",
    "myultracode",
    "ultra-code",
    "ultra code",
    "ULTRACODEGEN pipeline",
    "",
    "no keyword here",
  ]) {
    assert.equal(containsUltracodeKeyword(text), false, text);
  }
  assert.equal(containsUltracodeKeyword(null), false);
  assert.equal(containsUltracodeKeyword(undefined), false);
});

// ---------------------------------------------------------------------------
// 与灰度门同结论
// ---------------------------------------------------------------------------

test("灰度关时不注入——否则会把模型指向一个不存在的工具", () => {
  const entries = [userEntry("ultracode the audit")];
  assert.equal(shouldEmitUltracodeKeywordReminder({ entries }), true, "缺席即开启（与工具面同极性）");
  assert.equal(
    shouldEmitUltracodeKeywordReminder({ dynamicWorkflowEnabled: true, entries }),
    true,
  );
  assert.equal(
    shouldEmitUltracodeKeywordReminder({ dynamicWorkflowEnabled: false, entries }),
    false,
    "十个 dwf 工具与 RunWorkflow 都不注册时，reminder 只会诱导调用不存在的工具",
  );
});

test("没打关键词就不注入；纯 synthetic 输入也不算用户措辞", () => {
  assert.equal(shouldEmitUltracodeKeywordReminder({ entries: [userEntry("just fix the bug")] }), false);
  assert.equal(shouldEmitUltracodeKeywordReminder({ entries: [] }), false);
  // metadata.source 不是 real_user 的消息（automation / synthetic）不代表用户做了选择。
  assert.equal(
    shouldEmitUltracodeKeywordReminder({
      entries: [{ message: { content: "ultracode", role: "user" }, metadata: { source: "todo_reminder" } }],
    }),
    false,
  );
  // 附件 entry 要被跳过，继续往前找真实用户消息。
  assert.equal(
    shouldEmitUltracodeKeywordReminder({
      entries: [userEntry("ultracode the audit"), { kind: "attachment", type: "attachment" }],
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// 正文
// ---------------------------------------------------------------------------

test("正文点名 RunWorkflow 与技能，劝退另一套，并声明只限本轮", () => {
  const body = buildUltracodeKeywordReminderBody();
  assert.match(body, /ultracode/, "要说清是用户的哪个措辞触发的");
  assert.match(body, /RunWorkflow/);
  assert.match(body, /script-workflows/, "不提醒就会白跑一次被技能门拒掉的调用");
  // 仓库里有两套工作流系统，笼统说「用工作流」等于让模型掷骰子。
  assert.match(body, /not `CreateWorkflow`/);
  assert.match(body, /current turn only/, "不说清本轮限定，模型会把一次关键词当成整个会话的授权");
});

test("正文是**许可**而不是命令：模型必须被明确告知可以不起编排", () => {
  // 实测事故：一条问「/help 目录里有没有 ultracode 这个条目」的 prompt——纯粹在谈论这个词
  // ——被旧正文的命令句（"Use the RunWorkflow tool to fulfil the request"）劫持成一次真实的
  // 多代理编排，问题没被回答，钱和时间照花。整词匹配排除不了「整词命中但语义不是请求」，
  // 而那是个语义问题，只能交给模型判断；harness 的责任是把「有权拒绝」说清楚。
  const body = buildUltracodeKeywordReminderBody();
  assert.match(body, /permission to use it, not an instruction to use it/);
  // 必须给出可操作的判据，否则「自行判断」等于没说：谈论这个词 vs 请求多代理工作。
  assert.match(body, /only talking ABOUT the word/);
  assert.match(body, /do NOT start a run/);
  // 起编排那一支必须带条件词，不能是裸命令句。
  assert.match(body, /Only when the request genuinely calls for orchestrated multi-agent work/);
  // 旧的无条件命令句一个字都不许剩：留着就等于同时给出两条互相矛盾的指令。
  assert.equal(
    body.includes("Use the `RunWorkflow` tool to fulfil the request"),
    false,
    "无条件命令句必须消失，否则模型会照着它起编排",
  );
});

// ---------------------------------------------------------------------------
// 生命周期档位
// ---------------------------------------------------------------------------

test("走 per-request 档、不落 session（持久化会把某轮措辞伪装成会话事实）", () => {
  assert.ok(SYSTEM_REMINDER_PER_REQUEST_SOURCES.includes("ultracode_keyword"));
  assert.ok(!SYSTEM_REMINDER_PERSISTED_SOURCES.includes("ultracode_keyword"));
});

test("turn-loop 的注入点与语义召回同款：只在 turn 的首个模型请求前判定一次", () => {
  // 源码级断言：turn 内后续 step 是工具循环，用户文本不变，重复判定只会重复注入同一条。
  const source = readFileSync(
    new URL(`${CORE}/runtime/methods/turn-loop.ts`, import.meta.url),
    "utf8",
  );
  const index = source.indexOf("shouldEmitUltracodeKeywordReminder({");
  assert.ok(index > 0, "turn-loop 必须真的接上关键词判定，否则整条链路是死的");
  const preceding = source.slice(Math.max(0, index - 400), index);
  assert.match(preceding, /modelStepCount === 0/, "必须只在首个模型请求前注入");
  assert.match(
    source.slice(index, index + 400),
    /systemReminderAttachmentEntry\("ultracode_keyword"/,
    "必须以 ultracode_keyword 这个 source 落 attachment",
  );
  // 灰度判定必须在调用点传入，而不是在 helper 里读全局：helper 拿不到 runtime。
  assert.match(source.slice(index, index + 300), /dynamicWorkflowEnabled: this\.config\./);
});

test("/ultracode 命令路径不会重复触发关键词 reminder", async () => {
  // 断言**行为**而不是正文措辞：把命令展开后的真实 prompt 喂进检测器，看它是否注入。
  // 展开前言里有一行 harness 自己写的 `Run custom command /ultracode.`，那不是用户措辞；
  // 若被当成关键词，就会多注入一条声称「用户打了这个词」的 reminder——既重复又说谎。
  const { expandBuiltinUltracodeCommandPrompt } = await import(
    "../packages/bootstrap/src/builtin-ultracode-command.ts"
  );
  const prompt = expandBuiltinUltracodeCommandPrompt("audit the auth layer");
  assert.match(prompt, /RunWorkflow/, "展开正文本身已经指示了工具");
  assert.match(prompt, /\/ultracode/, "前言里确实带命令名——这正是需要排除的那次出现");
  assert.equal(
    shouldEmitUltracodeKeywordReminder({ entries: [userEntry(prompt)] }),
    false,
    "命令路径已由展开正文负责，关键词 reminder 不该再叠一条",
  );

  // 斜杠形态被排除，散文形态照常命中。
  assert.equal(containsUltracodeKeyword("/ultracode"), false);
  assert.equal(containsUltracodeKeyword("Run custom command /ultracode."), false);
  assert.equal(containsUltracodeKeyword("please run /ultracode on the auth layer"), false);
  assert.equal(containsUltracodeKeyword("ultracode the auth layer"), true);
  // 用户自己在参数里打了这个词，仍然算他打了（这次不是 harness 写的）。
  assert.equal(
    shouldEmitUltracodeKeywordReminder({
      entries: [userEntry(expandBuiltinUltracodeCommandPrompt("make ultracode faster"))],
    }),
    true,
  );
});
