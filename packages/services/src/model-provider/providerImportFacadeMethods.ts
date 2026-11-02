// provider-import 的两个 RPC 方法装配（docs/specs/provider-config-import.md R5）。
// 从 providerFacadeServices.ts 拆出，避免该文件接近架构/lint 的 400 行上限；
// 本文件只依赖端口接口与纯类型，刻意不引入任何 node: 依赖（browser-safe）。
import type {
  ProviderImportResult,
  ProviderImportScanResult,
  ProviderImportServicePort,
} from "./provider-import/providerImportTypes.js";
import type { IProviderSettingsService } from "./providerFacadeServices.js";

export type ProviderImportMethods = Pick<
  IProviderSettingsService,
  "scanProviderImports" | "importProviderCandidates"
>;

/** 未装配导入服务时 fail-closed：返回结构化错误而非抛错，renderer 有可映射的失败态。 */
export function createProviderImportMethods(port?: ProviderImportServicePort): ProviderImportMethods {
  if (!port) {
    const unavailableScan = async (): Promise<ProviderImportScanResult> => ({
      ok: false,
      error: { code: "scan-failed" },
    });
    const unavailableImport = async (): Promise<ProviderImportResult> => ({
      ok: false,
      error: { code: "scan-failed" },
    });
    return { scanProviderImports: unavailableScan, importProviderCandidates: unavailableImport };
  }
  return {
    scanProviderImports: (input) => port.scanProviderImports(input),
    importProviderCandidates: (input) => port.importProviderCandidates(input),
  };
}