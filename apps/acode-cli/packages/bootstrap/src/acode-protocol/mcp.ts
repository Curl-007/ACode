import { createConfig, resolvePath } from "@acode/adapters/config";
import type { Logger, McpConnectionSnapshot, McpPort, McpServerStatus } from "@acode/contracts";
import {
  acodeMcpListParamsSchema,
  acodeMcpListResultSchema,
  type ACodeMcpListResult,
} from "@acode/shared";
import {
  listMcpServerStatuses,
  omitMcpServers,
  resolveTrustedOfficialCuaServerNames,
} from "../mcp-config.js";
import {
  collectProjectDeclaredStdioServers,
  loadProjectMcpTrustSnapshot,
  resolveUntrustedProjectMcpServers,
} from "../app/project-mcp-trust.js";
import { StartupTimer, startupNow } from "../startup-logging.js";
import { getCliStorageRoot } from "../app/paths.js";
import { resolveStartupPlugins } from "../app/startup-marks.js";
import { protocolMcpServersToRuntimeMcpConfig } from "./protocol-mcp-config.js";
import { parseParams, type ACodeProtocolAgentServerContext } from "./server-types.js";

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

const MCP_OAUTH_AUTHORIZATION_STATUS_WAIT_MS = 5_000;
const MCP_OAUTH_AUTHORIZATION_STATUS_POLL_MS = 100;

export async function listMcpServers(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ACodeMcpListResult> {
  const params = parseParams(acodeMcpListParamsSchema, rawParams);
  const workingDirectory = params.workspace.workspacePath;
  const configResult = createConfig({
    env: context.deps.env,
    workingDirectory,
  });
  const cliStorageRoot = getCliStorageRoot(resolvePath(configResult.config.storage.dir));
  const startupTimer = new StartupTimer(
    context.logger ?? noopLogger,
    {
      module: "bootstrap.acode_protocol.mcp",
      workspaceKey: params.workspace.workspaceKey,
      workspacePath: params.workspace.workspacePath,
    },
    startupNow(),
  );
  const pluginOutcome = resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: context.deps.env,
    logger: context.logger,
    options: {},
    startupTimer,
    workingDirectory,
  });
  const explicitMcpServersProvided = params.mcpServers !== undefined;
  const explicitRuntimeMcp = protocolMcpServersToRuntimeMcpConfig(params.mcpServers);
  const configuredMcpServers = {
    ...pluginOutcome.mcpServers,
    // 设置页的本地 MCP 列表由 desktop main 解析 `.acode` / `.agents` fallback，
    // session runtime 也使用这批 params.mcpServers。mcp/list 不能再只靠 agent createConfig，
    // 否则 `.agents` fallback 行会缺少 status snapshot 并被 UI 误标红。
    ...(explicitMcpServersProvided
      ? (explicitRuntimeMcp?.servers ?? {})
      : configResult.config.mcp.servers),
  };
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginOutcome.mcpServers,
  );
  // 安全修复 H2（specs/project-mcp-trust-gate.md）：mcp/list 不再持有第二份「空集」
  // 真值——与 resolveAppRuntimeConfig 共用同一对 gate helper（快照加载 + 纯函数判定），
  // connect 收敛与状态投影对同一 workspace 得出同一 untrusted 结论。
  const configLayerMcpServers = explicitMcpServersProvided
    ? (explicitRuntimeMcp?.servers ?? {})
    : configResult.config.mcp.servers;
  const projectMcpTrust = await loadProjectMcpTrustSnapshot({
    workingDirectory,
    workspaceIdentity: params.workspace.workspaceIdentity,
    userConfigPath: configResult.sources.user.path,
    logger: context.logger ?? noopLogger,
  });
  const { untrustedServerNames: untrustedProjectMcpServers } = resolveUntrustedProjectMcpServers({
    configuredMcpServers,
    configLayerServers: configLayerMcpServers,
    serverSources: configResult.sources.mcp?.serverSources,
    // B1 收口（spec R10）：mcp/list 的显式 params 由 desktop 下发，可能回声仓库
    // 携带的 .acode/.agents 内容——内容命中项目声明的 stdio server 同样过 digest 门。
    projectDeclaredServers: collectProjectDeclaredStdioServers({
      servers: configResult.config.mcp.servers,
      serverSources: configResult.sources.mcp?.serverSources,
    }),
    workingDirectory,
    trust: projectMcpTrust,
  });
  const mcpPort = context.deps.mcpPort;
  if (mcpPort) {
    if (params.mode === "status") {
      // OAuth 轮询只需要读取当前运行态。传入 pending 子集会落到
      // connectConfiguredServers 的 replace 语义，导致未列出的 MCP 被断开。
      const statuses = await listMcpServerStatuses(
        mcpPort,
        configuredMcpServers,
        untrustedProjectMcpServers,
      );
      return acodeMcpListResultSchema.parse({ statuses });
    }

    // OAuth 轮询已由 mode=status 隔离；默认/connect 必须继续执行 replace 收敛，
    // 否则任一 server 待授权时，配置新增/删除和 stale MCP 清理都会被跳过。
    // 默认/connect 模式服务的是设置页刷新这类"重新探测"诉求，而 mcpPort 是进程级
    // `protocol-settings` lease；不带 revalidate 时连接池会直接复用旧 entry 并返回陈旧快照，
    // 停掉的 HTTP MCP 会永远显示已连接（见 adapters/src/mcp/pool.ts revalidateEntry）。
    const connectPromise = mcpPort.connectConfiguredServers(
      omitMcpServers(
        configuredMcpServers,
        untrustedProjectMcpServers,
        trustedOfficialCuaServerNames,
      ),
      {
        revalidate: true,
        workingDirectory,
      },
    );
    const pendingAuthorizationSnapshot = await waitForOAuthAuthorizationSnapshot(
      mcpPort,
      connectPromise,
    );
    if (pendingAuthorizationSnapshot) {
      void connectPromise.catch((error) => {
        context.logger?.warn("MCP background authorization connection failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.authorization.background.failed",
          workspaceKey: params.workspace.workspaceKey,
          workspacePath: params.workspace.workspacePath,
        });
      });
      return acodeMcpListResultSchema.parse({
        statuses: pendingAuthorizationSnapshot.statuses,
      });
    }

    await connectPromise;
  }
  const statuses = await listMcpServerStatuses(
    mcpPort,
    configuredMcpServers,
    untrustedProjectMcpServers,
  );
  return acodeMcpListResultSchema.parse({ statuses });
}

async function waitForOAuthAuthorizationSnapshot(
  mcpPort: McpPort,
  connectPromise: Promise<McpConnectionSnapshot>,
): Promise<McpConnectionSnapshot | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MCP_OAUTH_AUTHORIZATION_STATUS_WAIT_MS) {
    const race = await Promise.race([
      connectPromise.then(
        (snapshot) => ({ kind: "completed" as const, snapshot }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      delay(MCP_OAUTH_AUTHORIZATION_STATUS_POLL_MS).then(() => ({ kind: "poll" as const })),
    ]);

    if (race.kind === "completed") {
      return undefined;
    }
    if (race.kind === "failed") {
      throw race.error;
    }

    const statuses = await mcpPort.status();
    if (hasPendingOAuthAuthorization(statuses)) {
      return {
        statuses,
        tools: await mcpPort.listTools(),
      };
    }
  }

  return undefined;
}

function hasPendingOAuthAuthorization(statuses: Record<string, McpServerStatus>): boolean {
  return Object.values(statuses).some((status) => Boolean(status.authorization?.authorizationUrl));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
