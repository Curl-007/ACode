// MCP Port - Model Context Protocol adapter boundary
//
// 本文件曾以 398 行贴住单文件行数预算上限；按第一轮登记的拆分义务（2026-10-15）
// 拆为内聚叶子。barrel（interfaces/index.ts、contracts src/index.ts）与全部既有
// import 面零改动——本文件继续 re-export 拆分产物的所有符号：
// - mcp-config.port.ts        server 配置声明（transport / 协议版本 / OAuth / 官方鉴权 / provenance）
// - mcp-status.port.ts        连接状态机、重连挂起附加事实、状态变更事件
// - mcp-tools.port.ts         工具 annotations / descriptor / _meta 键 / callTool 请求与结果
// - mcp-official-auth.port.ts 官方身份头注入端口与 origin 信任判定
// - mcp-resources.port.ts     resources 拉取面

import type { McpServerConfig } from "./mcp-config.port.js";
import type { McpServerStatus } from "./mcp-status.port.js";
import type {
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectionSnapshot,
  McpConnectOptions,
  McpToolCallResult,
  McpToolDescriptor,
} from "./mcp-tools.port.js";
import type { McpReadResourceResult, McpResourceDescriptor } from "./mcp-resources.port.js";

export * from "./mcp-config.port.js";
export * from "./mcp-status.port.js";
export * from "./mcp-tools.port.js";
export * from "./mcp-official-auth.port.js";
export * from "./mcp-resources.port.js";

export interface McpPort {
  connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options?: McpConnectOptions,
  ): Promise<McpConnectionSnapshot>;
  connectServer(
    name: string,
    config: McpServerConfig,
    options?: McpConnectOptions,
  ): Promise<McpServerStatus>;
  disconnectServer(name: string): Promise<McpServerStatus | undefined>;
  /**
   * 主动探测连接是否仍然存活，返回 false 表示 transport 已断。
   * HTTP/SSE MCP 被停掉时不会派发 onclose，status() 会长期停在 connected；
   * 只有显式 ping 才能把这种"无声死亡"暴露出来。实现可选：未实现时调用方按存活处理。
   */
  pingServer?(name: string, options?: { timeoutMs?: number }): Promise<boolean>;
  /**
   * 资源拉取面（specs/mcp-sampling-resources.md）：仅对 `resources: true` 的 server 注册
   * 拉取工具；实现可选（旧 adapter 缺席时 core 不注册资源工具）。订阅/推送不在本面——
   * 拉取语义先立住。list 上限 200 条由调用方裁剪。
   */
  listResources?(name: string, options?: { timeoutMs?: number }): Promise<McpResourceDescriptor[]>;
  readResource?(
    name: string,
    uri: string,
    options?: { timeoutMs?: number },
  ): Promise<McpReadResourceResult | undefined>;
  status(): Promise<Record<string, McpServerStatus>>;
  listTools(): Promise<McpToolDescriptor[]>;
  /**
   * 工具面变更订阅（specs/mcp-startup-gate-breaker.md R1 收尾接线）：后台连接
   * 完成、Deferred/空工具记录被真实工具原子替换后触发（无载荷——消费方重查
   * listTools()）。实现可选：缺席时 core 注册表保持启动快照（callTool 按
   * server/tool 身份路由不受影响，仅注册表 schema 存在陈旧窗）。返回退订
   * 函数；监听器故障不得反向影响连接生命周期（派发点 try/catch，与状态
   * 事件监听同一哲学）。
   */
  onToolsChanged?(listener: () => void): () => void;
  callTool(request: McpCallToolRequest, options?: McpCallToolOptions): Promise<McpToolCallResult>;
  close(): Promise<void>;
}
