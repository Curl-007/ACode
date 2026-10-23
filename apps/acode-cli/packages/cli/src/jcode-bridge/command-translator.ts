// ============================================================
// jcode 桥接：v4 CommandEnvelope → jcode ACP 调用翻译（spec R2/R3/R5）
//
// 这是 V4GatewayHost.executeCommand 的实现体。核心纪律（对齐 native
// session-flow.ts:184-314 的 sendText）：
//   - sendText **立即返回 inputAccepted 收据**，不 await 整轮完成。turn 执行靠
//     jcode 的 session/update 事件流经 translator→ingest 异步推进。若在此 await
//     prompt，CommandInbox 的 per-session FIFO gate 会被整轮锁死，stop 命令无法
//     并发 admission（spec R5 的 settle 语义正源于此）。
//   - executeCommand 必须恰好 settle 一次：成功 return（→ACK accepted）、失败 throw
//     （→ACK failed + reasonCode）。绝不返回悬挂 promise。
//   - jcode 无对应的命令（fork/rewind/model 切换/workflow/…）抛 JcodeUnsupported-
//     CommandError，网关据 .reasonCode 产 failed ACK（v4-gateway.ts:2605-2618），
//     不静默 noop 骗客户端。
//
// 可测性：依赖 JcodeBridgeRuntime 接口（client/sessions/translator/ingest），
// 测试注入假件即可，不 spawn 真 jcode。
// ============================================================

import type { CommandEnvelope, CommandResult } from "@acode/shared/acode-protocol-v4";
import type { Logger } from "@acode/contracts";

import type { JcodeAcpClient } from "./acp-client.js";
import { JCODE_CAPABILITY_UNSUPPORTED_REASON } from "./constants.js";
import type { JcodeEventTranslator } from "./event-translator.js";
import type { TranslatedSessionEvent } from "./acp-types.js";
import type { JcodeSessionMap } from "./session-map.js";

/** command-translator 的依赖面（host.ts 实现，测试注入假件）。 */
export interface JcodeBridgeRuntime {
  readonly client: JcodeAcpClient;
  readonly sessions: JcodeSessionMap;
  /** 取（或按需创建）某 v4 会话的翻译器。 */
  ensureTranslator(v4SessionId: string): JcodeEventTranslator;
  translator(v4SessionId: string): JcodeEventTranslator | undefined;
  /** 把翻译出的 SessionEvent 喂给复用的 v4 网关（gateway.ingest）。 */
  ingestEvents(v4SessionId: string, events: readonly TranslatedSessionEvent[]): void;
  /** createSession 时生成 v4 侧会话 id（客户端据此订阅 conversation/<id>）。 */
  newV4SessionId(): string;
  /** workspaceId → jcode 会话 cwd（须是平台原生绝对路径，spike §2）。 */
  resolveCwd(workspaceId: string): string;
  now(): number;
  logger?: Logger;
}

/** jcode 无对应能力的命令 → 抛此错，网关产 failed ACK + 稳定 reasonCode（spec R5）。 */
export class JcodeUnsupportedCommandError extends Error {
  readonly reasonCode = JCODE_CAPABILITY_UNSUPPORTED_REASON;

  constructor(commandType: string) {
    super(`command not supported by jcode external agent backend: ${commandType}`);
    this.name = "JcodeUnsupportedCommandError";
  }
}

/** createSession 的 payload 最小读取面（其余键忽略）。 */
interface CreateSessionPayload {
  workspaceId?: string;
  firstInput?: { text?: string };
}
interface SendTextPayload {
  text?: string;
}

/**
 * executeCommand 的实现：按 envelope.type 分派到 jcode ACP。
 *
 * 返回 CommandResult（→accepted ACK）或 undefined（→accepted 无结果）；
 * 失败一律 throw（→failed ACK）。
 */
export async function executeJcodeCommand(
  runtime: JcodeBridgeRuntime,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  switch (envelope.type) {
    case "createSession":
      return createSession(runtime, envelope);
    case "sendText":
      return sendText(runtime, envelope);
    case "stop":
      return stop(runtime, envelope);
    case "deleteSession":
      return deleteSession(runtime, envelope);
    default:
      // fork/rewind/editUserQuery/switchModelConfig/usage/workflow/swarm/goal/hook/
      // artifact/queue/rename 等：jcode ACP 无对等面（spec R2、R5、未做与取舍）。
      // 显式 failed 而非静默 noop——客户端才能如实呈现「此后端不支持」。
      throw new JcodeUnsupportedCommandError(envelope.type);
  }
}

async function createSession(
  runtime: JcodeBridgeRuntime,
  envelope: CommandEnvelope,
): Promise<CommandResult> {
  const payload = (envelope.payload ?? {}) as CreateSessionPayload;
  const workspaceId = payload.workspaceId ?? "";
  const cwd = runtime.resolveCwd(workspaceId);
  // session/new：jcode 生成 sessionId（shim 无法指定）。cwd 必须原生绝对路径。
  const acp = await runtime.client.newSession(cwd);
  const jcodeSessionId = acp.sessionId;
  // fail-closed：jcode 未回有效 sessionId 即视为创建失败，不登记半死映射。
  if (!jcodeSessionId || typeof jcodeSessionId !== "string") {
    throw new Error("jcode session/new returned no sessionId");
  }
  const v4SessionId = runtime.newV4SessionId();
  runtime.sessions.bind(v4SessionId, jcodeSessionId, cwd, runtime.now());
  const translator = runtime.ensureTranslator(v4SessionId);
  // 顺序不变量 1：SessionCreated 必须先于任何 TurnStarted（product-projection draft 语义）。
  const created = translator.sessionCreatedEvent();
  if (created) runtime.ingestEvents(v4SessionId, [created]);

  // 桌面新建会话常带 firstInput；有则立即启动首轮（复用 startTurn）。
  const firstText = payload.firstInput?.text;
  if (firstText && firstText.trim().length > 0) {
    startTurn(runtime, v4SessionId, firstText, envelope.commandId);
  }
  return { type: "createSession", sessionId: v4SessionId };
}

async function sendText(
  runtime: JcodeBridgeRuntime,
  envelope: CommandEnvelope,
): Promise<CommandResult> {
  const v4SessionId = envelope.sessionId;
  if (!v4SessionId) throw new Error("sendText requires sessionId");
  const jcodeSessionId = runtime.sessions.toJcode(v4SessionId);
  if (!jcodeSessionId) throw new Error(`sendText: unknown session ${v4SessionId}`);
  const payload = (envelope.payload ?? {}) as SendTextPayload;
  const text = payload.text ?? "";
  // 空输入：对齐 native hasPromptInput 校验（session-flow.ts:191），拒绝而非发空 prompt。
  if (text.trim().length === 0) {
    throw Object.assign(new Error("input must not be empty"), { reasonCode: "proto.invalidPayload" });
  }
  startTurn(runtime, v4SessionId, text, envelope.commandId);
  // 立即返回收据（delivery startNow）；turn 结果经事件流推进，不在此 await。
  return { type: "inputAccepted", delivery: "startNow", inputId: envelope.commandId };
}

/**
 * 启动一轮：发 TurnStarted（合成 turnId）→ fire-and-forget jcode prompt →
 * prompt settle 后发 TurnComplete/TurnError。
 *
 * session/update 通知不在此处理——由 host.ts 全局注册的 client.onNotification
 * 按 jcodeSessionId 路由到 translator（见 host.ts）。本函数只管轮次边界事件。
 */
function startTurn(
  runtime: JcodeBridgeRuntime,
  v4SessionId: string,
  text: string,
  commandId: string,
): void {
  const jcodeSessionId = runtime.sessions.toJcode(v4SessionId);
  const translator = runtime.translator(v4SessionId);
  if (!jcodeSessionId || !translator) {
    runtime.logger?.warn("jcode bridge startTurn on unknown session", { v4SessionId });
    return;
  }
  // messageId 用 commandId 派生稳定值：TurnStarted 的 productTurnId 身份靠它。
  const turnStarted = translator.beginTurn(text, `msg_${commandId}`);
  runtime.ingestEvents(v4SessionId, [turnStarted]);

  // fire-and-forget：prompt 的 resolve/reject 都收口成 endTurn 事件，绝不悬挂。
  void runtime.client
    .prompt(jcodeSessionId, [{ type: "text", text }])
    .then((result) => {
      const events = translator.endTurn(
        { stopReason: result.stopReason },
        result.usage
          ? {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
              cachedReadTokens: result.usage.cachedReadTokens,
            }
          : undefined,
      );
      runtime.ingestEvents(v4SessionId, events);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      runtime.logger?.warn("jcode prompt failed", { v4SessionId, error: message });
      // turn 以 error 收口，投影 phase 才能离开 running，后续命令才可 admission。
      const events = translator.endTurn({ stopReason: "error", errorMessage: message });
      runtime.ingestEvents(v4SessionId, events);
    });
}

async function stop(runtime: JcodeBridgeRuntime, envelope: CommandEnvelope): Promise<undefined> {
  const v4SessionId = envelope.sessionId;
  if (!v4SessionId) throw new Error("stop requires sessionId");
  const jcodeSessionId = runtime.sessions.toJcode(v4SessionId);
  if (!jcodeSessionId) throw new Error(`stop: unknown session ${v4SessionId}`);
  // session/cancel 幂等（spike §4.3 实测空闲会话返回 {}）。turn 的 TurnComplete
  // 由 startTurn 的 prompt.catch/then 在 cancel 触发 prompt 返回后收口。
  await runtime.client.cancel(jcodeSessionId);
  return undefined;
}

async function deleteSession(
  runtime: JcodeBridgeRuntime,
  envelope: CommandEnvelope,
): Promise<undefined> {
  const v4SessionId = envelope.sessionId;
  if (!v4SessionId) throw new Error("deleteSession requires sessionId");
  const jcodeSessionId = runtime.sessions.toJcode(v4SessionId);
  if (jcodeSessionId) {
    // close 失败不阻断本地 unbind：会话映射清理是 shim 侧事实，best effort 通知 jcode。
    try {
      await runtime.client.closeSession(jcodeSessionId);
    } catch (error) {
      runtime.logger?.warn("jcode session/close failed", {
        v4SessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  runtime.sessions.unbind(v4SessionId);
  return undefined;
}
