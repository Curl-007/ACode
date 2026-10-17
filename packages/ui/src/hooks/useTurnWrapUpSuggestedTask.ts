// 建议任务卡动作面（packages/ui/specs/turn-wrap-up-card.md「动作面」/ CLI spec R7）。
// 「发起为新任务」完全复用 root「新建任务」（useRootWorkspaceActions.startNewTaskFromActiveWorkspace）
// 的同一组 store 动作序列——单一写入路径，本 hook 只把落点绑定到卡片所在会话的 workspace 身份
// （ConversationRowRenderContext.workspacePath/workspaceIdentity），不做第二份状态。
import { useCallback } from "react";
import { toast } from "@/components/ui/toast.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useACodeSessionStore } from "@/store/acodeSessionStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { persistV4ComposerDraft, V4_DRAFT_SCOPE_ROOT } from "@/v4/composer/composerDraftStore.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { TURN_WRAP_UP_LABEL_KEYS, formatTurnWrapUpLabel } from "@/v4/turnWrapUpLabels.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

export interface TurnWrapUpSuggestedTaskActions {
  /** 以 prompt 预填发起新任务草稿（不自动发送——root initialPrompt 同款语义）。 */
  startAsNewTask: (prompt: string) => void;
  copyPrompt: (prompt: string) => Promise<void>;
}

export function useTurnWrapUpSuggestedTask(
  workspacePath: string,
  workspaceIdentity?: string,
): TurnWrapUpSuggestedTaskActions {
  const tabStoreApi = useTabStoreApi();
  const { intl } = useACodeIntl();

  const startAsNewTask = useCallback(
    (prompt: string) => {
      const text = prompt.trim();
      if (!text) return;
      const tabState = tabStoreApi.getState();
      // 启动期失效 workspace 必须在动作边界再次校验（root 同款边界，仅禁用按钮不够）。
      if (isWorkspaceReadOnly(tabState, workspacePath, workspaceIdentity)) return;
      if (
        !tabState.activateTabByPath(
          workspacePath,
          workspaceIdentity ? { workspaceIdentity } : undefined,
        )
      ) {
        tabState.addTab(workspacePath, workspaceIdentity ? { workspaceIdentity } : undefined);
      }
      useWorkbenchGroupStore.getState().deactivateActiveGroup();
      usePaneLayoutStore.getState().resetToPrimaryPane();
      useACodeSessionStore
        .getState()
        .startDraft(workspacePath, undefined, workspaceIdentity, { createSource: "project" });
      // 先写草稿事实源、再发即时插入请求（root 同款双写顺序）：当前 composer 立即可见，
      // 后续因 pane/config 切换 remount 时新 composer 从草稿恢复同一文本。
      persistV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, { text });
      useACodeSessionStore
        .getState()
        .requestComposerTextInsert(workspacePath, text, workspaceIdentity);
    },
    [tabStoreApi, workspaceIdentity, workspacePath],
  );

  const copyPrompt = useCallback(
    async (prompt: string) => {
      try {
        await navigator.clipboard.writeText(prompt);
        toast(formatTurnWrapUpLabel(intl, TURN_WRAP_UP_LABEL_KEYS.copiedPrompt));
      } catch (error) {
        // 剪贴板权限是环境事实：失败静默（只留日志），不弹错误对话框（spec 失败语义）。
        logger.warn("[TurnWrapUp] copy prompt failed", { error });
      }
    },
    [intl],
  );

  return { copyPrompt, startAsNewTask };
}
