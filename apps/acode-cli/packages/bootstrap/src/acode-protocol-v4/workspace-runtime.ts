// workspace 运行时面的 v4 handler（apps/acode-cli/specs/m2-8-workspace-provider-process.md）。
//
// 实体自 legacy `acode-protocol/workspace-model-runtime.ts` 逐字迁入（M2-8：实体放 v4 目录，
// server.ts 只留一行转发，不在待删目录留实体债）。唯一改动：params/result 改 v4 schema
// （形状与 legacy 逐字 parity）。
import {
  v4WorkspaceReadPresentationParamsSchema,
  type V4WorkspacePresentation,
} from "@acode/shared/acode-protocol-v4";
import { listProtocolSlashCommands } from "../acode-protocol/slash-commands.js";
import {
  parseParams,
  type ACodeProtocolAgentServerContext,
} from "../acode-protocol/server-types.js";

export async function readWorkspacePresentationV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4WorkspacePresentation> {
  const params = parseParams(v4WorkspaceReadPresentationParamsSchema, rawParams);
  return {
    workspace: params.workspace,
    mode: "build" as const,
    slashCommands: await listProtocolSlashCommands({
      // 灰度门是 Host 判定的 workspace 级事实，目录装配读进程缓存。
      dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
      // 脚本工作流门同读进程缓存（v4 createSession 时机刷新，server-types.ts 注释）。
      scriptWorkflowEnabled: context.appRuntimePreferences.scriptWorkflowEnabled,
      env: context.deps.env,
      logger: context.logger,
      workingDirectory: params.workspace.workspacePath,
    }),
  };
}
