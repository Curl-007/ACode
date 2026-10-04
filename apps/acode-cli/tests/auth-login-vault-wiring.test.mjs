import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * R1-c（批次 4，packages/provider-node/specs/byo-apikey-credential-ref.md）守护：
 * auth-login 的 NodePersonalProviderConfigRepository 构造点必须注入 providerApiKeyVault。
 *
 * 该构造点曾是全仓唯一不注入 vault 的装配处：saveConfiguredDefault 重写整份文件时，
 * importLegacy 带入的旧明文 BYO Key 会原样落盘且不迁移（静默明文，无任何告警面）。
 * 构造参数缺 providerApiKeyVault 即红。
 */

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "../packages/bootstrap/src/auth-login.ts");

function read() {
  // 仓库 .ts 存在 CRLF/LF 混用，先归一（同 plugin-foreign-manifest-compat 测试纪律）。
  return readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
}

test("R1-c: auth-login repository construction injects providerApiKeyVault", () => {
  const source = read();
  const construction = source.match(/new NodePersonalProviderConfigRepository\(\{[\s\S]*?\}\);/);
  assert.ok(construction, "repository construction not found in auth-login.ts");
  assert.match(
    construction[0],
    /providerApiKeyVault:\s*createSharedCredentialStoreApiKeyVault\(input\.credentialStore\)/,
    "construction must wire the shared-credential-store vault adapter",
  );
});

test("R1-c: the vault adapter import stays wired", () => {
  const source = read();
  assert.match(source, /createSharedCredentialStoreApiKeyVault,/);
});
