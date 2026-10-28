import type { ACodeWorkspaceRef } from "@acode/shared";
import type { ACodeApp, ACodeAppOptions } from "../app/types.js";
import type {
  ACodeProtocolAgentServerContext,
  ACodeProtocolSessionRecord,
} from "./server-types.js";
import { runSessionModelConfigMutation } from "../acode-protocol-v4/model-config-mutation.js";
import { createProviderRuntimeHeadersPort } from "./provider-runtime-headers.js";

// M2-8：readWorkspacePresentation / testProviderModelConnectivity 实体已迁
// ../acode-protocol-v4/workspace-runtime.ts 与 provider-process.ts（specs/
// m2-8-workspace-provider-process.md），本文件只留 session 模型运行时尚存 helper。

export async function createWorkspaceACodeApp(
  context: ACodeProtocolAgentServerContext,
  workspace: ACodeWorkspaceRef,
  options: Omit<ACodeAppOptions, "providerRegistry">,
): Promise<ACodeApp> {
  const providerRuntimeHeadersPort =
    options.providerRuntimeHeadersPort ?? createProviderRuntimeHeadersPort(context, workspace);
  return context.deps.createACodeApp({
    ...options,
    platform: context.deps.platform,
    providerRuntimeHeadersPort,
    runtimeConfig: {
      ...options.runtimeConfig,
      // createACodeApp 会把 workingDirectory 规范化为执行 cwd。把协议入口的
      // workspacePath 单独注入 runtime，session 持久化才能保留本地 workspaceKey 的路径表示。
      workspacePath: workspace.workspacePath,
      // 远端 session 是 shared-host CUA 的第二层隔离边界：不能只传 workspacePath/identity，
      // 否则同一远端 workspace 的不同 attachment 会复用 Accessibility frame/action 状态。
      // 放在这个 helper 里而不是各调用点，是为了两条 session 创建路径都拿到同一份隔离键。
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
      ...(workspace.workspaceIdentity
        ? {
            memory: {
              ...options.runtimeConfig?.memory,
              workspaceIdentity: workspace.workspaceIdentity,
            },
          }
        : {}),
      // Electron/Protocol 主会话之前没有像 CLI/TUI 那样显式开启模型流式，
      // 导致主 turn 退回 generateText 非流式请求，遇到返回 SSE 的兼容端点会按 JSON 解析失败。
      modelStreaming: options.runtimeConfig?.modelStreaming ?? "on",
    },
  });
}

export function hasSessionModelProvider(
  _context: ACodeProtocolAgentServerContext,
  record: Pick<ACodeProtocolSessionRecord, "app" | "workspace">,
  providerId: string,
): boolean {
  return record.app.listModels().some((model) => model.ref.providerId === providerId);
}

async function ensureSessionModelAvailableUnlocked(
  context: ACodeProtocolAgentServerContext,
  record: ACodeProtocolSessionRecord,
): Promise<boolean> {
  // 存量模型失效时不能静默改成 Registry 第一项覆盖用户选择；失效选择保持未绑定，
  // 由恢复/Composer 的选择校验和首发门禁处理；这里不能再写入另一份默认模型事实。
  // 保留该过渡入口是为了让旧协议调用方平稳退场。
  void context;
  void record;
  return false;
}

export async function ensureSessionModelAvailable(
  context: ACodeProtocolAgentServerContext,
  record: ACodeProtocolSessionRecord,
): Promise<boolean> {
  return runSessionModelConfigMutation(record.app, () =>
    ensureSessionModelAvailableUnlocked(context, record),
  );
}

export function resolveSessionModelContextWindow(
  _context: ACodeProtocolAgentServerContext,
  record: Pick<ACodeProtocolSessionRecord, "app" | "workspace" | "restoredModelSelection">,
): number | undefined {
  // 缺档位会让恢复选择暂不绑定 Runtime，但模型身份仍可只读查询容量，不能伪造 20 万。
  const selection = record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
  const value = selection && record.app.getModelOption?.(selection)?.contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
