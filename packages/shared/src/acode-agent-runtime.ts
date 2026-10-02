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
 * 引擎作用域的运行时描述符。外部引擎槽位已下线（spec: agent-engine-external-slots-removal.md），
 * 当前恒等于 native(glm)；保留引擎入参以维持调用方形状，未知值一律回退 native。
 */
export function getEngineRuntime(
  _engineId?: ACodeProvider | string | null,
): ACodeAgentRuntimeDescriptor {
  return ACODE_AGENT_RUNTIME;
}

export function getACodeAgentRuntime(): ACodeAgentRuntimeDescriptor {
  return ACODE_AGENT_RUNTIME;
}
