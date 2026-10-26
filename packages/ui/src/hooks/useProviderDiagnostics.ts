import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProviderDiagnosticsResult,
  ProviderDiagnosticsTier,
} from "@acode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import {
  DEFAULT_DIAGNOSTICS_TIER,
  isDiagnosticsResultCurrent,
} from "@/lib/providerDiagnostics.js";

/**
 * U08 Provider 诊断的 UI 状态编排（specs/provider-diagnostics-ui.md）。
 *
 * 只做状态编排，**不做判定**：三态/fencing/档位授权/文案映射全在 `lib/providerDiagnostics.ts`
 * 的纯函数里（U1）。本 hook 负责的是纯函数无法负责的部分——requestId 生命周期、在飞态、
 * 以及「结果与 revision 绑定」这条时序不变量。
 *
 * 时序不变量（U3/U4）：
 * - 每次 run 生成**新** requestId，并记住发起时的 revision；结果只有在 revision 仍匹配
 *   当前值时才被采纳（迟到结果零写入，U08-A3）。
 * - 在飞期间重复 run 被忽略（单次执行的第一道 UI 门禁；服务端还有一道，U08-A4）。
 * - 取消只针对当前 requestId，且取消后不承诺退费（R4）。
 */

export interface UseProviderDiagnosticsTarget {
  /** 诊断目标 provider（保存接口返回的 providerId）。 */
  readonly providerId: string | null;
  /** 当前 ProviderSettingsView.revision：fencing 的判据来源。 */
  readonly revision: number;
}

export interface UseProviderDiagnosticsResult {
  /** 最近一次被采纳的结果（revision 不匹配的迟到结果不会出现在这里）。 */
  readonly result: ProviderDiagnosticsResult | null;
  readonly running: boolean;
  readonly tier: ProviderDiagnosticsTier;
  readonly requestId: string | null;
  setTier(tier: ProviderDiagnosticsTier): void;
  /** 运行诊断。`acknowledged` = 用户已确认该档位的联网/费用告知（R9）。 */
  run(input: { acknowledged: boolean }): Promise<void>;
  /** 取消当前在飞的诊断（只取消这一个 requestId）。 */
  cancel(): Promise<void>;
  /** 清空结果：用户改了配置后主动丢弃旧结论，避免旧结果被误读。 */
  clear(): void;
}

/** requestId 前缀：便于在日志里区分来源，且不含任何用户数据（R8）。 */
const REQUEST_ID_PREFIX = "ui-provider-diagnostics";
let requestSequence = 0;

function nextRequestId(): string {
  requestSequence += 1;
  // 用递增序号 + 时间戳，保证同一页面内不重复；不需要 UUID（requestId 只在 host↔CLI 间关联，
  // 不是安全凭据，也不跨进程持久化）。
  return `${REQUEST_ID_PREFIX}-${Date.now()}-${requestSequence}`;
}

export function useProviderDiagnostics(
  target: UseProviderDiagnosticsTarget,
): UseProviderDiagnosticsResult {
  const { providerSettingsService } = useServices();
  const [result, setResult] = useState<ProviderDiagnosticsResult | null>(null);
  const [running, setRunning] = useState(false);
  const [tier, setTierState] = useState<ProviderDiagnosticsTier>(DEFAULT_DIAGNOSTICS_TIER);
  const [requestId, setRequestId] = useState<string | null>(null);

  // 在飞 requestId：取消与「采纳/丢弃迟到结果」都只认它。用 ref 而不是 state，
  // 因为取消回调需要在同一次事件里读到最新值，不能等重渲染。
  const inflightRequestIdRef = useRef<string | null>(null);
  // 卸载守卫：组件已卸载时不得再写 state（否则 React 报警且旧结果污染新挂载）。
  const mountedRef = useRef(true);
  // 目标 provider 变化时丢弃旧结果：不同 provider 的结论不能互相顶替。
  const lastProviderIdRef = useRef<string | null>(target.providerId);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (lastProviderIdRef.current === target.providerId) return;
    lastProviderIdRef.current = target.providerId;
    // provider 换了 → 旧结果对新 provider 无意义，必须清空（R2 的同源纪律：
    // 结果只对「它跑时所针对的那份配置」有效）。
    setResult(null);
  }, [target.providerId]);

  const setTier = useCallback((next: ProviderDiagnosticsTier): void => {
    setTierState(next);
    // 换档即换授权语义（R9：授权只对本次、该档位生效）：清掉旧结论，避免
    // 「offline 通过」的徽标在用户切到 live 后仍被当成结论展示。
    setResult(null);
  }, []);

  const run = useCallback(
    async (input: { acknowledged: boolean }): Promise<void> => {
      const providerId = target.providerId;
      if (!providerId) return;
      // 在飞期间忽略重复点击（U4 的 UI 侧门禁；服务端按去重键再兜一道）。
      if (inflightRequestIdRef.current !== null) return;

      const nextRequestIdValue = nextRequestId();
      // revision 在**发起时**快照：结果回来时与当前 revision 比对，不匹配即丢弃（U3）。
      const revisionAtStart = target.revision;
      inflightRequestIdRef.current = nextRequestIdValue;
      setRequestId(nextRequestIdValue);
      setRunning(true);
      try {
        const outcome = await providerSettingsService.runProviderDiagnostics({
          requestId: nextRequestIdValue,
          providerId,
          revision: revisionAtStart,
          tier,
          // live 档必须带显式 opt-in；其余档位不带（带了也不会被服务端接受为 live 授权）。
          ...(tier === "live" ? { liveOptIn: input.acknowledged } : {}),
        });
        if (!mountedRef.current) return;
        // requestId 必须仍是本次的：期间若发生过取消/新请求，丢弃这份回包。
        if (inflightRequestIdRef.current !== nextRequestIdValue) return;
        // fencing：结果 revision 与发起时一致才采纳（服务端也校验，这里再兜一道，
        // 因为「用户已改配置」这个事实只有 UI 侧的 currentRevision 知道）。
        if (!isDiagnosticsResultCurrent(outcome, revisionAtStart)) return;
        setResult(outcome);
      } catch (error) {
        // 诊断失败不冒泡到保存流程（提案非目标：诊断失败 != 保存失败）。
        // 日志只带 provider/revision/tier 与错误对象，不带任何凭据形态字段（R8）。
        logger.warn("[useProviderDiagnostics] provider 诊断请求失败", {
          error,
          providerId,
          requestId: nextRequestIdValue,
          revision: revisionAtStart,
          tier,
        });
      } finally {
        if (mountedRef.current && inflightRequestIdRef.current === nextRequestIdValue) {
          inflightRequestIdRef.current = null;
          setRunning(false);
        }
      }
    },
    [providerSettingsService, target.providerId, target.revision, tier],
  );

  const cancel = useCallback(async (): Promise<void> => {
    const inflightRequestId = inflightRequestIdRef.current;
    if (!inflightRequestId) return;
    try {
      const outcome = await providerSettingsService.cancelProviderDiagnostics({
        requestId: inflightRequestId,
      });
      if (!mountedRef.current) return;
      // 取消是 best-effort（R4）：cancelled:false 表示已不在飞，不是错误。
      // 此时 run 的 finally 会自己收敛在飞态，这里不强行改状态，避免出现两条写入路径。
      if (outcome.cancelled) {
        inflightRequestIdRef.current = null;
        setRunning(false);
      }
    } catch (error) {
      // 取消失败同样 best-effort：不抛给用户，run 的回包/超时仍会收敛状态。
      logger.warn("[useProviderDiagnostics] 取消 provider 诊断失败", {
        error,
        requestId: inflightRequestId,
      });
    }
  }, [providerSettingsService]);

  const clear = useCallback((): void => {
    setResult(null);
  }, []);

  return { result, running, tier, requestId, setTier, run, cancel, clear };
}
