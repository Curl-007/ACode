import {
  acodeProtocolMethods,
  acodePluginsReferenceCatalogResultSchema,
  type ACodePluginsReferenceCatalogParams,
} from "@acode/shared";
import {
  V4_METHODS,
  v4PluginsReferenceCatalogResultSchema,
} from "@acode/shared/acode-protocol-v4";
import type { ACodeAgentRpcClient } from "#src/acode-agent/acodeAgentRpcClient.js";

/** 只有 -32601 能证明 Agent 不认识该方法名（协议错误码语义，legacy 与 v4 同）。 */
function isMethodNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === -32601;
}

/**
 * M2-5（specs/m2-5-plugins.md §4）：v4/plugins/referenceCatalog 为 primary（恒带 category，
 * 合并 legacy 两词）；pre-v4 CLI 的两级 legacy fallback 链完整保留——拆掉会让旧 CLI 的
 * Picker 从「降级无 category」退化为「整体不可用」（保守无能力损失默认）。
 * legacy 响应仍按旧协议严格校验；v4 响应由 v4 schema 校验（两侧逐字 parity）。
 */
export async function requestPluginReferenceCatalog(
  client: Pick<ACodeAgentRpcClient, "request">,
  params: ACodePluginsReferenceCatalogParams,
) {
  try {
    return await client.request(
      V4_METHODS.pluginsReferenceCatalog,
      params,
      v4PluginsReferenceCatalogResultSchema,
    );
  } catch (error) {
    if (!isMethodNotFound(error)) throw error;
    try {
      return await client.request(
        acodeProtocolMethods.pluginsReferenceCatalogWithCategory,
        params,
        acodePluginsReferenceCatalogResultSchema,
      );
    } catch (fallbackError) {
      if (!isMethodNotFound(fallbackError)) throw fallbackError;
      return client.request(
        acodeProtocolMethods.pluginsReferenceCatalog,
        params,
        acodePluginsReferenceCatalogResultSchema,
      );
    }
  }
}
