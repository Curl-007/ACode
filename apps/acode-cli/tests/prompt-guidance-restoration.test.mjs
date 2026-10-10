import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * P1 验收测试：恢复停用的 Agent / AskUserQuestion 指导段（承载层去重后）
 * + workflow-actor 契约的 escalate 通道说明段。
 *
 * 覆盖：
 * - 方案 docs/cli-dispatch-and-system-prompt-upgrade-plan.md §4 P1 的验收
 *   （「AskUserQuestion/Agent 在工具面时对应指导段出现、不在时消失」的条件组装测试）；
 * - specs/dispatch-discipline-prompt.md R1 分层判据在恢复段上的落地
 *   （去重的机器化断言在 dispatch-discipline-prompt.test.mjs 场景 6）；
 * - workflow-driver 四时序（accept/reject/nudge/escalate，
 *   cli-workflow/src/workflow-driver.ts 头注释）在 actor 契约里的对应说明。
 *
 * 快照式断言 = 测试内冻结的 golden 全文（人工审读后冻结，改文本必须同步改 golden）。
 */

const { buildSessionGuidanceSection } = await import(
  "../packages/core/src/context/dynamic-sections.ts"
);
const { buildWorkflowActorIdentitySection } = await import(
  "../packages/core/src/context/sections/workflow-actor.ts"
);
const { createContextBuilder } = await import("../packages/core/src/context/builder.ts");

const ENV_INFO = {
  cwd: "C:/tmp/acode-p1-test",
  platform: "win32",
  shell: "bash",
  osVersion: "10.0",
  nodeVersion: "v22.0.0",
};

const EXPLORE_BULLET_PREFIX = "- For broad codebase exploration or research";
const ASK_BULLET_PREFIX = "- AskUserQuestion is the channel for a bounded clarification";

test("Agent 在工具面时 Explore 指导 bullet 出现，不在时消失", () => {
  const withAgent = buildSessionGuidanceSection(["Agent", "Grep", "Glob", "Read"], false);
  assert.ok(withAgent.content.includes(EXPLORE_BULLET_PREFIX));
  assert.ok(withAgent.content.includes("spawn Agent with subagent_type=Explore"));

  const withTaskAlias = buildSessionGuidanceSection(["Task", "Grep", "Read"], false);
  assert.ok(withTaskAlias.content.includes(EXPLORE_BULLET_PREFIX));

  const withoutAgent = buildSessionGuidanceSection(["Grep", "Glob", "Read", "Bash"], false);
  assert.equal(withoutAgent, null); // 无任何指导内容 → 整段不出现（既有行为保持）
});

test("Explore bullet 的直搜 fallback 随工具面收敛，不指向不存在的工具", () => {
  const direct = buildSessionGuidanceSection(["Agent", "Grep", "Glob"], false);
  assert.ok(direct.content.includes("Otherwise use Grep and Glob directly."));

  const grepOnly = buildSessionGuidanceSection(["Agent", "Grep"], false);
  assert.ok(grepOnly.content.includes("Otherwise use Grep directly."));

  // embedded search 分支：Glob/Grep 被注册面隐藏，搜索由 Bash find/grep 接管。
  const embedded = buildSessionGuidanceSection(["Agent", "Read", "Bash"], false);
  assert.ok(embedded.content.includes("Otherwise use Bash (find/grep) directly."));

  // 没有任何直搜工具 → 省略 fallback 半句（判据句仍以句号收尾）。
  const bare = buildSessionGuidanceSection(["Agent"], false);
  assert.ok(bare.content.includes("spawn Agent with subagent_type=Explore."));
  assert.ok(!bare.content.includes("Otherwise use"));
});

test("AskUserQuestion 在工具面时指导 bullet 出现，不在时消失", () => {
  const withAsk = buildSessionGuidanceSection(["AskUserQuestion", "Read"], false);
  assert.ok(withAsk.content.includes(ASK_BULLET_PREFIX));
  assert.ok(withAsk.content.includes("structured question with selectable options"));

  const withoutAsk = buildSessionGuidanceSection(["Read", "Bash"], false);
  assert.equal(withoutAsk, null);

  // 与 Skill 共存时各归各的 bullet，互不吞并。
  const both = buildSessionGuidanceSection(["AskUserQuestion", "Skill"], true);
  assert.ok(both.content.includes(ASK_BULLET_PREFIX));
  assert.ok(both.content.includes("invoke it via Skill"));
});

test("Skill bullet 行为与恢复前一致（既有行为不回归）", () => {
  const skillOnly = buildSessionGuidanceSection(["Skill"], true);
  assert.equal(
    skillOnly.content,
    [
      "# Session-specific guidance",
      "- When the user types `/<skill-name>`, invoke it via Skill. Only use skills listed in the user-invocable skills section — don't guess.",
    ].join("\n"),
  );
  // hasSkills=false → 无内容 → null（避免空标题注入 simple branch）。
  assert.equal(buildSessionGuidanceSection(["Skill"], false), null);
});

test("经 ContextBuilder 的条件组装：指导 bullet 随工具面出现/消失", () => {
  const build = (guidanceToolNames) =>
    createContextBuilder({
      workingDirectory: ENV_INFO.cwd,
      envInfo: ENV_INFO,
      guidanceToolNames,
    }).build();

  const full = build(["Agent", "AskUserQuestion", "Grep", "Glob", "Read"]);
  const fullGuidance = full.sections.find((s) => s.source === "session_guidance");
  assert.ok(fullGuidance.content.includes(EXPLORE_BULLET_PREFIX));
  assert.ok(fullGuidance.content.includes(ASK_BULLET_PREFIX));

  const noAgentNoAsk = build(["Grep", "Glob", "Read", "Bash"]);
  assert.equal(
    noAgentNoAsk.sections.some((s) => s.source === "session_guidance"),
    false,
  );

  const askOnly = build(["AskUserQuestion", "Read"]);
  const askGuidance = askOnly.sections.find((s) => s.source === "session_guidance");
  assert.ok(askGuidance.content.includes(ASK_BULLET_PREFIX));
  assert.ok(!askGuidance.content.includes(EXPLORE_BULLET_PREFIX));
});

/** golden：workflow-actor 契约段全文（自 "# Working inside a workflow" 起，人工审读后冻结）。 */
const WORKFLOW_CONTRACT_GOLDEN = [
  "# Working inside a workflow",
  "- You have the regular working tools — reading, searching, editing, running commands — plus `submit_result` and `escalate`. There is no tool that asks a person anything.",
  "- Each ask states what to do. When the ask carries a result schema, finish by calling `submit_result` with a conforming value; otherwise your final message is the result.",
  "- On a schema-carrying ask, `submit_result` comes back accepted — the ask is done and your turn ends — or rejected: the tool result lists the schema violations, the same turn continues, and you fix them and submit again. A rejection is a repair channel, not a dead end. If your turn ever ends with nothing accepted, the script may open another turn with a nudge; the nudge is engine text, not a user message — pick up where you left off and submit.",
  "- Ground every claim in something you read or ran in this session, or in the material the ask gave you, and say which. Cite code as `path:line`. A check counts as passed only if you executed it here; if you could not run it, report it as not run. Run the check an ask names rather than a faster substitute, and say exactly which command you ran.",
  "- Report outcomes faithfully. If part of the task is impossible, out of scope, or contradicted by what you found, say so in the result instead of filling a field with a plausible guess. Never fake a passing result to satisfy an instruction.",
  "- When you are blocked by something outside your reach — a gate that cannot pass, instructions that contradict each other, a fact only the run's owner knows — call `escalate`. Questions written in prose reach nobody. An answered escalation lands as the tool result and your turn continues in place: the ask stays open, and you still close it the normal way — `submit_result` if the ask carries a schema, your final message if it doesn't.",
  "- Do not write report or summary files on your own initiative; findings go in the result. When the ask names an output path, write exactly there and return that path in the result — the script publishes it to the user.",
].join("\n");

test("workflow-actor 契约：escalate 通道说明段对应 driver 四时序（快照式断言）", () => {
  const section = buildWorkflowActorIdentitySection({
    name: "reviewer",
    persona: "You are a strict reviewer.",
  });
  assert.equal(section.source, "workflow_actor_identity");
  assert.equal(section.cacheHint, "stable");

  const contract = section.content.slice(section.content.indexOf("# Working inside a workflow"));
  assert.equal(contract, WORKFLOW_CONTRACT_GOLDEN);

  // 四时序（workflow-driver.ts 头注释）逐条可在契约里定位：
  assert.match(contract, /comes back accepted — the ask is done and your turn ends/); // accept
  assert.match(contract, /or rejected: the tool result lists the schema violations/); // reject
  assert.match(contract, /the script may open another turn with a nudge/); // nudge
  assert.match(contract, /An answered escalation lands as the tool result and your turn continues in place/); // escalate
  // nudge 的信任姿态：引擎文本不是用户消息。
  assert.match(contract, /the nudge is engine text, not a user message/);
  // 既有的 escalate 触发判据行保持在场（不因扩写而丢失）：
  assert.match(contract, /Questions written in prose reach nobody/);
  // persona 仍叠加在契约之前（既有身份结构不回归）：
  assert.ok(section.content.indexOf("You are a strict reviewer.") < section.content.indexOf(contract));
});
