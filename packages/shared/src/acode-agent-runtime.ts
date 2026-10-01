import type { ACodeProvider } from "./acode-task-types-core.js";
import { resolveAgentEngine } from "./acode-agent-registry.js";

export type ACodeAgentBinaryKind = "native-binary";

/**
 * J5-L1：桌面生产 agent 的 V8 字节码加载器入口文件名。
 * 字节码严格绑定编译时的 Electron/V8/平台/架构（指纹校验由 loader 在 agent 进程内权威执行）；
 * 生产 resolver 选用 loader 时设 ACODE_BYTECODE_FALLBACK=1，loader 失配则优雅回退 acode.cjs
 * （spec: packages/desktop/specs/agent-bytecode-production.md）。
 * 仅 native(glm) 随包带字节码；外部引擎（codex/opencode/gemini）不 bundle，无此入口。
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
 * 外部引擎的运行时描述符基线。
 *
 * 外部引擎默认不随包 bundle，binary 由用户自行安装（codex/opencode/gemini CLI），
 * 因此 missingBinaryMessage 是常见路径而非异常。spawnArgs 给出各 CLI 的「服务/协议」入口约定，
 * 但会话协议适配器尚未接入（registry implemented:false）；binary 发现与诊断已可用。
 */
function externalEngineRuntime(
  engineId: Exclude<ACodeProvider, "glm">,
  config: {
    binaryEnvVar: string;
    bundledResourceDir: string;
    binaryName: string;
    spawnArgs: string[];
    missingBinaryMessage: string;
  },
): ACodeAgentRuntimeDescriptor {
  return {
    binaryKind: "native-binary",
    binaryEnvVar: config.binaryEnvVar,
    bundledResourceDir: config.bundledResourceDir,
    version: "0.0.0",
    spawnArgs: config.spawnArgs,
    nativeConfigDir: `.acode/cli/${engineId}`,
    nativeConfigFileName: "config.json",
    missingBinaryMessage: config.missingBinaryMessage,
    resolveEntrySegments: (platform) => [resolvePlatformBinaryName(config.binaryName, platform)],
    nodeBundleEntryFile: `${engineId}.cjs`,
    resolveNodeBundleSegments() {
      return [this.nodeBundleEntryFile];
    },
  };
}

export const ACODE_AGENT_ENGINE_RUNTIMES: Readonly<Record<ACodeProvider, ACodeAgentRuntimeDescriptor>> =
  {
    glm: ACODE_AGENT_RUNTIME,
    codex: externalEngineRuntime("codex", {
      binaryEnvVar: "CODEX_BINARY_PATH",
      bundledResourceDir: "codex",
      binaryName: "codex",
      // codex 的 stdio 协议入口；适配器未接入前仅用于命令解析与探测。
      spawnArgs: ["proto"],
      missingBinaryMessage:
        "[ACode Agent] codex binary 未找到，请安装 Codex CLI 或设置 CODEX_BINARY_PATH",
    }),
    opencode: externalEngineRuntime("opencode", {
      binaryEnvVar: "OPENCODE_BINARY_PATH",
      bundledResourceDir: "opencode",
      binaryName: "opencode",
      spawnArgs: ["serve", "--stdio"],
      missingBinaryMessage:
        "[ACode Agent] opencode binary 未找到，请安装 OpenCode CLI 或设置 OPENCODE_BINARY_PATH",
    }),
    gemini: externalEngineRuntime("gemini", {
      binaryEnvVar: "GEMINI_BINARY_PATH",
      bundledResourceDir: "gemini",
      binaryName: "gemini",
      spawnArgs: ["--stdio"],
      missingBinaryMessage:
        "[ACode Agent] gemini binary 未找到，请安装 Gemini CLI 或设置 GEMINI_BINARY_PATH",
    }),
  };

/** 引擎作用域的运行时描述符读取入口。缺省/未知回退 native。 */
export function getEngineRuntime(engineId?: ACodeProvider | string | null): ACodeAgentRuntimeDescriptor {
  return ACODE_AGENT_ENGINE_RUNTIMES[resolveAgentEngine(engineId).id];
}

export function getACodeAgentRuntime(): ACodeAgentRuntimeDescriptor {
  return ACODE_AGENT_RUNTIME;
}
