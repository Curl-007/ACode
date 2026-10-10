/**
 * server 模块清单：远程服务器端（HTTP/stdio 传输）、remote backend（SSH/WSL/
 * Docker 部署与连接）与 Harness API 翻译桥。
 *
 * owner 是 remote-server。业务状态不在本模块：services 的 ServiceCollection 是
 * 服务实例的唯一所有者（harness-inprocess 只持懒工厂与 dispose 句柄）；remote
 * backend 只持连接作用域资源。依赖声明与 architecture-policy.yaml 一致：
 * client（RemoteServiceAccess 通道定义）、rpc（Emitter/SocketProtocol/ChannelServer）、
 * services（ServiceCollection 装配）、shared（协议/schema 唯一事实源）。
 */
export const serverModule = {
  id: "server",
  requires: ["client", "rpc", "services", "shared"],
  provides: ["remote-server", "remote-backend", "harness-api-server"],
  publicEntrypoints: [
    "contract.ts",
    "index.ts",
    "stdio.ts",
    "harness/index.ts",
    "harness-inprocess.ts",
    "remote/index.ts",
    "remote/posixShell.ts",
    "remote/remoteConnectionProgressContext.ts",
    "remote/wsl-backend.ts",
    "remote/wsl-detect.ts",
  ],
} as const;
