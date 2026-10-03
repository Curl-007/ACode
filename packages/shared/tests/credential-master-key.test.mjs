import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";

/**
 * 安全加固 P0-4 的不变量守护测试（凭据主密钥不可离线推导）。
 *
 * 仿照 packages/server/tests/server-auth.test.mjs 的写法：纯共享原语直接 import
 * （Node 25 type-stripping），仅用临时目录 fixture——**绝不读写真实 ~/.acode 或
 * 任何真实凭据**。
 *
 * R1-a（批次 4）后本文件钉住的是**文件模式**语义：所有解析/构造调用注入
 * `noKeychain` stub（unavailable），与 P0-4 时代的行为逐条对齐。钥匙串模式与
 * 优先级链在 credential-keychain.test.mjs 覆盖；真机钥匙串绝不被本文件触碰。
 *
 * 守护的不变量：
 * (a) 新密文一律 enc:v2:，密钥来自每安装随机密钥文件/env/显式注入，
 *     源码中不再出现 `acode-credential-fallback` 用于**新写入**的路径；
 * (b) 历史 enc:v1:（旧可推导密钥）仍可解密——升级不丢凭据；
 * (c) 两个「进程」（同 baseDir 的两个 cipher 实例）收敛到同一把密钥——
 *     桌面 host 与 CLI 共用同一 credentials.json 的前提；
 * (d) ACODE_CREDENTIAL_SECRET env 不得压过既有持久材料（密钥文件）；
 * (e) v1 密文重新贴上 enc:v2: 前缀必须被 GCM 拒绝（版本混淆攻击不成立）。
 */

const credentialCipher = await import("../src/node/credentialCipher.ts");
const credentialMasterKey = await import("../src/node/credentialMasterKey.ts");
const { isCredentialDecryptError } = await import("../src/oauth.ts");

const {
  createACodeCredentialCipher,
  isEncryptedACodeCredentialValue,
  isEncryptedACodeCredentialValueV1,
} = credentialCipher;
const { resolveCredentialMasterKey, resolveCredentialKeyFilePath, CREDENTIAL_KEY_FILE_NAME } =
  credentialMasterKey;

/**
 * 文件模式 stub：钥匙串恒不可用。R1-a 把「生成」分支改成了钥匙串优先，真机
 * （macOS/Windows/Linux 桌面）上默认访问器可用会让本文件的密钥文件断言全部失真，
 * 故显式注入。生成分支会因此发一条降级告警（走 onWarn 或 once-guarded console）。
 */
const noKeychain = {
  read: () => ({ status: "unavailable", reason: "disabled for file-mode test" }),
  write: () => ({ status: "unavailable", reason: "disabled for file-mode test" }),
};

/** 复刻旧 v1 加密逻辑（sha256 单轮、无 AAD），用于构造历史密文 fixture。 */
function encryptLegacyV1(plaintext, secret) {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    "enc:v1:",
    iv.toString("base64url"),
    ".",
    authTag.toString("base64url"),
    ".",
    encrypted.toString("base64url"),
  ].join("");
}

function legacyFallbackSecret() {
  return `acode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
}

function withTempBaseDir(fn) {
  const baseDir = mkdtempSync(join(tmpdir(), "acode-credkey-test-"));
  try {
    return fn(baseDir);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

test("new ciphertext is enc:v2 and round-trips via per-install key file", () => {
  withTempBaseDir((baseDir) => {
    const env = {};
    const cipher = createACodeCredentialCipher({ baseDir, env, keychain: noKeychain });
    const encrypted = cipher.encrypt("sk-live-secret-token");
    assert.ok(encrypted.startsWith("enc:v2:"), `expected enc:v2 prefix, got ${encrypted.slice(0, 12)}`);
    assert.ok(isEncryptedACodeCredentialValue(encrypted));
    assert.equal(cipher.decrypt(encrypted), "sk-live-secret-token");

    // 密钥文件已生成在 <baseDir>/.acode/v2/ 下，内容是 32 字节 base64url。
    const keyFilePath = resolveCredentialKeyFilePath({ baseDir, env });
    assert.equal(keyFilePath, join(baseDir, ".acode", "v2", CREDENTIAL_KEY_FILE_NAME));
    assert.ok(existsSync(keyFilePath));
    const parsed = JSON.parse(readFileSync(keyFilePath, "utf-8"));
    assert.equal(parsed.version, 1);
    assert.equal(Buffer.from(parsed.key, "base64url").length, 32);
  });
});

test("two cipher instances on the same baseDir converge on the same key (host+CLI shared file)", () => {
  withTempBaseDir((baseDir) => {
    const env = {};
    const desktopSide = createACodeCredentialCipher({ baseDir, env, keychain: noKeychain });
    const cliSide = createACodeCredentialCipher({ baseDir, env, keychain: noKeychain });
    const encrypted = desktopSide.encrypt("oauth-access-token-123");
    // CLI 侧必须能解开桌面侧写的密文——两进程共用 credentials.json 的前提。
    assert.equal(cliSide.decrypt(encrypted), "oauth-access-token-123");
    // 反向亦然。
    assert.equal(desktopSide.decrypt(cliSide.encrypt("cli-writes-too")), "cli-writes-too");
  });
});

test("ACODE_CREDENTIAL_SECRET env takes precedence and no key file is written", () => {
  withTempBaseDir((baseDir) => {
    const env = { ACODE_CREDENTIAL_SECRET: "explicit-user-provided-secret-value" };
    const cipher = createACodeCredentialCipher({ baseDir, env, keychain: noKeychain });
    const encrypted = cipher.encrypt("value-under-env-secret");
    assert.equal(cipher.decrypt(encrypted), "value-under-env-secret");

    const keyFilePath = resolveCredentialKeyFilePath({ baseDir, env });
    assert.ok(!existsSync(keyFilePath), "env secret path must not create a key file");

    // 不同 env secret 的实例解不开上面的密文（密钥确实来自 env 而非常量）。
    const otherCipher = createACodeCredentialCipher({
      baseDir,
      env: { ACODE_CREDENTIAL_SECRET: "a-different-secret" },
      keychain: noKeychain,
    });
    assert.throws(() => otherCipher.decrypt(encrypted), /凭据解密失败/);
  });
});

test("legacy enc:v1 (derivable key) still decrypts — upgrade never orphans credentials", () => {
  // 用与升级前产物完全一致的派生逻辑构造历史密文（env 缺省时走可推导回退串）。
  const legacyCipherText = encryptLegacyV1("legacy-oauth-refresh-token", legacyFallbackSecret());
  assert.ok(legacyCipherText.startsWith("enc:v1:"));

  withTempBaseDir((baseDir) => {
    // env 留空 → 新写入走 v2 随机密钥；但 decrypt 必须仍能读 v1 历史密文。
    const cipher = createACodeCredentialCipher({ baseDir, env: {}, keychain: noKeychain });
    assert.equal(cipher.decrypt(legacyCipherText), "legacy-oauth-refresh-token");
  });
});

test("v1 ciphertext relabeled as v2 is rejected by GCM (version-confusion attack fails)", () => {
  const legacyCipherText = encryptLegacyV1("legacy-secret", legacyFallbackSecret());
  const relabeled = "enc:v2:" + legacyCipherText.slice("enc:v1:".length);
  withTempBaseDir((baseDir) => {
    const cipher = createACodeCredentialCipher({ baseDir, env: {}, keychain: noKeychain });
    assert.throws(() => cipher.decrypt(relabeled), /凭据解密失败/);
  });
});

test("plaintext (unencrypted) values pass through unchanged, matching legacy behavior", () => {
  withTempBaseDir((baseDir) => {
    const cipher = createACodeCredentialCipher({ baseDir, env: {}, keychain: noKeychain });
    assert.equal(cipher.decrypt("not-encrypted-at-all"), "not-encrypted-at-all");
  });
});

test("resolveCredentialMasterKey never returns the derivable fallback for new material", () => {
  withTempBaseDir((baseDir) => {
    const resolved = resolveCredentialMasterKey({ baseDir, env: {}, keychain: noKeychain });
    assert.equal(resolved.source, "keyFile");
    assert.equal(resolved.key.length, 32);
    // 与旧派生结果必须不同（密钥确实不再是 sha256(fallback)）。
    const legacyKey = createHash("sha256").update(legacyFallbackSecret()).digest();
    assert.notDeepEqual(resolved.key, legacyKey);
    // 再次解析返回同一把（幂等，读文件而非重新生成）。
    const again = resolveCredentialMasterKey({ baseDir, env: {}, keychain: noKeychain });
    assert.deepEqual(again.key, resolved.key);
  });
});

test("source invariant: the derivable fallback is constructed only in the shared legacy-decrypt module", () => {
  // (a) 的源码级守护：可推导回退串只允许在 credentialCipher.ts 的 legacy 解密路径被
  // **构造**（模板字面量 `acode-credential-fallback:${...}`）。注释里提到该串（描述历史
  // 行为）不算违规——守护的是「新写入路径不再派生可推导密钥」，不是「字符串不许出现」。
  const roots = ["packages/shared/src", "packages/services/src", "apps/acode-cli/packages"];
  const offenders = [];
  const constructionPattern = /acode-credential-fallback:\$\{/;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".turbo") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
      const text = readFileSync(full, "utf-8");
      if (constructionPattern.test(text)) {
        offenders.push(full);
      }
    }
  };
  const repoRoot = new URL("../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  for (const r of roots) walk(join(repoRoot, r));
  const allowed = join(repoRoot, "packages", "shared", "src", "node", "credentialCipher.ts").replaceAll("\\", "/");
  const normalized = offenders.map((f) => f.replaceAll("\\", "/"));
  assert.deepEqual(
    normalized.filter((f) => f !== allowed),
    [],
    `derivable fallback construction leaked into: ${offenders.join(", ")}`,
  );
});

test("decrypt failure carries the stable code + prefix that isCredentialDecryptError relies on", () => {
  // 回归守护：oauthCredentialRepo.ts 有 4 处靠 isCredentialDecryptError 把解密失败降级为
  // 「清理损坏会话 → 强制干净登出 → 重新登录」。合并两份 cipher 时曾把错误改成不带
  // code/前缀的裸 Error，令该谓词恒 false、恢复路径失效。此测试钉住该契约。
  withTempBaseDir((baseDir) => {
    const cipher = createACodeCredentialCipher({ baseDir, env: {}, keychain: noKeychain });
    const good = cipher.encrypt("some-secret");
    // 用另一把密钥加密的密文，交给当前 cipher 解密必然失败。
    // 注意：这里必须用 explicit `secret`（最高优先级）而不是 ACODE_CREDENTIAL_SECRET env——
    // 密钥文件已存在于同一 baseDir，按 P0-4 的优先级 env 会被忽略（避免孤立既有 v2 凭据），
    // 用 env 反而解析出同一把密钥、解密成功，测不到失败契约。
    const otherCipher = createACodeCredentialCipher({
      baseDir,
      secret: "a-completely-different-secret",
    });
    const foreign = otherCipher.encrypt("some-secret");
    assert.notEqual(good, foreign);

    let caught;
    try {
      cipher.decrypt(foreign);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error, "decrypt of foreign ciphertext must throw");
    assert.equal(
      isCredentialDecryptError(caught),
      true,
      "decrypt error must satisfy isCredentialDecryptError (stable code or CJK prefix)",
    );
    assert.match(caught.message, /^凭据解密失败：/, "message must carry the CJK prefix");
    assert.equal(caught.code, "ACODE_CREDENTIAL_DECRYPT_FAILED");
  });
});

// ── P0-4 修复项（对抗评审 #5）：env 与已存在密钥文件冲突时不得静默换密钥 ──────
//
// 旧实现把 env 检查放在密钥文件之前，导致「正常升级（已写 v2）后再设
// ACODE_CREDENTIAL_SECRET」会静默换密钥、令全部 v2 凭据不可解密且无诊断。
// 新实现让已存在的持久材料（R1-a 后含钥匙串）优先，env 被忽略并告警。

test("existing key file wins over ACODE_CREDENTIAL_SECRET and warns (no silent orphaning)", () => {
  withTempBaseDir((baseDir) => {
    const warnings = [];
    const onWarn = (message) => warnings.push(message);

    // 第一次解析：无 env → 生成密钥文件（noKeychain stub → 文件模式 + 一条降级告警）。
    const first = resolveCredentialMasterKey({ baseDir, env: {}, onWarn, keychain: noKeychain });
    assert.equal(first.source, "keyFile");

    // 第二次解析：env 已设但密钥文件已存在 → 必须仍用密钥文件（否则既有 v2 凭据解不开），
    // 且发出可诊断的告警。R1-a 后 warnings 还含首次生成的钥匙串降级告警，按内容过滤断言。
    const second = resolveCredentialMasterKey({
      baseDir,
      env: { ACODE_CREDENTIAL_SECRET: "a-different-secret-set-after-upgrade" },
      onWarn,
      keychain: noKeychain,
    });
    assert.equal(second.source, "keyFile", "existing key file must take precedence over env");
    assert.deepEqual(second.key, first.key, "resolved key must be unchanged by the env var");
    const envWarnings = warnings.filter((line) => /ACODE_CREDENTIAL_SECRET/.test(line));
    assert.equal(envWarnings.length, 1, "env conflict must emit exactly one warning");
    assert.match(envWarnings[0], /orphaning existing enc:v2 credentials/);

    // 加密/解密仍然自洽（证明凭据没有被孤立）。
    const cipher = createACodeCredentialCipher({
      baseDir,
      env: { ACODE_CREDENTIAL_SECRET: "a-different-secret-set-after-upgrade" },
      onWarn,
      keychain: noKeychain,
    });
    const encrypted = cipher.encrypt("still-readable-after-env-appeared");
    assert.equal(cipher.decrypt(encrypted), "still-readable-after-env-appeared");
  });
});

test("ACODE_CREDENTIAL_SECRET is honored on a fresh install (no key file yet)", () => {
  withTempBaseDir((baseDir) => {
    const env = { ACODE_CREDENTIAL_SECRET: "fresh-install-explicit-secret" };
    const resolved = resolveCredentialMasterKey({
      baseDir,
      env,
      onWarn: () => {},
      keychain: noKeychain,
    });
    assert.equal(resolved.source, "env", "fresh install with env must use the env secret");
    assert.ok(
      !existsSync(resolveCredentialKeyFilePath({ baseDir, env })),
      "env path must not create a key file",
    );
  });
});

// ── 不变量：encrypt() 绝不产出可推导密钥下的 v1 密文（P0-4 的核心安全属性）──────

test("encrypt never emits enc:v1 (no new ciphertext under the derivable key)", () => {
  // 这是 isEncryptedACodeCredentialValueV1 的真实用途：把「新写入只走 v2、v1 仅可解密」
  // 这条核心不变量钉成可执行断言。一旦有人让 encrypt() 退回写 v1，本测试立即变红。
  withTempBaseDir((baseDir) => {
    // 三种密钥来源都验：随机密钥文件、env、显式 secret。
    const ciphers = {
      keyFile: createACodeCredentialCipher({ baseDir, env: {}, keychain: noKeychain }),
      env: createACodeCredentialCipher({
        baseDir,
        env: { ACODE_CREDENTIAL_SECRET: "fresh-secret-no-keyfile" },
        onWarn: () => {},
        keychain: noKeychain,
      }),
      explicit: createACodeCredentialCipher({ baseDir, secret: "explicit-secret" }),
    };
    for (const [source, cipher] of Object.entries(ciphers)) {
      for (const plaintext of ["sk-live-token", "oauth-refresh", "", "中文与 emoji 🎉", "a".repeat(512)]) {
        const encrypted = cipher.encrypt(plaintext);
        assert.ok(
          isEncryptedACodeCredentialValue(encrypted),
          `${source}: encrypt output must be recognized as an encrypted value`,
        );
        assert.equal(
          isEncryptedACodeCredentialValueV1(encrypted),
          false,
          `${source}: encrypt must never emit enc:v1 (derivable-key ciphertext)`,
        );
        assert.ok(
          encrypted.startsWith("enc:v2:"),
          `${source}: encrypt must emit enc:v2, got ${encrypted.slice(0, 8)}`,
        );
      }
    }
  });
});

test("legacy v1 fixture is recognized by isEncryptedACodeCredentialValueV1", () => {
  const legacy = encryptLegacyV1("legacy-token", legacyFallbackSecret());
  assert.equal(isEncryptedACodeCredentialValueV1(legacy), true);
  assert.equal(isEncryptedACodeCredentialValue(legacy), true);
});
