import type { McpServerStatus, ACodeMcpServer, ACodeMcpServerStatusSnapshot } from "@acode/shared";

type MappedMcpServerStatus = {
  authorization?: ACodeMcpServerStatusSnapshot["authorization"];
  error?: string;
  failureKind?: ACodeMcpServerStatusSnapshot["failureKind"];
  serverRequestId?: string;
  // 熔断挂起只在 failed/disconnected 两态出现（R1：显式复位先于连接，connected 恒不携带）；
  // 快照缺失时映射结果同样缺失，merge 输出据此清除 store 内旧值——恢复后不得残留挂起横幅。
  reconnectSuspension?: ACodeMcpServerStatusSnapshot["reconnectSuspension"];
  status: McpServerStatus;
};

function mapRuntimeStatusToUi(snapshot: ACodeMcpServerStatusSnapshot): MappedMcpServerStatus {
  switch (snapshot.status) {
    case "connected":
    case "connecting":
      return {
        authorization: snapshot.authorization,
        status: snapshot.status,
      };
    case "disconnected":
      return {
        authorization: snapshot.authorization,
        status: snapshot.status,
        error: snapshot.error,
        failureKind: snapshot.failureKind,
        serverRequestId: snapshot.serverRequestId,
        reconnectSuspension: snapshot.reconnectSuspension,
      };
    case "failed":
      return {
        status: "error",
        error: snapshot.error,
        failureKind: snapshot.failureKind ?? "connection_failed",
        serverRequestId: snapshot.serverRequestId,
        reconnectSuspension: snapshot.reconnectSuspension,
      };
    case "disabled":
      return { status: "unknown", error: snapshot.error };
    case "untrusted":
      return {
        status: "unknown",
        error: snapshot.error ?? "Project MCP server requires explicit connection before use.",
        failureKind: snapshot.failureKind ?? "status_unavailable",
        serverRequestId: snapshot.serverRequestId,
      };
  }
}

export function mergeMcpServerStatusSnapshots(
  servers: ACodeMcpServer[],
  statuses: Record<string, ACodeMcpServerStatusSnapshot>,
  options: { markMissingConnectingAsError?: boolean } = {},
): ACodeMcpServer[] {
  const markMissingConnectingAsError = options.markMissingConnectingAsError ?? true;
  return servers.map((server) => {
    if (server.source !== "acodeagentmcp") {
      return server;
    }
    const snapshot = statuses[server.name];
    if (!snapshot) {
      if (markMissingConnectingAsError && server.enabled && server.status === "connecting") {
        return {
          ...server,
          // mcp/list 正常返回但缺少当前行时，继续保留 connecting 会让设置页无限转圈。
          status: "error",
          failureKind: "status_unavailable",
          toolCount: undefined,
        };
      }
      return server;
    }
    const mapped = mapRuntimeStatusToUi(snapshot);
    return {
      ...server,
      status: mapped.status,
      authorization: mapped.authorization,
      error: mapped.error,
      failureKind: mapped.failureKind,
      serverRequestId: mapped.serverRequestId,
      reconnectSuspension: mapped.reconnectSuspension,
      toolCount: snapshot.toolCount,
      changed: false,
      lastConnected:
        mapped.status === "connected" ? new Date(snapshot.updatedAt) : server.lastConnected,
    };
  });
}
