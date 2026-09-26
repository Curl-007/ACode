import {
  acodeProtocolMethods,
  acodePluginsReferenceCatalogResultSchema,
  type ACodePluginsReferenceCatalogParams,
} from "@acode/shared";
import type { ACodeProtocolClient } from "#src/acode-agent/acodeProtocolClient.js";

/** 旧协议严格校验响应；新展示字段走独立入口，只有 -32601 能证明旧 Agent 不支持。 */
export async function requestPluginReferenceCatalog(
  client: Pick<ACodeProtocolClient, "request">,
  params: ACodePluginsReferenceCatalogParams,
) {
  try {
    return await client.request(
      acodeProtocolMethods.pluginsReferenceCatalogWithCategory,
      params,
      acodePluginsReferenceCatalogResultSchema,
    );
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === -32601))
      throw error;
    return client.request(
      acodeProtocolMethods.pluginsReferenceCatalog,
      params,
      acodePluginsReferenceCatalogResultSchema,
    );
  }
}
