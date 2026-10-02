import { useRef, useState } from "react";
import type {
  ACodePermissionOption,
  ACodePermissionRequest,
  ACodeProvider,
} from "@acode/shared";
import type { ConversationSnapshot } from "@acode/shared/acode-protocol-v4";
import { PermissionDialog } from "@/PermissionDialog.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  getTaskUiState,
  getWorkspaceState,
  useACodeSessionStore,
} from "@/store/acodeSessionStore.js";
import {
  buildTaskRespondPermissionParams,
  selectFallbackPermissionRequest,
} from "@/v4/botPermissionFallback.js";

interface BotPermissionFallbackProps {
  currentSnapshot: ConversationSnapshot | null;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ACodeProvider;
}

/**
 * bot 任务权限的桌面兜底批准入口（规格见 bot-permission-local-approval.md R1.2）。
 *
 * V4 snapshot 缺失该权限交互时（订阅不健康或事件竞态），从广播回放进 store 的权限队列
 * 里选出兜底请求渲染弹窗。与 snapshot 按 requestId≡interactionId 去重后只有确实缺失的
 * 请求才渲染；否则返回 null，让 snapshot 权威路径优先。
 *
 * 两个 store selector 分别返回稳定引用（request 对象与队列数组），避免组合成新对象
 * 触发 zustand 无限重渲染。内层弹窗以 requestId 为 key，保证连续请求重建输入焦点状态。
 */
export function BotPermissionFallback({
  currentSnapshot,
  sessionId,
  workspacePath,
  workspaceIdentity,
  provider,
}: BotPermissionFallbackProps) {
  const botPermissionRequest = useACodeSessionStore(
    (state) =>
      getTaskUiState(getWorkspaceState(state, workspacePath, workspaceIdentity), sessionId)
        .permissionRequest,
  );
  const botPendingPermissionRequests = useACodeSessionStore(
    (state) =>
      getTaskUiState(getWorkspaceState(state, workspacePath, workspaceIdentity), sessionId)
        .pendingPermissionRequests,
  );
  const fallbackRequest = selectFallbackPermissionRequest(currentSnapshot?.pendingInteractions, {
    permissionRequest: botPermissionRequest,
    pendingPermissionRequests: botPendingPermissionRequests,
  });
  if (!fallbackRequest) {
    return null;
  }
  return (
    <BotPermissionFallbackDialog
      key={fallbackRequest.requestId}
      request={fallbackRequest}
      sessionId={sessionId}
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      provider={provider}
    />
  );
}

interface BotPermissionFallbackDialogProps {
  request: ACodePermissionRequest;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ACodeProvider;
}

/**
 * 单个兜底权限请求的弹窗。响应经 acodeTaskService.respondPermission 落地（task 级 RPC，
 * 不依赖 session 订阅健康）。本实例只服务一个 requestId（由外层 key 保证），故
 * responding/failed 状态与单飞防重入无需跨请求复位。
 */
function BotPermissionFallbackDialog({
  request,
  sessionId,
  workspacePath,
  workspaceIdentity,
  provider,
}: BotPermissionFallbackDialogProps) {
  const services = useOptionalServices();
  const { intl } = useACodeIntl();
  const [response, setResponse] = useState<{ pending: boolean; failed: boolean }>({
    pending: false,
    failed: false,
  });
  const flightRef = useRef(false);
  const requestId = request.requestId;

  return (
    <PermissionDialog
      request={request}
      workspacePath={workspacePath}
      provider={provider}
      responding={response.pending}
      responseError={
        response.failed ? intl.formatMessage({ id: "chat.permission.responseFailed" }) : undefined
      }
      onRespond={(_respondedId: string, option: ACodePermissionOption) => {
        if (!services || flightRef.current) return;
        flightRef.current = true;
        setResponse({ pending: true, failed: false });
        void services.acodeTaskService
          .respondPermission(
            buildTaskRespondPermissionParams({
              taskId: sessionId,
              workspacePath,
              workspaceIdentity,
              request,
              option,
            }),
          )
          .then((submitted) => {
            flightRef.current = false;
            if (submitted) {
              // 本地乐观出队；广播 permission_resolved 的二次清理与此幂等。
              useACodeSessionStore
                .getState()
                .removeTaskPermissionRequest(
                  workspacePath,
                  sessionId,
                  requestId,
                  workspaceIdentity,
                );
            }
            setResponse({ pending: false, failed: !submitted });
          })
          .catch((error) => {
            logger.error("[v4-interaction] 兜底 respondPermission 失败", { requestId, error });
            flightRef.current = false;
            setResponse({ pending: false, failed: true });
          });
      }}
    />
  );
}
