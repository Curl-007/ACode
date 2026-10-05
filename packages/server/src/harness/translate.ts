/* eslint-disable max-lines -- 方法面 v1 全集的逐方法翻译集中维护（映射表与 spec 附录一一对应），拆散会让「方法→services 入口」的审计面失去单一出处。 */
// Harness API 翻译桥——逐方法把 R2 方法面翻译到既有 ServiceCollection 入口。
// 参照 jcode (MIT)「翻译桥不依赖重型内部协议」的设计：本文件**绝不 import
// acode-protocol（v4）**，只经 services 层 API 形状调用（类型来自 @acode/services /
// @acode/shared 根入口），这是「内部演进打不坏公开面」的结构保证。
// services 层缺的能力如实降级为 not_supported 错误（映射表见 spec 附录），不发明不存在的调用。

import { randomUUID } from "node:crypto";
import type { ServiceCollection } from "@acode/services";
import {
  IACodeAgentService,
  IACodeTaskService,
  IFileService,
  IModelSelectionService,
  type ACodeAgentServiceEvent,
} from "@acode/services";
import type {
  ACodePermissionResponse,
  ACodeSessionEvent,
  ACodeSessionInfo,
  ACodeSessionMode,
  ACodeSessionStateSnapshot,
} from "@acode/shared";
import type { z } from "zod";
import type { HarnessEvent } from "@acode/shared/harness-api";
import { harnessMethodParamsSchemas, isHarnessMethodName } from "@acode/shared/harness-api";

/** 方法级错误：server.ts 捕获后落 response.error 帧。 */
export class HarnessMethodError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function notSupported(
  method: string,
  reason: string,
  alternative?: string,
): HarnessMethodError {
  return new HarnessMethodError(
    "not_supported",
    `harness method '${method}' is not supported: ${reason}`,
    {
      method,
      reason,
      ...(alternative ? { alternative } : {}),
    },
  );
}

export interface HarnessTranslateContext {
  /** 取 ServiceCollection；懒构造让握手/降级路径不必初始化完整服务面。 */
  getServices(): Promise<ServiceCollection>;
  /** run 轮询等待 turn 终态的预算；缺省 10 分钟。 */
  runTimeoutMs?: number;
}

const RUN_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_POLL_INTERVAL_MS = 200;
const SESSION_MODES: readonly string[] = ["plan", "build", "edit", "yolo", "auto"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireAgent(services: ServiceCollection): IACodeAgentService {
  const agent = services.getOptional(IACodeAgentService);
  if (!agent) throw new HarnessMethodError("unavailable", "IACodeAgentService is not registered");
  return agent;
}

function requireTask(services: ServiceCollection): IACodeTaskService {
  const task = services.getOptional(IACodeTaskService);
  if (!task) throw new HarnessMethodError("unavailable", "IACodeTaskService is not registered");
  return task;
}

function sessionSummary(info: ACodeSessionInfo) {
  return {
    sessionId: info.sessionId,
    ...(info.parentSessionId ? { parentSessionId: info.parentSessionId } : {}),
    ...(info.title !== undefined ? { title: info.title } : {}),
    ...(info.mode !== undefined ? { mode: info.mode } : {}),
    ...(info.status !== undefined ? { status: info.status } : {}),
    ...(info.model ? { model: info.model } : {}),
    ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
    ...(info.updatedAt !== undefined ? { updatedAt: info.updatedAt } : {}),
  };
}

function createSessionResultOf(snapshot: ACodeSessionStateSnapshot) {
  return {
    sessionId: snapshot.session.sessionId,
    ...(snapshot.session.status !== undefined ? { status: snapshot.session.status } : {}),
  };
}

function asSessionMode(value: string | undefined): ACodeSessionMode | undefined {
  if (value === undefined) return undefined;
  if (!SESSION_MODES.includes(value)) {
    throw new HarnessMethodError(
      "invalid_params",
      `unknown session mode '${value}' (expected one of ${SESSION_MODES.join("/")})`,
    );
  }
  return value as ACodeSessionMode;
}

function workspaceOf(params: { workspacePath: string; workspaceIdentity?: string }): {
  workspacePath: string;
  workspaceIdentity?: string;
} {
  const target: { workspacePath: string; workspaceIdentity?: string } = {
    workspacePath: params.workspacePath,
  };
  if (params.workspaceIdentity) target.workspaceIdentity = params.workspaceIdentity;
  return target;
}

function sessionTargetOf(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}): { workspacePath: string; workspaceIdentity?: string; sessionId: string } {
  return { ...workspaceOf(params), sessionId: params.sessionId };
}

/** IACodeTaskService 面以 taskId 指代会话（taskId ≡ sessionId，见 adapter resolveInteraction envelope）。 */
function taskTargetOf(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}): { taskId: string; workspacePath?: string; workspaceIdentity?: string } {
  const target: { taskId: string; workspacePath?: string; workspaceIdentity?: string } = {
    taskId: params.sessionId,
  };
  if (params.workspacePath) target.workspacePath = params.workspacePath;
  if (params.workspaceIdentity) target.workspaceIdentity = params.workspaceIdentity;
  return target;
}

/** turn.completed usage 字段是 unknown（内部协议自由演进），防御式读取投影。 */
function readUsage(
  usage: unknown,
): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  if (!isRecord(usage)) return undefined;
  const pick = (key: string): number | undefined =>
    typeof usage[key] === "number" && Number.isFinite(usage[key])
      ? (usage[key] as number)
      : undefined;
  const inputTokens = pick("inputTokens");
  const outputTokens = pick("outputTokens");
  const totalTokens = pick("totalTokens");
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined)
    return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

/**
 * 内部 session 事件 → harness 公开事件（0..n 条）。
 * 不在 v1 公开面的内部事件（message.upserted / session.* / model.streaming 等）静默丢弃：
 * 公开面刻意小于内部协议（jcode 同款裁剪），additive 才补充。
 */
export function translateSessionEvent(event: ACodeSessionEvent): HarnessEvent[] {
  const envelope = event as unknown as {
    type: string;
    eventId?: string;
    turnId?: string;
    timestamp?: number;
    payload?: unknown;
  };
  const base = {
    ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
    ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
    ...(typeof envelope.timestamp === "number" ? { timestamp: envelope.timestamp } : {}),
  };
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  switch (envelope.type) {
    case "turn.started":
      return [
        {
          kind: "turn_started",
          ...base,
          ...(typeof payload.turnNumber === "number" ? { turnNumber: payload.turnNumber } : {}),
          ...(typeof payload.inputId === "string" ? { inputId: payload.inputId } : {}),
          ...(typeof payload.input === "string"
            ? { inputPreview: payload.input.slice(0, 120) }
            : {}),
        },
      ];
    case "turn.completed": {
      // 内部 resultType 里除 success/cancelled 外都是错误变体（error_max_turns 等），统一投影 error。
      const rawResultType = typeof payload.resultType === "string" ? payload.resultType : "success";
      const resultType =
        rawResultType === "success" || rawResultType === "cancelled" ? rawResultType : "error";
      const tokenCount = typeof payload.tokenCount === "number" ? payload.tokenCount : undefined;
      const usage = readUsage(payload.usage);
      const done: HarnessEvent = {
        kind: "turn_done",
        ...base,
        ...(typeof payload.inputId === "string" ? { inputId: payload.inputId } : {}),
        resultType,
        ...(typeof payload.response === "string" ? { response: payload.response } : {}),
        ...((usage ?? (tokenCount !== undefined ? { usage: { totalTokens: tokenCount } } : {}))
          ? { usage: usage ?? { totalTokens: tokenCount as number } }
          : {}),
        ...(typeof payload.duration === "number" ? { durationMs: payload.duration } : {}),
      };
      const events: HarnessEvent[] = [done];
      if (usage || tokenCount !== undefined) {
        events.push({
          kind: "token_usage",
          ...base,
          ...(usage ?? { totalTokens: tokenCount as number }),
        });
      }
      return events;
    }
    case "turn.failed":
      return [
        {
          kind: "turn_done",
          ...base,
          ...(typeof payload.inputId === "string" ? { inputId: payload.inputId } : {}),
          resultType: "error",
          ...(isRecord(payload.error) && typeof payload.error.message === "string"
            ? {
                error: {
                  message: payload.error.message,
                  ...(typeof payload.error.code === "string" ? { code: payload.error.code } : {}),
                },
              }
            : { error: { message: "turn failed" } }),
        },
      ];
    case "part.delta":
      if (payload.field !== undefined && payload.field !== "text") return [];
      if (typeof payload.delta !== "string") return [];
      return [
        {
          kind: "text_delta",
          ...base,
          ...(typeof payload.messageId === "string"
            ? { messageId: payload.messageId }
            : { messageId: "unknown" }),
          ...(typeof payload.partId === "string" ? { partId: payload.partId } : {}),
          delta: payload.delta,
        },
      ];
    case "tool.updated": {
      const kind = payload.kind;
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
      if (!toolCallId) return [];
      const common = {
        ...base,
        toolCallId,
        ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
      };
      if (kind === "started") {
        return [
          {
            kind: "tool_call_started",
            ...common,
            ...(typeof payload.description === "string"
              ? { description: payload.description }
              : {}),
          },
        ];
      }
      if (kind === "result") {
        return [
          {
            kind: "tool_call_finished",
            ...common,
            ok: true,
            ...(typeof payload.duration === "number" ? { durationMs: payload.duration } : {}),
          },
        ];
      }
      if (kind === "error") {
        return [
          {
            kind: "tool_call_finished",
            ...common,
            ok: false,
            ...(isRecord(payload.error) && typeof payload.error.message === "string"
              ? {
                  error: {
                    message: payload.error.message,
                    ...(typeof payload.error.code === "string" ? { code: payload.error.code } : {}),
                  },
                }
              : { error: { message: "tool call failed" } }),
          },
        ];
      }
      return [];
    }
    case "permission.requested": {
      const requestId =
        typeof payload.requestId === "string" && payload.requestId.length > 0
          ? payload.requestId
          : typeof payload.toolCallId === "string"
            ? payload.toolCallId
            : "";
      if (!requestId) return [];
      const rawOptions = Array.isArray(payload.options) ? payload.options : [];
      const options = rawOptions
        .filter(
          (option): option is Record<string, unknown> =>
            isRecord(option) && typeof option.optionId === "string",
        )
        .map((option) => ({
          optionId: option.optionId as string,
          ...(typeof option.kind === "string" ? { kind: option.kind } : {}),
          ...(typeof option.name === "string" ? { name: option.name } : {}),
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        }));
      if (options.length === 0) return [];
      return [
        {
          kind: "permission_requested",
          ...base,
          requestId,
          ...(typeof payload.toolCallId === "string" ? { toolCallId: payload.toolCallId } : {}),
          ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
          ...(payload.riskLevel === "low" ||
          payload.riskLevel === "medium" ||
          payload.riskLevel === "high" ||
          payload.riskLevel === "critical"
            ? { riskLevel: payload.riskLevel }
            : {}),
          ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
          options,
        },
      ];
    }
    default:
      return [];
  }
}

/** 服务级事件（onDynamicSessionEvent 的非 session.event 成员）→ harness 事件。 */
export function translateAgentServiceEvent(
  event: ACodeAgentServiceEvent,
  seenPermissionRequestIds: Set<string>,
): HarnessEvent[] {
  if (event.type === "session.event") {
    const translated = translateSessionEvent(event.event);
    for (const item of translated) {
      if (item.kind === "permission_requested" && !seenPermissionRequestIds.has(item.requestId)) {
        seenPermissionRequestIds.add(item.requestId);
      }
    }
    return translated;
  }
  if (event.type === "permission.request") {
    // 与 session.event(permission.requested) 双发去重：session 帧先到则 typed 帧跳过。
    const requestId =
      isRecord(event.request) && typeof event.request.requestId === "string"
        ? event.request.requestId
        : "";
    if (!requestId || seenPermissionRequestIds.has(requestId)) return [];
    seenPermissionRequestIds.add(requestId);
    const request = event.request as unknown as Record<string, unknown>;
    const rawOptions = Array.isArray(request.options) ? request.options : [];
    const options = rawOptions
      .filter(
        (option): option is Record<string, unknown> =>
          isRecord(option) && typeof option.optionId === "string",
      )
      .map((option) => ({
        optionId: option.optionId as string,
        ...(typeof option.kind === "string" ? { kind: option.kind } : {}),
        ...(typeof option.name === "string" ? { name: option.name } : {}),
        ...(typeof option.description === "string" ? { description: option.description } : {}),
      }));
    if (options.length === 0) return [];
    return [
      {
        kind: "permission_requested",
        requestId,
        ...(typeof request.toolCallId === "string" ? { toolCallId: request.toolCallId } : {}),
        ...(typeof request.toolName === "string" ? { toolName: request.toolName } : {}),
        ...(request.riskLevel === "low" ||
        request.riskLevel === "medium" ||
        request.riskLevel === "high" ||
        request.riskLevel === "critical"
          ? { riskLevel: request.riskLevel }
          : {}),
        ...(typeof request.reason === "string" ? { reason: request.reason } : {}),
        options,
      },
    ];
  }
  // snapshot / state.updated / userInput.* 不属于 v1 公开事件面。
  return [];
}

interface TurnTerminalResult {
  resultType: "success" | "cancelled" | "error";
  response?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  durationMs?: number;
  error?: { message: string; code?: string };
  inputId?: string;
}

/**
 * run 的等待半程：先订阅事件流再发送，等待**本 run 触发的 turn** 的终态（H1 归属过滤）。
 *
 * 归属方案（按优先级，实证依据见 apps/acode-cli runtime/methods/turn.ts 的
 * TurnStarted/TurnComplete payload 均回显 sendText 的 inputId）：
 * 1. **inputId 归属（主路径）**：run 预分配 inputId（`harness-run-<uuid>`）随 sendPrompt
 *    下发；引擎 TurnStarted/TurnComplete 事件 payload 回显该 inputId。turn_done 携带
 *    本 run 的 inputId → 直接收口；TurnStarted(inputId=本 run) 捕获其 envelope turnId
 *    → 同 turnId 的 TurnDone 也收口。
 * 2. **退化路径（引擎不回显 inputId 的兼容场景）**：只接受「订阅建立之后观察到
 *    TurnStarted 的 turnId」的终态——订阅前已在途的旧 turn（如 send 挂起中被 deny 的
 *    turn）的终态被跳过，不再被 run 冒领。捕获到 inputId 关联后退化窗口即关闭
 *    （并发第三方 turn 的终态不再误收；同会话并发 run 的精确归属仍不区分，v1 串行假设）。
 *
 * 为什么不用 readSessionEvents 轮询：从 afterSeq=0 起扫会命中历史 turn 的终态
 * （同会话第二次 run 会拿到第一次的结果）；订阅窗口天然只覆盖新事件。
 */
export async function runAndWaitTurn(
  agent: Pick<IACodeAgentService, "onDynamicSessionEvent" | "sendPrompt">,
  params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    content: string;
    /** H1：run 预分配并随 send 下发的 inputId（引擎在 turn 事件 payload 中回显）。 */
    inputId: string;
    model?: unknown;
    toolDenylist?: string[];
  },
  timeoutMs: number,
): Promise<{ sent: { stateRevision?: number }; terminal: TurnTerminalResult }> {
  const pending: TurnTerminalResult[] = [];
  // H1 归属状态：ownedTurnIds=TurnStarted(本 inputId) 捕获的 turnId；
  // liveTurnIds=订阅建立后观察到的 TurnStarted turnId（退化窗口）；
  // sawOwnershipSignal=已观察到本 run 的归属信号（关闭退化窗口）。
  const ownedTurnIds = new Set<string>();
  const liveTurnIds = new Set<string>();
  let sawOwnershipSignal = false;
  let wake: (() => void) | undefined;
  const subscription = agent.onDynamicSessionEvent({
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    sessionId: params.sessionId,
    deliveryKind: "desktop-continuous",
  });
  const disposable = subscription((serviceEvent) => {
    if (serviceEvent.type !== "session.event") return;
    for (const translated of translateSessionEvent(serviceEvent.event)) {
      if (translated.kind === "turn_started") {
        if (translated.turnId !== undefined) liveTurnIds.add(translated.turnId);
        if (translated.inputId === params.inputId) {
          sawOwnershipSignal = true;
          if (translated.turnId !== undefined) ownedTurnIds.add(translated.turnId);
        }
        continue;
      }
      if (translated.kind !== "turn_done") continue;
      const byInputId = translated.inputId === params.inputId;
      const byOwnedTurnId =
        translated.turnId !== undefined && ownedTurnIds.has(translated.turnId);
      // H1 退化路径仅在未捕获到任何归属信号时启用。
      const byLiveTurnId =
        !sawOwnershipSignal &&
        translated.turnId !== undefined &&
        liveTurnIds.has(translated.turnId);
      if (!byInputId && !byOwnedTurnId && !byLiveTurnId) continue;
      pending.push({
        resultType: translated.resultType,
        ...(translated.response !== undefined ? { response: translated.response } : {}),
        ...(translated.usage !== undefined ? { usage: translated.usage } : {}),
        ...(translated.durationMs !== undefined ? { durationMs: translated.durationMs } : {}),
        ...(translated.error !== undefined ? { error: translated.error } : {}),
        ...(translated.inputId !== undefined ? { inputId: translated.inputId } : {}),
      });
      wake?.();
    }
  });
  try {
    const sent = await agent.sendPrompt({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      sessionId: params.sessionId,
      content: params.content,
      inputId: params.inputId,
      ...(isRecord(params.model) ? { modelSelection: params.model as never } : {}),
      ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
    });
    const deadline = Date.now() + timeoutMs;
    while (pending.length === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new HarnessMethodError(
          "run_timeout",
          `run did not observe a terminal turn event within ${timeoutMs}ms`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            wake = undefined;
            resolve();
          },
          Math.min(remaining, RUN_POLL_INTERVAL_MS),
        );
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    }
    return { sent, terminal: pending[0] as TurnTerminalResult };
  } finally {
    disposable.dispose();
  }
}

type Handler = (params: unknown) => Promise<unknown>;

/**
 * H2：入参经 shared 方法面 schema（harnessMethodParamsSchemas）safeParse。
 * 错误形状稳定：code=invalid_params + message + details.issues[{path,message}]
 * （字段路径点分，如 "content" / "model.modelId"）。
 * 兼容铁律对齐 parseFrameLoose：校验前剥离未知字段（additive 演进的新客户端字段
 * 不打坏老服务端），已声明字段做严格类型校验（终结 String(undefined) 变形透传）。
 */
export function parseHarnessMethodParams<M extends keyof typeof harnessMethodParamsSchemas>(
  method: M,
  params: unknown,
): z.output<(typeof harnessMethodParamsSchemas)[M]> {
  const schema = harnessMethodParamsSchemas[method];
  const shape =
    schema && typeof schema === "object" && "shape" in schema
      ? Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape)
      : undefined;
  const stripped: Record<string, unknown> = {};
  if (isRecord(params)) {
    if (shape) {
      for (const key of shape) {
        if (key in params) stripped[key] = params[key];
      }
    } else {
      Object.assign(stripped, params);
    }
  } else if (params !== undefined) {
    throw new HarnessMethodError(
      "invalid_params",
      `params of '${method}' must be an object`,
      { method, issues: [{ path: "", message: "params must be an object" }] },
    );
  }
  const result = schema.safeParse(stripped);
  if (!result.success) {
    // 字段路径点分化（zod path 可能含 number/symbol 段，显式 String 化）。
    const pathOf = (path: PropertyKey[]): string =>
      path.map((segment) => String(segment)).join(".") || "(root)";
    throw new HarnessMethodError(
      "invalid_params",
      `invalid params for '${method}': ${result.error.issues
        .map((issue) => `${pathOf(issue.path)} ${issue.message}`)
        .join("; ")}`,
      {
        method,
        issues: result.error.issues.map((issue) => ({
          path: pathOf(issue.path),
          message: issue.message,
        })),
      },
    );
  }
  return result.data as z.output<(typeof harnessMethodParamsSchemas)[M]>;
}

/** 方法分发表：方法名 → 翻译到 services 层的处理器。 */
export function createHarnessMethodHandlers(
  context: HarnessTranslateContext,
): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  // H2：parseParams = 方法面 schema safeParse（未知字段剥离 + 严格类型校验）。
  const parseParams = parseHarnessMethodParams;

  handlers.set("list_sessions", async (raw) => {
    const params = parseParams("list_sessions", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    const sessions = await agent.listSessions({
      ...workspaceOf(params),
      ...(params.includeArchived === true ? { includeArchived: true } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
    return { sessions: sessions.map(sessionSummary) };
  });

  handlers.set("create_session", async (raw) => {
    const params = parseParams("create_session", raw);
    if (typeof params.systemPrompt === "string" && params.systemPrompt.length > 0) {
      throw notSupported(
        "create_session.systemPrompt",
        "services 层 createSession 无 systemPrompt 入参；v1 不透传给引擎（不静默忽略）",
      );
    }
    const services = await context.getServices();
    const agent = requireAgent(services);
    const snapshot = await agent.createSession({
      ...workspaceOf(params),
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      ...(params.parentSessionId !== undefined
        ? { parentSessionId: params.parentSessionId }
        : {}),
      ...(asSessionMode(params.mode) ? { mode: asSessionMode(params.mode) } : {}),
      ...(params.model ? { model: params.model as never } : {}),
      ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
    });
    return createSessionResultOf(snapshot);
  });

  handlers.set("attach_session", async (raw) => {
    const params = parseParams("attach_session", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    const snapshot = await agent.resumeSession(sessionTargetOf(params));
    return createSessionResultOf(snapshot);
  });

  handlers.set("detach_session", async (raw) => {
    const params = parseParams("detach_session", raw);
    const services = await context.getServices();
    // detach = 客户端不再持有该会话：释放为此连接拉起的空闲预热会话即可，
    // 绝不 closeSession（会终止会话本体——detach 语义是“放手”不是“关闭”）。
    const task = requireTask(services);
    await task.releaseWorkspacePreparation(workspaceOf(params));
    return { detached: true };
  });

  handlers.set("fork_session", async (raw) => {
    const params = parseParams("fork_session", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    const snapshot = await agent.createSession({
      ...workspaceOf(params),
      // H2：schema 保证 sessionId 为非空 string，直接透传（此前 String(undefined)
      // 会把缺参变形为 parentSessionId:"undefined" 的会话——实证缺陷）。
      parentSessionId: params.sessionId,
    });
    return createSessionResultOf(snapshot);
  });

  handlers.set("rewind_session", (raw) => {
    parseParams("rewind_session", raw);
    // services 层只有 v4 文件 rewind preview 与 CLI 内建 /rewind 命令，
    // 没有会话级 rewind 入口；方法保留在面上、如实降级（spec 附录登记）。
    throw notSupported(
      "rewind_session",
      "services 层无会话级 rewind API（仅 CLI 内建 /rewind 与 v4 文件 rewind 预览）；等 additive 落地后解除",
    );
  });

  handlers.set("send_message", async (raw) => {
    const params = parseParams("send_message", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    const result = await agent.sendPrompt({
      ...sessionTargetOf(params),
      // H2：schema 保证 content 为非空 string（此前 String(undefined) 发出 "undefined" 消息）。
      content: params.content,
      ...(params.model ? { modelSelection: params.model as never } : {}),
      ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
    });
    return {
      accepted: true as const,
      ...(typeof result.stateRevision === "number" ? { revision: result.stateRevision } : {}),
    };
  });

  handlers.set("cancel_turn", async (raw) => {
    const params = parseParams("cancel_turn", raw);
    const services = await context.getServices();
    const task = requireTask(services);
    await task.stopGeneration(taskTargetOf(params));
    return { cancelled: true };
  });

  handlers.set("run", async (raw) => {
    const params = parseParams("run", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    const target = sessionTargetOf(params);
    const { terminal } = await runAndWaitTurn(
      agent,
      {
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        sessionId: target.sessionId,
        // H2：schema 保证 content 为非空 string。
        content: params.content,
        // H1：run 预分配 inputId，引擎 turn 事件回显后作为终态归属依据。
        inputId: `harness-run-${randomUUID()}`,
        ...(params.model ? { model: params.model } : {}),
        ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
      },
      context.runTimeoutMs ?? RUN_DEFAULT_TIMEOUT_MS,
    );
    return {
      sessionId: target.sessionId,
      ...(terminal.inputId !== undefined ? { inputId: terminal.inputId } : {}),
      resultType: terminal.resultType,
      ...(terminal.response !== undefined ? { response: terminal.response } : {}),
      ...(terminal.usage !== undefined ? { usage: terminal.usage } : {}),
      ...(terminal.durationMs !== undefined ? { durationMs: terminal.durationMs } : {}),
      ...(terminal.error !== undefined ? { error: terminal.error } : {}),
    };
  });

  handlers.set("permission_respond", async (raw) => {
    const params = parseParams("permission_respond", raw);
    const services = await context.getServices();
    const task = requireTask(services);
    // services 层 respondPermission 的 response 字段在 v4 resolveInteraction 收敛路径上
    // 不被消费（决策完全由 optionId 承载，见 acodeTaskServiceAdapter.respondPermission），
    // 这里传中性 decision 仅满足入参 schema；harness 面不暴露伪造 decision 的字段。
    const neutralResponse: ACodePermissionResponse = { decision: "allow" };
    const accepted = await task.respondPermission({
      ...taskTargetOf(params),
      // H2：schema 保证 requestId/optionId 为非空 string（此前 String(undefined) 透传）。
      requestId: params.requestId,
      optionId: params.optionId,
      response: neutralResponse,
    });
    return { accepted };
  });

  handlers.set("set_model", async (raw) => {
    const params = parseParams("set_model", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    await agent.setModel({
      ...sessionTargetOf(params),
      model: params.model as never,
    });
    return {};
  });

  handlers.set("get_models", async (raw) => {
    parseParams("get_models", raw);
    const services = await context.getServices();
    const selection = services.getOptional(IModelSelectionService);
    if (!selection)
      throw new HarnessMethodError("unavailable", "IModelSelectionService is not registered");
    const view = await selection.getView();
    return {
      providers: (view.providers ?? []).map((provider) => ({
        providerId: provider.providerId,
        ...(provider.providerName ? { providerName: provider.providerName } : {}),
        models: (provider.models ?? []).map((model) => ({ modelId: model.modelId })),
      })),
      ...(view.preferredSelection ? { preferredSelection: view.preferredSelection } : {}),
    };
  });

  handlers.set("compact", async (raw) => {
    const params = parseParams("compact", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    await agent.compactSession({
      ...sessionTargetOf(params),
      ...(params.instructions !== undefined ? { instructions: params.instructions } : {}),
    });
    return {};
  });

  handlers.set("read_file", async (raw) => {
    const params = parseParams("read_file", raw);
    const services = await context.getServices();
    const file = services.getOptional(IFileService);
    if (!file) throw new HarnessMethodError("unavailable", "IFileService is not registered");
    const slice = await file.readTextFile({
      // H2：schema 保证 path 为非空 string（此前 String(undefined) 透传）。
      path: params.path,
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      ...(params.length !== undefined ? { length: params.length } : {}),
    });
    return {
      path: slice.path,
      content: slice.content,
      offset: slice.offset,
      bytesRead: slice.bytesRead,
      totalBytes: slice.totalBytes,
      truncated: slice.truncated,
      isBinary: slice.isBinary,
    };
  });

  handlers.set("search_text", (raw) => {
    parseParams("search_text", raw);
    // IFileService 只有文件名模糊搜索（searchWorkspaceFiles），无内容 grep；
    // 内容检索能力在 agent 工具面（rg）而非 services 层。如实降级。
    throw notSupported(
      "search_text",
      "services 层无内容检索 API（IFileService 仅文件名搜索）；嵌入方可经 send_message 使用引擎检索工具",
    );
  });

  handlers.set("find_files", async (raw) => {
    const params = parseParams("find_files", raw);
    const services = await context.getServices();
    const file = services.getOptional(IFileService);
    if (!file) throw new HarnessMethodError("unavailable", "IFileService is not registered");
    const entries = await file.searchWorkspaceFiles({
      // H2：schema 保证 rootPath/query 为非空 string、limit 为正整数 ≤500
      // （此前 limit 1e9 等越界值经 typeof 检查直通——实证缺陷）。
      rootPath: params.rootPath,
      query: params.query,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
    return {
      entries: entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        ...(entry.relativePath ? { relativePath: entry.relativePath } : {}),
        type: entry.type,
      })),
    };
  });

  handlers.set("configure_tools", (raw) => {
    parseParams("configure_tools", raw);
    // 工具控制在 services 层是 create/resume/send 时点的 toolAllowlist/toolDenylist 参数，
    // 无 create 后的会话级动态配置面，也无自定义工具注册回调；如实降级。
    // 可用替代：create_session.toolDenylist（创建时禁用清单）。
    throw notSupported(
      "configure_tools",
      "services 层无 create 后的会话级工具配置面；禁用清单请在 create_session.toolDenylist 传入",
      "create_session.toolDenylist",
    );
  });

  return handlers;
}

/** 供 server.ts 校验方法名（未注册的方法名统一 unknown_method）。 */
export function assertKnownHarnessMethod(method: string): void {
  if (!isHarnessMethodName(method)) {
    throw new HarnessMethodError("unknown_method", `unknown harness method '${method}'`);
  }
}
