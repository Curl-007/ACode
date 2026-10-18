/**
 * WI-17 HMAC 私钥生命周期单测（specs/transcript-secret-obfuscation.md 验收场景 3）。
 * win32 权限语义如实处理：NTFS 忽略 POSIX mode 位，0600 断言只在非 win32 执行，
 * win32 断言文件存在与内容合法并显式记录差异（spec R5/R8-6）。
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultSecretKeyDir,
  loadOrCreateSecretPlaceholderKey,
  SECRET_PLACEHOLDER_KEY_FILENAME,
} from "../src/security/secret-redaction/key.js";

const IS_WIN32 = process.platform === "win32";
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "acode-secret-key-test-"));
  try {
    run(dir);
  } finally {
    // Windows 上只读目录会挡住递归删除，先恢复权限再清理。
    if (IS_WIN32) {
      try {
        chmodSync(dir, 0o700);
      } catch {
        // 清理尽力而为
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("首次调用创建 key 文件：内容合法、非 win32 下 0600", () => {
  withTempDir((dir) => {
    const outcome = loadOrCreateSecretPlaceholderKey(dir);
    assert.equal(outcome.persisted, true);
    assert.ok(KEY_SHAPE.test(outcome.key), "43 字符 base64url");
    const keyPath = join(dir, SECRET_PLACEHOLDER_KEY_FILENAME);
    const onDisk = readFileSync(keyPath, "utf8");
    assert.equal(onDisk, outcome.key, "落盘内容与返回值一致");
    if (IS_WIN32) {
      // NTFS 无 POSIX mode 语义：只断言文件存在与内容合法（spec R8-6 如实记录）。
      assert.ok(statSync(keyPath).isFile());
    } else {
      const mode = statSync(keyPath).mode & 0o777;
      assert.equal(mode, 0o600, "私钥文件必须 0600");
    }
  });
});

test("二次调用复用同一 key（跨会话占位符稳定性的来源）", () => {
  withTempDir((dir) => {
    const first = loadOrCreateSecretPlaceholderKey(dir);
    const second = loadOrCreateSecretPlaceholderKey(dir);
    assert.equal(second.key, first.key);
    assert.equal(second.persisted, true);
  });
});

test("损坏 key 文件：不覆盖、不抛错，ephemeral 降级", () => {
  withTempDir((dir) => {
    const keyPath = join(dir, SECRET_PLACEHOLDER_KEY_FILENAME);
    writeFileSync(keyPath, "corrupted-not-a-valid-key", { mode: 0o600 });
    const outcome = loadOrCreateSecretPlaceholderKey(dir);
    assert.equal(outcome.persisted, false);
    assert.equal(outcome.persistenceError, "key_file_present_but_unreadable");
    assert.ok(KEY_SHAPE.test(outcome.key), "ephemeral key 同样是合法形态");
    assert.equal(readFileSync(keyPath, "utf8"), "corrupted-not-a-valid-key", "损坏文件不被覆盖");
  });
});

test("目录不可写：ephemeral 降级 + 错误类别，绝不抛出", () => {
  if (IS_WIN32) {
    // win32 只读位对目录写入的拦截语义与 POSIX 不同且不完整——跳过该用例（如实记录）。
    return;
  }
  withTempDir((parent) => {
    const locked = join(parent, "locked");
    const readOnlyDir = join(locked, "security");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const outcome = loadOrCreateSecretPlaceholderKey(readOnlyDir);
      assert.equal(outcome.persisted, false);
      assert.ok(outcome.persistenceError, "带错误类别（不含 key 值）");
      assert.ok(KEY_SHAPE.test(outcome.key));
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

test("defaultSecretKeyDir：ACODE_DATA_BASE_DIR 优先，落 <root>/.acode/cli/security", () => {
  const dir = defaultSecretKeyDir({ ACODE_DATA_BASE_DIR: "/tmp/synthetic-acode-base" });
  assert.equal(dir, join("/tmp/synthetic-acode-base", ".acode", "cli", "security"));
  const fallback = defaultSecretKeyDir({ HOME: "/home/synthetic" });
  assert.equal(fallback, join("/home/synthetic", ".acode", "cli", "security"));
});

test("key 值不出现在 outcome 之外的任何字段（日志红线）", () => {
  withTempDir((dir) => {
    const outcome = loadOrCreateSecretPlaceholderKey(dir);
    // outcome 的可序列化字段里，key 之外不得再含 key 值（persistenceError 是类别 token）。
    const { key, ...rest } = outcome;
    assert.ok(!JSON.stringify(rest).includes(key));
  });
});
