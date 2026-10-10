// Harness SDK 会话面：create/run（阻塞取 TurnResult）/事件迭代器（seq gap）/
// configureTools / rewind / fork / ask 结构化输出 / 权限 fail-closed 超时。
//
// 权限红线（spec R5 不变量）：SDK 不提供任何绕过权限管线的执行捷径；
// PermissionRequested 必须由消费方应答，或在 SDK_PERMISSION_TIMEOUT_MS 内无应答时
// 由 SDK 自动回执「拒绝」选项——超时语义 = 拒绝（fail-closed），绝不挂死 turn。

import type { z } from "zod";
import type {
  HarnessEvent,
  HarnessModelSelection,
  PermissionRequestedEvent,
  RunResult,
} from "@acode/shared/harness-api";
import { HarnessRpcError, HarnessStructuredOutputError } from "./errors.js";
import { SDK_PERMISSION_TIMEOUT_MS, SDK_STRUCTURED_RETRY_MAX } from "./constants.js";
// 依赖倒置（纳管后 forbidCycles 生效）：session 不再反向 import client.ts，
// 只依赖 session-types.ts 的 SessionClientPort；AcodeHarnessClient 结构化满足。
import type {
  ConfigureToolsInput,
  CreateSessionInput,
  SessionClientPort,
  SessionRunOptions,
} from "./session-types.js";
import { describeZodSchema, parseJsonOutput } from "./structured-output.js";

// 公开类型与结构化输出实现分别下沉到 session-types.ts / structured-output.ts
// （400 行物理上限治理）；此处原样转发，@acode/harness-sdk 包根与既有
// ./session.js 导入面（含 tests 的 deep import）不变。
export type {
  ConfigureToolsInput,
  CreateSessionInput,
  CustomToolSpec,
  SessionRunOptions,
} from "./session-types.js";
export { describeZodSchema } from "./structured-output.js";

/**
 * L2：从权限选项里挑「拒绝」语义项——显式匹配 deny/reject
 * （optionId/kind/name 任一字段命中；词边界匹配避免误中 "undeny" 类误报）。
 * 无显式 deny 选项时兜底取最后一项。契约假设（登记）：ACode 权限选项按风险升序排列、
 * 末项是最保守动作；若未来引擎改变排列契约，此兜底需重新评估。
 */
export function pickDenyOption(event: PermissionRequestedEvent): { optionId: string } | undefined {
  const deny = event.options.find((option) => {
    const haystack = `${option.optionId} ${option.kind ?? ""} ${option.name ?? ""}`.toLowerCase();
    return /\bdeny\b|\breject\b/.test(haystack);
  });
  if (deny) return { optionId: deny.optionId };
  const last = event.options[event.options.length - 1];
  return last ? { optionId: last.optionId } : undefined;
}

/** events() 迭代器在 session 内的队列条目（M3：可结束、可真移除）。 */
interface EventQueueEntry {
  queue: { seq: number; event: HarnessEvent }[];
  wakeup: (() => void) | undefined;
  finished: boolean;
}

export class HarnessSession {
  readonly #client: SessionClientPort;
  readonly #sessionId: string;
  readonly #workspacePath: string;
  readonly #workspaceIdentity: string | undefined;
  #subscriptionId: string | undefined;
  #subscriptionPromise: Promise<string> | undefined;
  readonly #eventQueues: EventQueueEntry[] = [];
  readonly #permissionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** M3(1)：session 构造时登记的连接级监听器移除句柄（close 时回收）。 */
  #removeConnectionListener: (() => void) | undefined;
  #closed = false;
  /** 测试可注入的权限超时（缺省 SDK_PERMISSION_TIMEOUT_MS）。 */
  #permissionTimeoutMs: number;

  constructor(
    client: SessionClientPort,
    input: {
      sessionId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      permissionTimeoutMs?: number;
    },
  ) {
    this.#client = client;
    this.#sessionId = input.sessionId;
    this.#workspacePath = input.workspacePath;
    this.#workspaceIdentity = input.workspaceIdentity;
    this.#permissionTimeoutMs = input.permissionTimeoutMs ?? SDK_PERMISSION_TIMEOUT_MS;
    // 权限 fail-closed：本会话收到 PermissionRequested 且消费方未应答 → 超时自动回执拒绝。
    // M3(1)：监听器登记移除句柄——session.close()/client.close() 时从连接层摘除，
    // 此前每建一个 session 就永久挂一个连接级监听器（多 session 场景双重泄漏）。
    this.#removeConnectionListener = client.addEventListener((frame) => {
      if (this.#closed) return;
      if (frame.sessionId !== this.#sessionId) return;
      if (frame.event.kind === "permission_requested") {
        this.#armPermissionTimeout(frame.event);
      }
      for (const entry of Array.from(this.#eventQueues)) {
        if (entry.finished) continue;
        entry.queue.push({ seq: frame.seq, event: frame.event });
        entry.wakeup?.();
      }
    });
  }

  /** M3 诊断：活跃 events() 队列数（泄漏回归观测点）。 */
  get eventQueueCount(): number {
    return this.#eventQueues.length;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get workspacePath(): string {
    return this.#workspacePath;
  }

  #target(): Record<string, string> {
    return {
      workspacePath: this.#workspacePath,
      ...(this.#workspaceIdentity ? { workspaceIdentity: this.#workspaceIdentity } : {}),
      sessionId: this.#sessionId,
    };
  }

  #armPermissionTimeout(event: PermissionRequestedEvent): void {
    const requestId = event.requestId;
    if (this.#permissionTimers.has(requestId)) return;
    const timer = setTimeout(() => {
      this.#permissionTimers.delete(requestId);
      // 超时 = 拒绝：自动回执 deny 语义选项；连可回执选项都没有时只能放行给引擎超时。
      const deny = pickDenyOption(event);
      if (!deny) return;
      void this.#client
        .request("permission_respond", { ...this.#target(), requestId, optionId: deny.optionId })
        .catch(() => undefined);
    }, this.#permissionTimeoutMs);
    this.#permissionTimers.set(requestId, timer);
  }

  /** 消费方主动应答权限：取消该请求的 fail-closed 计时。 */
  async respondPermission(requestId: string, optionId: string): Promise<{ accepted: boolean }> {
    const timer = this.#permissionTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.#permissionTimers.delete(requestId);
    }
    const result = (await this.#client.request("permission_respond", {
      ...this.#target(),
      requestId,
      optionId,
    })) as { accepted: boolean };
    return result;
  }

  /** 阻塞取 TurnResult（服务端 run：send + 等待 turn 终态）。 */
  async run(text: string, options: SessionRunOptions = {}): Promise<RunResult> {
    // 权限 fail-closed 计时器依赖事件流（permission_requested 事件到达才起表）；
    // run 本就要等终态，先确保订阅——服务端终态等待走 run 自身轮询，不受影响。
    await this.#ensureSubscription().catch(() => undefined);
    return (await this.#client.request("run", {
      ...this.#target(),
      content: text,
      ...(options.model ? { model: options.model } : {}),
      ...(options.toolDenylist ? { toolDenylist: options.toolDenylist } : {}),
    })) as RunResult;
  }

  /** 只发送不等待终态（事件流自行消费 TurnDone）。 */
  async send(
    text: string,
    options: SessionRunOptions = {},
  ): Promise<{ accepted: boolean; revision?: number }> {
    // M2：send-only 场景同样先确保订阅——此前只有 run()/events() 建订阅，
    // 纯 send 的消费方永远收不到 permission_requested（fail-closed 计时器无法起表，
    // turn 挂死到引擎超时）。与 run() 同款 best-effort：订阅失败不阻断发送本身。
    await this.#ensureSubscription().catch(() => undefined);
    return (await this.#client.request("send_message", {
      ...this.#target(),
      content: text,
      ...(options.model ? { model: options.model } : {}),
      ...(options.toolDenylist ? { toolDenylist: options.toolDenylist } : {}),
    })) as { accepted: boolean; revision?: number };
  }

  async cancelTurn(): Promise<{ cancelled: boolean }> {
    return (await this.#client.request("cancel_turn", this.#target())) as { cancelled: boolean };
  }

  /**
   * 事件迭代器（含 seq）。首次调用建立 subscribe_events 订阅；
   * 之后的帧实时推入队列。未知枚举值事件以 kind:"unknown" 产出（不抛）。
   * M3(2)：消费方 break/return 或 session.close() 后，队列条目从 #eventQueues
   * 真移除（此前闭包只置 finished 标志、数组永不收缩——多次 events 后线性泄漏）。
   * 手写 AsyncIterableIterator（不用生成器）：未启动的生成器调用 return() 不执行
   * finally，队列条目会残留——显式迭代器的 return() 路径完全可控。
   */
  events(): AsyncIterableIterator<{ seq: number; event: HarnessEvent }> {
    void this.#ensureSubscription();
    const entry: EventQueueEntry = { queue: [], wakeup: undefined, finished: false };
    this.#eventQueues.push(entry);
    const removeEntry = (): void => {
      const index = this.#eventQueues.indexOf(entry);
      if (index !== -1) this.#eventQueues.splice(index, 1);
    };
    const iterator: AsyncIterableIterator<{ seq: number; event: HarnessEvent }> = {
      async next() {
        while (entry.queue.length === 0) {
          if (entry.finished) return { done: true as const, value: undefined };
          await new Promise<void>((resolve) => {
            entry.wakeup = resolve;
          });
        }
        return {
          done: false as const,
          value: entry.queue.shift() as { seq: number; event: HarnessEvent },
        };
      },
      // 消费方 break（for await 退出）或显式 return()：停止接收后续帧并真移除条目。
      async return() {
        entry.finished = true;
        entry.wakeup = undefined;
        entry.queue.length = 0;
        removeEntry();
        return { done: true as const, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  }

  /**
   * M3(1)：会话生命周期收口——移除连接级监听器、结束全部 events() 迭代器、
   * 清权限计时器并 best-effort 退订。client.close() 会对所有登记的 session 统一执行。
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeConnectionListener?.();
    this.#removeConnectionListener = undefined;
    for (const entry of this.#eventQueues.splice(0)) {
      entry.finished = true;
      entry.queue.length = 0;
      entry.wakeup?.();
    }
    for (const timer of this.#permissionTimers.values()) clearTimeout(timer);
    this.#permissionTimers.clear();
    if (this.#subscriptionId) {
      const subscriptionId = this.#subscriptionId;
      this.#subscriptionId = undefined;
      this.#subscriptionPromise = undefined;
      await this.#client.request("unsubscribe_events", { subscriptionId }).catch(() => undefined);
    }
    this.#client.unregisterSession(this);
  }

  async #ensureSubscription(): Promise<string> {
    this.#subscriptionPromise ??= (async () => {
      const result = (await this.#client.request("subscribe_events", this.#target())) as {
        subscriptionId: string;
        lastSeq?: number;
      };
      this.#subscriptionId = result.subscriptionId;
      return result.subscriptionId;
    })();
    return this.#subscriptionPromise;
  }

  /**
   * 会话级工具控制。v1：disable/custom 经 configure_tools 方法发往服务端，
   * 服务端如实返回 not_supported 错误（services 层无 create 后动态配置面）；
   * 错误以 HarnessRpcError 抛出，消费方可按 code 分支。可用替代：
   * createSession({ toolDenylist }) 在创建时禁用。
   */
  async configureTools(
    input: ConfigureToolsInput,
  ): Promise<{ applied: boolean; disabled: string[]; customRegistered: string[] }> {
    const result = await this.#client.request("configure_tools", {
      ...this.#target(),
      ...(input.disable ? { disable: input.disable } : {}),
      ...(input.custom
        ? {
            custom: input.custom.map((tool) => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              ...(tool.schema ? { schema: tool.schema } : {}),
            })),
          }
        : {}),
    });
    return result as { applied: boolean; disabled: string[]; customRegistered: string[] };
  }

  /** 会话 rewind：v1 服务端返回 not_supported（HarnessRpcError），方法面保留。 */
  async rewind(
    target?: { kind: "turn"; turnIndex: number } | { kind: "message"; messageId: string },
  ): Promise<{ rewound: boolean }> {
    return (await this.#client.request("rewind_session", {
      ...this.#target(),
      ...(target ? { target } : {}),
    })) as { rewound: boolean };
  }

  /** 从当前会话分叉出新会话。 */
  async fork(): Promise<HarnessSession> {
    const result = (await this.#client.request("fork_session", this.#target())) as {
      sessionId: string;
    };
    return new HarnessSession(this.#client, {
      sessionId: result.sessionId,
      workspacePath: this.#workspacePath,
      workspaceIdentity: this.#workspaceIdentity,
      permissionTimeoutMs: this.#permissionTimeoutMs,
    });
  }

  async setModel(model: HarnessModelSelection): Promise<void> {
    await this.#client.request("set_model", { ...this.#target(), model });
  }

  async compact(instructions?: string): Promise<void> {
    await this.#client.request("compact", {
      ...this.#target(),
      ...(instructions ? { instructions } : {}),
    });
  }

  /**
   * 结构化输出：JSON schema（zod）校验模型回复，违例自动带错误反馈重试
   * （封顶 SDK_STRUCTURED_RETRY_MAX 次）；连续违例抛 HarnessStructuredOutputError
   * （含每次原始输出摘要）。
   */
  async ask<T extends z.ZodType>(schema: T, prompt: string): Promise<z.infer<T>> {
    const attempts: { output: string; issue: string }[] = [];
    const instruction = [
      prompt,
      "",
      "Respond with a single JSON object only (no markdown fence, no prose) that validates against this requirement:",
      JSON.stringify(describeZodSchema(schema)),
    ].join("\n");
    for (let attempt = 0; attempt <= SDK_STRUCTURED_RETRY_MAX; attempt += 1) {
      const suffix =
        attempt === 0
          ? ""
          : `\n\nYour previous reply was invalid (${attempts[attempts.length - 1]?.issue}). Reply again with a corrected single JSON object.`;
      const result = await this.run(instruction + suffix);
      const output = result.response ?? "";
      const parsed = parseJsonOutput(output);
      if (parsed.ok) {
        const validated = schema.safeParse(parsed.value);
        if (validated.success) {
          return validated.data as z.infer<T>;
        }
        attempts.push({ output, issue: `schema validation failed: ${validated.error.message}` });
      } else {
        attempts.push({ output, issue: parsed.issue });
      }
    }
    throw new HarnessStructuredOutputError(attempts);
  }

  async detach(): Promise<void> {
    if (this.#subscriptionId) {
      await this.#client
        .request("unsubscribe_events", { subscriptionId: this.#subscriptionId })
        .catch(() => undefined);
      this.#subscriptionId = undefined;
      this.#subscriptionPromise = undefined;
    }
    await this.#client.request("detach_session", this.#target());
  }
}

export { HarnessRpcError };
