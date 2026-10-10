// 编译校验的消费示例（架构 context 阅读包展示；不执行任何 IO——不读库、不触网、
// 不起定时器）：只演示 session contract.ts 公开面中纯函数与类型的典型用法；
// repo/service 实例由宿主注入，示例只消费其类型，不构造、不触达数据库。
import {
  computeNextRunAt,
  computeRetryAt,
  isValidCronExpr,
  DISPATCH_MAX_ATTEMPTS,
  type IACodeTaskService,
  type IOffPeakTaskService,
  type SessionMessageDeliveryResult,
  type SessionMessageSendRequested,
} from "./contract.js";

/** 重试退避：纯计算（base 30s、cap 15min、封顶 5 次）；claim/dispatch 状态唯一所有者是 AutomationRepo。 */
export function exampleNextRetryAt(now: number, attempts: number): number | null {
  if (attempts >= DISPATCH_MAX_ATTEMPTS) return null;
  return computeRetryAt(now, attempts);
}

/** cron 校验与下次运行时间：纯函数；调度行的持久化唯一所有者是 repo。 */
export function exampleNextAutomationRun(cronExpr: string, from: number): number | null {
  if (!isValidCronExpr(cronExpr)) return null;
  return computeNextRunAt(cronExpr, from);
}

/** 跨会话消息：请求自带 requestId，投递结果以 typed result 闭环（success/failed 二态 + 可选 error）。 */
export function exampleAckMessage(
  request: SessionMessageSendRequested,
): SessionMessageDeliveryResult {
  return {
    messageId: request.messageId,
    requestId: request.requestId,
    sessionId: request.toSessionId,
    status: "success",
  };
}

/** 服务描述符注入位：消费方以接口类型持有服务，不 import 实现类。 */
export type ExampleTaskServices = {
  tasks: IACodeTaskService;
  offPeak: IOffPeakTaskService;
};
