import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * D3 审计问题 1 的证据测试：`maxTurns` 在主/子代理 turn loop 里**没有强制点**。
 *
 * 覆盖规格 apps/acode-cli/specs/command-terminal-state-audit.md 的 R1 问题 1（重述版）
 * 与 R2 的 E1/E2/E3。审计结论：方案 D3 原问法「subagent maxTurns 到顶的终态是否误报
 * completed」的前提不成立——主/子代理循环里不存在「到顶」这件事；真缺口是这个字段
 * 是**悬空配置**（含用户可写的 agent frontmatter 面），静默无效。
 *
 * **本文件已从「断言缺口存在」翻转为「断言缺口已闭合」**，两个缺口各自被修复：
 *   A. 悬空装配链与用户可写面（修正项 #1）——整条链已删除：(3) 钉住装配面与声明面不再
 *      出现 maxTurns，(5) 钉住 frontmatter 往返 / 设置页保留逻辑 / 孤儿文案一并删除，
 *      (8) 钉住 child 边界收不到该字段。删除后残留的 `maxTurns:` frontmatter 键与其他
 *      未知键同等待遇：解析只挑已知键、不产 diagnostic，重序列化不回写。
 *   B. memory 抽取到顶不可区分（修正项 #2）——(6) 钉住 runMemoryAgentLoop 的返回值带
 *      `capped` 截断标记且能与自然收尾区分，(7) 钉住抽取按 capped 分流记 warn。
 *
 * (1)(2)(4) 钉住的审计事实**未变**，继续防回退：turn loop 仍无强制点（否则「到顶」这件事
 * 会重新存在），唯一强制点仍是 memory agent loop 且只被硬编码常量喂。
 */

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const CLI = "apps/acode-cli/packages";

const { runMemoryAgentLoop } = await import(
  "../packages/core/src/memory/memory-agent-loop.ts"
);
const { createExploreSubagentPort } = await import(
  "../packages/core/src/subagent/runner.ts"
);
const { createSessionId, createTraceId } = await import(
  "../packages/contracts/src/interfaces/shared.ts"
);

// ── A. 强制点查证（E1/E2：源码事实） ─────────────────────────────────

test("(1) 主/子代理 turn loop 与 AgentRuntime 都不读 maxTurns（零强制点）", async () => {
  // 这两处是「到顶」唯一可能落地的地方：turn loop 的迭代条件、runtime 的配置消费面。
  const turnLoop = await read(`${CLI}/core/src/runtime/methods/turn-loop.ts`);
  const agentRuntime = await read(`${CLI}/core/src/runtime/agent-runtime.ts`);
  assert.doesNotMatch(turnLoop, /maxTurns/u, "turn-loop.ts 出现 maxTurns：强制点已落地，本审计结论失效");
  assert.doesNotMatch(agentRuntime, /maxTurns/u, "agent-runtime.ts 出现 maxTurns：强制点已落地，本审计结论失效");
  // turn loop 是无条件 while(true)，只由 model step 的 "break" 收口。
  assert.match(turnLoop, /while \(true\) \{/u);
  assert.match(turnLoop, /if \(result === "break"\) \{/u);
});

test("(2) break 的三个来源都不是轮数上限", async () => {
  // turn-stop.ts：automation 创建上限命中 / 自然 text-only 收口；turn-tools.ts：工具主动请求停轮。
  const turnStop = await read(`${CLI}/core/src/runtime/methods/turn-stop.ts`);
  const turnTools = await read(`${CLI}/core/src/runtime/methods/turn-tools.ts`);
  assert.doesNotMatch(turnStop, /maxTurns/u);
  assert.doesNotMatch(turnTools, /maxTurns/u);
  assert.match(turnStop, /Promise<"continue" \| "break">/u);
  assert.match(turnTools, /Promise<"continue" \| "break">/u);
  // 自然收口：assistant completed + Stop hook 不续跑 → break（不是被切断）。
  assert.match(turnStop, /state\.turnMachine\.complete\(state\.modelResponse, "success"\)/u);
});

test("(3) 装配链已拆除：maxTurns 不再写进 child runtime config，声明面一并删除", async () => {
  // 修正项 #1：此前「默认 4」被一路装配进 child runtime config 而下游无人读。两处装配点
  // （subagent.ts 的方案 D3 引用的默认值、workflow 子 runtime 的同款装配）都已删除。
  const subagent = await read(`${CLI}/core/src/runtime/methods/subagent.ts`);
  const childRuntime = await read(`${CLI}/cli-workflow/src/script-workflow-child-runtime.ts`);
  assert.doesNotMatch(subagent, /maxTurns/u, "subagent.ts 重新装配 maxTurns：悬空字段回退");
  assert.doesNotMatch(
    childRuntime,
    /maxTurns/u,
    "workflow child runtime 重新装配 maxTurns：悬空字段回退",
  );

  // 声明面同样删除：RuntimeConfig.maxTurns 与 subagents.maxTurns 两个字段。
  const types = await read(`${CLI}/core/src/runtime/types.ts`);
  assert.doesNotMatch(types, /maxTurns/u, "runtime/types.ts 重新声明 maxTurns");

  // workflow script schema 的成员与 MAX_WORKFLOW_AGENT_TURNS 常量一并删除（全仓零命中）。
  const scriptSchema = await read(`${CLI}/contracts/src/workflow/script.ts`);
  assert.doesNotMatch(
    scriptSchema,
    /maxTurns|MAX_WORKFLOW_AGENT_TURNS/u,
    "workflow script schema 重新出现 maxTurns/MAX_WORKFLOW_AGENT_TURNS",
  );

  // child 边界的透传删除：ExploreSubagentRuntimeRequest 不再携带该字段（见 (8) 的行为核查）。
  const runner = await read(`${CLI}/core/src/subagent/runner.ts`);
  assert.doesNotMatch(runner, /maxTurns/u, "runner.ts 重新透传 maxTurns 到 child 边界");
});

test("(4) 唯一强制点是 memory agent loop，且只被硬编码常量喂（不接用户配置）", async () => {
  const loop = await read(`${CLI}/core/src/memory/memory-agent-loop.ts`);
  assert.match(loop, /for \(; turns < input\.maxTurns; turns \+= 1\) \{/u);

  const extraction = await read(`${CLI}/core/src/runtime/helpers/project-memory-extraction.ts`);
  assert.match(extraction, /^const EXTRACTION_MAX_TURNS = 5;/mu);
  assert.match(extraction, /maxTurns: EXTRACTION_MAX_TURNS,/u);
  // 唯一调用点：memory 抽取。它不来自 RuntimeConfig.maxTurns，也不来自 agent profile。
  assert.equal(extraction.match(/runMemoryAgentLoop\(/gu)?.length, 1);
});

test("(5) 用户可写面已拆除：frontmatter 往返、设置页保留逻辑与孤儿文案一并删除", async () => {
  // 修正项 #1：此前用户手写 `maxTurns: N` 进 agent markdown → services 解析 → CLI profile →
  // child config → 无人读。整条用户可写面已删；残留的 `maxTurns:` 键现在与其他未知 frontmatter
  // 键同等待遇（解析只挑已知键、不产 diagnostic；重序列化不回写）。
  const markdown = await read("packages/services/src/subagents/subagentMarkdown.ts");
  assert.doesNotMatch(markdown, /maxTurns/u, "services 的 frontmatter 往返回退了");

  const profile = await read(`${CLI}/core/src/subagent/profile.ts`);
  assert.doesNotMatch(profile, /maxTurns/u, "CLI profile 解析又开始读 maxTurns");

  // 类型成员（AgentProfile / SubAgentConfig）与设置页「保存时原样带回」的逻辑同样删除。
  const sharedTypes = await read("packages/shared/src/subagents-types.ts");
  assert.doesNotMatch(sharedTypes, /maxTurns/u, "shared 的类型成员回退了");
  const section = await read("packages/ui/src/settings/SubagentsSection.tsx");
  assert.doesNotMatch(section, /maxTurns/u, "设置页又开始保留 maxTurns");

  // 两条无消费点的孤儿 i18n 文案删除；packages/ui/src 全域不再有 maxTurns 的键或消费点。
  for (const locale of ["en-US", "zh-CN"]) {
    const messages = await read(`packages/ui/src/i18n/locales/${locale}.ts`);
    assert.doesNotMatch(
      messages,
      /settings\.subagents\.form\.maxTurns/u,
      `${locale} 仍留着 maxTurns 孤儿文案`,
    );
  }
  const uiSources = await listUiSources();
  for (const file of uiSources) {
    assert.doesNotMatch(
      await read(file),
      /maxTurns/u,
      `${file} 重新引入 maxTurns：用户可写面已拆除的结论需复核`,
    );
  }
});

async function listUiSources() {
  const { readdir } = await import("node:fs/promises");
  const out = [];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(dir, root), { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) await walk(`${rel}/`);
      else if (/\.(ts|tsx)$/u.test(entry.name)) out.push(rel);
    }
  };
  await walk("packages/ui/src/");
  return out;
}

// ── B. 行为事实（E3：可重复执行） ────────────────────────────────────

/** 只实现 runMemoryAgentLoop 真正触到的 Model 面。 */
function stubModel({ alwaysToolCall }) {
  let calls = 0;
  return {
    calls: () => calls,
    optionSpecs: {
      maxOutputTokens: { max: 1024 },
      reasoningLevel: { values: ["low"] },
    },
    properties: { inputFormat: "text" },
    async generateText() {
      calls += 1;
      if (!alwaysToolCall) return { text: "done", reasoning: [], toolCalls: [] };
      return {
        text: "",
        reasoning: [],
        toolCalls: [
          { id: `call_${calls}`, input: { pattern: "x" }, name: "Grep" },
        ],
      };
    },
  };
}

const MEMORY_LOOP_REQUEST = {
  rootDir: "/memory-root",
  workingDirectory: "/work",
  workspaceRoot: "/work",
};

/** 跑一轮 memory agent loop；alwaysToolCall=true 时模型每轮都索取工具 → 必然到顶。 */
function runLoop({ alwaysToolCall, maxTurns }) {
  const model = stubModel({ alwaysToolCall });
  return runMemoryAgentLoop({
    executeTool: async (toolCall) => ({
      content: [{ text: `ran ${toolCall.name}`, type: "text" }],
      isError: false,
    }),
    maxTurns,
    messages: [{ content: "extract memories", role: "user" }],
    model,
    tools: [{ name: "Grep", sideEffectScope: "none" }],
    ...MEMORY_LOOP_REQUEST,
  }).then((result) => ({ model, result }));
}

test("(6) 行为：memory agent loop 到顶即停，且返回值自描述「被切断」（capped）", async () => {
  const { model, result } = await runLoop({ alwaysToolCall: true, maxTurns: 2 });

  // 强制点确实生效：模型每轮都要工具，循环仍在 2 轮后停（不是自然收尾）。
  assert.equal(result.turns, 2);
  assert.equal(model.calls(), 2);
  // 修正项 #2：返回形状带 capped 截断标记。到顶 = 模型最后一轮仍在索取工具 → capped:true。
  assert.equal(result.capped, true, "到顶却报 capped:false：截断与自然收尾重新同形");
  assert.deepEqual(Object.keys(result).sort(), ["capped", "messages", "turns"]);

  // 自然收尾必须可区分：模型第一轮就不再索取工具 → turns:1、capped:false。
  const natural = await runLoop({ alwaysToolCall: false, maxTurns: 2 });
  assert.equal(natural.result.turns, 1);
  assert.equal(natural.result.capped, false);
  assert.deepEqual(Object.keys(natural.result).sort(), ["capped", "messages", "turns"]);

  // capped 是**必需**的，不是锦上添花：turns 单独区分不了两者。maxTurns=1 时
  // 「第 1 轮自然收尾」（break 前 +1）与「第 1 轮到顶」（循环头 +1）都返回 turns=1，
  // 只有 capped 能把它们分开——这正是 memory-agent-loop.ts 上 capped 注释写的理由。
  const cappedAtOne = await runLoop({ alwaysToolCall: true, maxTurns: 1 });
  const naturalAtOne = await runLoop({ alwaysToolCall: false, maxTurns: 1 });
  assert.equal(cappedAtOne.result.turns, naturalAtOne.result.turns, "前提变了：turns 已能区分两者");
  assert.equal(cappedAtOne.result.turns, 1);
  assert.equal(cappedAtOne.result.capped, true);
  assert.equal(naturalAtOne.result.capped, false);
});

test("(7) 行为：memory 抽取消费 capped —— 到顶记 warn，但仍报 success（取舍在案）", async () => {
  // 修正项 #2：project-memory-extraction 不再丢弃 runMemoryAgentLoop 的返回值，按 capped 分流。
  const extraction = await read(`${CLI}/core/src/runtime/helpers/project-memory-extraction.ts`);
  const body = extraction.slice(extraction.indexOf("await runMemoryAgentLoop({"));
  const tail = body.slice(0, body.indexOf("catch (error)"));
  assert.match(tail, /if \(loop\.capped\) \{/u, "抽取不再消费 capped：到顶可区分性回退");
  // 到顶是**可恢复异常**级别的事实（memory 文件可能只写了一半），按根 AGENTS.md 用 warn。
  assert.match(tail, /runtime\.logger\?\.warn\(/u);
  assert.match(tail, /event: "memory\.extraction\.turn_capped"/u);
  assert.match(tail, /maxTurns: EXTRACTION_MAX_TURNS,/u);

  // 到顶仍 finishCompleted + 返回 success：MemoryExtractionExecutionStatus 是闭合四值联合
  // （success/no-op/error/aborted），没有「截断」档，而 error/aborted 都不推进 cursor →
  // 同一窗口会每次触发都重抽且不保证收敛。本项只补可观测性、不改重抽策略，取舍写在源码注释里。
  assert.match(tail, /telemetry\.finishCompleted\(\);/u);
  assert.match(tail, /return "success" as const;/u);
  assert.match(tail, /不改重抽策略/u, "「到顶仍报 success」的取舍说明消失了：结论需复核");
});

test("(8) 行为：残留的 maxTurns 不再透传到 child 边界，终态仍 completed 且不带截断标记", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-d3-maxturns-"));
  try {
    const captured = [];
    // 桩件代替真实 child AgentRuntime：它模拟「跑了 10 个 model round」后自然返回。
    // 真实 child 的轮数由 turn-loop 的 while(true) 决定，而 turn-loop 不读 maxTurns（见 (1)）。
    const port = createExploreSubagentPort({
      outputRootDir: dir,
      profiles: [
        {
          description: "audit probe",
          // 模拟用户 agent markdown 里**残留**的 `maxTurns: 2`：字段已从 AgentProfile 删除，
          // 解析不会产出它，但调用方直接塞对象时它仍会挂在 profile 上——用来验证透传确实断了。
          maxTurns: 2,
          name: "general-purpose",
          source: "user",
          systemPrompt: "probe",
        },
      ],
      runExploreAgent: async (request) => {
        captured.push(request);
        await request.onSessionReady?.();
        return {
          events: [],
          response: "finished after 10 model rounds",
          traceId: request.traceContext.traceId,
        };
      },
      emitParentEvent: async () => undefined,
    });

    const output = await port.launch({
      agentType: "general-purpose",
      description: "audit probe run",
      parentToolCallId: "toolu_probe",
      prompt: "do the work",
      sessionId: createSessionId("sess_d3_probe"),
      trace: { traceId: createTraceId() },
      workingDirectory: dir,
      workspaceRoot: dir,
    });

    // 修正项 #1：透传已删——profile 上残留的 2 到不了 child 边界（此前实测收到 maxTurns: 2）。
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0].maxTurns,
      undefined,
      "maxTurns 又开始透传到 child 边界：悬空装配链回退",
    );
    // child「跑了 10 轮」自然收尾，终态是 completed，且不带任何截断/到顶标记——这与审计结论
    // 一致：completed 由自然收尾触发，不构成误报（截断可区分性只属于 memory 抽取，见 (6)(7)）。
    assert.equal(output.status, "completed");
    assert.deepEqual(
      Object.keys(output).filter((key) => /turn|truncat|capped|limit/iu.test(key)),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
