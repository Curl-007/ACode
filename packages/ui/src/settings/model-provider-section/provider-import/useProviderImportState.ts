import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProviderImportCandidateView,
  ProviderImportErrorCode,
  ProviderImportResult,
  ProviderImportServicePort,
  ProviderImportSource,
  ProviderImportWarning,
} from "@acode/services";
import {
  defaultProviderImportSelection,
  isProviderImportRescanRequired,
  PROVIDER_IMPORT_SOURCE_ORDER,
  toggleProviderImportCandidateIds,
  toggleProviderImportSource,
  type ProviderImportStep,
} from "./providerImportModel.js";

/**
 * Provider 导入向导的步骤与请求状态（R8）：**组件局部态**，不进 store（AGENTS.md：
 * UI 局部状态不应被误当作服务端事实）。请求走注入的 `providerImportService`（hooks 纪律，
 * 组件不直连 window.acode、不直连服务实现）。
 */

interface UseProviderImportStateParams {
  open: boolean;
  service: ProviderImportServicePort;
  /** 成功导入后刷新设置视图（父组件负责 commit）。 */
  onImported: () => Promise<void> | void;
}

export interface ProviderImportState {
  step: ProviderImportStep;
  selectedSources: readonly ProviderImportSource[];
  candidates: readonly ProviderImportCandidateView[];
  warnings: readonly ProviderImportWarning[];
  selectedCandidateIds: readonly string[];
  importResult: ProviderImportResult | null;
  errorCode: ProviderImportErrorCode | null;
  /** candidate-missing 的局部放弃项（R8 失败态）。 */
  missingCandidateId: string | null;
  busy: boolean;
  rescanRequired: boolean;
  selectableCandidateIds: readonly string[];
  hasScanned: boolean;
  setSourceSelected: (source: ProviderImportSource, checked: boolean) => void;
  selectAllSources: () => void;
  clearAllSources: () => void;
  startScan: () => Promise<void>;
  /** scan-stale 后的过期重扫（R8）：按当前来源重新扫描并重置预览。 */
  rescan: () => Promise<void>;
  toggleCandidate: (candidateId: string, checked: boolean) => void;
  selectAllCandidates: () => void;
  clearAllCandidates: () => void;
  submitImport: () => Promise<void>;
  closeDialog: () => void;
}

export function useProviderImportState({
  open,
  service,
  onImported,
}: UseProviderImportStateParams): ProviderImportState {
  const [step, setStep] = useState<ProviderImportStep>("sources");
  const [selectedSources, setSelectedSources] =
    useState<readonly ProviderImportSource[]>(PROVIDER_IMPORT_SOURCE_ORDER);
  const [candidates, setCandidates] = useState<readonly ProviderImportCandidateView[]>([]);
  const [warnings, setWarnings] = useState<readonly ProviderImportWarning[]>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<readonly string[]>([]);
  const [importResult, setImportResult] = useState<ProviderImportResult | null>(null);
  const [errorCode, setErrorCode] = useState<ProviderImportErrorCode | null>(null);
  const [missingCandidateId, setMissingCandidateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  // 打开/重扫期间父组件可能重渲染；旧请求晚到会覆盖新结果，token 守卫丢弃过期响应。
  const requestTokenRef = useRef(0);

  const reset = useCallback(() => {
    requestTokenRef.current += 1;
    setStep("sources");
    setSelectedSources(PROVIDER_IMPORT_SOURCE_ORDER);
    setCandidates([]);
    setWarnings([]);
    setSelectedCandidateIds([]);
    setImportResult(null);
    setErrorCode(null);
    setMissingCandidateId(null);
    setBusy(false);
    setHasScanned(false);
  }, []);

  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const setSourceSelected = useCallback((source: ProviderImportSource, checked: boolean) => {
    setSelectedSources((current) => toggleProviderImportSource(current, source, checked));
  }, []);
  const selectAllSources = useCallback(() => setSelectedSources(PROVIDER_IMPORT_SOURCE_ORDER), []);
  const clearAllSources = useCallback(() => setSelectedSources([]), []);

  const runScan = useCallback(
    async (sources: readonly ProviderImportSource[]) => {
      const token = requestTokenRef.current + 1;
      requestTokenRef.current = token;
      setBusy(true);
      setStep("scanning");
      setErrorCode(null);
      setMissingCandidateId(null);
      setImportResult(null);
      setCandidates([]);
      setWarnings([]);
      setSelectedCandidateIds([]);
      try {
        const result = await service.scanProviderImports({ sources: [...sources] });
        if (token !== requestTokenRef.current) return;
        setHasScanned(true);
        if (!result.ok) {
          setErrorCode(result.error.code);
          setStep("sources");
          return;
        }
        setCandidates(result.candidates);
        setWarnings(result.warnings);
        setSelectedCandidateIds(defaultProviderImportSelection(result.candidates));
        setStep("preview");
      } catch {
        if (token !== requestTokenRef.current) return;
        setHasScanned(true);
        setErrorCode("scan-failed");
        setStep("sources");
      } finally {
        if (token === requestTokenRef.current) setBusy(false);
      }
    },
    [service],
  );

  const startScan = useCallback(async () => {
    if (selectedSources.length === 0) return;
    await runScan(selectedSources);
  }, [runScan, selectedSources]);

  const toggleCandidate = useCallback((candidateId: string, checked: boolean) => {
    setSelectedCandidateIds((current) =>
      toggleProviderImportCandidateIds(current, [candidateId], checked),
    );
  }, []);

  const selectableCandidateIds = candidates
    .filter((candidate) => candidate.duplicate !== "existing")
    .map(({ id }) => id);
  const selectAllCandidates = useCallback(
    () => setSelectedCandidateIds(selectableCandidateIds),
    [selectableCandidateIds],
  );
  const clearAllCandidates = useCallback(() => setSelectedCandidateIds([]), []);

  const submitImport = useCallback(async () => {
    if (selectedCandidateIds.length === 0 || busy) return;
    setBusy(true);
    setStep("importing");
    setErrorCode(null);
    setMissingCandidateId(null);
    try {
      const result = await service.importProviderCandidates({
        candidateIds: [...selectedCandidateIds],
      });
      if (result.ok) {
        setImportResult(result);
        setStep("result");
        await onImported();
        return;
      }
      // 零写入的失败态：保留预览允许重试（R8）；scan-stale 提示重新扫描，
      // candidate-missing 局部放弃该项。
      if (result.error.code === "candidate-missing") {
        const missingId = String(result.error.params?.id ?? "");
        if (missingId) {
          setMissingCandidateId(missingId);
          setSelectedCandidateIds((current) => current.filter((id) => id !== missingId));
        }
      }
      setErrorCode(result.error.code);
      setStep("preview");
    } catch {
      setErrorCode("write-failed");
      setStep("preview");
    } finally {
      setBusy(false);
    }
  }, [busy, onImported, selectedCandidateIds, service]);

  /** 过期重扫：scan-stale 后按当前来源重新扫描（R8）。 */
  const rescan = useCallback(async () => {
    await runScan(selectedSources);
  }, [runScan, selectedSources]);
  const closeDialog = useCallback(() => reset(), [reset]);

  return {
    step,
    selectedSources,
    candidates,
    warnings,
    selectedCandidateIds,
    importResult,
    errorCode,
    missingCandidateId,
    busy,
    rescanRequired: isProviderImportRescanRequired(errorCode),
    selectableCandidateIds,
    hasScanned,
    setSourceSelected,
    selectAllSources,
    clearAllSources,
    startScan,
    rescan,
    toggleCandidate,
    selectAllCandidates,
    clearAllCandidates,
    submitImport,
    closeDialog,
  };
}