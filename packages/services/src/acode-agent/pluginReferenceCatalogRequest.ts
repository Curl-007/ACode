
import { type V4PluginsReferenceCatalogParams, V4_METHODS, v4PluginsReferenceCatalogResultSchema } from "@acode/shared/acode-protocol-v4";

import type { ACodeAgentRpcClient } from "#src/acode-agent/acodeAgentRpcClient.js";

/**
 * M3（specs/m3-legacy-server-removal.md §0）：v4/plugins/referenceCatalog 为唯一面
 * （恒带 category，合并 legacy 两词）。M2-5 §4 曾保留 pre-v4 CLI 的两级 legacy fallback；
 * M3 删除 CLI legacy server 后该回落不再可达（新 CLI 恒识 v4 方法），按裁决清单删除——
 * 不属幸存清单（幸存清单仅 sessionSubagents / pluginsCancelOperation / sessionSend 附件回退）。
 */
export async function requestPluginReferenceCatalog(
  client: Pick<ACodeAgentRpcClient, "request">,
  params: V4PluginsReferenceCatalogParams,
) {
  return client.request(
    V4_METHODS.pluginsReferenceCatalog,
    params,
    v4PluginsReferenceCatalogResultSchema,
  );
}
