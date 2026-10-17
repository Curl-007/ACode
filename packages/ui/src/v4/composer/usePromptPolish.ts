import { useCallback, useEffect, useRef, useState } from "react";
import { useACodeAgentService } from "@/hooks/useACodeAgentService.js";
import { logger } from "@/logger.js";
import {
  loadPromptPolishModelPreference,
  normalizePromptPolishModelSelection,
  setPromptPolishModelPreference,
  type PromptPolishModelSelection,
} from "@/lib/promptPolishPreferences.js";
import { useACodeSessionStore } from "@/store/acodeSessionStore.js";
import { subscribeToComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import {
  preparePromptPolishRequest,
  resolvePromptPolishModel,
  type PromptPolishCatalog,
  type PromptPolishModelTier,
} from "@/v4/composer/promptPolishModel.js";

// 提示词润色调用 hook（specs/prompt-polish.md 产品规则 2–5）。
// 依赖注入纪律：草稿读取/替换/还原全部经 options 注入（默认替换通道 =
// acodeSessionStore 单例的 requestComposerTextInsert(mode:"replace")），
// 不改 SessionPane/ConversationComposer/store index；本 hook 处于 inert-until-wired 状态。

export interface PromptPolishDraftSnapshot {
  text: string;
  /** Lexical editorState JSON；还原时优先回灌（restoreSubmittedDraft 先例），缺省退化为纯文本。 */
  editorStateJson?: string | null;
  /** composerDraftRevision：发请求前快照，回包时比对，防迟到回包覆盖用户新编辑。 */
  revision: number;
}

export type PromptPolishStatus = "idle" | "polishing" | "restorable";

export type PromptPolishErrorKind =
  | "empty-draft"
  | "no-model"
  | "failed"
  | "cancelled"
  /** 等待期间用户编辑了草稿，回包被丢弃（revision guard）。 */
  | "stale";

export interface PromptPolishError {
  kind: PromptPolishErrorKind;
  message?: string;
}

export interface UsePromptPolishOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  /**
   * 会话/scope 键（建议传 sessionId）：变化即视为切换会话——中止在飞请求、
   * 清除可还原态与本次 explicit 覆盖（spec 产品规则 4：还原态持续到切会话为止）。
   */
  scopeKey?: string;
  /** 模型目录（ModelConfigSelect 同源的 ModelSelectionView 结构兼容）。 */
  catalog?: PromptPolishCatalog | null;
  /** 当前会话模型（解析阶梯 session 档）。 */
  sessionSelection?: PromptPolishModelSelection | null;
  getDraftSnapshot: () => PromptPolishDraftSnapshot | null;
  /** 缺省走 acodeSessionStore 单例 requestComposerTextInsert(mode:"replace")。 */
  replaceDraftText?: (text: string) => void;
  /** 可回灌 editorStateJson 的还原通道；返回 false 表示还原未生效（保持还原态）。 */
  restoreDraftSnapshot?: (snapshot: PromptPolishDraftSnapshot) => boolean | void;
  /** 偏好写入口；缺省直接写 lib（store 接线后应换 store setter 以获得跨窗广播）。 */
  persistModelSelection?: (selection: PromptPolishModelSelection | null) => void;
  maxOutputTokens?: number;
  /** 透传协议层 RPC 超时（thinking 模型长请求，见 ACodeAgentGenerateWorkspaceTextParams）。 */
  requestTimeoutMs?: number;
}

export interface UsePromptPolishResult {
  status: PromptPolishStatus;
  /** 草稿非空白且不在润色中。 */
  canPolish: boolean;
  /** 还原态且草稿仍是本次润色写入的正文（用户编辑/提交后自动失效）。 */
  canRestore: boolean;
  error: PromptPolishError | null;
  resolvedModel: PromptPolishModelSelection | null;
  resolvedModelSource: PromptPolishModelTier | null;
  polish: () => void;
  cancel: () => void;
  restore: () => void;
  /** 右键菜单选中：持久化偏好 + 作为本次 explicit 覆盖。 */
  selectModel: (selection: PromptPolishModelSelection) => void;
  dismissError: () => void;
}

export function usePromptPolish(options: UsePromptPolishOptions): UsePromptPolishResult {
  const {
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeKey,
    catalog,
    sessionSelection,
    getDraftSnapshot,
    replaceDraftText,
    restoreDraftSnapshot,
    persistModelSelection,
    maxOutputTokens,
    requestTimeoutMs,
  } = options;

  const agentService = useACodeAgentService(workspacePath, remoteSessionId, workspaceIdentity);

  const [status, setStatus] = useState<PromptPolishStatus>("idle");
  const [error, setError] = useState<PromptPolishError | null>(null);
  const [explicitSelection, setExplicitSelection] = useState<PromptPolishModelSelection | null>(
    null,
  );

  const statusRef = useRef(status);
  statusRef.current = status;
  // 跨 RPC 取消面（specs/prompt-polish.md）：renderer 不得把 AbortSignal 传给服务
  // 代理——序列化产物缺 addEventListener，host 侧接线即抛 TypeError（E2E D1 回归）。
  // 取消 = operationId + 服务端 cancelWorkspaceGenerateText（best-effort），本地由
  // cancelRequested + 代际号保证迟到回包不落地。
  const activeOpRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef<string | null>(null);
  // 请求代际号：取消/切会话/卸载后自增，在飞回包比对失败即整体丢弃。
  const requestSeqRef = useRef(0);
  const restoreRef = useRef<{ original: PromptPolishDraftSnapshot; replacedText: string } | null>(
    null,
  );

  // 回调经 ref 取最新值，polish/restore 引用保持稳定（调用方不必 memo options 函数）。
  const getDraftSnapshotRef = useRef(getDraftSnapshot);
  getDraftSnapshotRef.current = getDraftSnapshot;
  const defaultReplaceDraftText = useCallback(
    (text: string) => {
      useACodeSessionStore
        .getState()
        .requestComposerTextInsert(workspacePath, text, workspaceIdentity, undefined, "replace");
    },
    [workspaceIdentity, workspacePath],
  );
  const replaceDraftTextRef = useRef<(text: string) => void>(defaultReplaceDraftText);
  replaceDraftTextRef.current = replaceDraftText ?? defaultReplaceDraftText;
  const restoreDraftSnapshotRef = useRef(restoreDraftSnapshot);
  restoreDraftSnapshotRef.current = restoreDraftSnapshot;

  // 解析阶梯每次现算：persisted 档读 localStorage（唯一事实源），不缓存陈旧值。
  const resolution = resolvePromptPolishModel({
    explicit: explicitSelection,
    persisted: loadPromptPolishModelPreference(),
    session: sessionSelection,
    catalog,
  });
  const resolvedModel = resolution.status === "resolved" ? resolution.selection : null;
  const resolvedModelSource = resolution.status === "resolved" ? resolution.source : null;

  const cancelActiveOperation = useCallback(() => {
    const operationId = activeOpRef.current;
    if (!operationId) return;
    activeOpRef.current = null;
    cancelRequestedRef.current = operationId;
    void agentService
      .cancelWorkspaceGenerateText({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        operationId,
      })
      .catch(() => {
        // best-effort：取消通知失败由代际号/cancelRequested 守卫兜底丢弃回包。
      });
  }, [agentService, remoteSessionId, workspaceIdentity, workspacePath]);

  const resetToIdle = useCallback(() => {
    requestSeqRef.current += 1;
    cancelActiveOperation();
    restoreRef.current = null;
    setStatus("idle");
  }, [cancelActiveOperation]);

  // 切换会话/scope：中止在飞请求，还原态与本次 explicit 覆盖都不跨会话保留。
  const lastScopeKeyRef = useRef(scopeKey);
  useEffect(() => {
    if (lastScopeKeyRef.current === scopeKey) return;
    lastScopeKeyRef.current = scopeKey;
    resetToIdle();
    setExplicitSelection(null);
    setError(null);
  }, [scopeKey, resetToIdle]);

  // 卸载即收口：迟到回包由代际号拦截，不写任何状态；在飞请求 best-effort 通知取消。
  // 经 ref 取最新 cancel 函数，避免其依赖变化触发本 effect 重跑（重跑=误取消在飞请求）。
  const cancelActiveOperationRef = useRef(cancelActiveOperation);
  cancelActiveOperationRef.current = cancelActiveOperation;
  useEffect(() => {
    return () => {
      requestSeqRef.current += 1;
      cancelActiveOperationRef.current();
    };
  }, []);

  const polish = useCallback(() => {
    // 润色中禁重复触发（spec 产品规则 5）。
    if (statusRef.current === "polishing") return;
    const snapshot = getDraftSnapshotRef.current();
    const prepared = preparePromptPolishRequest({
      draftText: snapshot?.text ?? "",
      resolution: resolvePromptPolishModel({
        explicit: explicitSelection,
        persisted: loadPromptPolishModelPreference(),
        session: sessionSelection,
        catalog,
      }),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    });
    if (!prepared.ok) {
      // 空草稿/无可用模型：可读回执，零请求发出（spec 产品规则 2/5）。
      setError({ kind: prepared.issue });
      return;
    }
    const operationId = generatePolishOperationId();
    activeOpRef.current = operationId;
    cancelRequestedRef.current = null;
    const seq = ++requestSeqRef.current;
    const sentRevision = snapshot?.revision ?? 0;
    setError(null);
    setStatus("polishing");
    void agentService
      .generateWorkspaceText({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        selection: {
          providerId: prepared.selection.providerId,
          modelId: prepared.selection.modelId,
        },
        messages: prepared.messages,
        querySource: prepared.querySource,
        maxOutputTokens: prepared.maxOutputTokens,
        operationId,
        ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
      })
      .then((result) => {
        if (seq !== requestSeqRef.current) return;
        if (cancelRequestedRef.current === operationId) {
          // 取消与完成赛跑输了：丢弃结果回待机态，不替换草稿。
          setStatus("idle");
          setError({ kind: "cancelled" });
          return;
        }
        // revision guard：等待期间用户已编辑 → 丢弃迟到回包，绝不覆盖新编辑。
        const current = getDraftSnapshotRef.current();
        if (!snapshot || !current || current.revision !== sentRevision) {
          restoreRef.current = null;
          setStatus("idle");
          setError({ kind: "stale" });
          return;
        }
        const polished = result.text;
        if (!polished.trim()) {
          // 空回执视同失败：不动草稿，也不进入可还原态。
          setStatus("idle");
          setError({ kind: "failed" });
          return;
        }
        // 原文（text+editorStateJson）保存在组件态，供可还原态回灌。
        restoreRef.current = { original: snapshot, replacedText: polished };
        replaceDraftTextRef.current(polished);
        setStatus("restorable");
      })
      .catch((requestError: unknown) => {
        if (seq !== requestSeqRef.current) return;
        setStatus("idle");
        if (cancelRequestedRef.current === operationId) {
          // 取消回到待机态（spec 产品规则 5）。
          setError({ kind: "cancelled" });
          return;
        }
        const message = requestError instanceof Error ? requestError.message : String(requestError);
        logger.warn("[prompt-polish] 润色请求失败", {
          workspacePath,
          providerId: prepared.selection.providerId,
          modelId: prepared.selection.modelId,
          error: message,
        });
        // 失败回执不动草稿。
        setError({ kind: "failed", message });
      })
      .finally(() => {
        if (seq === requestSeqRef.current && activeOpRef.current === operationId) {
          activeOpRef.current = null;
        }
      });
  }, [
    agentService,
    catalog,
    explicitSelection,
    maxOutputTokens,
    remoteSessionId,
    requestTimeoutMs,
    sessionSelection,
    workspaceIdentity,
    workspacePath,
  ]);

  const cancel = useCallback(() => {
    cancelActiveOperation();
  }, [cancelActiveOperation]);

  const restore = useCallback(() => {
    const saved = restoreRef.current;
    if (!saved || statusRef.current !== "restorable") return;
    const current = getDraftSnapshotRef.current();
    // 还原态窗口守卫：正文已不是本次润色写入的（用户编辑/提交）→ 还原态作废，不覆盖。
    if (!current || current.text !== saved.replacedText) {
      restoreRef.current = null;
      setStatus("idle");
      return;
    }
    const restoreSnapshot = restoreDraftSnapshotRef.current;
    if (restoreSnapshot) {
      if (restoreSnapshot(saved.original) === false) return;
    } else {
      replaceDraftTextRef.current(saved.original.text);
    }
    restoreRef.current = null;
    setStatus("idle");
  }, []);

  const selectModel = useCallback(
    (selection: PromptPolishModelSelection) => {
      const normalized = normalizePromptPolishModelSelection(selection);
      if (!normalized) return;
      // 选中即持久化 + 作为本次 explicit 覆盖（spec 产品规则 1）。
      if (persistModelSelection) {
        persistModelSelection(normalized);
      } else {
        setPromptPolishModelPreference(normalized);
      }
      setExplicitSelection(normalized);
    },
    [persistModelSelection],
  );

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  // 展示态探针（E2E D2 回归）：工具栏是 memo 化子树、不随草稿输入重渲染，渲染期
  // 同步探针会停在陈旧布尔。改为订阅草稿 revision：只在探针布尔翻转时更新局部
  // state 触发重渲染，避免逐键重渲染整个工具栏；polish()/restore() 内部各有
  // 权威守卫，不依赖探针新鲜度。
  const computeDraftProbe = useCallback(() => {
    const snapshot = getDraftSnapshotRef.current();
    const saved = restoreRef.current;
    return {
      matchesRestore:
        statusRef.current === "restorable" &&
        saved !== null &&
        snapshot?.text === saved.replacedText,
      nonEmpty: Boolean(snapshot?.text.trim()),
    };
  }, []);
  const [draftProbe, setDraftProbe] = useState(computeDraftProbe);
  const refreshDraftProbe = useCallback(() => {
    const next = computeDraftProbe();
    setDraftProbe((prev) =>
      prev.nonEmpty === next.nonEmpty && prev.matchesRestore === next.matchesRestore ? prev : next,
    );
  }, [computeDraftProbe]);
  useEffect(() => {
    refreshDraftProbe();
    return subscribeToComposerDraftRevision(workspacePath, workspaceIdentity, refreshDraftProbe);
  }, [refreshDraftProbe, workspaceIdentity, workspacePath]);
  // 状态迁移（回包替换/还原/取消）不必然伴随 revision 变化：status 变化时补算一次。
  useEffect(() => {
    refreshDraftProbe();
  }, [refreshDraftProbe, status]);
  const canPolish = status !== "polishing" && draftProbe.nonEmpty;
  const canRestore = status === "restorable" && draftProbe.matchesRestore;

  return {
    status,
    canPolish,
    canRestore,
    error,
    resolvedModel,
    resolvedModelSource,
    polish,
    cancel,
    restore,
    selectModel,
    dismissError,
  };
}

function generatePolishOperationId(): string {
  // renderer 安全上下文有 randomUUID；非安全上下文退化为时间戳+随机串
  // （operationId 只作取消面关联键，本窗口在飞请求内唯一即可）。
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `polish_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
