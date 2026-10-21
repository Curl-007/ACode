// MCP server 配置声明面（mcp.port.ts 拆分产物，2026-10-15）。
// transport 形态、协议版本旋钮、OAuth 与官方鉴权声明、宿主归属标记。

export type McpServerTransportType = "stdio" | "http" | "sse";
export type McpProtocolVersion = "legacy" | "auto" | "2026-07-28";
export type McpServerIsolation = "session" | "workspace";

/** 公共 MCP 配置校验完成后由宿主附加的运行时来源。 */
export interface McpServerRuntimeSource {
  kind: "builtin" | "plugin";
  /** 插件加载器权威身份；普通内置 MCP server 不填写。 */
  pluginId?: string;
}

export interface McpServerConfigBase {
  enabled?: boolean;
  isolation?: McpServerIsolation;
  protocolVersion?: McpProtocolVersion;
  /** 仅限宿主生成，公共配置 schema 会拒绝该字段。 */
  source?: McpServerRuntimeSource;
  timeoutMs?: number;
  /**
   * 允许该 server 发起 sampling/createMessage（specs/mcp-sampling-resources.md）。
   * 缺省 false = 不声明 capability，fail-closed。⚠ 当前 SDK 在 2026-07-28 协议纪元已把
   * sampling 标记 deprecated（elicitation 是后继面）——消费面落地前先按 spec 立项对齐。
   */
  sampling?: boolean;
  /** 把该 server 的 resources 暴露为拉取工具（list/read）。缺省 false。 */
  resources?: boolean;
}

export interface McpClientCredentialsOAuthConfig {
  type: "client_credentials";
  clientId: string;
  clientSecret: string;
  clientName?: string;
  scope?: string;
}

export interface McpAuthorizationCodeOAuthConfig {
  type: "authorization_code";
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  redirectPath?: string;
  scope?: string;
}

export type McpOAuthConfig = McpAuthorizationCodeOAuthConfig | McpClientCredentialsOAuthConfig;

/**
 * ACode 官方 Server MCP 的鉴权声明。
 * 允许出现在 `type: "http"` 与 `type: "stdio"`；`sse` 仍拒。
 * `type`/`provider` 均为精确值，不接受别名或大小写变体。
 *
 * 注意：该字段本身**不构成**官方身份证明。官方身份由运行时解析的 ACode API origin 判定
 * （host 侧还会二次校验）；第三方 Plugin 复制该字段只能让凭证流向真实 ACode 后端。
 *
 * 两种形态的凭证投递通道不同：
 * - http：宿主在 fetch wrapper 里逐请求注入身份头，凭证从不进入插件进程；
 * - stdio：请求由插件进程自己发出，身份头随每条出站协议消息的 `_meta` 下发。
 */
export interface ACodeOfficialMcpAuthConfig {
  type: "acode_official";
  provider: "jwt_token";
}

/**
 * Plugin loader 生成的运行时归属信息，`.mcp.json` 不能覆盖。
 * 用于凭据解析和日志关联，不参与信任判定。
 * 目标 origin 必须通过 `isOfficialMcpOriginTrusted` 的校验；插件身份本身不构成
 * 授权过滤条件。目的地校验与服务端接口权限、套餐、配额校验分别承担不同边界。
 */
export interface McpOfficialProvenance {
  pluginId: string;
  /** Plugin 内的原始 MCP key（未加 `plugin:<name>:` 命名空间前缀）。 */
  mcpKey: string;
  source: "plugin";
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  auth?: ACodeOfficialMcpAuthConfig;
  /** 宿主生成，禁止来自文件配置。 */
  official?: McpOfficialProvenance;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  auth?: ACodeOfficialMcpAuthConfig;
  /** 宿主生成，禁止来自文件配置。 */
  official?: McpOfficialProvenance;
}

export interface McpSseServerConfig extends McpServerConfigBase {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;
