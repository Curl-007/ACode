// provider + process 域的 v4 handler（apps/acode-cli/specs/m2-8-workspace-provider-process.md）。
//
// 实体自 legacy `acode-protocol/` 的 account-provider-config.ts / workspace-model-runtime.ts
// （testProviderModelConnectivity）/ process-child-processes.ts 逐字迁入（M2-8：实体放 v4
// 目录，server.ts 只留一行转发，不在待删目录留实体债）。唯一改动：params 改 parse v4
// schema（形状与 legacy 逐字 parity）。
import type { McpTrackedProcess } from "@acode/adapters";
import { createInMemorySessionEventStore } from "@acode/adapters/storage";
import type { ModelSelection } from "@acode/contracts";
import {
  v4ProviderTestModelConnectivityParamsSchema,
  v4ProviderUpdateAccountConfigParamsSchema,
  type V4ProcessChildProcessesResult,
  type V4ProviderTestModelConnectivityResult,
  type V4ProviderUpdateAccountConfigResult,
} from "@acode/shared/acode-protocol-v4";
import { parseProcessAccountProviderConfigSnapshot } from "../app/process-provider-registry-runtime.js";
import { resolveOfficialPluginNameByHostMcpServerName } from "../app/official-plugin-definitions.js";
import { createWorkspaceACodeApp } from "./workspace-model-runtime.js";
import {
  parseParams,
  ProtocolRequestError,
  type ACodeProtocolAgentServerContext,
} from "./server-types.js";

/**
 * 更新进程级 Account Provider Config。
 *
 * 该协议传 Account Overlay 与对应状态；API Key、JWT 和动态 Header 由请求期鉴权协议处理。
 */
export async function updateAccountProviderConfigV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4ProviderUpdateAccountConfigResult> {
  const envelope = parseParams(v4ProviderUpdateAccountConfigParamsSchema, rawParams);
  const snapshot = parseProcessAccountProviderConfigSnapshot(envelope);
  if (!context.deps.syncAccountProviderConfig) {
    throw new ProtocolRequestError(-32018, "Account Provider Config runtime is not configured");
  }
  const changed = await context.deps.syncAccountProviderConfig(snapshot);
  return {
    receivedRevision: snapshot.revision,
    providerCount: snapshot.providers.keys().length,
    status: changed ? "received" : "unchanged",
  };
}

export async function testProviderModelConnectivityV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<V4ProviderTestModelConnectivityResult> {
  const params = parseParams(v4ProviderTestModelConnectivityParamsSchema, rawParams);
  // 旧 Personal Config 跨进程 watcher 可能永久漏掉原子写事件；连接测试若不先
  // 主动刷新，会反复查询旧 Registry。这里复用正式 Registry refresh，不旁路创建配置事实。
  await context.deps.refreshProviderRegistry?.("provider-connectivity");
  const active = Array.from(context.sessions.values()).find(
    (record) => record.workspace.workspaceKey === params.workspace.workspaceKey,
  );
  const app =
    active?.app ??
    (await createWorkspaceACodeApp(context, params.workspace, {
      env: context.deps.env,
      eventStore: createInMemorySessionEventStore(),
      runtimeConfig: { workingDirectory: params.workspace.workspacePath },
      sessionStore: context.deps.sessionStore,
      version: context.deps.version,
    }));
  try {
    await app.testModelConnectivity(
      { selection: params.selection as ModelSelection },
      { abortSignal },
    );
    return { success: true as const };
  } finally {
    if (!active) await app.close?.();
  }
}

/**
 * `v4/process/childProcesses`：把 MCP 进程注册表内存里的子进程映射整理成协议结果。
 * 只做归属补齐（builtin host MCP → 官方插件名），不做任何 I/O；CPU/内存采样由桌面 Host 完成。
 */
export function listChildProcessesV4(
  tracked: readonly McpTrackedProcess[],
): V4ProcessChildProcessesResult {
  return {
    processes: tracked.map((process) => {
      const pluginName =
        process.pluginName ??
        (process.mcpSource === "builtin"
          ? resolveOfficialPluginNameByHostMcpServerName(process.serverName)
          : undefined);
      return {
        pid: process.pid,
        serverName: process.serverName,
        mcpSource: process.mcpSource,
        ...(pluginName ? { pluginName } : {}),
      };
    }),
  };
}
