import { useCallback, useEffect, useRef, useState } from "react";
import type { IPlatformService, LocalDiagnosticFacts, LocalDiagnosticReport } from "@acode/shared";
import { logger } from "@/logger.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";
import {
  DEFAULT_DIAGNOSTIC_SCOPE,
  composeLocalDiagnosticReport,
  diagnosticReportFileName,
  resolveDownloadOutcome,
  type DiagnosticScope,
  type DownloadOutcome,
} from "@/lib/localDiagnosticReport.js";

/**
 * U12 本地诊断报告的采集/组合/下载编排 hook。
 * 契约真源：packages/shared/specs/local-diagnostic-report.md；UI 不变量见
 * packages/ui/specs/local-diagnostic-report-ui.md。
 *
 * 职责：打开对话框时**采集一次**（platform.collectLocalDiagnostics + 内存计数），
 * 之后 scope 变化只做**纯重组**——不再触发采集（验收 U12-A5「无重复后台采集」）。
 * 下载重试同样复用已采集事实。
 */

/** renderer 内存指标是否可得：Chromium 专有 performance.memory（Web 端缺失 → false）。 */
function readMemoryAvailability(): boolean {
  if (typeof performance === "undefined") {
    return false;
  }
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return typeof memory?.usedJSHeapSize === "number";
}

export type DiagnosticPhase = "idle" | "collecting" | "ready" | "error";

export interface UseLocalDiagnosticReport {
  phase: DiagnosticPhase;
  /** ready 后的当前报告（随 scope 重组）。 */
  report: LocalDiagnosticReport | null;
  scope: DiagnosticScope;
  toggleScope: (group: keyof DiagnosticScope) => void;
  /** 采集失败时的稳定错误码。 */
  errorCode: string | null;
  /** 触发一次性采集（由对话框在 open 变 true 时调用；开关真源是父级的 open prop）。 */
  open: () => void;
  /** 释放采集结果（不残留，下次打开重新采集）。 */
  close: () => void;
  /** 下载 JSON；saveDiagnosticReport 缺席或平台拒绝时降级为剪贴板复制。 */
  download: () => Promise<DownloadOutcome>;
  downloading: boolean;
}

export function useLocalDiagnosticReport(
  platform: Pick<IPlatformService, "collectLocalDiagnostics" | "saveDiagnosticReport">,
): UseLocalDiagnosticReport {
  // 不持有 isOpen：对话框是受控组件，开关真源在父级（帮助菜单 state）。本 hook 再存一份
  // 就是重复状态（AGENTS.md 禁止），且两者可能不同步。
  const [phase, setPhase] = useState<DiagnosticPhase>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [scope, setScope] = useState<DiagnosticScope>(DEFAULT_DIAGNOSTIC_SCOPE);
  const [report, setReport] = useState<LocalDiagnosticReport | null>(null);
  const [downloading, setDownloading] = useState(false);
  /** 采集到的事实缓存：scope 变化只重组不重采（U12-A5）。 */
  const factsRef = useRef<LocalDiagnosticFacts | null>(null);
  const memoryRef = useRef<{ counts: Record<string, number>; available: boolean } | null>(null);
  /**
   * 采集代际计数（关闭/重开时递增）：陈旧代的采集 promise resolve 时被 isCurrent() 拒绝，
   * 不写任何 state。防「关闭再重开时旧采集晚到覆盖新报告」（同 web 重连的代际守卫范式）。
   */
  const generationRef = useRef(0);
  /**
   * scope 的 ref 镜像：toggleScope 需要在**同一次事件内**基于最新 scope 计算下一个值。
   * 若读 `scope` state 会读到渲染快照（连续快速勾选会丢更新）；用 ref 保证读到最新值。
   * open() 重置 scope 时必须同步重置本 ref，否则重开后首次 toggle 会基于陈旧值展开。
   */
  const scopeRef = useRef<DiagnosticScope>(DEFAULT_DIAGNOSTIC_SCOPE);

  const recompose = useCallback((nextScope: DiagnosticScope) => {
    const facts = factsRef.current;
    const memory = memoryRef.current;
    if (!facts || !memory) {
      return;
    }
    try {
      setReport(
        composeLocalDiagnosticReport({
          facts,
          memoryCounts: memory.counts,
          memoryAvailable: memory.available,
          // U08 未落地：无 provider 诊断结果源，传 null → 组标 unavailable（不伪造）。
          providerEntries: null,
          // 事件摘要源未接入（见 spec 后续批次），空数组 → not-collected/truncated 由 scope 决定。
          events: [],
          scope: nextScope,
          generatedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      // 组合器 fail-loud（如超限无解）：显示错误态，不产出坏报告。
      logger.error("[diagnostics] compose failed", error);
      setPhase("error");
      setErrorCode("compose-failed");
    }
  }, []);

  const open = useCallback(() => {
    setPhase("collecting");
    setErrorCode(null);
    scopeRef.current = DEFAULT_DIAGNOSTIC_SCOPE;
    setScope(DEFAULT_DIAGNOSTIC_SCOPE);
    setReport(null);
    factsRef.current = null;
    memoryRef.current = null;
    // 采集代际守卫：关闭/重开会让上一次采集的 promise 变成「陈旧代」。若陈旧代在新一代之后
    // resolve，它会用旧事实覆盖 factsRef 并把 phase 置回 ready，导致显示过期报告——
    // 与 packages/web 重连模块的代际守卫同类问题（review 2026-10-26 的 26R2-02）。
    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;
    // 一次性采集：只读平台事实 + renderer 内存计数，零网络零 probe（契约产品规则 4）。
    void platform
      .collectLocalDiagnostics()
      .then((facts) => {
        if (!isCurrent()) {
          return; // 陈旧代：丢弃，不写任何 state（对话框可能已关闭或已重新采集）
        }
        factsRef.current = facts;
        memoryRef.current = {
          counts: uiMemoryDiagnosticsRegistry.collect(),
          available: readMemoryAvailability(),
        };
        recompose(DEFAULT_DIAGNOSTIC_SCOPE);
        setPhase("ready");
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return;
        }
        logger.error("[diagnostics] collect failed", error);
        setPhase("error");
        setErrorCode("collect-failed");
      });
  }, [platform, recompose]);

  const close = useCallback(() => {
    // 作废在途采集代：其 promise 之后 resolve 时 isCurrent() 为 false，不写任何 state。
    generationRef.current += 1;
    setPhase("idle");
    setReport(null);
    // 释放已采集事实（U12-A5：关闭后不残留、下次打开重新采集；无 object URL 由本层持有）。
    factsRef.current = null;
    memoryRef.current = null;
  }, []);

  const toggleScope = useCallback((group: keyof DiagnosticScope) => {
    // 不在 setScope 的 updater 内调 recompose：React 要求 updater 纯函数（StrictMode 下可能
    // 被双调用），在其中触发另一个 setState 是反模式。这里同步更新 ref + setState，
    // 由下方 effect（依赖 scope）统一重组——单一重组路径，不在 updater 里产生副作用。
    scopeRef.current = { ...scopeRef.current, [group]: !scopeRef.current[group] };
    setScope(scopeRef.current);
  }, []);

  // 重组由 scope 变化或事实到位驱动（事实到位时 scope 重置也会触发本 effect，因 DEFAULT 是新对象）。
  // recompose 在事实缺席时安全 no-op，故挂载期空跑无害。
  useEffect(() => {
    recompose(scope);
  }, [scope, recompose]);

  const download = useCallback(async (): Promise<DownloadOutcome> => {
    if (!report) {
      return { kind: "failed", errorCode: "no-report" };
    }
    setDownloading(true);
    try {
      const json = JSON.stringify(report, null, 2);
      const suggestedName = diagnosticReportFileName(report.platformType, report.generatedAt);
      const result = platform.saveDiagnosticReport
        ? await platform.saveDiagnosticReport(json, suggestedName)
        : undefined;
      const clipboardAvailable =
        typeof navigator !== "undefined" && Boolean(navigator.clipboard?.writeText);
      // 决策逻辑是纯函数（lib/localDiagnosticReport.ts resolveDownloadOutcome），便于行为测试。
      const outcome = resolveDownloadOutcome({ result, clipboardAvailable });
      if (outcome.kind === "copied" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(json);
      }
      return outcome;
    } catch (error) {
      logger.error("[diagnostics] download failed", error);
      return { kind: "failed", errorCode: "download-failed" };
    } finally {
      setDownloading(false);
    }
  }, [platform, report]);

  // 卸载防护：组件卸载后不再 setState（对话框在采集完成前被关闭的竞态）。
  useEffect(() => {
    return () => {
      factsRef.current = null;
      memoryRef.current = null;
    };
  }, []);

  return {
    phase,
    report,
    scope,
    toggleScope,
    errorCode,
    open,
    close,
    download,
    downloading,
  };
}
