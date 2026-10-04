import {
  ACODE_VERSION,
  buildRuntimeACodeApiUrl,
  buildRuntimeACodeEndpointUrls,
} from "@acode/shared";

// F6 修复（2026-10-04）：回调协议改为 acode://——桌面受理端自 fork 初始提交起只认
// acode:（desktopDeepLinkUrl.ts 的 DEEP_LINK_SCHEME/谓词硬校验 protocol === "acode:"），
// 此前的旧 zcode scheme 值令官网中转页 redirect 到本产品**收不到**的协议：同机装有
// 上游 ZCode 时授权码回调甚至会被其抢收（PKCE 是缓解而非豁免）。token 主链路走
// polling 不受影响，断的是 deep-link 归因/收窗体验。裁决：不做旧协议兼容注册——本
// fork 从未受理过它（无存量外链可保），注册反而与上游抢默认 handler。
// 外部依赖注意：官网 /app/oauth/login 对 redirect 参数若有 scheme 白名单（仓库外，
// 无法静态核实），acode:// 被拒时表现与修复前一致（登录仍由 polling 兜底），发布
// 验证轮跑一次真实 OAuth 流程确认。
const DESKTOP_OAUTH_CALLBACK_URI = "acode://oauth/callback";

export function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = readEnv(env, key);
  if (raw == null) {
    return fallback;
  }

  return raw !== "0" && raw.toLowerCase() !== "false";
}

export function buildACodeApiUrlFromEnv(env: NodeJS.ProcessEnv, path: string): string {
  // OAuth provider 是运行时配置，必须跟随传入 env.ACODE_ENV；
  // 地址来自 .env 的通用变量，默认线上；登录与 token 交换必须使用同一配置来源。
  return buildRuntimeACodeApiUrl(env, path);
}

export function buildDesktopOAuthRedirectUriFromEnv(env: NodeJS.ProcessEnv): string {
  const url = new URL("/app/oauth/login", buildRuntimeACodeEndpointUrls(env).origin);
  url.searchParams.set("redirect", DESKTOP_OAUTH_CALLBACK_URI);
  // Website 需要按 App 版本决定是否关闭自动 deep link；缺少版本时必须兼容旧客户端行为。
  url.searchParams.set("app_version", ACODE_VERSION);
  return url.toString();
}
