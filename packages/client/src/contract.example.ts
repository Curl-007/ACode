// 编译校验的消费示例（架构 context 阅读包展示；不执行任何 IO——不建连接、
// 不触网、不触达 window.acode）：port/url 由宿主注入（declare），只演示
// contract.ts 公开面的典型用法。
import {
  connectViaWebSocket,
  createMessagePortServiceConnection,
  type MessagePortServiceConnection,
  type WebSocketConnectionCloseEvent,
} from "./contract.js";

declare const port: MessagePort;

/**
 * Desktop renderer 主链路：MessagePort → MessagePortProtocol → ChannelClient →
 * RemoteServiceAccess。返回的连接对象带幂等 dispose（scoped session 换代时
 * 必须同时释放 ChannelClient 与底层 port，否则挂起 RPC 无法 settle）。
 */
export function exampleConnectViaMessagePort(): MessagePortServiceConnection {
  const connection = createMessagePortServiceConnection(port);
  // 类型级验证：services 门面暴露 IServiceAccessor 的服务 getter
  void connection.services.fileService;
  return connection;
}

/** Web 远程链路：WebSocket 直连 server，close 事件带 code/reason/wasClean。 */
export async function exampleConnectViaWebSocket(url: string): Promise<void> {
  const closed: WebSocketConnectionCloseEvent[] = [];
  const services = await connectViaWebSocket(url, {
    onClose: (event) => {
      closed.push(event);
    },
  });
  void services.gitService;
}
