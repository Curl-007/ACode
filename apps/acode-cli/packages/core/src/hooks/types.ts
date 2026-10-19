import type {
  ExecutionPort,
  HookEventName,
  HookExecutionDescriptor,
  HookInput,
  HookJSONOutput,
  HookPermissionDecision,
  HookSourceKind,
  HooksRuntimeConfig,
  WorkspaceHookBundleSnapshot,
  Logger,
  PermissionRequestHookDecision,
  SessionEvent,
} from "@acode/contracts";

import type { WorkspaceHookRuntimeAdmissionPort } from "./workspace-hook-runtime-admission.js";

export interface HookCallbackContext {
  hookIndex: number;
  signal?: AbortSignal;
  /**
   * 中间件专用（specs/plugin-hook-middleware.md 一期最小洋葱）：继续链执行并返回
   * 下游合并结果；可选传入改写后的事件（身份字段不可变，下游看到 e'）。
   * 不调用即自答（短路：本环节之后的链内 hook 全部跳过）。
   * legacy（非 middleware）注册的 callback 不会收到本字段。
   */
  next?: HookMiddlewareNext;
}

/**
 * 中间件的链续行函数。`next()` = 以当前事件继续；`next(e')` = 改写下游所见。
 * 纪律：至多调用一次，且只许在自己的 dispatch 期间发起；违例按
 * `hook_middleware_misuse` 失败处理（fail-open 放行 + 失败可见性注记）。
 */
export type HookMiddlewareNext = (event?: HookInput) => Promise<HookRunResult>;

/**
 * 配置 Hook 的执行器可以附带 stderr 等诊断；这些信息只进入生命周期事件，
 * 不参与 Hook 决策，也不会作为 Hook JSON 输出暴露给模型。
 */
export interface HookCallbackDiagnostics {
  errorMessage?: string;
  stderrPreview?: string;
  stdoutPreview?: string;
}

export interface HookCallbackResult {
  kind: "hookCallbackResult";
  diagnostics?: HookCallbackDiagnostics;
  output?: HookJSONOutput;
}

export type HookCallback = (
  input: HookInput,
  context: HookCallbackContext,
) =>
  | HookJSONOutput
  | HookCallbackResult
  | void
  | Promise<HookJSONOutput | HookCallbackResult | void>;

export interface HookRunAdmissionDecision {
  allowed: boolean;
  reasonCode?: string;
  skipLifecycle?: boolean;
}

export interface HookRegistration {
  admission?: (input: HookInput) => HookRunAdmissionDecision;
  async?: boolean;
  callback: HookCallback;
  descriptor?: HookExecutionDescriptor | ((input: HookInput) => HookExecutionDescriptor);
  event: HookEventName;
  matcher?: string;
  /**
   * 一期最小洋葱（specs/plugin-hook-middleware.md）：声明后 callback 才会收到
   * context.next（不调 next = 自答短路；next(e') = 改写下游所见）。仅程序化注册
   * 可声明；配置面外部进程 hook 永不带本标志。与 `async:true` 互斥——async 胜出
   * （后台派发脱离链），本标志被忽略并记 debug 行。
   */
  middleware?: boolean;
  source?: string;
  sourceKind?: HookSourceKind;
  timeoutMs?: number;
}

export interface HookRunOptions {
  matchValue?: string;
  matchValues?: readonly string[];
  signal?: AbortSignal;
}

export interface HookRunResult {
  additionalContexts: string[];
  /**
   * 与 additionalContexts 索引对齐的来源 hook 名（防滥用标注，
   * specs/hook-additional-context-hardening.md）。仅在至少一条 context 有已知来源时
   * 存在；无来源条目以 undefined 占位。存在时长度恒与 additionalContexts 一致——
   * 写入点只有 output.ts 的 hardenHookAdditionalContexts（收集）与
   * mergeHookRunResult（合并对齐）两处，格式化层只读。
   */
  additionalContextSources?: (string | undefined)[];
  blockRequested?: boolean;
  hookPermissionDecisionReason?: string;
  permissionBehavior?: HookPermissionDecision;
  permissionRequestResult?: PermissionRequestHookDecision;
  preventContinuation?: boolean;
  stopShouldContinue?: boolean;
  stopReason?: string;
  updatedInput?: unknown;
}

export interface HookRunner {
  run(input: HookInput, options?: HookRunOptions): Promise<HookRunResult>;
}

export interface HookRunnerOptions {
  defaultTimeoutMs?: number;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  hooks?: HookRegistration[];
  logger?: Logger;
}

export interface ConfiguredHookRunnerOptions {
  config: HooksRuntimeConfig;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  executionPort: ExecutionPort;
  getWorkingDirectory: () => string;
  logger?: Logger;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
}
