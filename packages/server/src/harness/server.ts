// Harness API 翻译桥服务端：帧循环 + 握手 + 方法分发 + 事件泵（seq 单调）。
// 参照 jcode (MIT) harness-api-server 的「独立翻译桥逐客户端连接」设计，自撰实现。
//
// R5 状态所有权：本桥只持连接作用域状态（握手态/事件订阅登记/seq 计数器），
// 无任何业务状态——会话真相在 services 层，SDK 状态在 SDK 实例。

import { randomUUID } from "node:crypto";
import type { ServiceCollection } from "@acode/services";
import { IACodeAgentService } from "@acode/services";
import {
  HARNESS_API_VERSION_MAJOR,
  HARNESS_API_VERSION_MINOR,
  harnessHelloVersionProbeSchema,
  parseFrameLoose,
  type HarnessEvent,
} from "@acode/shared/harness-api";
import type { HarnessStdioTransport } from "./transport.js";
import {
  HarnessMethodError,
  createHarnessMethodHandlers,
  parseHarnessMethodParams,
  translateAgentServiceEvent,
} from "./translate.js";

export interface CreateHarnessApiServerOptions {
  transport: HarnessStdioTransport;
  /** 既有 ServiceCollection，或懒工厂（握手/降级路径不初始化完整服务面）。 */
  services: ServiceCollection | (() => ServiceCollection | Promise<ServiceCollection>);
  serverName?: string;
  capabilities?: string[];
  runTimeoutMs?: number;
  /** 测试钩子：命中该 seq 的事件帧跳过写出（计数器照常前进），验证消费方 gap 检测。 */
  testDropEventSeq?: number;
  /** 测试钩子：日志输出（缺省丢弃——生产 stdio 的 stderr 由 entry 层管理）。 */
  log?: (message: string) => void;
}

export interface HarnessApiServer {
  /** 主动停止：断开事件订阅并结束帧循环（幂等）。 */
  stop(): Promise<void>;
  /** 传输关闭后 resolve。 */
  done(): Promise<void>;
}

interface ActiveSubscription {
  subscriptionId: string;
  sessionId: string;
  dispose: () => void;
}

export function createHarnessApiServer(options: CreateHarnessApiServerOptions): HarnessApiServer {
  const log = options.log ?? (() => undefined);
  const transport = options.transport;
  let servicesInstance: ServiceCollection | undefined;
  let servicesPromise: Promise<ServiceCollection> | undefined;
  const getServices = (): Promise<ServiceCollection> => {
    if (servicesInstance) return Promise.resolve(servicesInstance);
    servicesPromise ??= (async () => {
      servicesInstance =
        typeof options.services === "function" ? await options.services() : options.services;
      return servicesInstance;
    })();
    return servicesPromise;
  };

  const handlers = createHarnessMethodHandlers({ getServices, runTimeoutMs: options.runTimeoutMs });

  // 连接作用域状态（R5：桥无业务状态，以下全部随连接生命周期回收）。
  let nextSeq = 0;
  const subscriptions = new Map<string, ActiveSubscription>();
  const subscriptionsBySession = new Map<string, Set<string>>();
  const seenPermissionRequestIds = new Set<string>();
  let stopped = false;
  let loopDoneResolve: () => void;
  const loopDone = new Promise<void>((resolve) => {
    loopDoneResolve = resolve;
  });

  const writeFrame = (frame: unknown): void => {
    transport.writeLine(JSON.stringify(frame));
  };

  const writeEvent = (sessionId: string, event: HarnessEvent): void => {
    const seq = ++nextSeq;
    if (options.testDropEventSeq === seq) {
      // 测试钩子：跳过写出但 seq 已消耗——消费方相邻 seq 出现缺口即触发 onGap。
      log(`test hook dropped event seq=${seq}`);
      return;
    }
    writeFrame({ v: HARNESS_API_VERSION_MAJOR, kind: "event", sessionId, seq, event });
  };

  const disposeSubscription = (subscriptionId: string): boolean => {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) return false;
    subscriptions.delete(subscriptionId);
    const sessionSet = subscriptionsBySession.get(subscription.sessionId);
    sessionSet?.delete(subscriptionId);
    if (sessionSet && sessionSet.size === 0) subscriptionsBySession.delete(subscription.sessionId);
    try {
      subscription.dispose();
    } catch (error) {
      log(`subscription dispose failed: ${String(error)}`);
    }
    return true;
  };

  const disposeAllSubscriptions = (): void => {
    for (const subscriptionId of Array.from(subscriptions.keys())) {
      disposeSubscription(subscriptionId);
    }
  };

  const respondError = (id: unknown, error: unknown): void => {
    if (error instanceof HarnessMethodError) {
      writeFrame({
        v: HARNESS_API_VERSION_MAJOR,
        kind: "response",
        id,
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`internal error: ${message}`);
    writeFrame({
      v: HARNESS_API_VERSION_MAJOR,
      kind: "response",
      id,
      ok: false,
      error: { code: "internal_error", message },
    });
  };

  const handleSubscribeEvents = async (id: unknown, params: unknown): Promise<void> => {
    // H2：subscribe_events 同样经 shared 方法面 schema 校验（与其他方法错误形状一致）。
    const record = parseHarnessMethodParams("subscribe_events", params);
    const services = await getServices();
    const agent = services.getOptional(IACodeAgentService);
    if (!agent) throw new HarnessMethodError("unavailable", "IACodeAgentService is not registered");
    const sessionId = record.sessionId;
    const subscriptionId = randomUUID();
    // harness 嵌入方是 live 消费者：走 continuous 投影（replayable 是手机恢复链路语义）。
    const eventSubscription = agent.onDynamicSessionEvent({
      workspacePath: record.workspacePath,
      ...(record.workspaceIdentity ? { workspaceIdentity: record.workspaceIdentity } : {}),
      sessionId,
      deliveryKind: "desktop-continuous",
    });
    const listenerDisposable = eventSubscription((serviceEvent) => {
      // seenPermissionRequestIds 只做去重，防无限增长：超界清空（重复 permission 投影的
      // 最坏影响是多发一条 permission_requested，消费方应答幂等）。
      if (seenPermissionRequestIds.size > 256) seenPermissionRequestIds.clear();
      for (const harnessEvent of translateAgentServiceEvent(
        serviceEvent,
        seenPermissionRequestIds,
      )) {
        writeEvent(sessionId, harnessEvent);
      }
    });
    const dispose = (): void => listenerDisposable.dispose();
    subscriptions.set(subscriptionId, { subscriptionId, sessionId, dispose });
    let sessionSet = subscriptionsBySession.get(sessionId);
    if (!sessionSet) {
      sessionSet = new Set();
      subscriptionsBySession.set(sessionId, sessionSet);
    }
    sessionSet.add(subscriptionId);
    writeFrame({
      v: HARNESS_API_VERSION_MAJOR,
      kind: "response",
      id,
      ok: true,
      result: { subscriptionId, lastSeq: nextSeq },
    });
  };

  const handleUnsubscribeEvents = (id: unknown, params: unknown): void => {
    // H2：unsubscribe_events 同样经 shared 方法面 schema 校验。
    const record = parseHarnessMethodParams("unsubscribe_events", params);
    const unsubscribed = disposeSubscription(record.subscriptionId);
    if (!unsubscribed) {
      throw new HarnessMethodError(
        "invalid_params",
        `unknown subscriptionId '${record.subscriptionId}'`,
      );
    }
    writeFrame({
      v: HARNESS_API_VERSION_MAJOR,
      kind: "response",
      id,
      ok: true,
      result: { unsubscribed: true },
    });
  };

  const dispatchRequest = (id: unknown, method: string, params: unknown): void => {
    // 请求并发处理：run 会阻塞等待 turn 终态，串行会饿死同连接的 permission_respond。
    void (async () => {
      try {
        if (method === "subscribe_events") {
          await handleSubscribeEvents(id, params);
          return;
        }
        if (method === "unsubscribe_events") {
          handleUnsubscribeEvents(id, params);
          return;
        }
        const handler = handlers.get(method);
        if (!handler) {
          throw new HarnessMethodError("unknown_method", `unknown harness method '${method}'`);
        }
        const result = await handler(params);
        writeFrame({
          v: HARNESS_API_VERSION_MAJOR,
          kind: "response",
          id,
          ok: true,
          ...(result !== undefined ? { result } : {}),
        });
      } catch (error) {
        respondError(id, error);
      }
    })();
  };

  const runLoop = async (): Promise<void> => {
    try {
      // ── 握手：首帧必须 hello；主版本不匹配即拒绝（可读错误+建议），minor 差异容忍 ──
      for await (const line of transport.readLines()) {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          writeFrame({
            v: HARNESS_API_VERSION_MAJOR,
            kind: "error",
            code: "invalid_json",
            message: "frame is not valid JSON (one JSON object per line)",
          });
          continue;
        }
        const frame = parseFrameLoose(raw);
        if (frame.kind !== "hello") {
          if (frame.kind === "unknown") {
            const probe = harnessHelloVersionProbeSchema.safeParse(raw);
            if (probe.success && probe.data.v !== HARNESS_API_VERSION_MAJOR) {
              writeFrame({
                v: HARNESS_API_VERSION_MAJOR,
                kind: "error",
                code: "version_mismatch",
                message: `client harness api major version ${probe.data.v} is incompatible with server ${HARNESS_API_VERSION_MAJOR}; upgrade the SDK or the harness server (minor differences are tolerated, major are not)`,
              });
            } else {
              writeFrame({
                v: HARNESS_API_VERSION_MAJOR,
                kind: "error",
                code: "invalid_handshake",
                message: "first frame must be a hello frame",
              });
            }
          } else {
            writeFrame({
              v: HARNESS_API_VERSION_MAJOR,
              kind: "error",
              code: "invalid_handshake",
              message: "first frame must be a hello frame",
            });
          }
          await stop();
          return;
        }
        log(
          `client connected: ${frame.client} capabilities=${frame.capabilities.join(",") || "none"}`,
        );
        writeFrame({
          v: HARNESS_API_VERSION_MAJOR,
          kind: "hello_ack",
          server: options.serverName ?? "acode-harness",
          protocolMinor: HARNESS_API_VERSION_MINOR,
          capabilities: options.capabilities ?? [],
        });
        break;
      }

      // ── 请求循环 ──
      for await (const line of transport.readLines()) {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          writeFrame({
            v: HARNESS_API_VERSION_MAJOR,
            kind: "error",
            code: "invalid_json",
            message: "frame is not valid JSON (one JSON object per line)",
          });
          continue;
        }
        const frame = parseFrameLoose(raw);
        if (frame.kind === "request") {
          dispatchRequest(frame.id, frame.method, frame.params);
        }
        // 兼容铁律：未知帧/未知字段/未知枚举值一律忽略（hello 重复帧、event 回流等）。
      }
    } finally {
      disposeAllSubscriptions();
      loopDoneResolve();
    }
  };

  const stopPromise: Promise<void> = (async () => {
    await loopDone;
  })();

  let stoppedPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopped) return stopPromise;
    stopped = true;
    stoppedPromise = (async () => {
      disposeAllSubscriptions();
      transport.dispose();
      await loopDone;
    })();
    return stoppedPromise;
  };

  transport.onClose().then(
    () => {
      void stop();
    },
    () => {
      void stop();
    },
  );

  void runLoop().catch((error) => {
    log(`harness loop crashed: ${String(error)}`);
    void stop();
  });

  return {
    stop,
    done: () => stopPromise,
  };
}
