// ============================================================
// 插件 hook 中间件（一期最小洋葱）辅助件
// specs/plugin-hook-middleware.md：事件冻结纯值、next(e') 改写校验、
// misuse 错误构造。链执行本体在 runner.ts。
// ============================================================
import { CoreErrorType, createCoreError, type HookInput } from "@acode/contracts";
import type { HookRunResult } from "./types.js";

/**
 * misuse 标记：next 使用纪律违例（double-next / dispatch 结束后调用 / 改写身份字段 /
 * e' 形状非法）。经 CoreError.context.refusalKind 供失败可见性侧解析为闭集原因
 * `hook_middleware_misuse`（hook-refusal-visibility.ts）。misuse 是 middleware 自身
 * 的失败——按既有失败语义 fail-open 放行，绝不阻断业务动作。
 */
export function createHookMiddlewareMisuseError(message: string): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    context: { refusalKind: "middleware_misuse" },
    recoverable: true,
  });
}

/** 身份字段：链上不可改写（触发点按 hookEventName 校验输出、按会话三元组关联事件）。 */
const IDENTITY_FIELDS = ["hookEventName", "sessionId", "traceId", "turnId"] as const;

/** 必备基础字段（BaseHookInput）：改写后的事件必须在场，否则下游投影/stdin 不完整。 */
const REQUIRED_BASE_FIELDS = ["cwd", "mode", "timestamp"] as const;

/**
 * 事件对象冻结纯值（一期 = 顶层浅冻结副本）：middleware 收到的事件与 next(e') 之后
 * 下游收到的事件都是冻结对象，链上任何环节都不能就地改写事件。深层冻结会波及
 * runtime 持有的嵌套结构（如 toolInput 引用），登记二期（spec R1）。
 */
export function freezeHookEvent(event: HookInput): HookInput {
  return Object.freeze({ ...event }) as HookInput;
}

/**
 * 校验 next(e') 的改写事件：必须是普通对象、身份字段与原事件一致、必备基础字段在场。
 * 通过则返回「身份字段钉死为原值」的冻结副本；违例抛 misuse（由 runner 的环节
 * try/catch 收敛为 HookRunFailed + fail-open）。
 */
export function validateHookEventRewrite(original: HookInput, rewrite: unknown): HookInput {
  if (typeof rewrite !== "object" || rewrite === null || Array.isArray(rewrite)) {
    throw createHookMiddlewareMisuseError("Hook middleware next(e) requires a plain event object");
  }
  if (Object.getPrototypeOf(rewrite) !== Object.prototype) {
    throw createHookMiddlewareMisuseError("Hook middleware next(e) rejects non-plain objects");
  }
  const candidate = rewrite as Record<string, unknown>;
  for (const field of IDENTITY_FIELDS) {
    if (field in candidate && candidate[field] !== original[field]) {
      throw createHookMiddlewareMisuseError(
        `Hook middleware next(e) must not rewrite identity field "${field}"`,
      );
    }
  }
  for (const field of REQUIRED_BASE_FIELDS) {
    if (candidate[field] === undefined) {
      throw createHookMiddlewareMisuseError(
        `Hook middleware next(e) is missing required field "${field}"`,
      );
    }
  }
  // 身份字段以原值钉死（即使 e' 未携带），其余字段以改写为准——下游所见即 e'。
  // HookInput 是按 hookEventName 判别的联合：运行时已钉死判别字段并核验基础字段，
  // 静态形状经由 unknown 收敛（改写面的类型安全由本校验函数承担）。
  return freezeHookEvent({
    ...candidate,
    hookEventName: original.hookEventName,
    sessionId: original.sessionId,
    traceId: original.traceId,
    ...(original.turnId !== undefined ? { turnId: original.turnId } : {}),
  } as unknown as HookInput);
}

/**
 * 每个 middleware 环节一份的 next 状态机：至多调用一次；只许在自己的 dispatch 期间
 * 发起（callback 返回后再调 = misuse）；返回在飞的下游链 Promise 供 runner 在环节
 * 结算时兜底 await（未 await 的 next 也要让链跑完，生命周期事件完整）。
 */
export interface HookMiddlewareNextState {
  /** 下游链是否在飞/已完成（next 已被调用）。 */
  called: boolean;
  /** dispatch 是否已结束（callback 已返回或已抛错）。 */
  dispatchSettled: boolean;
  /** 下游链的执行 Promise（仅 called 后有值）。 */
  downstream?: Promise<void>;
  /** 下游合并结果（下游链跑完后可读；middleware 失败时也照常并入，见 spec 一.3）。 */
  downstreamResult?: HookRunResult;
}

export function createMiddlewareNextState(): HookMiddlewareNextState {
  return { called: false, dispatchSettled: false };
}
