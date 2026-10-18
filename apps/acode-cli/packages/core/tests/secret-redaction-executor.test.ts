/**
 * WI-17 工具参数还原路径集成单测（specs/transcript-secret-obfuscation.md 验收场景 4）：
 * 走真实 call-runner（executeToolCall），最小 stub 依赖。断言：
 *   1. handler 收到还原后的秘密原文（Bash/Edit 拿占位符就坏的红线防线）；
 *   2. 权限判定（确认窗同源载荷）看到的是占位符——还原点在权限之后（R3/R4 顺序）；
 *   3. ToolCallStarted 事件不携带 input（UI 转录保持混淆态的事件面基础）；
 *   4. 失败 + 严格形态未解析占位符 → modelContent 追加 fail-loud 纠错提示；
 *   5. 成功 + 未知 $$…$$ 字面量 → 放行且无提示追加。
 * 全部使用合成秘密。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeToolCall } from "../src/tool/executor/call-runner.js";
import {
  getSecretRedactionService,
  resetSecretRedactionServiceForTests,
} from "../src/security/secret-redaction/service.js";

const SYNTH_ENV_SECRET = "synthetic-env-secret-Value-123";

interface CapturedCall {
  handlerInput: unknown;
  permissionInput: unknown;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

function createStubs(capture: { current: CapturedCall }) {
  const entry = {
    metadata: { name: "FakeSecretTool" },
    handler: async (input: unknown) => {
      capture.current.handlerInput = input;
      const typed = input as { command?: string; fail?: boolean };
      if (typed.fail === true) throw new Error("synthetic failure");
      return `executed:${typed.command ?? ""}`;
    },
  };
  const registry = {
    get: (name: string) => (name === "FakeSecretTool" ? entry : undefined),
    has: () => false,
    list: () => [],
    getMetadata: () => undefined,
  };
  const deps = {
    registry,
    getMode: () => "build",
    permissionService: {
      checkPermission: (context: { input: unknown }) => {
        capture.current.permissionInput = context.input;
        return { decision: "allow", allowed: true };
      },
    },
    emitEvent: async (event: { type: string; payload: Record<string, unknown> }) => {
      capture.current.events.push({ type: event.type, payload: event.payload });
    },
    getWorkingDirectory: () => tmpdir(),
    getWorkspaceRoot: () => tmpdir(),
    sessionId: "synthetic-session",
    defaultTimeoutMs: 30_000,
  };
  const backgroundTasks = { trackBackgroundTask: async () => {} };
  return { deps, backgroundTasks };
}

function withService<T>(run: () => Promise<T>): Promise<T> {
  const keyDir = mkdtempSync(join(tmpdir(), "acode-secret-executor-test-"));
  resetSecretRedactionServiceForTests();
  getSecretRedactionService({
    env: { API_KEY: SYNTH_ENV_SECRET },
    keyDir,
  });
  return run().finally(() => {
    resetSecretRedactionServiceForTests();
    rmSync(keyDir, { recursive: true, force: true });
  });
}

function extractPlaceholder(text: string): string {
  const match = /\$\$[A-Z0-9]{12}(?::[ULCM])?\$\$/.exec(text);
  assert.ok(match, `前置：应铸造出占位符，实际: ${text}`);
  return match[0];
}

test("executor 还原路径：handler 收原文，权限/事件面收占位符", async () => {
  await withService(async () => {
    const service = getSecretRedactionService();
    // 用真实投影铸造占位符（模拟模型在混淆上下文里学到的形态）。
    const obfuscated = service.projectModelMessages([
      { role: "user", content: `use ${SYNTH_ENV_SECRET} now` },
    ])[0].content as string;
    const placeholder = extractPlaceholder(obfuscated);

    const capture = {
      current: { handlerInput: undefined, permissionInput: undefined, events: [] } as CapturedCall,
    };
    const { deps, backgroundTasks } = createStubs(capture);
    const result = await executeToolCall(deps as never, backgroundTasks as never, {
      id: "call_synth_1" as never,
      name: "FakeSecretTool",
      input: { command: `curl -H "X-Key: ${placeholder}"` },
    });

    assert.equal(result.success, true, JSON.stringify(result.error));
    // 1. handler 收到还原后的原文（红线：Bash/Edit 绝不能拿占位符执行）。
    const handlerInput = capture.current.handlerInput as { command: string };
    assert.ok(handlerInput.command.includes(SYNTH_ENV_SECRET), "handler 必须收到秘密原文");
    assert.ok(!handlerInput.command.includes("$$"), "handler 不得残留占位符");
    // 2. 权限判定（确认窗同源）看到占位符——还原点在权限之后（R3 顺序断言）。
    const permissionInput = capture.current.permissionInput as { command: string };
    assert.ok(permissionInput.command.includes("$$"), "权限面保持脱敏投影");
    assert.ok(!permissionInput.command.includes(SYNTH_ENV_SECRET));
    // 3. ToolCallStarted 不携带 input（UI 事件面无原值）。
    const started = capture.current.events.find((event) => event.type === "tool_call_started");
    assert.ok(started, "应发出 tool_call_started 事件");
    assert.ok(!("input" in started.payload), "ToolCallStarted 载荷不含 input");
    // 非结果类事件不得含秘密原值（started/permission 面保持脱敏投影）。
    // ToolCallResult 例外：它承载 handler 的真实输出 = spec R4 的「本地事实面」，
    // 原样进本地事件/转录，出站时由投影统一混淆——下面单独断言该闭环。
    const nonResultEvents = capture.current.events.filter(
      (event) => event.type !== "tool_call_result",
    );
    assert.ok(!JSON.stringify(nonResultEvents).includes(SYNTH_ENV_SECRET));
    // 出站闭环：工具结果原文经投影后无秘密（provider 面零泄漏的另一半）。
    const resultEvent = capture.current.events.find((event) => event.type === "tool_call_result");
    assert.ok(resultEvent, "应发出 tool_call_result 事件");
    const resultText = JSON.stringify(resultEvent.payload);
    assert.ok(resultText.includes(SYNTH_ENV_SECRET), "本地事实面：结果原样（R4）");
    const projectedResult = service.projectModelMessages([
      { role: "tool", toolCallId: "call_synth_1", toolName: "FakeSecretTool", content: resultText },
    ]);
    assert.ok(!JSON.stringify(projectedResult).includes(SYNTH_ENV_SECRET), "出站面：结果被混淆");
  });
});

test("fail-loud：失败调用 + 严格形态未解析占位符 → modelContent 追加纠错提示", async () => {
  await withService(async () => {
    const capture = {
      current: { handlerInput: undefined, permissionInput: undefined, events: [] } as CapturedCall,
    };
    const { deps, backgroundTasks } = createStubs(capture);
    const result = await executeToolCall(deps as never, backgroundTasks as never, {
      id: "call_synth_2" as never,
      name: "FakeSecretTool",
      // 12 位大写 base36 基 = 严格铸造形态，但不在本进程还原表（模拟轮换/跨重启陈旧占位符）。
      input: { command: "deploy --token $$ZZZZZZZZZZZZ$$", fail: true },
    });
    assert.equal(result.success, false);
    const modelContent = String(result.modelContent ?? "");
    assert.ok(
      modelContent.includes("secret_placeholder_error"),
      `应追加提示，实际: ${modelContent}`,
    );
    assert.ok(modelContent.includes("could not be restored"));
    assert.ok(modelContent.includes("synthetic failure"), "原错误信息保留");
  });
});

test("放行语义：成功调用 + 未知 $$…$$ 字面量 → 原样执行且无提示噪音", async () => {
  await withService(async () => {
    const capture = {
      current: { handlerInput: undefined, permissionInput: undefined, events: [] } as CapturedCall,
    };
    const { deps, backgroundTasks } = createStubs(capture);
    const result = await executeToolCall(deps as never, backgroundTasks as never, {
      id: "call_synth_3" as never,
      name: "FakeSecretTool",
      input: { command: "echo $$ && echo $$ZZZZZZZZZZZZ$$" },
    });
    assert.equal(result.success, true);
    const handlerInput = capture.current.handlerInput as { command: string };
    assert.equal(handlerInput.command, "echo $$ && echo $$ZZZZZZZZZZZZ$$", "未知形态逐字节放行");
    assert.ok(
      !String(result.modelContent ?? "").includes("secret_placeholder_error"),
      "成功调用不追加提示",
    );
  });
});
