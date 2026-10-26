import type {
  ProviderDiagnosticsCancelResult,
  ProviderDiagnosticsRequest,
  ProviderDiagnosticsResult,
} from "@acode/shared";
import { ACODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "./acodeAgent.js";
import {
  PROVIDER_DIAGNOSTICS_NO_AGENT_RUNTIME_CODE,
  type ProviderDiagnosticsRpcPort,
} from "../model-provider/providerDiagnosticsExecutor.js";

/**
 * U08 Provider 诊断的 RPC 端口适配（编排器 → acodeAgentService）。
 * 规格 packages/services/specs/provider-diagnostics.md。
 *
 * 形状与既有 `createProviderSettingsConnectivityTester`（providerSettingsConnectivity.ts）同构：
 * 一个薄适配，把「服务接口方法」包成编排器要的 `ProviderDiagnosticsRpcPort`。
 *
 * 职责边界：本模块**不选进程、不找载体、不碰协议方法名**——那些都在 acodeAgentService 里
 * （载体选择、`PROVIDER_DIAGNOSTICS_METHODS`、schema 校验）。这里只做两件事：
 * 1. 转调；
 * 2. 把执行侧异常归一成带稳定 code 的错误对象，好让编排器按**结构化字段**（而非错误文本）
 *    识别「没有可承载诊断的 agent 运行时」（根 AGENTS.md：不依赖错误文本做流程判断）。
 */

/** acodeAgentService 暴露的两个诊断方法（node.ts 用 Pick 注入，同 testModelConnectivity 先例）。 */
export interface ProviderDiagnosticsAgentService {
  runProviderDiagnostics(params: ProviderDiagnosticsRequest): Promise<ProviderDiagnosticsResult>;
  cancelProviderDiagnostics(
    params: ProviderDiagnosticsCancelRequestLike,
  ): Promise<ProviderDiagnosticsCancelResult>;
}

export interface ProviderDiagnosticsCancelRequestLike {
  readonly requestId: string;
}

export interface CreateProviderDiagnosticsRpcOptions {
  readonly agentService: ProviderDiagnosticsAgentService;
}

/**
 * acodeAgentService 在「没有 agent 进程可承载诊断」时抛的稳定 code（`PROVIDER_DIAGNOSTICS_NO_AGENT_RUNTIME_CODE`
 * 从编排器模块导入，避免两处定义漂移）。首次配置发生在 WelcomeScreen，此时可能一个 workspace
 * 都没打开，因此没有活跃 runtime；编排器按这个 code 归一成 `no-agent-runtime` 终态：零网络/DNS/
 * 模型调用（U08-A1），并给用户「稍后在设置中验证」的出口。
 */
export function createProviderDiagnosticsRpcPort(
  options: CreateProviderDiagnosticsRpcOptions,
): ProviderDiagnosticsRpcPort {
  return {
    async run(request) {
      try {
        // acodeAgentService 已在跨进程边界 parse 过；这里是同一份白名单 DTO 的原样转交。
        return await options.agentService.runProviderDiagnostics(request);
      } catch (error) {
        throw normalizeCarrierError(error);
      }
    },

    async cancel(requestId) {
      try {
        return await options.agentService.cancelProviderDiagnostics({ requestId });
      } catch (error) {
        // 取消是 best-effort 控制面（R4）：载体都找不到，说明没有在飞的执行，
        // 归一成 cancelled:false 而不是抛——调用方语义本就是「丢弃回包」。
        if (isNoAgentRuntimeError(error)) return { requestId, cancelled: false };
        throw normalizeCarrierError(error);
      }
    },
  };
}

/** 载体不可用 → 带稳定 code 的错误；其余异常原样上抛（不吞、不改写成字符串）。 */
function normalizeCarrierError(error: unknown): unknown {
  if (isNoAgentRuntimeError(error)) return createNoAgentRuntimeError();
  return error;
}

/**
 * 构造「没有可承载诊断的 agent 运行时」的错误。
 *
 * 带**结构化** code（不靠 message 文本判断，根 AGENTS.md）：编排器据此归一成
 * `no-agent-runtime` 终态——零网络/DNS/模型调用，UI 保持「已保存、尚未验证」。
 */
export function createNoAgentRuntimeError(): Error & { code: string } {
  const error = new Error("no agent runtime available for provider diagnostics") as Error & {
    code: string;
  };
  error.code = PROVIDER_DIAGNOSTICS_NO_AGENT_RUNTIME_CODE;
  return error;
}

function isNoAgentRuntimeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === PROVIDER_DIAGNOSTICS_NO_AGENT_RUNTIME_CODE ||
    // 既有载体路径在「绝不为此拉起新进程」时抛的稳定 code（createRuntimeUnavailableError，
    // acodeAgent.ts:209）。按结构化 code 识别，不匹配 message 文本。
    code === ACODE_AGENT_RUNTIME_UNAVAILABLE_CODE
  );
}
