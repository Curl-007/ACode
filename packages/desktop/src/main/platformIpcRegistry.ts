import { BrowserWindow, ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import type { PlatformChannelMap } from "@acode/shared";
import { isTrustedRendererSenderFrame, type SenderFrameLike } from "./rendererFrameTrust.js";
import { deriveIpcSyncLabel, wrapIpcHandle } from "./ipcSyncTiming.js";

/**
 * 桌面平台 IPC 注册工厂（specs/ipc-registration-factory.md，T1-15）。
 *
 * 注册即声明：通道名受 PlatformChannelMap 类型约束（shared 通道词表是唯一来源，
 * 本模块只读引用）；非 void 载荷通道必须声明运行时校验器；sender 门控策略必填
 * （无隐式缺省）。重复注册幂等替换（Electron 原生 handle 重复注册抛错 / on 静默
 * 叠加监听器，两种事故形态都被替换语义收口）。同步段计时（W1-6）在工厂内部统一
 * 接线，注册处不再手写 wrapIpcHandle。
 *
 * 单一所有者纪律：
 * - 「哪个注册在通道上活跃」的唯一事实来源 = 本模块级 activeRegistrations；
 * - 帧受信判定复用 rendererFrameTrust（顶层帧 + 本地 origin），不复制逻辑；
 * - 载荷校验 schema / 自定义 sender predicate 归各域 registrar 所有。
 */

/** 可注册通道 = shared 平台通道映射表的键（字符串字面量闭集）。 */
export type PlatformIpcChannel = keyof PlatformChannelMap & string;

type ChannelRequest<C extends PlatformIpcChannel> = PlatformChannelMap[C]["request"];
type ChannelResponse<C extends PlatformIpcChannel> = PlatformChannelMap[C]["response"];

/**
 * 结构化校验器接口：zod schema（safeParse）天然满足，工厂不绑定 zod 具体实现。
 * 失败分支的 error 只用于日志摘要（issue code/path），原始载荷值不落日志。
 */
export interface PlatformIpcValidator<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error?: unknown };
}

/** sender 门控可用的事件面（invoke 与 send 两种事件的公共结构）。 */
export type PlatformIpcSenderEvent = IpcMainInvokeEvent | IpcMainEvent;

/**
 * sender 门控策略（闭集 + 显式扩展点）：
 * - `"app-renderer"`：受信顶层帧（rendererFrameTrust）+ BrowserWindow.fromWebContents
 *   身份解析出未销毁窗口。标准应用 renderer 面用这档。
 * - `"trusted-frame"`：只要求受信顶层帧，不要求解析出窗口（无窗辅助面；注册处必须
 *   注释说明理由）。
 * - `{ predicate }`：自定义门控（如资源管理器窗口比对）。返回 true 放行；返回字符串
 *   = 拒绝原因（仅进 main 日志，且必须匹配 ^[a-z0-9_]{1,64}$，否则按 custom_denied
 *   收敛——日志不回显任意字符串）；抛错按拒绝处理（fail-closed）。
 */
export type PlatformIpcSenderPolicy =
  | "app-renderer"
  | "trusted-frame"
  | { readonly predicate: (event: PlatformIpcSenderEvent) => true | string };

/** handler 上下文：原始事件 + sender 门控解析出的窗口（未解析时为 null）。 */
export interface PlatformIpcContext {
  readonly event: PlatformIpcSenderEvent;
  readonly window: BrowserWindow | null;
}

/** renderer 可见错误码闭集（spec R4）；拒绝原因细节只进 main 日志。 */
export type PlatformIpcErrorCode = "invalid_payload" | "invalid_response" | "forbidden";

export class PlatformIpcError extends Error {
  readonly code: PlatformIpcErrorCode;
  readonly channel: string;
  /** 拒绝原因词（main 日志侧诊断用；不进 renderer 可见 message）。 */
  readonly reason?: string;

  constructor(code: PlatformIpcErrorCode, channel: string, reason?: string) {
    super(`[platform-ipc] ${code}: ${channel}`);
    this.name = "PlatformIpcError";
    this.code = code;
    this.channel = channel;
    if (reason !== undefined) this.reason = reason;
  }
}

export interface PlatformIpcLogger {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/** request 为 void 的通道可省略 validate；非 void 通道类型层强制声明（spec R1.2）。 */
type ValidateRequirement<C extends PlatformIpcChannel> = [ChannelRequest<C>] extends [void]
  ? { readonly validate?: PlatformIpcValidator<ChannelRequest<C>> }
  : { readonly validate: PlatformIpcValidator<ChannelRequest<C>> };

export interface PlatformIpcHandleRegistrationBase<C extends PlatformIpcChannel> {
  readonly sender: PlatformIpcSenderPolicy;
  /** 可选返回值校验：声明后 fail-closed（脏返回按 invalid_response reject）。 */
  readonly validateResponse?: PlatformIpcValidator<ChannelResponse<C>>;
  /**
   * 载荷校验失败时的信封应答（保留存量 {success:false,error:"invalid_payload"} 类
   * renderer 契约）。只覆盖 invalid_payload；sender 拒绝永远 reject，不可被覆盖。
   */
  readonly onInvalidPayload?: (context: PlatformIpcContext) => ChannelResponse<C>;
  readonly handler: (
    context: PlatformIpcContext,
    payload: ChannelRequest<C>,
  ) => ChannelResponse<C> | Promise<ChannelResponse<C>>;
}

export type PlatformIpcHandleRegistration<C extends PlatformIpcChannel> =
  PlatformIpcHandleRegistrationBase<C> & ValidateRequirement<C>;

export interface PlatformIpcOnRegistrationBase<C extends PlatformIpcChannel> {
  readonly sender: PlatformIpcSenderPolicy;
  readonly handler: (context: PlatformIpcContext, payload: ChannelRequest<C>) => void;
}

export type PlatformIpcOnRegistration<C extends PlatformIpcChannel> =
  PlatformIpcOnRegistrationBase<C> & ValidateRequirement<C>;

export interface PlatformIpcRegistry {
  /** 注册 invoke 型通道（ipcMain.handle）；重复注册幂等替换。 */
  handle<C extends PlatformIpcChannel>(channel: C, registration: PlatformIpcHandleRegistration<C>): void;
  /** 注册 send-only 通道（ipcMain.on）；重复注册幂等替换；失败一律丢弃 + warn。 */
  on<C extends PlatformIpcChannel>(channel: C, registration: PlatformIpcOnRegistration<C>): void;
  /** 摘除本 registry 实例名下仍活跃的全部注册（域关闭 / 测试复位）。 */
  dispose(): void;
}

/** on 通道监听器的存储面；handle 通道仅记账用（removeHandler 不需要引用）。 */
type StoredListener = (event: IpcMainEvent, payload: unknown) => void;

interface ActiveRegistration {
  readonly kind: "handle" | "on";
  readonly listener: StoredListener;
  /** registry 实例令牌：dispose 只摘自己名下仍活跃的注册。 */
  readonly owner: object;
}

/** 「哪个注册在通道上活跃」的唯一事实来源（spec R3）。 */
const activeRegistrations = new Map<string, ActiveRegistration>();

/** 仅供测试复位模块级注册台账；生产代码不得调用。 */
export function resetPlatformIpcRegistryForTest(): void {
  activeRegistrations.clear();
}

/** 自定义 predicate 拒绝原因的日志白名单（spec R2：不回显任意字符串）。 */
const CUSTOM_DENY_REASON_PATTERN = /^[a-z0-9_]{1,64}$/;

interface SenderAllowed {
  readonly ok: true;
  readonly window: BrowserWindow | null;
}
interface SenderDenied {
  readonly ok: false;
  readonly reason: string;
}
type SenderEvaluation = SenderAllowed | SenderDenied;

function resolveSenderWindow(event: PlatformIpcSenderEvent): BrowserWindow | null {
  try {
    const sender = event.sender as WebContents | null | undefined;
    if (!sender || sender.isDestroyed()) return null;
    const resolved = BrowserWindow.fromWebContents(sender);
    return resolved && !resolved.isDestroyed() ? resolved : null;
  } catch {
    // 帧/窗口对象在竞态销毁窗口期访问会抛错：按解析失败处理（fail-closed）。
    return null;
  }
}

function evaluateSender(
  policy: PlatformIpcSenderPolicy,
  event: PlatformIpcSenderEvent,
): SenderEvaluation {
  if (typeof policy === "object") {
    let verdict: true | string;
    try {
      verdict = policy.predicate(event);
    } catch {
      return { ok: false, reason: "predicate_error" };
    }
    if (verdict === true) return { ok: true, window: resolveSenderWindow(event) };
    return {
      ok: false,
      reason:
        typeof verdict === "string" && CUSTOM_DENY_REASON_PATTERN.test(verdict)
          ? verdict
          : "custom_denied",
    };
  }
  const frame = (event.senderFrame ?? null) as SenderFrameLike | null;
  if (!frame) return { ok: false, reason: "no_sender_frame" };
  if (!isTrustedRendererSenderFrame(frame)) return { ok: false, reason: "untrusted_frame" };
  const window = resolveSenderWindow(event);
  if (policy === "app-renderer" && window === null) return { ok: false, reason: "no_window" };
  return { ok: true, window };
}

function safeSenderId(event: PlatformIpcSenderEvent): number | undefined {
  const id = (event.sender as WebContents | null | undefined)?.id;
  return typeof id === "number" ? id : undefined;
}

interface ValidatorIssueSummary {
  code?: string;
  path?: string;
}

/** 校验失败日志摘要：只取 issue 的 code/path（截断 8 条 / path 120 字符），不落原始值。 */
function summarizeValidatorError(error: unknown): ValidatorIssueSummary[] {
  const issues = (error as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, 8).map((issue) => {
    const record = (issue ?? {}) as { code?: unknown; path?: unknown };
    const summary: ValidatorIssueSummary = {};
    if (typeof record.code === "string") summary.code = record.code;
    if (Array.isArray(record.path)) {
      summary.path = record.path
        .map((segment) => String(segment))
        .join(".")
        .slice(0, 120);
    }
    return summary;
  });
}

function detachRegistration(channel: string, entry: ActiveRegistration): void {
  if (entry.kind === "handle") {
    ipcMain.removeHandler(channel);
  } else {
    ipcMain.removeListener(channel, entry.listener);
  }
  activeRegistrations.delete(channel);
}

export function createPlatformIpcRegistry(options: { logger: PlatformIpcLogger }): PlatformIpcRegistry {
  const logger = options.logger;
  /** 实例令牌：以对象身份区分「同通道上活跃注册是否属于本 registry」。 */
  const owner = {};
  const ownedChannels = new Set<string>();

  function attachHandle(channel: string, listener: (event: IpcMainInvokeEvent, payload: unknown) => unknown): void {
    try {
      ipcMain.handle(channel, listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>);
    } catch {
      // 迁移期通道上可能挂着工厂外的 legacy ipcMain.handle（工厂台账无引用，Electron
      // 对重复 handle 直接抛错）：摘除后重试一次，让工厂注册取代 legacy 注册（spec R3）。
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>);
      logger.warn("[platform-ipc] replaced untracked legacy handler", { channel });
    }
  }

  function attach<C extends PlatformIpcChannel>(
    kind: "handle" | "on",
    channel: C,
    listener: (event: never, payload: unknown) => unknown,
  ): void {
    const existing = activeRegistrations.get(channel);
    if (existing) {
      detachRegistration(channel, existing);
      logger.info?.("[platform-ipc] channel re-registered", {
        channel,
        replaced: existing.kind,
        kind,
      });
    }
    const stored = listener as unknown as StoredListener;
    activeRegistrations.set(channel, { kind, listener: stored, owner });
    ownedChannels.add(channel);
    if (kind === "handle") {
      attachHandle(channel, listener as (event: IpcMainInvokeEvent, payload: unknown) => unknown);
    } else {
      ipcMain.on(channel, stored);
    }
  }

  function warnSenderRejected(channel: string, reason: string, event: PlatformIpcSenderEvent): void {
    logger.warn("[platform-ipc] sender rejected", {
      channel,
      reason,
      webContentsId: safeSenderId(event),
    });
  }

  function warnInvalidPayload(channel: string, error: unknown): void {
    logger.warn("[platform-ipc] invalid payload", { channel, issues: summarizeValidatorError(error) });
  }

  return {
    handle<C extends PlatformIpcChannel>(channel: C, registration: PlatformIpcHandleRegistration<C>): void {
      const { sender, validate, validateResponse, onInvalidPayload, handler } = registration;
      const gated = async (event: IpcMainInvokeEvent, rawPayload: unknown): Promise<unknown> => {
        const evaluation = evaluateSender(sender, event);
        if (!evaluation.ok) {
          warnSenderRejected(channel, evaluation.reason, event);
          throw new PlatformIpcError("forbidden", channel, evaluation.reason);
        }
        const context: PlatformIpcContext = { event, window: evaluation.window };
        let payload = rawPayload as ChannelRequest<C>;
        if (validate) {
          const parsed = validate.safeParse(rawPayload);
          if (!parsed.success) {
            warnInvalidPayload(channel, parsed.error);
            // 信封契约优先于 reject（存量 renderer 行为保留，spec R4）；sender 拒绝不走这里。
            if (onInvalidPayload) return onInvalidPayload(context);
            throw new PlatformIpcError("invalid_payload", channel);
          }
          payload = parsed.data;
        }
        const result = await handler(context, payload);
        if (validateResponse) {
          const parsed = validateResponse.safeParse(result);
          if (!parsed.success) {
            const issues = summarizeValidatorError(parsed.error);
            const report = logger.error ?? logger.warn;
            report.call(logger, "[platform-ipc] invalid response", { channel, issues });
            throw new PlatformIpcError("invalid_response", channel);
          }
          return parsed.data;
        }
        return result;
      };
      // 同步段计时在工厂内统一接线（W1-6 归因面单一所有者，spec R5.3）。
      const listener = wrapIpcHandle(deriveIpcSyncLabel(channel), gated);
      attach<C>("handle", channel, listener as unknown as (event: never, payload: unknown) => unknown);
    },

    on<C extends PlatformIpcChannel>(channel: C, registration: PlatformIpcOnRegistration<C>): void {
      const { sender, validate, handler } = registration;
      const listener = (event: IpcMainEvent, rawPayload: unknown): void => {
        const evaluation = evaluateSender(sender, event);
        if (!evaluation.ok) {
          warnSenderRejected(channel, evaluation.reason, event);
          return;
        }
        const context: PlatformIpcContext = { event, window: evaluation.window };
        let payload = rawPayload as ChannelRequest<C>;
        if (validate) {
          const parsed = validate.safeParse(rawPayload);
          if (!parsed.success) {
            warnInvalidPayload(channel, parsed.error);
            return;
          }
          payload = parsed.data;
        }
        try {
          handler(context, payload);
        } catch (error) {
          // send-only 通道无应答面：handler 异常收敛为 warn，避免升级为 main 进程
          // uncaughtException（此前直接 ipcMain.on 的裸异常路径）。
          logger.warn("[platform-ipc] on-handler failed", {
            channel,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      attach<C>("on", channel, listener as unknown as (event: never, payload: unknown) => unknown);
    },

    dispose(): void {
      // Set 迭代中删除当前项是规范允许的安全操作，无需先拷贝。
      for (const channel of ownedChannels) {
        const entry = activeRegistrations.get(channel);
        if (entry && entry.owner === owner) {
          detachRegistration(channel, entry);
        }
        ownedChannels.delete(channel);
      }
    },
  };
}

/**
 * per-window dispatcher（spec R5.2）拆出为姊妹模块 platformIpcPerWindowDispatcher.ts
 * （max-file-lines 400 行门禁）；API 经本入口 re-export，调用面保持单一入口。
 */
export {
  createPerWindowDispatcher,
  type PerWindowDispatcher,
} from "./platformIpcPerWindowDispatcher.js";
