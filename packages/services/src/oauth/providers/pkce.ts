import pkceChallenge from "pkce-challenge";
import type { OAuthProviderContext } from "./providerAdapter.js";

/**
 * OAuth 授权码流 PKCE（S256）共用工具。
 *
 * 两个 provider adapter（BigModel/ZAI）的 PKCE 参数拼接收敛到此处，
 * 避免重复实现导致行为分叉（AGENTS.md：避免重复状态与多条写入路径）。
 * verifier/challenge 的生成与暂存由 OAuthService 统一负责，adapter 只消费 context。
 */

/** PKCE 授权码交换挑战方法，固定 S256（RFC 7636），禁止 plain。 */
const PKCE_CHALLENGE_METHOD = "S256";

/** 生成 PKCE verifier/challenge pair（委托 pkce-challenge，与 MCP OAuth 同源依赖）。 */
export async function createOAuthPkcePair(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  const { code_verifier, code_challenge } = await pkceChallenge();
  return { codeVerifier: code_verifier, codeChallenge: code_challenge };
}

/**
 * 授权 URL 的 PKCE 查询参数：有 challenge 时返回 S256 参数，否则返回空对象。
 * 空对象展开不改变既有参数，保证无 PKCE 上下文（轮询流程）的 URL 字节形态零回归。
 */
export function buildPkceAuthorizeParams(context: OAuthProviderContext): Record<string, string> {
  if (!context.codeChallenge) {
    return {};
  }

  return {
    code_challenge: context.codeChallenge,
    code_challenge_method: PKCE_CHALLENGE_METHOD,
  };
}

/**
 * token 交换载荷的 PKCE 字段：有 verifier 时返回 `{ code_verifier }`，否则空对象。
 * 服务端 PKCE 支持未经本地验证（见 specs/oauth-pkce.md），采用附加参数策略：
 * 不识别该字段的后端应按 RFC 7636 语义忽略，识别则立即获得防护。
 */
export function buildPkceTokenExchangeFields(context: OAuthProviderContext): Record<string, string> {
  if (!context.codeVerifier) {
    return {};
  }

  return { code_verifier: context.codeVerifier };
}
