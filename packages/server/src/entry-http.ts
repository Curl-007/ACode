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
  const host = process.env["ACODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ACODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ACODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  const services = createLocalServices({
    acodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[acode-server:http] startup failed", error);
  process.exitCode = 1;
});
