// ============================================================
// user/project 层 .mcp.json / config.json 的 per-server env 声明面拒绝门
// （specs/subprocess-env-credential-allowlist.md R4 接线需求②收口，M1 登记项）
// ============================================================
// 缺口：mcp/index.ts createTransport 的 stdio env 是
// `{...buildMcpStdioEnv(...), ...config.env}`——基座 env 虽经劫持闭集剥离，
// per-server 声明的 env 后置 spread 会原样重新引入 NODE_OPTIONS /
// ELECTRON_RUN_AS_NODE / LD_PRELOAD 等劫持键（克隆仓库的 .mcp.json 即可让
// MCP 子进程变成代码注入载体）。本门在**声明面**收口：配置解析层（唯一同时
// 看得见 server 与来源层的事实点）拒绝命中闭集键的 user/project server。
//
// 裁决与豁免（与 plugins/mcp.ts 的插件声明面门同源哲学）：
// - 「拒绝」优于「静默剥离」：整 server 跳过 + warn 日志（键名+层），配置作者
//   看得见原因；绝不带病启动一个行为悄然不同的 server。
// - 第一方豁免按**来源层**判定：system/env/cli 层是宿主注入路径（bootstrap
//   内置 node_repl 的 ELECTRON_RUN_AS_NODE 重建、官方插件运行时 manifest），
//   不经用户/项目文件声明面；user/project 层无豁免——第一方重建从不写这两层。
// - skip 而非 throw：配置合并发生在每次启动，throw 会让一个坏 .mcp.json 阻断
//   整个应用启动；跳过该 server 与既有 config_mcp_server_invalid 语义一致。

import { isExecHijackEnvKey } from "../exec/exec-hijack-env-guard.js";

/** 声明面层来源（config-factory 的 McpServerConfigSource 同形，避免循环引用）。 */
export type McpEnvGateSource = "system" | "project" | "user" | "env" | "cli";

/** 门只作用于文件声明面（user/project）；宿主注入层（system/env/cli）豁免。 */
const GATED_SOURCES: ReadonlySet<McpEnvGateSource> = new Set(["project", "user"]);

export type McpServerEnvGateVerdict =
  | { accepted: true }
  | { accepted: false; hijackKeys: string[] };

/** 拒绝事实（config-factory 汇总后逐条 warn；键名大写规范形态，只列名不列值）。 */
export interface McpServerEnvRejection {
  serverName: string;
  source: McpEnvGateSource;
  hijackKeys: string[];
}

/**
 * per-server env 拒绝门判定（纯函数）：env 非对象 = 无键可判（形态合法性归
 * schema 面，本门不重复裁决）；命中闭集键 → 拒绝并回传大写规范键名（日志用）。
 * 参数收 object 而非 `{env?: unknown}`：McpServerConfig 的 http/sse 变体没有 env
 * 属性，弱类型检测会拒绝联合赋值——本门只关心 env 键，形态判定在函数内完成。
 */
export function evaluateMcpServerEnvGate(
  server: object,
  source: McpEnvGateSource,
): McpServerEnvGateVerdict {
  if (!GATED_SOURCES.has(source)) return { accepted: true };
  const env = (server as { env?: unknown }).env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return { accepted: true };
  const hijackKeys = Object.keys(env as Record<string, unknown>)
    .filter((key) => isExecHijackEnvKey(key))
    .map((key) => key.trim().toUpperCase());
  return hijackKeys.length > 0 ? { accepted: false, hijackKeys } : { accepted: true };
}
