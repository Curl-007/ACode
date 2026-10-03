import type { ACodeAutomationBotDeliveryTarget } from "@acode/shared";

interface CronBotDeliveryRepo {
  getBotDeliveryTarget(
    automationId: string,
    workspaceKey?: string,
  ): Promise<ACodeAutomationBotDeliveryTarget | undefined>;
}

interface CronBotDeliveryService {
  watchAutomationRun(params: {
    target: ACodeAutomationBotDeliveryTarget;
    taskId: string;
    runId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
}

/**
 * 在 prompt 派发前完成 Bot 终态订阅，避免快速任务先完成、后注册 listener 而漏回推。
 */
export async function watchCronRunBotDelivery(params: {
  automationId: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  /** heartbeat 协议 R3：run 台账 id，透传给 bots 侧做诊断关联。 */
  runId: string;
  repo: CronBotDeliveryRepo;
  botsService: CronBotDeliveryService;
}): Promise<boolean> {
  const target = await params.repo.getBotDeliveryTarget(params.automationId, params.workspaceKey);
  if (!target) return false;
  await params.botsService.watchAutomationRun({
    target,
    taskId: params.taskId,
    runId: params.runId,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  });
  return true;
}
