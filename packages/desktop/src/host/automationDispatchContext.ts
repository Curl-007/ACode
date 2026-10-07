import type { ServiceCollection } from "@acode/services";

/**
 * Host automation 派发域的共享上下文（cron / off-peak / manual 三条派发链路）。
 *
 * 背景（2026-10-05，host/index.ts 领域拆分第一批）：automation 派发域约 700 行
 * 从 host 入口文件抽出为独立模块；入口文件与派发域之间只保留本上下文接口。
 * activeServices 与 remote connection registry 在入口文件中的创建位置晚于派发域
 * 工厂的调用位置（历史上靠函数调用时机避开 TDZ），因此必须以惰性 getter 传递，
 * 不得在构造期求值。
 */

/** host 入口的结构化日志面（与 index.ts 的 logger 对象同形）。 */
export interface AutomationDispatchLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** windowRemoteConnectionRegistry 的结构子集：派发域只用到会话定位与 scoped services 解析。 */
export interface AutomationRemoteConnectionRegistry {
  findSessionForWorkspace(request: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): { remoteSessionId: string; workspaceIdentity?: string } | null | undefined;
  resolveScopedServices(params: {
    kind: "remote";
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
  }): ServiceCollection;
}

export interface HostAutomationDispatchContext {
  logger: AutomationDispatchLogger;
  /** 惰性读取 host 当前本地服务集合（null = 未初始化/已释放）。 */
  getActiveServices: () => ServiceCollection | null;
  /** 惰性读取远端连接注册表（创建位置在派发域工厂之后，禁止构造期求值）。 */
  getRemoteConnectionRegistry: () => AutomationRemoteConnectionRegistry;
}
