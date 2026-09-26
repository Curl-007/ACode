import {
  buildRuntimeACodeEndpointUrls,
  ACODE_ENV,
  type RuntimeACodeEndpointEnv,
} from "@acode/shared";

interface RendererImportMetaEnv {
  VITE_ACODE_BASE_URL?: string;
  VITE_ACODE_ENDPOINT_ORIGIN?: string;
}

function readRendererImportMetaEnv(): RendererImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: RendererImportMetaEnv }).env ??
    {}) as RendererImportMetaEnv;
}

function createRendererACodeEndpointEnv(
  env: RendererImportMetaEnv = readRendererImportMetaEnv(),
): RuntimeACodeEndpointEnv {
  return {
    ACODE_ENV,
    // UI 侧的 zcode-plan 占位 provider 以前只看 ACODE_ENV，
    // 没有消费 Vite 注入的 base url，导致自定义测试域名时 renderer 和 host/service 可能不一致。
    ACODE_BASE_URL: env.VITE_ACODE_BASE_URL,
    ACODE_ENDPOINT_ORIGIN: env.VITE_ACODE_ENDPOINT_ORIGIN,
  };
}

export const RENDERER_ACODE_ENDPOINT_URLS = buildRuntimeACodeEndpointUrls(
  createRendererACodeEndpointEnv(),
);
