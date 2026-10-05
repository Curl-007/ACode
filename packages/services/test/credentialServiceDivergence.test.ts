import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { isCredentialDecryptError } from "@acode/shared";
import { createACodeCredentialCipher, type CredentialKeychainAccess } from "@acode/shared/node";
import { createCredentialService } from "../src/credential/credentialService.js";
import { setDataBaseDir } from "../src/paths.js";

/**
 * R2（0.0.3，packages/services/specs/credential-storage.md）host 侧验收：
 * - 自愈收敛：读到「分歧密钥文件材料」写入的密文后，值被主密钥材料重加密写回，
 *   存储回到单一材料态（删除分歧密钥文件后仍可读）。
 * - 解密失败留证：两把材料都解不开时，整店备份为 credentials.json.corrupt-<hash>.bak
 *   后才把错误上抛（下游 clearCorruptOAuthSession 清空前有可恢复证据），
 *   错误仍满足 isCredentialDecryptError 契约。
 *
 * 只在临时目录 + setDataBaseDir 上运行，绝不触碰真实 ~/.acode 与真机钥匙串。
 */

function stubKeychain(): CredentialKeychainAccess & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    read(keyFilePath) {
      const secret = store.get(keyFilePath);
      return secret === undefined ? { status: "absent" } : { status: "found", secret };
    },
    write(keyFilePath, secret) {
      store.set(keyFilePath, secret);
      return { status: "written", secret };
    },
    delete(keyFilePath) {
      store.delete(keyFilePath);
    },
  };
}

/** pre-R1 旧构建视图：钥匙串不可用、只认密钥文件。 */
const unavailableKeychain: CredentialKeychainAccess = {
  read: () => ({ status: "unavailable", reason: "disabled for R2 old-build simulation" }),
  write: () => ({ status: "unavailable", reason: "disabled for R2 old-build simulation" }),
  delete: () => {},
};

function writeKeyFile(keyFilePath: string, material: Buffer): void {
  mkdirSync(dirname(keyFilePath), { recursive: true });
  writeFileSync(
    keyFilePath,
    `${JSON.stringify({ version: 1, key: material.toString("base64url") }, null, 2)}\n`,
    "utf-8",
  );
}

const ACCESS_TOKEN_KEY = "oauth:bigmodel:access_token";

test("R2 自愈收敛：回退读到分歧密文后用主密钥材料重加密写回", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "acode-cred-r2-"));
  const oldDir = mkdtempSync(join(tmpdir(), "acode-cred-r2-old-"));
  try {
    // 1) pre-R1 旧构建在独立目录用密钥文件材料写入凭据（独立目录是为了绕开
    //    解析层按 keyFilePath 的进程级钥匙串缓存：同一文件路径的旧/新视图会互相污染）。
    const divergent = randomBytes(32);
    const oldKeyFilePath = join(oldDir, ".acode", "v2", "credential-key.json");
    writeKeyFile(oldKeyFilePath, divergent);
    const oldBuildCipher = createACodeCredentialCipher({
      keyFilePath: oldKeyFilePath,
      env: {},
      keychain: unavailableKeychain,
      onWarn: () => {},
    });
    const divergentCipherText = oldBuildCipher.encrypt("token-secret");

    // 2) 新构建视图：当前数据根下钥匙串（主材料）∧ 密钥文件（分歧材料）并存。
    setDataBaseDir(baseDir);
    const configDir = join(baseDir, ".acode", "v2");
    mkdirSync(configDir, { recursive: true });
    const keyFilePath = join(configDir, "credential-key.json");
    writeKeyFile(keyFilePath, divergent);
    const keychain = stubKeychain();
    keychain.store.set(keyFilePath, randomBytes(32).toString("base64url"));
    const credentialsFile = join(configDir, "credentials.json");
    writeFileSync(
      credentialsFile,
      `${JSON.stringify({ [ACCESS_TOKEN_KEY]: divergentCipherText }, null, 2)}\n`,
      "utf-8",
    );

    const cipherProvider = createACodeCredentialCipher({
      keyFilePath,
      env: {},
      keychain,
      onWarn: () => {},
    });
    const service = createCredentialService({ cipherProvider });

    // 3) 读取成功（分歧材料回退命中），且该值被主密钥材料重加密写回。
    const value = await service.load(ACCESS_TOKEN_KEY);
    assert.equal(value, "token-secret");

    const rawAfter = JSON.parse(readFileSync(credentialsFile, "utf-8"))[ACCESS_TOKEN_KEY] as string;
    assert.notEqual(rawAfter, divergentCipherText, "密文应已被收敛重写");

    // 4) 删除分歧密钥文件（只剩钥匙串材料）后密文仍可直接解密——存储已回到单一材料态。
    rmSync(keyFilePath);
    const primaryOnly = createACodeCredentialCipher({
      keyFilePath,
      env: {},
      keychain,
      onWarn: () => {},
    });
    assert.equal(primaryOnly.decrypt(rawAfter), "token-secret");

    // 5) 收敛后的再次读取走主材料，不再产生重写（幂等）。
    const valueAgain = await service.load(ACCESS_TOKEN_KEY);
    assert.equal(valueAgain, "token-secret");
    const rawStable = JSON.parse(readFileSync(credentialsFile, "utf-8"))[
      ACCESS_TOKEN_KEY
    ] as string;
    assert.equal(rawStable, rawAfter);
  } finally {
    setDataBaseDir(null);
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(oldDir, { recursive: true, force: true });
  }
});

test("R2 留证：解密失败先整店备份 .corrupt-*.bak 再上抛，错误契约不变", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "acode-cred-r2-quarantine-"));
  try {
    setDataBaseDir(baseDir);
    const configDir = join(baseDir, ".acode", "v2");
    mkdirSync(configDir, { recursive: true });
    const keyFilePath = join(configDir, "credential-key.json");
    const keychain = stubKeychain();
    keychain.store.set(keyFilePath, randomBytes(32).toString("base64url"));

    // 第三把材料（显式 secret 来源）加密的密文：钥匙串与（不存在的）密钥文件都解不开。
    const foreignCipher = createACodeCredentialCipher({
      env: {},
      secret: randomBytes(32).toString("base64url"),
    });
    const credentialsFile = join(configDir, "credentials.json");
    const originalStore = JSON.stringify(
      { [ACCESS_TOKEN_KEY]: foreignCipher.encrypt("secret"), "ssh:some-host": "plain-legacy" },
      null,
      2,
    );
    writeFileSync(credentialsFile, `${originalStore}\n`, "utf-8");

    const cipherProvider = createACodeCredentialCipher({
      keyFilePath,
      env: {},
      keychain,
      onWarn: () => {},
    });
    const service = createCredentialService({ cipherProvider });

    await assert.rejects(
      () => service.load(ACCESS_TOKEN_KEY),
      (error: unknown) => isCredentialDecryptError(error),
      "解密失败必须仍满足 isCredentialDecryptError（下游恢复路径依赖该谓词）",
    );

    const backups = readdirSync(configDir).filter(
      (name) => name.startsWith("credentials.json.corrupt-") && name.endsWith(".bak"),
    );
    assert.equal(backups.length, 1, "应留下恰好一份内容哈希命名的备份");
    assert.equal(
      readFileSync(join(configDir, backups[0]), "utf-8"),
      `${originalStore}\n`,
      "备份内容与清空前原文件一致（含未涉事的 SSH 等其他凭据）",
    );

    // 幂等：同一损坏内容重复读取仍收敛到同一份备份（内容哈希命名 + 排他创建）。
    await assert.rejects(
      () => service.load(ACCESS_TOKEN_KEY),
      (error: unknown) => isCredentialDecryptError(error),
    );
    const backupsAfterRetry = readdirSync(configDir).filter(
      (name) => name.startsWith("credentials.json.corrupt-") && name.endsWith(".bak"),
    );
    assert.equal(backupsAfterRetry.length, 1);
  } finally {
    setDataBaseDir(null);
    rmSync(baseDir, { recursive: true, force: true });
  }
});
