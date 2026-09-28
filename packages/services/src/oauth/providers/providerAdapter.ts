import type {
  ApiClient,
  OAuthCallbackParams,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@acode/shared";

/** Provider 执行上下文 */
export interface OAuthProviderContext {
  providerId: OAuthProviderId;
  state: string;
  redirectUri: string;
  now: () => number;
  /**
   * 本次授权流的 PKCE verifier（仅客户端构造授权 URL 的 deep-link 流程存在；
   * 轮询流程授权 URL 与兑换均由后端持有，无 verifier，字段保持缺省）。
   * 由 OAuthService 生成并暂存于 pendingState，adapter 只消费不存储。
   */
  codeVerifier?: string;
  /** 与 codeVerifier 配对的 S256 challenge，供 buildAuthorizeUrl 拼接授权参数。 */
  codeChallenge?: string;
}

/** OAuth provider 适配器：隔离协议差异 */
export interface OAuthProviderAdapter {
  readonly providerId: OAuthProviderId;
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;

  parseCallbackParams(url: string): OAuthCallbackParams;
  buildAuthorizeUrl(context: OAuthProviderContext): string;
  exchangeToken(params: OAuthCallbackParams, context: OAuthProviderContext): Promise<OAuthTokenSet>;
  /** 将后端 polling 返回的 provider token 归一化为 Desktop 持久化语义。 */
  normalizePolledTokenSet?(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet>;
  fetchUserInfo?(tokenSet: OAuthTokenSet, context: OAuthProviderContext): Promise<OAuthUserProfile>;
  refreshToken?(tokenSet: OAuthTokenSet, context: OAuthProviderContext): Promise<OAuthTokenSet>;

  /** provider 级 legacy 凭据读取（用于升级兼容） */
  loadLegacyTokenSet?(
    loadCredential: (key: string) => Promise<string | null>,
  ): Promise<OAuthTokenSet | null>;

  normalizeError(error: unknown): Error;
}
