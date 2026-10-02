import { createLocalServices, getAppConfigDir } from "@acode/services/node";
import {
  materializeBundledACodeBuiltinProviderConfig,
  readBundledACodeBuiltinProviderConfig,
} from "./bundledACodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";

async function main(): Promise<void> {
  const acodeBuiltinProviderConfigFilePath = await materializeBundledACodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledACodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  // P0-2：未显式指定 host 时默认 loopback，配合 createHttpServer 的 fail-closed 不变量，
  // 避免「未指定即监听所有网卡」的 fail-open 默认。
  const host =
    process.env["ACODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || "127.0.0.1";
  const staticRoot = process.env["ACODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ACODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  // `/ws/host` 升级允许的非 loopback Origin 白名单（逗号分隔），用于受信反代/局域网部署。
  const allowedOrigins = process.env["ACODE_SERVER_ALLOWED_ORIGINS"]?.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const services = createLocalServices({
    acodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });

  createHttpServer(services, port, {
    host,
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
    ...(allowedOrigins && allowedOrigins.length > 0 ? { allowedOrigins } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[acode-server:http] startup failed", error);
  process.exitCode = 1;
});
