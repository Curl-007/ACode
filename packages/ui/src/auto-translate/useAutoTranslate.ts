/**
 * 出站翻译的编排 hook（PRD auto-translate-outgoing §4.3 / §4.5）。
 *
 * 依赖方向（单向，无环）：
 *   ConversationComposer.submit → useAutoTranslate → useServices().acodeAgentService
 *     .generateWorkspaceText（既有通用辅助 RPC）
 *
 * 为什么直接调 `generateWorkspaceText` 而不新增 host 服务：与 useNextStepSuggestions
 * 同一裁决——该 RPC 已经是「给辅助任务用」的通用面（Git 提交信息等都在用），
 * 再包一个服务只会得到「一个类的壳 + 同一句 RPC」。
 *
 * 状态所有权：设置归 AppSettings（唯一持久化所有者）；「翻译中」过渡态归 composer
 * 局部状态；翻译调用在途状态（abort + revision）归本 hook 内部，不进任何 store。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTO_TRANSLATE_MAX_OUTPUT_TOKENS,
  AUTO_TRANSLATE_QUERY_SOURCE,
  AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  AUTO_TRANSLATE_TIMEOUT_MS,
  type AutoTranslateMode,
  type AutoTranslateModelSelection,
} from "@acode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import {
  buildTranslationUserMessage,
  isTranslationOutputExcessive,
  normalizeTranslationOutput,
  resolveTranslationSystemPrompt,
} from "@/auto-translate/translationPrompt.js";

/** 请求发起时由调用方冻结的上下文。 */
export interface AutoTranslateRequestContext {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  mode: AutoTranslateMode;
  modelSelection: AutoTranslateModelSelection;
}

export type AutoTranslateStatus = "idle" | "pending" | "failed";

export interface UseAutoTranslateResult {
  /** 翻译在途；composer 用它禁用发送键并显示状态条。 */
  status: AutoTranslateStatus;
  /** 状态条用的模型显示名（pending 时有值）。 */
  pendingModelLabel: string | null;
  /**
   * 翻译一次出站文本。返回译文；任何失败（超时/错误/空输出/超长漂移）返回原文，
   * 用户取消（abort）返回 null —— 调用方不发任何内容。
   */
  translate: (
    text: string,
    context: AutoTranslateRequestContext,
    signal: AbortSignal,
  ) => Promise<string | null>;
  /** 状态条短提示「翻译失败」后消隐的定时句柄；组件卸载时清理。 */
  consumeFailureNotice: () => boolean;
}

/**
 * 翻译中 + 失败提示的 UI 状态。失败提示只在状态条上短暂停留（§4.3 第 5 条：
 * 静默回退发原文、不弹 toast），由 composer 在下一次渲染周期消隐。
 */
export function useAutoTranslate(): UseAutoTranslateResult {
  const { acodeAgentService } = useServices();
  const [status, setStatus] = useState<AutoTranslateStatus>("idle");
  const [pendingModelLabel, setPendingModelLabel] = useState<string | null>(null);
  const failureNoticeRef = useRef(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    // 组件卸载时复位状态；在飞请求由调用方持有的 AbortSignal 收口。
    return () => {
      setStatus("idle");
      setPendingModelLabel(null);
    };
  }, []);

  const translate = useCallback(
    async (
      text: string,
      context: AutoTranslateRequestContext,
      signal: AbortSignal,
    ): Promise<string | null> => {
      const userMessage = buildTranslationUserMessage(text);
      if (userMessage === null) {
        // 空/全空白/超上限：不算失败，直接放行原文（§4.4）。
        return text;
      }

      // 串行上限：同一 composer 同时只允许一条翻译在飞；新请求到来时旧的必然已被
      // abort（composer 保证），这里只是防御性拒绝。
      if (inFlightRef.current) {
        return text;
      }
      inFlightRef.current = true;
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      signal.addEventListener("abort", forwardAbort, { once: true });
      const timer = window.setTimeout(() => controller.abort(), AUTO_TRANSLATE_TIMEOUT_MS);
      setStatus("pending");
      setPendingModelLabel(context.modelSelection.modelId);
      const inputChars = text.trim().length;
      logger.info("[auto-translate] 翻译发起", {
        querySource: AUTO_TRANSLATE_QUERY_SOURCE,
        inputChars,
      });

      try {
        const result = await acodeAgentService.generateWorkspaceText({
          workspacePath: context.workspacePath,
          ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
          ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
          selection: {
            providerId: context.modelSelection.providerId,
            modelId: context.modelSelection.modelId,
          },
          messages: [
            { role: "system", content: resolveTranslationSystemPrompt(context.mode) },
            { role: "user", content: userMessage },
          ],
          querySource: AUTO_TRANSLATE_QUERY_SOURCE,
          maxOutputTokens: AUTO_TRANSLATE_MAX_OUTPUT_TOKENS,
          signal: controller.signal,
          requestTimeoutMs: AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
        });
        if (result.toolCalls && result.toolCalls.length > 0) {
          // 翻译请求不传 tools；模型越权返回 toolCalls 时丢弃结果，绝不注入。
          logger.warn("[auto-translate] 翻译失败", { reason: "tool_calls_returned" });
          failureNoticeRef.current = true;
          setStatus("failed");
          return text;
        }
        const normalized = normalizeTranslationOutput(result.text);
        if (normalized === null) {
          logger.warn("[auto-translate] 翻译失败", { reason: "empty-output" });
          failureNoticeRef.current = true;
          setStatus("failed");
          return text;
        }
        if (isTranslationOutputExcessive(normalized.length, inputChars)) {
          // 译文远长于输入：模型把翻译做成了回答/扩写（§4.6 超长防护），回退原文。
          logger.warn("[auto-translate] 翻译回退原文", {
            reason: "output-excessive",
            inputChars,
            outputChars: normalized.length,
          });
          failureNoticeRef.current = true;
          setStatus("failed");
          return text;
        }
        logger.info("[auto-translate] 翻译完成", {
          outputChars: normalized.length,
        });
        return normalized;
      } catch {
        if (signal.aborted || controller.signal.aborted) {
          // 用户取消（Esc → abort）：完全静默，返回 null 表示「不发任何内容」（§4.3 第 6 条）。
          logger.debug("[auto-translate] 已取消", { cause: "abort" });
          return null;
        }
        // 失败静默回退发原文（§4.3 第 5 条）：只 warn，不弹 toast。
        // 日志红线（照抄 voicePolishService）：只记分类，不记 error.message——
        // 上游异常 message 会回显 prompt 片段，而这里的 prompt 就是用户输入原文。
        logger.warn("[auto-translate] 翻译失败", { reason: "upstream-error" });
        failureNoticeRef.current = true;
        setStatus("failed");
        return text;
      } finally {
        window.clearTimeout(timer);
        signal.removeEventListener("abort", forwardAbort);
        inFlightRef.current = false;
        setPendingModelLabel(null);
      }
    },
    [acodeAgentService],
  );

  const consumeFailureNotice = useCallback((): boolean => {
    if (!failureNoticeRef.current) {
      return false;
    }
    failureNoticeRef.current = false;
    setStatus("idle");
    return true;
  }, []);

  return {
    status,
    pendingModelLabel,
    translate,
    consumeFailureNotice,
  };
}
