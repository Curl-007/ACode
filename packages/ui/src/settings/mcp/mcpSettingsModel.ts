/**
 * MCP Settings 的 refresh queue / status 决策 / OAuth authorization build 纯逻辑。
 *
 * 由 `settings/McpSettingsSection.tsx` 拆出（specs/god-component-split-plan.md「settings 上帝组件
 * 拆分计划」批次 + review 2026-10-28 §3.⑤）。本模块为**纯函数 + 常量**，无 React、无 IO、无闭包副作用——
 * 例外：`createMcpStatusListRefreshQueue` 是**有状态工厂**（返回带闭包状态的 queue 对象），不是纯函数；
 * 调用方不应假设多次调用产生相同行为。
 *
 * 测试：`packages/ui/test/mcpSettingsModel.test.ts`。
 */
import { convertToACodeAgentMcpServer } from "@acode/shared";
import type { ACodeAgentMcpServer, ACodeMcpServer } from "@acode/shared";
import { type V4McpServerStatusSnapshot, type V4PluginInfo } from "@acode/shared/acode-protocol-v4";

/** MCP 来源常量。`DEFAULT_MCP_SOURCE` 留在主文件（属于表单/编辑器默认值，不属于 refresh 决策）。 */

export const MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS = 1_000;
export const MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_DURATION_MS = 5 * 60_000;
export const MCP_OAUTH_AUTHORIZATION_FOLLOWUP_REFRESH_ATTEMPTS = 10;

export function createMcpOAuthAuthorizationStatusRefreshDeadline(
  now: () => number = Date.now,
): number {
  return now() + MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_DURATION_MS;
}

export function isMcpOAuthAuthorizationStatusRefreshExpired(
  deadline: number,
  now: () => number = Date.now,
): boolean {
  return now() >= deadline;
}

export interface McpOAuthAuthorizationPendingRefresh {
  mcpServers: ACodeAgentMcpServer[];
  pendingKey: string;
  workspaceKey: string;
}

export function transitionMcpAutoStatusListRefreshKey(
  previousKey: string,
  nextKey: string,
): { lastRefreshKey: string; shouldRefresh: boolean } {
  if (!nextKey) {
    // workspace 切换会先清空 server/status；若空状态仍保留 A 的去重 key，
    // 回到相同配置的 A 时会被误判为已刷新，列表和 OAuth 轮询永久停在 unknown。
    return { lastRefreshKey: "", shouldRefresh: false };
  }
  return {
    lastRefreshKey: nextKey,
    shouldRefresh: previousKey !== nextKey,
  };
}

export interface McpOAuthAuthorizationFollowupRefresh {
  mcpServers: ACodeAgentMcpServer[];
  refreshKey: string;
  workspaceKey: string;
}

export function transitionMcpOAuthAuthorizationPendingRefresh({
  activeWorkspaceKey,
  existingFollowup = null,
  mcpServers,
  now = Date.now,
  pendingKey,
  previous,
}: {
  activeWorkspaceKey: string;
  existingFollowup?: McpOAuthAuthorizationFollowupRefresh | null;
  mcpServers: ACodeAgentMcpServer[];
  now?: () => number;
  pendingKey: string;
  previous: McpOAuthAuthorizationPendingRefresh | null;
}): {
  followup: McpOAuthAuthorizationFollowupRefresh | null;
  pending: McpOAuthAuthorizationPendingRefresh | null;
} {
  if (!activeWorkspaceKey) {
    return { followup: null, pending: null };
  }
  if (pendingKey) {
    return {
      followup: null,
      pending: {
        mcpServers: [...mcpServers],
        pendingKey,
        workspaceKey: activeWorkspaceKey,
      },
    };
  }
  if (existingFollowup?.workspaceKey === activeWorkspaceKey) {
    // follow-up 自己的 status merge 会改变 servers/snapshot 并重跑 transition；
    // 同 workspace 的有界重试窗口必须保持同一对象，不能在首包后把自己 cleanup。
    return { followup: existingFollowup, pending: null };
  }
  if (!previous || previous.workspaceKey !== activeWorkspaceKey) {
    return { followup: null, pending: null };
  }
  return {
    followup: {
      mcpServers: [...previous.mcpServers],
      refreshKey: `${activeWorkspaceKey}:${previous.pendingKey}:${now()}`,
      workspaceKey: activeWorkspaceKey,
    },
    pending: null,
  };
}

export interface McpStatusListRefreshQueue {
  request: (runLatest: () => Promise<void>) => Promise<void>;
}

/** 刷新来源：manual 是用户点了刷新按钮，auto 是列表/配置变化驱动的自动刷新。 */
export type McpStatusListRefreshTrigger = "auto" | "manual";

export interface McpStatusListRefreshInput {
  activeWorkspaceKey: string;
  activeWorkspacePath?: string;
  configReadyWorkspaceKey: string;
  isConfigLoaded: boolean;
  serverStatusListKey: string;
  storeWorkspaceKey: string;
}

export function resolveMcpStatusListRefreshSkipReason({
  input,
  requestedWorkspaceKey,
  trigger,
}: {
  input: McpStatusListRefreshInput;
  requestedWorkspaceKey: string;
  trigger: McpStatusListRefreshTrigger;
}): string | undefined {
  if (!requestedWorkspaceKey) return "no-active-workspace";
  if (input.activeWorkspaceKey !== requestedWorkspaceKey) {
    return "workspace-changed";
  }
  if (input.storeWorkspaceKey !== requestedWorkspaceKey) {
    return "mcp-store-not-aligned";
  }
  if (input.configReadyWorkspaceKey !== requestedWorkspaceKey) {
    return "config-not-ready";
  }
  if (!input.isConfigLoaded) return "config-not-loaded";
  if (!input.activeWorkspacePath) return "no-workspace-path";
  // 只有宿主/插件内置 MCP、没有任何用户 MCP 时 serverStatusListKey 会是空串。
  // 自动刷新据此去重没问题，但用户点了刷新就必须真的发一次请求，否则按钮看起来完全没反应。
  if (!input.serverStatusListKey && trigger !== "manual") {
    return "empty-status-list-key";
  }
  return undefined;
}

export function createMcpStatusListRefreshQueue(): McpStatusListRefreshQueue {
  let inFlight: Promise<void> | null = null;
  let latestRun: (() => Promise<void>) | null = null;
  let rerunAfterCurrent = false;

  return {
    async request(runLatest) {
      latestRun = runLatest;
      if (inFlight) {
        rerunAfterCurrent = true;
        await inFlight;
        return;
      }

      inFlight = (async () => {
        try {
          do {
            rerunAfterCurrent = false;
            const run = latestRun ?? runLatest;
            latestRun = null;
            await run();
          } while (rerunAfterCurrent);
        } finally {
          inFlight = null;
        }
      })();

      await inFlight;
    },
  };
}

export function buildMcpOAuthAuthorizationStatusRefreshServers(
  servers: ACodeMcpServer[],
  statusSnapshots: Record<string, V4McpServerStatusSnapshot> = {},
): ACodeAgentMcpServer[] {
  const pendingSnapshotNames = new Set(
    Object.entries(statusSnapshots)
      .filter(([, snapshot]) => Boolean(snapshot.authorization?.authorizationUrl))
      .map(([serverName]) => serverName),
  );
  const result: ACodeAgentMcpServer[] = [];
  const seenNames = new Set<string>();

  for (const server of servers) {
    if (server.source !== "acodeagentmcp" || !server.enabled) {
      continue;
    }
    const hasPendingAuthorization =
      Boolean(server.authorization?.authorizationUrl) || pendingSnapshotNames.has(server.name);
    if (!hasPendingAuthorization || seenNames.has(server.name)) {
      continue;
    }
    const acodeAgentServer = convertToACodeAgentMcpServer(server.name, server.config);
    if (!acodeAgentServer) {
      continue;
    }
    seenNames.add(server.name);
    result.push(acodeAgentServer);
  }

  return result;
}

export function buildMcpOAuthAuthorizationStatusRefreshOptions(mcpServers: ACodeAgentMcpServer[]): {
  mode: "status";
  mcpServers: ACodeAgentMcpServer[];
} {
  return {
    // OAuth pending/follow-up/focus 刷新只读运行态，不能让 pending 子集进入 connect replace 路径。
    mode: "status",
    mcpServers,
  };
}

export function buildMcpServerStatusListKey(servers: ACodeMcpServer[]): string {
  return servers
    .filter((server) => server.source === "acodeagentmcp")
    .map((server) => {
      const enabledKey = server.enabled ? "enabled" : "disabled";
      return `${server.id}:${enabledKey}:${JSON.stringify(server.config)}`;
    })
    .join("|");
}

export function buildPluginMcpServerStatusListKey(plugins: V4PluginInfo[]): string {
  return plugins
    .map((plugin) => {
      const declaredNames = plugin.declaredMcpServerNames ?? [];
      const runtimeNames = plugin.mcpServerNames;
      const hostNames = plugin.hostMcpServerNames ?? [];
      if (
        (!plugin.enabled && hostNames.length === 0) ||
        (declaredNames.length === 0 && runtimeNames.length === 0 && hostNames.length === 0)
      ) {
        return "";
      }
      const pluginKey = `${plugin.id}:${plugin.enabled ? "enabled" : "disabled"}:${[
        ...declaredNames,
      ]
        .sort()
        .join(",")}:${[...runtimeNames].sort().join(",")}`;
      return hostNames.length > 0
        ? `${pluginKey}:host=${[...hostNames].sort().join(",")}`
        : pluginKey;
    })
    .filter(Boolean)
    .join("|");
}

export function shouldShowPluginMcpServersInMcpSettings(isRemoteSyncContext: boolean): boolean {
  return !isRemoteSyncContext;
}

export function buildPendingMcpOAuthAuthorizationRefreshKey(
  servers: ACodeMcpServer[],
  statusSnapshots: Record<string, V4McpServerStatusSnapshot> = {},
): string {
  const localPendingKeys = servers
    .filter(
      (server) =>
        server.source === "acodeagentmcp" &&
        server.enabled &&
        Boolean(server.authorization?.authorizationUrl),
    )
    .map((server) => `${server.id}:${server.authorization?.startedAt ?? ""}`);
  const runtimePendingKeys = Object.entries(statusSnapshots)
    .filter(([, snapshot]) => Boolean(snapshot.authorization?.authorizationUrl))
    .map(([serverName, snapshot]) => `${serverName}:${snapshot.authorization?.startedAt ?? ""}`);
  return Array.from(new Set([...localPendingKeys, ...runtimePendingKeys])).join("|");
}
