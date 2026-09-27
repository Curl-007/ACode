import { existsSync } from "node:fs";
import {
  getEngineRuntime,
  resolveAgentEngine,
  type ACodeProvider,
} from "@acode/shared";
import { findACodeAgentRuntimeBinary } from "../runtime-tools/providerRuntimeResolver.js";
import type { ACodeAgentCommand } from "./acodeAgentProcessManager.js";

/**
 * 外部引擎（codex/opencode/gemini）命令解析。
 *
 * 与 native(glm) 路径分离：native 走 acodeAgentProcessManager 内既有的
 * bundled/Electron/deployed 候选链；外部引擎默认不随包 bundle，多由用户自装，
 * 因此「未安装 / 运行时缺失」是常见路径，必须 surface 清晰的 missingBinaryMessage。
 *
 * 注意：外部引擎的会话协议适配器尚未接入（registry implemented:false）。本解析只负责
 * 定位 binary 与构造 spawn 命令，供「引擎是否安装」探测与诊断使用；真正驱动会话需要
 * 各自的 CLI 协议桥（净新增，ZCode 无参考），不在本层范围。
 */
export interface ExternalEngineCommandResult {
  command: ACodeAgentCommand | null;
  /** binary 未命中时的引擎专属诊断文案；命中时为 undefined。 */
  missingBinaryMessage?: string;
}

export function resolveExternalEngineCommand(
  engineId: ACodeProvider | string | null | undefined,
  workspacePath: string,
): ExternalEngineCommandResult {
  const engine = resolveAgentEngine(engineId);
  if (engine.native) {
    // native 不走外部解析；调用方应使用既有 native 候选链。
    return { command: null };
  }

  const runtime = getEngineRuntime(engine.id);
  const envPath = process.env[runtime.binaryEnvVar]?.trim();
  const binaryPath =
    envPath && existsSync(envPath) ? envPath : findACodeAgentRuntimeBinary(engine.id);

  if (!binaryPath) {
    return { command: null, missingBinaryMessage: runtime.missingBinaryMessage };
  }

  return {
    command: {
      command: binaryPath,
      args: [...runtime.spawnArgs],
      cwd: workspacePath,
    },
  };
}
