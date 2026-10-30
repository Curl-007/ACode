import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@acode/rpc";
import {
  type ServiceCollection,
  IACodeAgentService,
  createACodeAgentConnectionScope,
  ICredentialService,
  IProviderProvisioningTargetService,
} from "@acode/services";
import { createTerminalClientCredentialGuard } from "@acode/shared/node";
import { log } from "./log.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

/**
 * WS 升级后的 RPC 通道装配（2026-10-30 自 http.ts 拆出，行为不变）。
 * 升级前的鉴权/Origin/能力裁决全部留在 http.ts 本体路由层——本函数只在裁决通过后被调用。
 */
export function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const server = new LoggingChannelServer(rawServer, log);
  const agentService = services.getOptional(IACodeAgentService);
  const connectionScope = agentService
    ? createACodeAgentConnectionScope(agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IACodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  // M4：Credential 通道承载全仓明文凭据（OAuth token / JWT / BYO API Key / MCP token /
  // bot secret），此前无差别注册给每条连接——默认 loopback 无 token 姿态下本机任意进程/
  // 恶意网页可 dump 全部凭据。与上方 Provisioning 先例同模式，在传输注册层（overrides）
  // 按 clientMode 收窄：desktop-continuous 保持全量（renderer 登录态与 remote-workspace
  // token 流依赖）；terminal-client 仅放行 allowlist 键的只读 load（allowlist 证据与拒绝
  // 语义的唯一所有者在 @acode/shared/node credentialChannelAccess，两套 server 共用）。
  if (clientMode !== "desktop-continuous") {
    const credentialService = services.getOptional(ICredentialService);
    if (credentialService) {
      overrides.set(
        ICredentialService.channelName,
        createTerminalClientCredentialGuard(credentialService),
      );
    }
  }
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}
