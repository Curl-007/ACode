import { buildRuntimeACodeApiUrl, resolveZaiBusinessBaseUrl } from "@acode/shared";

export const ACODE_CLIENT_SCENES_URL = buildRuntimeACodeApiUrl(
  process.env,
  "/api/v1/client/scenes",
);

export const ZAI_API_HOST = resolveZaiBusinessBaseUrl(process.env);
