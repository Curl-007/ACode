import {
  PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS,
  type ProviderDiagnosticsCancelResult,
  type ProviderDiagnosticsReasonCode,
  type ProviderDiagnosticsRequest,
  type ProviderDiagnosticsResult,
} from "@acode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";

/**
 * U08 Provider 诊断的服务侧编排器（纯逻辑，无 I/O）。
 * 规格 packages/services/specs/provider-diagnostics.md（R2/R3/R4/R5）。
 *
 * 三条服务不变量：
 * 1. 单次执行（R3）：相同 (providerId, revision, modelId, tier) 的并行请求收敛到一次 RPC；
 *    双击/重试只跑一遍，每个调用方拿到盖自己 requestId 的同一终态。
 * 2. 取消路由（R4）：cancel(requestId) 只下发给该 requestId 所属的那一次执行，不波及同
 *    provider 的其它请求；取消不承诺退费。
 * 3. revision 回显校验（R2）：执行方回显的 revision 与请求不一致即契约违约，本地改判
 *    revision-mismatch 失败，绝不让它冒充对当前配置的结论。
 *
 * 真正的诊断执行（含 offline 零网络三重强制）在 CLI 侧 adapters/doctor；本编排器只经注入的
 * rpc 端口调用它，因此可脱离进程用 fake rpc 完整测试（U08-A1/A3/A4）。
 */

/** 跨 RPC 的执行端口。node.ts 装配时接到 acodeAgentService。 */
export interface ProviderDiagnosticsRpcPort {
  run(request: ProviderDiagnosticsRequest): Promise<ProviderDiagnosticsResult>;
  cancel(requestId: string): Promise<ProviderDiagnosticsCancelResult>;
}

export interface ProviderDiagnosticsExecutor {
  run(request: ProviderDiagnosticsRequest): Promise<ProviderDiagnosticsResult>;
  cancel(requestId: string): Promise<ProviderDiagnosticsCancelResult>;
  /** 当前在飞的执行数（去重后，不是请求数）。 */
  readonly inflightCount: number;
}

/** 一次在飞执行的登记项。 */
interface InflightExecution {
  readonly key: string;
  /**
   * 真正发往 CLI 的 requestId。合并进来的后续请求从未被 CLI 见过，因此取消必须路由到
   * 这个主 requestId，否则 CLI 回 cancelled:false 而实际执行仍在飞（R4 的正确性依赖此）。
   */
  readonly primaryRequestId: string;
  readonly requestIds: Set<string>;
  readonly promise: Promise<ProviderDiagnosticsResult>;
}

/** 去重键分隔符：刻意用不可见控制字符，避免 id 里出现同样字符时两个不同请求碰撞。 */
const KEY_SEPARATOR = String.fromCharCode(31);

/** acodeAgentService 在「没有 agent 进程可承载诊断」时抛的稳定 code（结构化识别，不匹配文本）。 */
export const PROVIDER_DIAGNOSTICS_NO_AGENT_RUNTIME_CODE = "provider-diagnostics-no-agent-runtime";

/** 全 skipped 的占位检查点：终态失败（执行方没给报告）时用，保证 DTO 的 12 点契约不破。 */
function placeholderCheckpoints(reasonCode: ProviderDiagnosticsReasonCode) {
  return PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS.map((id) => ({
    id,
    status: "skipped" as const,
    reasonCode,
  }));
}

/**
 * 执行去重键（R3）。modelId 缺席按空串参与，使「未指定模型」与「指定某模型」不互相合并；
 * providerId/modelId 原样参与（不做大小写折叠——与 Registry 事实同源，折叠会误合并两个 id）。
 */
export function providerDiagnosticsExecutionKey(request: ProviderDiagnosticsRequest): string {
  const parts = [request.providerId, String(request.revision), request.modelId ?? "", request.tier];
  return parts.join(KEY_SEPARATOR);
}

/**
 * 把执行方回传的 DTO 重新盖章成本调用方的 requestId，并校验 revision（R2）。
 *
 * 合并进来的请求共享同一次执行，但各自的 requestId 不同——回包必须盖调用方自己的
 * requestId，否则 UI 的 requestId 匹配失效，结果会被当成别的请求的。
 */
function stampResultForRequest(
  request: ProviderDiagnosticsRequest,
  executed: ProviderDiagnosticsResult,
): ProviderDiagnosticsResult {
  // 执行方必须逐字回显请求时的 revision（契约叶子 superRefine 已保证字段存在，这里保证值
  // 一致）。不一致 = 执行方把结果跑在了别的配置上，绝不能当成对当前配置的结论。
  if (executed.revision !== request.revision) {
    return buildTerminalFailure({
      request,
      errorCode: "revision-mismatch",
      startedAt: executed.startedAt,
      finishedAt: executed.finishedAt,
    });
  }
  return { ...executed, requestId: request.requestId };
}

/**
 * 构造一份「没有 Doctor 报告」的终态失败 DTO。
 *
 * spend 刻意缺席（R4）：没跑起来 / 跑挂了 / 被取消时，花费事实是**未知**，不是 0。
 * 填 0 等于向用户承诺「没花钱」，而 live 档可能已经发出过计费请求。
 */
export function buildTerminalFailure(input: {  readonly request: ProviderDiagnosticsRequest;
  readonly errorCode: ProviderDiagnosticsReasonCode;
  readonly startedAt: string;
  readonly finishedAt: string;
}): ProviderDiagnosticsResult {
  return {
    requestId: input.request.requestId,
    providerId: input.request.providerId,
    revision: input.request.revision,
    tier: input.request.tier,
    status: input.errorCode === "cancelled" ? "cancelled" : "failed",
    errorCode: input.errorCode,
    checkpoints: placeholderCheckpoints(input.errorCode),
    // 没有 agent 进程时「重试」也没用（还是没进程），只给「稍后验证」的出口，
    // 对齐提案 §3.6「失败不清空已保存 provider；可保持已保存、未验证并稍后诊断」。
    remediationActions:
      input.errorCode === "no-agent-runtime"
        ? ["verify-later"]
        : ["retry-diagnostics", "verify-later"],
    nextStepCommands: [],
    blockedNetworkCalls: 0,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
}

export interface CreateProviderDiagnosticsExecutorOptions {
  readonly rpc: ProviderDiagnosticsRpcPort;
  readonly now?: () => string;
}

/**
 * 创建服务侧诊断编排器。所有者是 IProviderSettingsService（经 node.ts 装配）；
 * UI 不直接持有本对象，避免形成第二条写入/取消路径。
 */
export function createProviderDiagnosticsExecutor(
  options: CreateProviderDiagnosticsExecutorOptions,
): ProviderDiagnosticsExecutor {
  const log = createServiceLogger("provider-diagnostics");
  const now = options.now ?? ((): string => new Date().toISOString());
  const inflight = new Map<string, InflightExecution>();
  /** requestId → 所属执行，用于把取消精确路由到那一次执行（R4）。 */
  const executionByRequestId = new Map<string, InflightExecution>();

  const release = (execution: InflightExecution): void => {
    if (inflight.get(execution.key) === execution) inflight.delete(execution.key);
    for (const requestId of execution.requestIds) {
      if (executionByRequestId.get(requestId) === execution) {
        executionByRequestId.delete(requestId);
      }
    }
  };

  return {
    get inflightCount() {
      return inflight.size;
    },

    async run(request: ProviderDiagnosticsRequest): Promise<ProviderDiagnosticsResult> {
      // R9 live 授权门禁：tier=live 会真实计费，必须显式 opt-in。缺 opt-in 直接返回终态失败，
      // **零** RPC、零模型调用——授权只对本次、该档位生效，不落盘、不复用。
      if (request.tier === "live" && request.liveOptIn !== true) {
        const at = now();
        return buildTerminalFailure({
          request,
          errorCode: "live-opt-in-required",
          startedAt: at,
          finishedAt: at,
        });
      }

      const key = providerDiagnosticsExecutionKey(request);
      const existing = inflight.get(key);
      if (existing) {
        // R3 单次执行：同键并行请求合并到已在飞的那一次，不再发第二个 RPC。
        // 登记 requestId 才能让它后续的 cancel 也路由到同一次执行。
        existing.requestIds.add(request.requestId);
        executionByRequestId.set(request.requestId, existing);
        const executed = await existing.promise;
        return stampResultForRequest(request, executed);
      }

      const startedAt = now();
      // 主 requestId 决定这次执行在 CLI 侧的身份；取消一律按它路由。
      const primaryRequestId = request.requestId;
      const requestIds = new Set<string>([primaryRequestId]);
      let settle: (value: ProviderDiagnosticsResult) => void = () => {};
      const promise = new Promise<ProviderDiagnosticsResult>((resolve) => {
        settle = resolve;
      });
      const execution: InflightExecution = { key, primaryRequestId, requestIds, promise };
      inflight.set(key, execution);
      executionByRequestId.set(primaryRequestId, execution);

      // 执行失败不向上抛：诊断失败 != 保存失败（提案非目标），UI 需要的是结构化终态。
      try {
        const executed = await options.rpc.run({ ...request, requestId: primaryRequestId });
        const stamped = stampResultForRequest({ ...request, requestId: primaryRequestId }, executed);
        settle(stamped);
        return stamped;
      } catch (error) {
        // 取消在跨 RPC 边界常表现为 reject（AbortError），归一成 cancelled 终态而非失败：
        // 用户主动取消不是错误，把它报成失败会误导（R4）。
        const errorCode = classifyExecutionError(error);
        // 日志分级（AGENTS.md）：用户主动取消是正常终态，不记日志（避免首配路径刷屏）；
        // 无 agent 运行时在首次配置是**预期状态**而非可恢复异常，记 info；
        // revision-mismatch（执行方违约）与 execution-failed（真实异常）记 warn。
        // 日志只带稳定码与 provider/revision 标识，绝不带 detail 或任何凭据形态（R8）。
        const logContext = {
          errorCode,
          providerId: request.providerId,
          requestId: primaryRequestId,
          revision: request.revision,
          tier: request.tier,
        };
        if (errorCode === "no-agent-runtime") {
          log.info(undefined, "provider 诊断无可用的 agent 运行时，返回稍后验证", logContext);
        } else if (errorCode !== "cancelled") {
          log.warn(undefined, "provider 诊断执行失败", logContext);
        }
        const failed = buildTerminalFailure({
          request: { ...request, requestId: primaryRequestId },
          errorCode,
          startedAt,
          finishedAt: now(),
        });
        settle(failed);
        return failed;
      } finally {
        release(execution);
      }
    },

    async cancel(requestId: string): Promise<ProviderDiagnosticsCancelResult> {
      const execution = executionByRequestId.get(requestId);
      if (!execution) {
        // 不在飞（已完成/未知）不是错误：调用方语义 = 丢弃回包，由 revision fencing 兜底（R4）。
        return { requestId, cancelled: false };
      }
      // 路由到主 requestId：合并进来的请求 CLI 侧根本不认识（见 InflightExecution 注释）。
      return options.rpc.cancel(execution.primaryRequestId);
    },
  };
}

/**
 * 把执行异常归一成稳定错误码（结构化识别，不匹配错误文本——根 AGENTS.md）。
 *
 * `no-agent-runtime`：首次配置发生在 WelcomeScreen，此时可能没有任何 workspace 被打开，
 * 因此没有 agent 进程可承载诊断（spec「无 workspace 的首次配置」段）。这种情形必须**零**
 * 网络/DNS/模型调用（U08-A1），并给用户「稍后在设置中验证」的出口。
 */
function classifyExecutionError(error: unknown): ProviderDiagnosticsReasonCode {
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === PROVIDER_DIAGNOSTICS_NO_AGENT_RUNTIME_CODE) return "no-agent-runtime";
  }
  return "execution-failed";
}
