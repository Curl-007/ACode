import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type ApiClient,
  type ApiRequestInit,
  createDefaultOfficialServiceSwitches,
  setOfficialServiceSwitches,
} from "@acode/shared";
import { OAuthService } from "../src/oauth/oauthService.js";
import { BigModelProviderAdapter } from "../src/oauth/providers/bigmodelProviderAdapter.js";
import {
  buildPkceAuthorizeParams,
  buildPkceTokenExchangeFields,
  createOAuthPkcePair,
} from "../src/oauth/providers/pkce.js";
import type { OAuthProviderContext } from "../src/oauth/providers/providerAdapter.js";
import { ZaiProviderAdapter } from "../src/oauth/providers/zaiProviderAdapter.js";
import type {
  OAuthProviderRuntimeConfig,
} from "../src/oauth/runtimeConfig.js";

const REDIRECT_URI = "zcode://oauth/callback";
const BIGMODEL_TOKEN_URL = "https://backend.example/api/v1/oauth/token";
const ZAI_BUSINESS_LOGIN_URL = "https://api.z.example/api/auth/z/login";

interface CapturedRequest {
  url: string;
  init?: ApiRequestInit;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createMemoryCredentialService() {
  const store = new Map<string, string>();
  return {
    load: async (key: string) => store.get(key) ?? null,
    save: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function createFakeApiClient(
  respond: (url: string, init?: ApiRequestInit) => Response,
  captured: CapturedRequest[],
): ApiClient {
  return {
    async request(input, init) {
      const url = typeof input === "string" ? input : input.toString();
      captured.push({ url, init });
      return respond(url, init);
    },
  };
}

function bigModelConfig(): OAuthProviderRuntimeConfig {
  return {
    id: BIGMODEL_PROVIDER_ID,
    displayName: "BigModel",
    enabled: true,
    order: 0,
    authorizeUrl: "https://bigmodel.example/login",
    tokenUrl: BIGMODEL_TOKEN_URL,
    userinfoUrl: "https://bigmodel.example/api/biz/customer/getCustomerInfo",
    appId: "acode",
    redirectUri: REDIRECT_URI,
  };
}

function zaiConfig(): OAuthProviderRuntimeConfig {
  return {
    id: ZAI_PROVIDER_ID,
    displayName: "Z.ai",
    enabled: true,
    order: 1,
    authorizeUrl: "https://chat.z.example/api/oauth/authorize",
    tokenUrl: BIGMODEL_TOKEN_URL,
    userinfoUrl: "https://chat.z.example/api/oauth/userinfo",
    businessLoginUrl: ZAI_BUSINESS_LOGIN_URL,
    appId: "client_test",
    redirectUri: REDIRECT_URI,
  };
}

/** 独立实现的 S256 对照（不复用被测代码的派生路径）。 */
function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function contextWith(
  pair: { codeVerifier: string; codeChallenge: string },
  providerId: OAuthProviderContext["providerId"] = BIGMODEL_PROVIDER_ID,
  state = "state-fixed",
): OAuthProviderContext {
  return {
    providerId,
    state,
    redirectUri: REDIRECT_URI,
    now: () => 1_000,
    codeVerifier: pair.codeVerifier,
    codeChallenge: pair.codeChallenge,
  };
}

function bareContext(
  providerId: OAuthProviderContext["providerId"] = BIGMODEL_PROVIDER_ID,
): OAuthProviderContext {
  // 无 PKCE 上下文：对应轮询流程的 deep-link 完成与 refresh 语义。
  return {
    providerId,
    state: "state-fixed",
    redirectUri: REDIRECT_URI,
    now: () => 1_000,
  };
}

function enableOfficialAccount(): void {
  setOfficialServiceSwitches({ account: true });
}

function resetOfficialAccount(): void {
  setOfficialServiceSwitches(createDefaultOfficialServiceSwitches());
}

const BIGMODEL_TOKEN_ENVELOPE = {
  code: 0,
  data: {
    // token 与 bigmodel.access_token 相同可命中 fetchUserInfo 的短路路径，测试不需要 userinfo 请求。
    token: "acode-jwt-x",
    bigmodel: { access_token: "acode-jwt-x", refresh_token: "refresh-x" },
  },
};

const ZAI_TOKEN_ENVELOPE = {
  code: 0,
  data: {
    token: "acode-jwt-z",
    zai: { access_token: "zai-oauth-token" },
    user: { user_id: "u-1", name: "tester" },
  },
};

const ZAI_BUSINESS_LOGIN_ENVELOPE = { code: 0, data: { access_token: "zai-business-token" } };

test("PKCE pair 遵循 S256 且 verifier 满足 RFC 7636 形态", async () => {
  const first = await createOAuthPkcePair();
  const second = await createOAuthPkcePair();

  // challenge 必须等于 base64url(sha256(verifier))（S256，非 plain）。
  assert.equal(first.codeChallenge, s256(first.codeVerifier));
  assert.equal(second.codeChallenge, s256(second.codeVerifier));
  // RFC 7636：verifier 长度 43-128，字符集为 unreserved。
  assert.ok(first.codeVerifier.length >= 43 && first.codeVerifier.length <= 128);
  assert.match(first.codeVerifier, /^[A-Za-z0-9\-._~]+$/);
  assert.notEqual(first.codeVerifier, second.codeVerifier);
});

test("helper 在无 PKCE 上下文时返回空对象", async () => {
  const context = bareContext();
  assert.deepEqual(buildPkceAuthorizeParams(context), {});
  assert.deepEqual(buildPkceTokenExchangeFields(context), {});
});

test("BigModel 授权 URL 注入 code_challenge/S256 并保留既有参数", async () => {
  const adapter = new BigModelProviderAdapter(bigModelConfig(), createFakeApiClient(() => jsonResponse({}), []));
  const pair = await createOAuthPkcePair();
  const url = new URL(adapter.buildAuthorizeUrl(contextWith(pair)));

  assert.equal(url.origin + url.pathname, "https://bigmodel.example/login");
  assert.equal(url.searchParams.get("code_challenge"), pair.codeChallenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state-fixed");
  assert.equal(url.searchParams.get("redirect"), REDIRECT_URI);
  assert.equal(url.searchParams.get("appId"), "acode");
  // 无 PKCE 上下文时不得出现挑战参数（轮询流程零回归）。
  const bareUrl = new URL(adapter.buildAuthorizeUrl(bareContext()));
  assert.equal(bareUrl.searchParams.get("code_challenge"), null);
  assert.equal(bareUrl.searchParams.get("code_challenge_method"), null);
});

test("ZAI 授权 URL 注入 code_challenge/S256 并保留既有参数", async () => {
  const adapter = new ZaiProviderAdapter(zaiConfig(), createFakeApiClient(() => jsonResponse({}), []));
  const pair = await createOAuthPkcePair();
  const url = new URL(adapter.buildAuthorizeUrl(contextWith(pair, ZAI_PROVIDER_ID)));

  assert.equal(url.origin + url.pathname, "https://chat.z.example/api/oauth/authorize");
  assert.equal(url.searchParams.get("code_challenge"), pair.codeChallenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state-fixed");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client_test");
  const bareUrl = new URL(adapter.buildAuthorizeUrl(bareContext(ZAI_PROVIDER_ID)));
  assert.equal(bareUrl.searchParams.get("code_challenge"), null);
});

test("BigModel token 交换载荷携带配对的 code_verifier", async () => {
  enableOfficialAccount();
  const captured: CapturedRequest[] = [];
  const api = createFakeApiClient((url) =>
    url.startsWith(BIGMODEL_TOKEN_URL) ? jsonResponse(BIGMODEL_TOKEN_ENVELOPE) : jsonResponse({}),
    captured,
  );
  const adapter = new BigModelProviderAdapter(bigModelConfig(), api);
  const pair = await createOAuthPkcePair();

  await adapter.exchangeToken({ code: "authcode-1", state: "state-fixed" }, contextWith(pair));

  assert.equal(captured.length, 1);
  const body = JSON.parse(String(captured[0]?.init?.body)) as Record<string, unknown>;
  assert.equal(body.code, "authcode-1");
  assert.equal(body.code_verifier, pair.codeVerifier);
  // 载荷里的 verifier 必须与授权 URL 的 challenge 配对（同一派生）。
  assert.equal(s256(String(body.code_verifier)), s256(pair.codeVerifier));
});

test("ZAI token 交换载荷携带配对的 code_verifier", async () => {
  enableOfficialAccount();
  const captured: CapturedRequest[] = [];
  const api = createFakeApiClient((url) => {
    if (url.startsWith(BIGMODEL_TOKEN_URL)) return jsonResponse(ZAI_TOKEN_ENVELOPE);
    if (url.startsWith(ZAI_BUSINESS_LOGIN_URL)) return jsonResponse(ZAI_BUSINESS_LOGIN_ENVELOPE);
    return jsonResponse({});
  }, captured);
  const adapter = new ZaiProviderAdapter(zaiConfig(), api);
  const pair = await createOAuthPkcePair();

  const tokenSet = await adapter.exchangeToken(
    { code: "authcode-2", state: "state-fixed" },
    contextWith(pair, ZAI_PROVIDER_ID),
  );

  const tokenCall = captured.find((entry) => entry.url.startsWith(BIGMODEL_TOKEN_URL));
  assert.ok(tokenCall);
  const body = JSON.parse(String(tokenCall.init?.body)) as Record<string, unknown>;
  assert.equal(body.code, "authcode-2");
  assert.equal(body.code_verifier, pair.codeVerifier);
  assert.equal(tokenSet.accessToken, "zai-business-token");
});

test("无 PKCE 上下文时交换载荷保持原形（轮询流程 deep-link 完成零回归）", async () => {
  enableOfficialAccount();
  const captured: CapturedRequest[] = [];
  const api = createFakeApiClient((url) =>
    url.startsWith(BIGMODEL_TOKEN_URL) ? jsonResponse(BIGMODEL_TOKEN_ENVELOPE) : jsonResponse({}),
    captured,
  );
  const adapter = new BigModelProviderAdapter(bigModelConfig(), api);

  await adapter.exchangeToken({ code: "authcode-3", state: "state-fixed" }, bareContext());

  const body = JSON.parse(String(captured[0]?.init?.body)) as Record<string, unknown>;
  assert.equal("code_verifier" in body, false);
});

test("OAuthService：回调兑换使用启动暂存的 verifier，旧 state 回调被拒且零请求", async () => {
  enableOfficialAccount();
  const captured: CapturedRequest[] = [];
  const api = createFakeApiClient((url) =>
    url.startsWith(BIGMODEL_TOKEN_URL) ? jsonResponse(BIGMODEL_TOKEN_ENVELOPE) : jsonResponse({}),
    captured,
  );
  const service = new OAuthService(createMemoryCredentialService(), {
    adapters: [new BigModelProviderAdapter(bigModelConfig(), api)],
    apiClient: api,
    env: {},
  });

  try {
    const first = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    const authorizeChallenge = new URL(first.authorizeUrl).searchParams.get("code_challenge");
    assert.ok(authorizeChallenge);
    assert.equal(new URL(first.authorizeUrl).searchParams.get("code_challenge_method"), "S256");

    const result = await service.handleCallback(
      `zcode://oauth/callback?authCode=code-1&state=${first.state}`,
    );
    assert.equal(result?.kind, "session");

    // 兑换用的 verifier 与授权 URL 的 challenge 配对：证明回调消费的正是启动时暂存的那一个。
    const tokenCalls = captured.filter(
      (entry) => entry.url.startsWith(BIGMODEL_TOKEN_URL) && entry.init?.method === "POST",
    );
    assert.equal(tokenCalls.length, 1);
    const body = JSON.parse(String(tokenCalls[0]?.init?.body)) as Record<string, unknown>;
    assert.equal(s256(String(body.code_verifier)), authorizeChallenge);

    // 新 flow 启动后，旧 state 的回调必须被拒，且不得发出第二次 token 请求
    // （state 错配在先，verifier 永远不会跨 flow 消费）。
    await service.startOAuth(BIGMODEL_PROVIDER_ID);
    await assert.rejects(
      () => service.handleCallback(`zcode://oauth/callback?authCode=code-2&state=${first.state}`),
      /state 不匹配或已过期/,
    );
    assert.equal(
      captured.filter(
        (entry) => entry.url.startsWith(BIGMODEL_TOKEN_URL) && entry.init?.method === "POST",
      ).length,
      1,
    );
  } finally {
    await service.cancelPending();
    resetOfficialAccount();
  }
});

test("OAuthService：refresh 路径不携带任何 PKCE 参数（未实现 refresh 时零网络请求）", async () => {
  enableOfficialAccount();
  const captured: CapturedRequest[] = [];
  const api = createFakeApiClient((url) =>
    url.startsWith(BIGMODEL_TOKEN_URL) ? jsonResponse(BIGMODEL_TOKEN_ENVELOPE) : jsonResponse({}),
    captured,
  );
  const service = new OAuthService(createMemoryCredentialService(), {
    adapters: [new BigModelProviderAdapter(bigModelConfig(), api)],
    apiClient: api,
    env: {},
  });

  try {
    const started = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    await service.handleCallback(
      `zcode://oauth/callback?authCode=code-1&state=${started.state}`,
    );

    const before = captured.length;
    // 当前 BigModel/ZAI adapter 均未实现 refreshToken：refresh 是独立 grant，
    // 无授权码语义，任何 PKCE 参数都不应出现；这里断言失败路径同样零网络请求。
    await assert.rejects(() => service.refreshToken(BIGMODEL_PROVIDER_ID), /refresh token 交换接口/);
    assert.equal(captured.length, before);
  } finally {
    await service.cancelPending();
    resetOfficialAccount();
  }
});

test("startOAuthWithPolling 不注入 PKCE 参数（授权 URL 由后端所有）", async () => {
  enableOfficialAccount();
  const captured: CapturedRequest[] = [];
  const backendAuthorizeUrl =
    "https://chat.z.example/api/oauth/authorize?redirect_uri=backend-callback&response_type=code&client_id=client_backend&state=backend-state";
  const api = createFakeApiClient(() =>
    jsonResponse({
      code: 0,
      data: {
        flow_id: "flow-1",
        authorize_url: backendAuthorizeUrl,
        expires_at: (Date.now() + 300_000) / 1000,
        poll_interval_sec: 2,
      },
    }),
    captured,
  );
  const service = new OAuthService(createMemoryCredentialService(), {
    adapters: [new ZaiProviderAdapter(zaiConfig(), api)],
    apiClient: api,
    env: {},
  });

  try {
    const start = await service.startOAuthWithPolling(ZAI_PROVIDER_ID);
    const url = new URL(start.authorizeUrl);

    assert.equal(url.searchParams.get("state"), "backend-state");
    // 客户端只重写 redirect 参数；PKCE 由后端协议负责，客户端不得注入 challenge，
    // 否则 provider 强制 PKCE 时后端兑换（无 verifier）会失败。
    assert.equal(url.searchParams.get("code_challenge"), null);
    assert.equal(url.searchParams.get("code_challenge_method"), null);
  } finally {
    await service.cancelPending(ZAI_PROVIDER_ID);
    resetOfficialAccount();
  }
});
