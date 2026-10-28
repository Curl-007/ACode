/**
 * workspace prepare 的协议 RPC 收口。
 *
 * 拆出原因：useWorkspacePrepare.ts 只保留可单测的轻量判定入口；
 * 这里只读取 workspace presentation（slash commands）；模型选择事实由目标 Host View 提供。
 *
 * **mode 来源裁决（2026-10-28，spec `packages/ui/specs/workspace-prepare-mode-source.md`）**：
 * mode 从来不是协议事实——legacy `readWorkspacePresentation`
 * （`apps/acode-cli/.../workspace-model-runtime.ts:26`）硬编码 `mode: "build" as const`，
 * 不读任何持久/运行态。故本函数不再采信 `presentation.mode`，直接用 shared 权威 5 档表
 * + `currentValue: "build"` 硬编码。slashCommands 仍是真实协议事实，继续从协议读取
 * （归 M2 切换 v4，本决策不动）。
 */
import type { IACodeSessionService } from "@acode/services";
import { type ACodeProvider, type ACodeWorkspacePrepareResult } from "@acode/shared";
import { getChatErrorMessage } from "@/lib/chatPrepareError.js";
import { logger } from "@/logger.js";
import { acodeWorkspacePresentationToConfigOptions } from "@/lib/workspaceModeConfigOptions.js";

/**
 * 预热路径的 mode 常量。legacy 协议硬编码 build（见头注），UI 侧采信同一常量。
 * 提取为命名常量避免在业务逻辑中散落字面量（AGENTS.md CLI 规则）。
 */
const PREPARE_MODE_CONSTANT = "build" as const;

export async function prepareWorkspaceWithACodeSessionService(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider: ACodeProvider;
  acodeSessionService: Pick<IACodeSessionService, "readWorkspacePresentation">;
}): Promise<ACodeWorkspacePrepareResult> {
  const startedAt = Date.now();
  logger.info("[acode-workspace-presentation] workspace prepare start", {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity ?? null,
    provider: params.provider,
  });

  // 只取 slashCommands——mode 字段不采信（见头注裁决）。
  let slashCommands: Awaited<
    ReturnType<IACodeSessionService["readWorkspacePresentation"]>
  >["slashCommands"];
  try {
    const presentation = await params.acodeSessionService.readWorkspacePresentation({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    slashCommands = presentation.slashCommands;
  } catch (error) {
    logger.warn("[acode-workspace-presentation] readWorkspacePresentation failed", {
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity ?? null,
      provider: params.provider,
      durationMs: Date.now() - startedAt,
      error: getChatErrorMessage(error),
    });
    throw error;
  }

  const readPresentationDurationMs = Date.now() - startedAt;
  const configOptions = acodeWorkspacePresentationToConfigOptions(PREPARE_MODE_CONSTANT);
  const totalDurationMs = Date.now() - startedAt;
  logger.info("[acode-workspace-presentation] readWorkspacePresentation done", {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity ?? null,
    provider: params.provider,
    readPresentationDurationMs,
    totalDurationMs,
    configOptionsCount: configOptions.length,
    modeCurrent: PREPARE_MODE_CONSTANT,
  });

  return {
    workspacePath: params.workspacePath,
    preparedSessionId: "",
    version: "ACode Protocol/1",
    provider: params.provider,
    configOptions,
    slashCommands,
  };
}
