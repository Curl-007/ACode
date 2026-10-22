// specs/web-reconnect.md 无关；本文件守护 R2-05 finding 5：getActiveProvider 过 isWebOAuthProviderId。
// BrowserOAuthCredentialRepo 构造器接受注入 storage，无需 jsdom——用内存 Storage 桩即可。
import assert from "node:assert/strict";
import test from "node:test";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@acode/shared";
import { BrowserOAuthCredentialRepo } from "../src/auth/browserOAuthCredentialRepo.js";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";

/** 最小 Storage 桩：只实现 repo 用到的 getItem/setItem/removeItem。 */
function makeMemoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function makeRepo(localStorageSeed: Record<string, string> = {}) {
  return new BrowserOAuthCredentialRepo({
    localStorage: makeMemoryStorage(localStorageSeed),
    sessionStorage: makeMemoryStorage(),
  });
}

test("getActiveProvider 返回合法 provider（zai / bigmodel）", () => {
  assert.equal(makeRepo({ [ACTIVE_PROVIDER_KEY]: ZAI_PROVIDER_ID }).getActiveProvider(), ZAI_PROVIDER_ID);
  assert.equal(
    makeRepo({ [ACTIVE_PROVIDER_KEY]: BIGMODEL_PROVIDER_ID }).getActiveProvider(),
    BIGMODEL_PROVIDER_ID,
  );
});

test("getActiveProvider 对非法 active_provider 归一为 null（finding 5 验收）", () => {
  // 修复前：直接 `getItem(...) as OAuthProviderId`，任意字符串强转成合法 provider，
  // 流入 useAuthToken 的 `oauth:${activeProvider}:access_token` 键模板。
  for (const bad of ["evil-provider", "notion", "", "  ", "__proto__", "constructor"]) {
    const repo = makeRepo({ [ACTIVE_PROVIDER_KEY]: bad });
    assert.equal(repo.getActiveProvider(), null, `非法值 "${bad}" 必须归一为 null`);
  }
});

test("getActiveProvider 缺失 key 时返回 null", () => {
  assert.equal(makeRepo({}).getActiveProvider(), null);
});

test("setActiveProvider(null) 清除后 getActiveProvider 返回 null", () => {
  const repo = makeRepo({ [ACTIVE_PROVIDER_KEY]: ZAI_PROVIDER_ID });
  assert.equal(repo.getActiveProvider(), ZAI_PROVIDER_ID);
  repo.setActiveProvider(null);
  assert.equal(repo.getActiveProvider(), null);
});

test("loadPendingProvider 对非法 pending provider 也归一为 null（同范式回归）", () => {
  // 确认既有正确范式未被破坏，且与 getActiveProvider 校验一致。
  const repo = makeRepo({});
  // 直接写非法 pending provider 到 sessionStorage（模拟旧版本残留 / 手工写入）。
  const storage = makeMemoryStorage({ oauth_pending_provider: "evil-provider" });
  const repoWithBadPending = new BrowserOAuthCredentialRepo({
    localStorage: makeMemoryStorage(),
    sessionStorage: storage,
  });
  assert.equal(repoWithBadPending.loadPendingProvider(), null);
  repo.savePendingProvider(ZAI_PROVIDER_ID);
  assert.equal(repo.loadPendingProvider(), ZAI_PROVIDER_ID);
});
