/**
 * server 模块公开契约（治理用精选视图）。
 *
 * 权威公开面以 packages/server/package.json exports 为准：包根（createHttpServer）、
 * ./stdio、./harness、./harness-inprocess、./remote 以及 "./remote/*.js" 通配子路径。
 * 通配面在架构检查中无法表达（publicEntrypointMatches 是精确路径匹配），被跨模块
 * 消费的 remote 文件已在 architecture-policy.yaml 的 publicEntrypoints 逐一显式
 * 登记；新的跨模块 deep import 会失败并迫使显式补登——这是有意的 ratchet。
 * 本文件精选跨模块消费的核心面，供架构 context 阅读包与新消费者速览。
 */

// ── HTTP 服务端（包根面）────────────────────────────────────────────
export { createHttpServer } from "./index.js";

// ── stdio 服务端（./stdio 子路径面）────────────────────────────────
export { createStdioServer, wrapStdio } from "./stdio.js";

// ── remote backend 与连接（./remote 面）────────────────────────────
export {
  connectRemote,
  createRemoteBackend,
  deployServer,
  performHandshake,
  type ConnectOptions,
  type DeployOptions,
  type IRemoteBackend,
  type RemoteBackendOptions,
  type RemoteConnection,
  type RemoteEnvironment,
  type StdioStream,
} from "./remote/index.js";
// posixShell / remoteConnectionProgressContext 不在 remote/index.ts barrel 内，
// desktop 经 "./remote/*.js" 通配子路径消费；这里显式纳入契约面。
export {
  buildPosixShellExecCommand,
  buildWriteLiteralFileCommand,
  quotePosixPathArg,
  quotePosixShellArg,
  resolvePosixHomePath,
} from "./remote/posixShell.js";
export {
  createRemoteConnectionProgressContext,
  type RemoteConnectionProgressEvent,
  type RemoteConnectionProgressLevel,
} from "./remote/remoteConnectionProgressContext.js";
export {
  isWSLAvailable,
  listWSLDistros,
  parseWSLDistroList,
  WSLBackend,
  type WSLDistro,
} from "./remote/index.js";

// ── Harness API 翻译桥（./harness、./harness-inprocess 面）─────────
export {
  createHarnessApiServer,
  createStdioTransport,
  type CreateHarnessApiServerOptions,
  type HarnessApiServer,
  type HarnessStdioTransport,
} from "./harness/index.js";
export {
  createInProcessHarnessServices,
  type CreateInProcessHarnessServicesOptions,
  type HarnessServiceCollection,
  type InProcessHarnessServices,
} from "./harness-inprocess.js";
