import type { ACodeProvider } from "./acode-task-types-core.js";

export type ACodeAgentBinaryKind = "native-binary";

/**
 * J5-L1：桌面生产 agent 的 V8 字节码加载器入口文件名。
 * 字节码严格绑定编译时的 Electron/V8/平台/架构（指纹校验由 loader 在 agent 进程内权威执行）；
 * 生产 resolver 选用 loader 时设 ACODE_BYTECODE_FALLBACK=1，loader 失配则优雅回退 acode.cjs
 * （spec: packages/desktop/specs/agent-bytecode-production.md）。
 */
export const ACODE_AGENT_BYTECODE_ENTRY_FILE = "acode.bytecode.cjs";

export interface ACodeAgentRuntimeDescriptor {
  binaryKind: ACodeAgentBinaryKind;
  binaryEnvVar: string;
  bundledResourceDir: string;
  version: string;
  spawnArgs: string[];
  nativeConfigDir: string;
  nativeConfigFileName: string;
  missingBinaryMessage: string;
  resolveEntrySegments(platform: string): string[];
  /**
   * 桌面端把 agent 的 JS bundle（acode.cjs）打进 resources/glm，由 app 内置的 Electron Node runtime
   * （ELECTRON_RUN_AS_NODE）直接执行，避免再随包内置一份独立 Node 二进制。
   * 这里只放纯 JS 入口文件名，平台无关（与 resolveEntrySegments 的原生二进制路径平行）。
   */
  nodeBundleEntryFile: string;
  resolveNodeBundleSegments(): string[];
}

export function resolvePlatformBinaryName(binaryName: string, platform: string): string {
  return platform === "win32" ? `${binaryName}.exe` : binaryName;
}

export const ACODE_AGENT_RUNTIME: ACodeAgentRuntimeDescriptor = {
  binaryKind: "native-binary",
  binaryEnvVar: "GLM_BINARY_PATH",
  bundledResourceDir: "glm",
  version: "0.13.3",
  spawnArgs: ["app-server", "--stdio"],
  nativeConfigDir: ".acode/cli",
  nativeConfigFileName: "config.json",
  missingBinaryMessage:
    "[ACode Agent] glm binary 未找到，请设置 GLM_BINARY_PATH 或先准备 GLM 运行时资源",
  resolveEntrySegments: (platform) => [resolvePlatformBinaryName("acode-agent", platform)],
  nodeBundleEntryFile: "acode.cjs",
  resolveNodeBundleSegments() {
    return [this.nodeBundleEntryFile];
  },
};

/**
 * jcode 引擎的运行时描述符（spec: packages/shared/specs/agent-engine-jcode-slot.md R3）。
 *
 * 与 native 的**唯一实质差异是 spawnArgs**：jcode-bridge 是同一个 acode.cjs bundle 的子命令
 * （apps/acode-cli/packages/cli/src/run.ts 的 case "jcode-bridge"，A.9 实测已在 bundle 内），
 * 所以 bundledResourceDir / nodeBundleEntryFile / nativeConfigDir 全部与 glm 相同——不额外
 * 分发一份 bundle，只换启动的子命令。shim 内部再 spawn jcode 本体（走 --jcode-binary，
 * 见 agent-engine-jcode-slot.md R5，由 Settings 显式配置而非 ACode 的 binary 候选链）。
 *
 * binaryEnvVar 用 JCODE_BINARY_PATH：与 GLM_BINARY_PATH 平行，仅 dev/远端非打包态生效，
 * 打包态被 agent-command-env-gate.md R1 统一忽略（不因新增引擎而放宽门禁）。
 * resolveEntrySegments 指向 acode-agent 形状保留但实际不被 jcode 路径消费（桌面走 node
 * bundle，远端 SSH 部署 jcode 引擎不在本期范围）。
 */
export const ACODE_JCODE_AGENT_RUNTIME: ACodeAgentRuntimeDescriptor = {
  binaryKind: "native-binary",
  binaryEnvVar: "JCODE_BINARY_PATH",
  bundledResourceDir: "glm",
  version: ACODE_AGENT_RUNTIME.version,
  spawnArgs: ["jcode-bridge", "--stdio"],
  nativeConfigDir: ".acode/cli",
  nativeConfigFileName: "config.json",
  missingBinaryMessage:
    "[ACode Agent] jcode 引擎的 ACode CLI bundle 未找到，请先准备运行时资源（jcode 本体路径由 Settings 配置）",
  resolveEntrySegments: (platform) => [resolvePlatformBinaryName("acode-agent", platform)],
  nodeBundleEntryFile: "acode.cjs",
  resolveNodeBundleSegments() {
    return [this.nodeBundleEntryFile];
  },
};

/**
 * 引擎作用域的运行时描述符（spec: agent-engine-jcode-slot.md R1/R3）。
 *
 * 按 engineId dispatch：jcode → ACODE_JCODE_AGENT_RUNTIME（spawnArgs 走 jcode-bridge 子命令），
 * 其余（含 native glm、空值、未知/旧值如已下线的 codex/opencode/gemini）→ native runtime。
 * 曾是恒返回 ACODE_AGENT_RUNTIME（单引擎时代的形状保留）——那会让 jcode 拿到 glm 的
 * spawnArgs（app-server），启动的是 native agent 而非桥接，属静默错误。
 *
 * 归一口径与 acode-agent-registry 的 resolveAgentEngine 一致：非 jcode 一律回退 native。
 */
export function getEngineRuntime(
  engineId?: ACodeProvider | string | null,
): ACodeAgentRuntimeDescriptor {
  return engineId === "jcode" ? ACODE_JCODE_AGENT_RUNTIME : ACODE_AGENT_RUNTIME;
}

export function getACodeAgentRuntime(): ACodeAgentRuntimeDescriptor {
  return ACODE_AGENT_RUNTIME;
}
