/**
 * WI-14 懒加载 OTel 遥测单测（specs/otel-telemetry.md「验证场景」）：
 * 1. env 门禁矩阵逐行断言（开关矩阵 7 行）；
 * 2. no-op 装载探针：门禁未过时 init 不加载 impl 模块（默认启动路径零开销）；
 * 3. grpc/http-json 显式拒绝：禁用 + warn 文案含 unsupported；
 * 4. span 属性白名单：全链路构造（turn/step/tool/command/model/compaction/detached），
 *    断言导出属性键 ⊆ 白名单，且错误 message 中的「内容样本」绝不出现在任何属性值；
 * 5. flush 时序：turn 终态触发去抖 flush，无需手动 flush 批内 span 即达 exporter。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  describeOtelGateRejection,
  resolveOtelTraceGate,
} from "../src/telemetry/otel/env-gate.js";
import {
  initOtelTelemetry,
  isOtelImplLoaded,
} from "../src/telemetry/otel/init.js";
import { SPAN_ATTRIBUTE_WHITELIST } from "../src/telemetry/otel/attributes.js";
import { createOtelTraceRuntime } from "../src/telemetry/otel/impl.js";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import type { AgentTurnTraceStart } from "@acode/contracts";

// ---------------------------------------------------------------------------
// 1. 门禁矩阵（spec 开关矩阵 7 行逐行断言）
// ---------------------------------------------------------------------------

const ENDPOINT_ENV = {
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces",
};

test("gate row 1: ACODE_TELEMETRY opt-out 强制 no-op（即使端点存在）", () => {
  for (const value of ["0", "false", "off", " FALSE "]) {
    const decision = resolveOtelTraceGate({ ...ENDPOINT_ENV, ACODE_TELEMETRY: value });
    assert.equal(decision.enabled, false, `ACODE_TELEMETRY=${value} 应关闭`);
    assert.equal(decision.enabled || decision.reason, "opt_out");
  }
});

test("gate row 1b: ACODE_TELEMETRY=1 不强制启用——无端点仍是 no_endpoint", () => {
  const decision = resolveOtelTraceGate({ ACODE_TELEMETRY: "1" });
  assert.equal(decision.enabled, false);
  assert.equal(decision.enabled || decision.reason, "no_endpoint");
});

test("gate row 2: OTEL_SDK_DISABLED kill-switch", () => {
  const decision = resolveOtelTraceGate({ ...ENDPOINT_ENV, OTEL_SDK_DISABLED: "TRUE" });
  assert.equal(decision.enabled, false);
  assert.equal(decision.enabled || decision.reason, "sdk_disabled");
});

test("gate row 3/4: OTEL_TRACES_EXPORTER 选择列表", () => {
  const none = resolveOtelTraceGate({ ...ENDPOINT_ENV, OTEL_TRACES_EXPORTER: "none" });
  assert.equal(none.enabled, false);
  assert.equal(none.enabled || none.reason, "exporter_none");

  const other = resolveOtelTraceGate({ ...ENDPOINT_ENV, OTEL_TRACES_EXPORTER: "console" });
  assert.equal(other.enabled, false);
  assert.equal(other.enabled || other.reason, "exporter_not_otlp");

  const withOtlp = resolveOtelTraceGate({ ...ENDPOINT_ENV, OTEL_TRACES_EXPORTER: "console,otlp" });
  assert.equal(withOtlp.enabled, true);
});

test("gate row 5: 无端点 = 默认完全 no-op（含只有公共端点空串）", () => {
  assert.equal(resolveOtelTraceGate({}).enabled, false);
  const empty = resolveOtelTraceGate({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " });
  assert.equal(empty.enabled, false);
  assert.equal(empty.enabled || empty.reason, "no_endpoint");
});

test("gate row 6: grpc / http-json 显式拒绝", () => {
  for (const protocol of ["grpc", "http/json", " GRPC "]) {
    const decision = resolveOtelTraceGate({
      ...ENDPOINT_ENV,
      OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
    });
    assert.equal(decision.enabled, false, `protocol=${protocol} 应拒绝`);
    assert.equal(decision.enabled || decision.reason, "unsupported_protocol");
    const rejection = describeOtelGateRejection(decision);
    assert.ok(rejection?.includes("unsupported"), "拒绝文案必须点名 unsupported");
    assert.ok(rejection?.includes("http/protobuf"), "拒绝文案必须给出受支持协议");
  }
});

test("gate row 7: 端点存在（公共端点回退 / per-signal 优先）= 启用", () => {
  assert.equal(resolveOtelTraceGate(ENDPOINT_ENV).enabled, true);
  assert.equal(
    resolveOtelTraceGate({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" }).enabled,
    true,
  );
  // per-signal 协议显式 http/protobuf 同样启用。
  assert.equal(
    resolveOtelTraceGate({
      ...ENDPOINT_ENV,
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
    }).enabled,
    true,
  );
});

// ---------------------------------------------------------------------------
// 2. no-op 装载探针：门禁未过 → handle undefined 且 impl 模块未加载
// ---------------------------------------------------------------------------

function createWarnSink(): { messages: string[]; sink: { warn: (m: string) => void } } {
  const messages: string[] = [];
  return { messages, sink: { warn: (message: string) => messages.push(message) } };
}

test("init: 无端点 env → undefined 且 impl 模块未加载（import 探针）", async () => {
  assert.equal(isOtelImplLoaded(), false, "前置：impl 尚未被 init 加载");
  const handle = await initOtelTelemetry({ env: {} });
  assert.equal(handle, undefined);
  assert.equal(isOtelImplLoaded(), false, "no-op 路径不得动态 import impl");
});

test("init: ACODE_TELEMETRY=0 + 端点 → undefined 且 impl 未加载", async () => {
  const handle = await initOtelTelemetry({
    env: { ...ENDPOINT_ENV, ACODE_TELEMETRY: "0" },
  });
  assert.equal(handle, undefined);
  assert.equal(isOtelImplLoaded(), false);
});

// ---------------------------------------------------------------------------
// 3. grpc 拒绝：init 层禁用 + warn 明确错误
// ---------------------------------------------------------------------------

test("init: grpc 协议 → undefined + warn 点名 unsupported（防误路由）", async () => {
  const { messages, sink } = createWarnSink();
  const handle = await initOtelTelemetry({
    env: { ...ENDPOINT_ENV, OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "grpc" },
    logger: { debug: () => {}, info: () => {}, warn: sink.warn },
  });
  assert.equal(handle, undefined);
  assert.equal(isOtelImplLoaded(), false, "拒绝路径不得加载 SDK 模块图");
  assert.equal(messages.length, 1);
  assert.ok(messages[0].includes("grpc"), "warn 应回显被拒协议值");
  assert.ok(messages[0].includes("unsupported"));
});

// ---------------------------------------------------------------------------
// 4/5. impl 层：属性白名单 + 嵌套 + flush 时序（InMemorySpanExporter 测试缝）
// ---------------------------------------------------------------------------

/** 内容样本：模拟提示词正文/工具参数/凭据，绝不允许出现在任何 span 属性值中。 */
const CONTENT_SAMPLE = "SECRET_PROMPT_CONTENT 提示词正文 file:///etc/passwd BearerToken123";

function turnStart(overrides?: Partial<AgentTurnTraceStart>): AgentTurnTraceStart {
  return {
    context: {
      actorKind: "main",
      launchSurface: "standalone_cli",
      queryId: "query-1",
      sessionId: "session-1",
      turnId: "turn-1",
    },
    inputSource: "user",
    turnNumber: 3,
    ...overrides,
  };
}

function createTestRuntime() {
  const exporter = new InMemorySpanExporter();
  const warnings: string[] = [];
  const runtime = createOtelTraceRuntime({
    serviceName: "acode-cli-test",
    serviceVersion: "0.0.0-test",
    serviceInstanceId: "session-test",
    platform: "test",
    exporter,
    turnFlushDebounceMs: 10,
    periodicFlushIntervalMs: 3_600_000,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => warnings.push(message),
    },
  });
  return { exporter, runtime, warnings };
}

test("白名单：全链路 span 属性键 ⊆ 白名单，且无内容样本泄漏", async () => {
  const { exporter, runtime } = createTestRuntime();
  const contentError = new Error(CONTENT_SAMPLE);

  const turn = runtime.port.startTurn(turnStart());
  await turn.run(async () => {
    const step = runtime.port.startStep({ stepId: "step-1", stepIndex: 0 });
    await step.run(async () => {
      // 模型请求事实：字段全部是元数据；构造上不存在内容字段。
      const now = Date.now();
      runtime.port.recordModelRequest({
        querySource: "main_turn",
        providerId: "provider-x",
        modelId: "model-y",
        status: "error",
        startedAt: now - 120,
        completedAt: now,
        firstTokenAt: now - 80,
        durationMs: 120,
        finishReason: "stop",
        inputTokens: 1200,
        outputTokens: 340,
        reasoningTokens: 60,
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
        totalTokens: 1540,
        retryCount: 1,
        contextExceeded: false,
        toolCallCount: 2,
        // errorMessage 不在事实类型里；errorType/errorCode 是分类代码级。
        errorType: "rate_limit",
        errorCode: "429",
      });
      const tool = runtime.port.startTool({
        registeredToolName: "Bash",
        toolCallId: "call-1",
      });
      await tool.run(async () => {
        tool.markPermissionRequested();
        tool.setPermissionDecision("granted");
        const command = tool.startCommand({
          category: "shell",
          commandCount: 1,
          safeName: "git",
          sandboxed: false,
          shellKind: "bash",
        });
        command.setExitCode(1);
        command.setOutputBytes(42);
        // 命令以「携带内容样本的错误」失败：只允许 error.type 级元数据进 span。
        command.finishFailed("execute", "provider", contentError);
      });
      tool.setOutputBytes(42);
      tool.setOutputTruncated(false);
      tool.finishFailed("handler", "provider", contentError);
    });
    step.finishFailed("model", "rate_limit", contentError);
  });

  const compaction = runtime.port.startCompaction({
    modelMode: "streaming",
    phase: "pre_request",
    trigger: "auto",
    thresholdTokens: 100,
  });
  compaction.setInputTokens(10);
  compaction.setOutputTokens(5);
  compaction.finishCompleted();

  const detached = runtime.port.startDetachedOperation({
    context: {
      actorKind: "main",
      launchSurface: "standalone_cli",
      sessionId: "session-1",
    },
    executionKind: "background",
    operation: "session_title_generation",
    trigger: "turn",
  });
  detached.setResultType("text");
  detached.finishCompleted();

  turn.finishCompleted("assistant_message");
  await runtime.flush();

  const spans = exporter.getFinishedSpans();
  const names = spans.map((span) => span.name).sort();
  assert.deepEqual(names, [
    "agent_step",
    "chat model-y",
    "command git",
    "context_compaction",
    "execute_tool Bash",
    "invoke_agent",
    "session_title_generation",
  ]);

  const whitelist = new Set<string>(SPAN_ATTRIBUTE_WHITELIST);
  const serializedValues: string[] = [];
  for (const span of spans) {
    for (const [key, value] of Object.entries(span.attributes)) {
      assert.ok(whitelist.has(key), `属性键 ${key} 必须在白名单内（span=${span.name}）`);
      serializedValues.push(String(value));
    }
    // 事件（first_output 等）也不得携带内容样本。
    for (const event of span.events) {
      serializedValues.push(JSON.stringify(event.attributes ?? {}));
    }
  }
  for (const value of serializedValues) {
    assert.ok(
      !value.includes("SECRET_PROMPT_CONTENT") && !value.includes("提示词正文"),
      `span 属性值泄漏内容样本: ${value}`,
    );
  }

  // 错误只保留 type 级元数据：Error.name 进 error.type，message 被丢弃。
  const failedTool = spans.find((span) => span.name === "execute_tool Bash");
  assert.equal(failedTool?.attributes["error.type"], "Error");
  assert.equal(failedTool?.attributes["acode.error.category"], "provider");

  // GenAI 语义约定抽查：chat span 的 token usage 与 provider/model。
  const chat = spans.find((span) => span.name === "chat model-y");
  assert.equal(chat?.attributes["gen_ai.operation.name"], "chat");
  assert.equal(chat?.attributes["gen_ai.provider.name"], "provider-x");
  assert.equal(chat?.attributes["gen_ai.request.model"], "model-y");
  assert.equal(chat?.attributes["gen_ai.usage.input_tokens"], 1200);
  assert.equal(chat?.attributes["gen_ai.usage.output_tokens"], 340);
  assert.deepEqual(chat?.attributes["gen_ai.response.finish_reasons"], ["stop"]);
  assert.equal(chat?.attributes["acode.request.ttft_ms"], 40);

  // 嵌套父子：step ⊂ turn；chat/tool ⊂ step；command ⊂ tool。
  //（OTel JS 2.x ReadableSpan 用 parentSpanContext，不再有 parentSpanId。）
  const byName = new Map(spans.map((span) => [span.name, span]));
  const turnSpan = byName.get("invoke_agent")!;
  assert.equal(
    byName.get("agent_step")?.parentSpanContext?.spanId,
    turnSpan.spanContext().spanId,
  );
  assert.equal(
    byName.get("chat model-y")?.parentSpanContext?.spanId,
    byName.get("agent_step")?.spanContext().spanId,
  );
  assert.equal(
    byName.get("execute_tool Bash")?.parentSpanContext?.spanId,
    byName.get("agent_step")?.spanContext().spanId,
  );
  assert.equal(
    byName.get("command git")?.parentSpanContext?.spanId,
    byName.get("execute_tool Bash")?.spanContext().spanId,
  );

  await runtime.shutdown();
});

test("flush 时序：turn 终态触发去抖 flush，无需手动 flush", async () => {
  const { exporter, runtime } = createTestRuntime();
  const turn = runtime.port.startTurn(turnStart());
  turn.finishCompleted("assistant_message");
  // 去抖窗口 10ms + BatchSpanProcessor 导出：等待后 span 必须已到达 exporter。
  await new Promise((resolve) => setTimeout(resolve, 300));
  const flushed = exporter.getFinishedSpans();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].name, "invoke_agent");
  await runtime.shutdown();
});

test("abandonSession：悬挂 turn 以 missing_terminal 收口", async () => {
  const { exporter, runtime } = createTestRuntime();
  runtime.port.startTurn(turnStart());
  runtime.port.abandonSession("session-1");
  await runtime.flush();
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].attributes["acode.abandon.reason"], "missing_terminal");
  await runtime.shutdown();
});

test("causation：非法 trace/span id 被忽略（宁可不挂父，不造坏 trace）", async () => {
  const { exporter, runtime } = createTestRuntime();
  const turn = runtime.port.startTurn(
    turnStart({
      causation: { isRemote: true, spanId: "bogus", traceFlags: 1, traceId: "bogus" },
    }),
  );
  turn.finishCompleted("assistant_message");
  await runtime.flush();
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].parentSpanContext, undefined);
  await runtime.shutdown();
});
