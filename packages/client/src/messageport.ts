import { MessagePortProtocol, ChannelClient, toDisposable } from "@acode/rpc";
import type { IServiceAccessor } from "@acode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";
import { isRendererProductionBuild } from "./rendererLoggingEnv.js";

function logMessagePortDebug(message: string): void {
  // 生产构建下 renderer 连接日志不输出，避免窗口启动和重连路径产生同步 console 成本。
  if (isRendererProductionBuild()) {
    return;
  }
  console.log(message);
}

export interface MessagePortServiceConnection {
  services: IServiceAccessor;
  dispose: (reason?: Error) => void;
}

/**
 * 创建一个带明确生命周期的 MessagePort service connection。
 *
 * scoped remote session 换代时必须同时释放 ChannelClient 和底层 port，
 * 否则旧 attachment 上的挂起 RPC 无法 settle，并会继续占用上层去重状态。
 */
export function createMessagePortServiceConnection(
  port: MessagePort,
): MessagePortServiceConnection {
  logMessagePortDebug("[messageport] creating protocol and client...");
  const protocol = new MessagePortProtocol(port);
  const client = new ChannelClient(protocol);
  client.onDidInitialize(() => {
    logMessagePortDebug("[messageport] ChannelClient received Initialize from server");
  });
  logMessagePortDebug("[messageport] client created, waiting for Initialize...");

  // 单一幂等释放边界：connection.dispose 与 services.dispose 共用，避免两条释放路径
  //（RemoteServiceAccess.dispose 内部再守一次 disposed）。client.dispose 会 reject 挂起 RPC，
  // protocol.disconnect 摘 message 订阅并关闭 port。
  let disposed = false;
  const transport = toDisposable(() => {
    if (disposed) {
      return;
    }
    disposed = true;
    client.dispose();
    protocol.disconnect();
  });

  const services = new RemoteServiceAccess(client, transport);
  return {
    services,
    dispose: (reason?: Error) => {
      // reason 仅用于把挂起 RPC 以指定错误 fail-closed；共享 transport 无参，故先在此收口一次。
      if (!disposed) {
        disposed = true;
        client.dispose(reason);
        protocol.disconnect();
      }
    },
  };
}

/**
 * 通过 MessagePort 连接服务。
 *
 * Desktop 模式下，utilityProcess（或 main 进程的远程代理）通过 MessagePort
 * 暴露 ChannelServer，renderer 用此函数建立 ChannelClient 连接。
 */
export function connectViaMessagePort(port: MessagePort): IServiceAccessor {
  return createMessagePortServiceConnection(port).services;
}
