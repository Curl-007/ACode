import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

/**
 * R1-a（批次 4，specs/credential-storage.md + docs/credential-os-keychain-design.md）
 * 验收测试：OS 钥匙串访问器（mock spawn 全分支，绝不触碰真机钥匙串）与主密钥解析链
 * 的钥匙串优先级/降级/fail-loud/进程级缓存语义。
 *
 * 文件模式（P0-4 原语义）由 credential-master-key.test.mjs 注入 unavailable stub 钉住。
 */

const {
  createCredentialKeychain,
  credentialKeychainAccount,
  windowsDpapiBlobPath,
  CREDENTIAL_KEYCHAIN_SERVICE,
} = await import("../src/node/credentialKeychain.ts");
const { resolveCredentialMasterKey, resolveCredentialKeyFilePath } = await import(
  "../src/node/credentialMasterKey.ts"
);

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-keychain-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mockSpawn(handler) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return handler(command, args, options, calls.length - 1);
  };
  return { spawn, calls };
}

const enoent = () => ({ status: null, error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) });
const ok = (stdout) => ({ status: 0, stdout: Buffer.from(stdout), stderr: Buffer.from("") });
const fail = (status, stderr) => ({ status, stdout: Buffer.from(""), stderr: Buffer.from(stderr) });

const sampleKeyB64Url = randomBytes(32).toString("base64url");

// ── macOS（security）─────────────────────────────────────────────────

test("darwin: read found / absent(44) / corrupt / ENOENT→unavailable", () => {
  const keyFilePath = "/tmp/does-not-matter/credential-key.json";

  const found = createCredentialKeychain({
    platform: "darwin",
    spawn: mockSpawn(() => ok(`${sampleKeyB64Url}\n`)).spawn,
  });
  const foundResult = found.read(keyFilePath);
  assert.equal(foundResult.status, "found");
  assert.equal(foundResult.secret, sampleKeyB64Url);

  const absent = createCredentialKeychain({
    platform: "darwin",
    spawn: mockSpawn(() => fail(44, "security: SecKeychainSearchCopyMatch: The specified item could not be found in the keychain.")).spawn,
  });
  assert.equal(absent.read(keyFilePath).status, "absent");

  const corrupt = createCredentialKeychain({
    platform: "darwin",
    spawn: mockSpawn(() => fail(1, "unexpected error")).spawn,
  });
  assert.equal(corrupt.read(keyFilePath).status, "error");

  const missing = createCredentialKeychain({ platform: "darwin", spawn: mockSpawn(enoent).spawn });
  assert.equal(missing.read(keyFilePath).status, "unavailable");
});

test("darwin: write uses no -U (exclusive); duplicate reads back the winner", () => {
  const keyFilePath = "/tmp/x/credential-key.json";
  const winnerSecret = randomBytes(32).toString("base64url");
  let writeAttempted = false;
  const { spawn, calls } = mockSpawn((command, args) => {
    if (args[0] === "add-generic-password") {
      writeAttempted = true;
      return fail(44, "security: SecKeychainItemCopyContent: The specified item already exists in the keychain.");
    }
    return ok(winnerSecret); // find-generic-password → 赢家材料
  });
  const keychain = createCredentialKeychain({ platform: "darwin", spawn });
  const result = keychain.write(keyFilePath, "loser-secret");
  assert.equal(result.status, "written");
  assert.equal(result.secret, winnerSecret, "duplicate write must adopt the winner's material");
  assert.ok(writeAttempted);
  const addCall = calls.find((call) => call.args[0] === "add-generic-password");
  assert.ok(!addCall.args.includes("-U"), "write must not pass -U (exclusive semantics)");
  assert.ok(addCall.args.includes(CREDENTIAL_KEYCHAIN_SERVICE));
  assert.ok(addCall.args.includes(credentialKeychainAccount(keyFilePath)));
});

// ── Windows（DPAPI blob + PowerShell）────────────────────────────────

test("win32: read absent without blob (no spawn); found via unprotect; corrupt blob → error", () => {
  withTempDir((dir) => {
    const keyFilePath = join(dir, "credential-key.json");
    let spawnCount = 0;
    const keychain = createCredentialKeychain({
      platform: "win32",
      spawn: mockSpawn(() => {
        spawnCount += 1;
        return ok(sampleKeyB64Url);
      }).spawn,
    });

    // blob 不存在 → absent，且绝不 spawn PowerShell（廉价路径）。
    assert.equal(keychain.read(keyFilePath).status, "absent");
    assert.equal(spawnCount, 0);

    // 写入 blob（protect 输出即 blob 内容）后 read 走 unprotect → found。
    writeFileSync(windowsDpapiBlobPath(keyFilePath), JSON.stringify({ version: 1, blob: "PROTECTED" }), "utf-8");
    const found = keychain.read(keyFilePath);
    assert.equal(found.status, "found");
    assert.equal(found.secret, sampleKeyB64Url);

    // blob 损坏 → error（fail-loud，绝不 absent——absent 会导致生成新密钥孤立凭据）。
    writeFileSync(windowsDpapiBlobPath(keyFilePath), "{ not json", "utf-8");
    assert.equal(keychain.read(keyFilePath).status, "error");
    writeFileSync(windowsDpapiBlobPath(keyFilePath), JSON.stringify({ version: 99, blob: "X" }), "utf-8");
    assert.equal(keychain.read(keyFilePath).status, "error");
  });
});

test("win32: blob present but powershell missing/failing → error (never unavailable)", () => {
  withTempDir((dir) => {
    const keyFilePath = join(dir, "credential-key.json");
    writeFileSync(windowsDpapiBlobPath(keyFilePath), JSON.stringify({ version: 1, blob: "PROTECTED" }), "utf-8");

    const missing = createCredentialKeychain({ platform: "win32", spawn: mockSpawn(enoent).spawn });
    assert.equal(missing.read(keyFilePath).status, "error");

    const blocked = createCredentialKeychain({
      platform: "win32",
      spawn: mockSpawn(() => fail(1, "ConstrainedLanguage mode")).spawn,
    });
    assert.equal(blocked.read(keyFilePath).status, "error");
  });
});

test("win32: write protects via powershell, wx-exclusive blob; EEXIST adopts winner; PS failure → unavailable", () => {
  withTempDir((dir) => {
    const keyFilePath = join(dir, "credential-key.json");
    const blobPath = windowsDpapiBlobPath(keyFilePath);

    // 正常写入：protect → wx 写 blob。
    const keychain = createCredentialKeychain({
      platform: "win32",
      spawn: mockSpawn((command, args) => {
        const cmd = args[args.length - 1];
        return cmd.includes("::Protect(") ? ok("PROTECTED-B64") : ok(sampleKeyB64Url);
      }).spawn,
    });
    const written = keychain.write(keyFilePath, sampleKeyB64Url);
    assert.equal(written.status, "written");
    assert.ok(existsSync(blobPath));
    const blob = JSON.parse(readFileSync(blobPath, "utf-8"));
    assert.equal(blob.version, 1);
    assert.equal(blob.blob, "PROTECTED-B64");

    // EEXIST → 回读赢家（unprotect 返回赢家材料）。
    const winnerSecret = randomBytes(32).toString("base64url");
    const racing = createCredentialKeychain({
      platform: "win32",
      spawn: mockSpawn((command, args) => {
        const cmd = args[args.length - 1];
        return cmd.includes("::Protect(") ? ok("RACE-PROTECTED") : ok(winnerSecret);
      }).spawn,
    });
    const raceResult = racing.write(keyFilePath, "loser");
    assert.equal(raceResult.status, "written");
    assert.equal(raceResult.secret, winnerSecret);

    // PowerShell 不可用（新装、无任何既有材料）→ unavailable（调用方安全降级文件模式）。
    const noPs = createCredentialKeychain({ platform: "win32", spawn: mockSpawn(enoent).spawn });
    assert.equal(noPs.write(join(dir, "other", "credential-key.json"), sampleKeyB64Url).status, "unavailable");
  });
});

// ── Linux（secret-tool）──────────────────────────────────────────────

test("linux: read found/absent(empty stdout)/D-Bus→unavailable/other→error", () => {
  const keyFilePath = "/tmp/x/credential-key.json";

  const found = createCredentialKeychain({
    platform: "linux",
    spawn: mockSpawn(() => ok(`${sampleKeyB64Url}\n`)).spawn,
  });
  assert.equal(found.read(keyFilePath).status, "found");

  const absent = createCredentialKeychain({
    platform: "linux",
    spawn: mockSpawn(() => ok("")).spawn,
  });
  assert.equal(absent.read(keyFilePath).status, "absent");

  const headless = createCredentialKeychain({
    platform: "linux",
    spawn: mockSpawn(() => fail(1, "Cannot autolaunch D-Bus without $DBUS_SESSION_BUS_ADDRESS")).spawn,
  });
  assert.equal(headless.read(keyFilePath).status, "unavailable");

  const broken = createCredentialKeychain({
    platform: "linux",
    spawn: mockSpawn(() => fail(1, "keyring is locked")).spawn,
  });
  assert.equal(broken.read(keyFilePath).status, "error");
});

test("linux: write goes through stdin (no ps exposure), read-before adopts winner, read-back verifies", () => {
  const keyFilePath = "/tmp/x/credential-key.json";

  // 写前读已有条目 → 直接采用赢家，不调用 store。
  const winnerSecret = randomBytes(32).toString("base64url");
  let storeCalled = false;
  const adopt = createCredentialKeychain({
    platform: "linux",
    spawn: mockSpawn((command, args) => {
      if (args[0] === "store") storeCalled = true;
      return ok(winnerSecret);
    }).spawn,
  });
  const adopted = adopt.write(keyFilePath, "loser");
  assert.equal(adopted.status, "written");
  assert.equal(adopted.secret, winnerSecret);
  assert.equal(storeCalled, false, "existing entry must be adopted without storing");

  // 正常写入：lookup(absent) → store(stdin=secret) → lookup(回读) → written。
  const calls = [];
  const keychain = createCredentialKeychain({
    platform: "linux",
    spawn: mockSpawn((command, args, options) => {
      calls.push({ args, options });
      if (args[0] === "store") return ok("");
      // 第一次 lookup（写前）为空；store 之后的 lookup（回读）返回已存材料。
      const stored = calls.some((call) => call.args[0] === "store");
      return ok(stored ? sampleKeyB64Url : "");
    }).spawn,
  });
  const written = keychain.write(keyFilePath, sampleKeyB64Url);
  assert.equal(written.status, "written");
  assert.equal(written.secret, sampleKeyB64Url);
  const storeCall = calls.find((call) => call.args[0] === "store");
  assert.equal(storeCall.options.input, sampleKeyB64Url, "secret must travel via stdin, not argv");
  assert.ok(!storeCall.args.includes(sampleKeyB64Url), "secret must not appear in argv");
});

test("unsupported platform → unavailable on both ops; account fingerprint stable and distinct", () => {
  const keychain = createCredentialKeychain({ platform: "freebsd", spawn: mockSpawn(enoent).spawn });
  assert.equal(keychain.read("/tmp/x").status, "unavailable");
  assert.equal(keychain.write("/tmp/x", "s").status, "unavailable");

  const a1 = credentialKeychainAccount("/home/u/.acode/v2/credential-key.json");
  const a2 = credentialKeychainAccount("/home/u/.acode/v2/credential-key.json");
  const a3 = credentialKeychainAccount("/home/other/.acode/v2/credential-key.json");
  assert.equal(a1, a2);
  assert.notEqual(a1, a3);
  assert.match(a1, /^credential-master-key@[0-9a-f]{16}$/);
  assert.equal(
    windowsDpapiBlobPath("/home/u/.acode/v2/credential-key.json"),
    join("/home/u/.acode/v2", "credential-key.dpapi.json"),
  );
});

// ── 解析链（stub 钥匙串）─────────────────────────────────────────────

function stubKeychain() {
  const state = {
    store: new Map(),
    reads: 0,
    writes: 0,
    deletes: 0,
    readResult: undefined, // 覆盖 read 返回（absent 缺省）
    writeResult: undefined, // 覆盖 write 返回（written 缺省）
  };
  return {
    state,
    read(keyFilePath) {
      state.reads += 1;
      if (state.store.has(keyFilePath)) return { status: "found", secret: state.store.get(keyFilePath) };
      return state.readResult ?? { status: "absent" };
    },
    write(keyFilePath, secret) {
      state.writes += 1;
      if (state.writeResult && state.writeResult.status !== "written") return state.writeResult;
      state.store.set(keyFilePath, secret);
      return { status: "written", secret };
    },
    delete(keyFilePath) {
      state.deletes += 1;
      state.store.delete(keyFilePath);
    },
  };
}

test("resolver: keychain found wins; coexistence with key file warns; no key file touched", () => {
  withTempDir((baseDir) => {
    const keychain = stubKeychain();
    const keyFilePath = resolveCredentialKeyFilePath({ baseDir, env: {} });
    keychain.state.store.set(keyFilePath, sampleKeyB64Url);

    const warnings = [];
    const resolved = resolveCredentialMasterKey({
      baseDir,
      env: {},
      onWarn: (m) => warnings.push(m),
      keychain,
    });
    assert.equal(resolved.source, "keychain");
    assert.deepEqual(resolved.key, Buffer.from(sampleKeyB64Url, "base64url"));
    assert.equal(warnings.length, 0);
    assert.equal(existsSync(keyFilePath), false, "keychain mode must not create a key file");

    // 并存（用户恢复了旧密钥文件备份）→ 钥匙串优先 + 并存告警。
    mkdirSync(dirname(keyFilePath), { recursive: true });
    writeFileSync(
      keyFilePath,
      JSON.stringify({ version: 1, key: randomBytes(32).toString("base64url") }),
      "utf-8",
    );
    const coexist = resolveCredentialMasterKey({
      baseDir,
      env: {},
      onWarn: (m) => warnings.push(m),
      keychain,
    });
    assert.equal(coexist.source, "keychain");
    assert.deepEqual(coexist.key, resolved.key, "coexistence must not change the resolved key");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /keychain entry and a credential key file/);
  });
});

test("resolver: corrupt keychain entry or malformed material → fail-loud, never regenerate", () => {
  withTempDir((baseDir) => {
    const errorKc = stubKeychain();
    errorKc.state.readResult = { status: "error", reason: "DPAPI unprotect failed" };
    assert.throws(
      () => resolveCredentialMasterKey({ baseDir, env: {}, onWarn: () => {}, keychain: errorKc }),
      /keychain entry exists but is not readable/,
    );

    const shortKc = stubKeychain();
    const keyFilePath = resolveCredentialKeyFilePath({ baseDir, env: {} });
    shortKc.state.store.set(keyFilePath, Buffer.from("too-short").toString("base64url"));
    assert.throws(
      () => resolveCredentialMasterKey({ baseDir, env: {}, onWarn: () => {}, keychain: shortKc }),
      /malformed/,
    );
    // 两次解析都抛（error 不缓存：现场必须每次可见）。
    assert.equal(errorKc.state.reads >= 1, true);
  });
});

test("resolver: fresh install with working keychain generates into the entry, no key file", () => {
  withTempDir((baseDir) => {
    const keychain = stubKeychain();
    const resolved = resolveCredentialMasterKey({ baseDir, env: {}, onWarn: () => {}, keychain });
    assert.equal(resolved.source, "keychain");
    assert.equal(resolved.key.length, 32);
    assert.equal(keychain.state.writes, 1);
    const keyFilePath = resolveCredentialKeyFilePath({ baseDir, env: {} });
    assert.equal(existsSync(keyFilePath), false, "keychain-first generation must not write a key file");
    // 幂等：第二次解析读到 found（缓存），材料一致。
    const again = resolveCredentialMasterKey({ baseDir, env: {}, onWarn: () => {}, keychain });
    assert.deepEqual(again.key, resolved.key);
    assert.equal(again.source, "keychain");
  });
});

test("resolver: keychain unavailable → file mode + one-time degrade warning; write not attempted", () => {
  withTempDir((baseDir) => {
    const keychain = stubKeychain();
    keychain.state.readResult = { status: "unavailable", reason: "no secret service" };
    const warnings = [];
    const resolved = resolveCredentialMasterKey({
      baseDir,
      env: {},
      onWarn: (m) => warnings.push(m),
      keychain,
    });
    assert.equal(resolved.source, "keyFile");
    assert.equal(resolved.key.length, 32);
    assert.equal(keychain.state.writes, 0, "unavailable read must short-circuit the write attempt");
    assert.ok(existsSync(resolveCredentialKeyFilePath({ baseDir, env: {} })));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /OS keychain unavailable/);

    // unavailable 进程级缓存：第二次解析不再 read（spawn 不重复付费）。
    const readsAfterFirst = keychain.state.reads;
    resolveCredentialMasterKey({ baseDir, env: {}, onWarn: (m) => warnings.push(m), keychain });
    assert.equal(keychain.state.reads, readsAfterFirst, "unavailable must be cached per process");
  });
});

test("resolver: keychain write failure → file fallback + warning (fresh install has no material to orphan)", () => {
  withTempDir((baseDir) => {
    const keychain = stubKeychain();
    keychain.state.writeResult = { status: "error", reason: "keychain is locked" };
    const warnings = [];
    const resolved = resolveCredentialMasterKey({
      baseDir,
      env: {},
      onWarn: (m) => warnings.push(m),
      keychain,
    });
    assert.equal(resolved.source, "keyFile");
    assert.ok(existsSync(resolveCredentialKeyFilePath({ baseDir, env: {} })));
    assert.ok(warnings.some((line) => /OS keychain unavailable/.test(line)));
  });
});

test("resolver: existing key file still wins over env when keychain absent (P0-4 semantics preserved)", () => {
  withTempDir((baseDir) => {
    const keychain = stubKeychain();
    // 写入不可用 → 首装生成落文件模式（本测试钉的是「文件 vs env」的 P0-4 优先级，
    // 钥匙串可用的生成路径由上一组测试覆盖）。
    keychain.state.writeResult = { status: "unavailable", reason: "no secret service" };
    const first = resolveCredentialMasterKey({ baseDir, env: {}, onWarn: () => {}, keychain });
    assert.equal(first.source, "keyFile");
    const warnings = [];
    const second = resolveCredentialMasterKey({
      baseDir,
      env: { ACODE_CREDENTIAL_SECRET: "late-env-secret" },
      onWarn: (m) => warnings.push(m),
      keychain,
    });
    assert.equal(second.source, "keyFile");
    assert.deepEqual(second.key, first.key);
    assert.ok(warnings.some((line) => /ACODE_CREDENTIAL_SECRET/.test(line)));
  });
});

test("resolver: found read is cached per process (spawn paid once per data dir)", () => {
  withTempDir((baseDir) => {
    const keychain = stubKeychain();
    const keyFilePath = resolveCredentialKeyFilePath({ baseDir, env: {} });
    keychain.state.store.set(keyFilePath, sampleKeyB64Url);
    resolveCredentialMasterKey({ baseDir, env: {}, onWarn: () => {}, keychain });
    const readsAfterFirst = keychain.state.reads;
    resolveCredentialMasterKey({ baseDir, env: {}, onWarn: () => {}, keychain });
    resolveCredentialMasterKey({ baseDir, env: {}, onWarn: () => {}, keychain });
    assert.equal(keychain.state.reads, readsAfterFirst, "found must be cached per process");
  });
});

test("resolver: standard-base64 keychain material is accepted (hand-written entries)", () => {
  withTempDir((baseDir) => {
    const keychain = stubKeychain();
    const keyFilePath = resolveCredentialKeyFilePath({ baseDir, env: {} });
    const raw = randomBytes(32);
    keychain.state.store.set(keyFilePath, raw.toString("base64")); // 含 +/ 的标准 base64
    const resolved = resolveCredentialMasterKey({ baseDir, env: {}, onWarn: () => {}, keychain });
    assert.equal(resolved.source, "keychain");
    assert.deepEqual(resolved.key, raw);
  });
});

// ── R1-b 一次性迁移（密钥文件 → 钥匙串，零重加密）─────────────────────

function writeKeyFileFixture(keyFilePath, material) {
  mkdirSync(dirname(keyFilePath), { recursive: true });
  writeFileSync(
    keyFilePath,
    `${JSON.stringify({ version: 1, key: material.toString("base64url") }, null, 2)}\n`,
    "utf-8",
  );
}

test("R1-b migration: key file material moves into the keychain, file removed, key unchanged", () => {
  withTempDir((baseDir) => {
    const keychain = stubKeychain();
    const keyFilePath = resolveCredentialKeyFilePath({ baseDir, env: {} });
    const material = randomBytes(32);
    writeKeyFileFixture(keyFilePath, material);

    const warnings = [];
    const resolved = resolveCredentialMasterKey({
      baseDir,
      env: {},
      onWarn: (m) => warnings.push(m),
      keychain,
    });
    assert.equal(resolved.source, "keychain");
    assert.deepEqual(resolved.key, material, "migration must be zero-re-encryption (same bytes)");
    assert.equal(existsSync(keyFilePath), false, "key file must be removed after verified migration");
    assert.equal(keychain.state.writes, 1);
    assert.equal(keychain.state.deletes, 0, "happy path must not roll back");
    assert.ok(warnings.some((line) => /migrated from .* into the OS keychain/.test(line)));

    // 幂等：第二次解析走 found（条目里就是原材料），不再迁移。
    const again = resolveCredentialMasterKey({ baseDir, env: {}, onWarn: () => {}, keychain });
    assert.equal(again.source, "keychain");
    assert.deepEqual(again.key, material);
    assert.equal(keychain.state.writes, 1, "second resolve must not re-migrate");
  });
});

test("R1-b migration: read-back mismatch rolls the entry back and keeps the file authoritative", () => {
  withTempDir((baseDir) => {
    const keyFilePath = resolveCredentialKeyFilePath({ baseDir, env: {} });
    const material = randomBytes(32);
    writeKeyFileFixture(keyFilePath, material);

    // 病态钥匙串：写入「成功」但回读返回另一份材料（store 与 lookup 不一致的坏环境）。
    let stored = false;
    let deleted = false;
    const poison = {
      read() {
        if (!stored) return { status: "absent" };
        return { status: "found", secret: randomBytes(32).toString("base64url") };
      },
      write() {
        stored = true;
        return { status: "written", secret: material.toString("base64url") };
      },
      delete() {
        deleted = true;
        stored = false;
      },
    };

    const warnings = [];
    const resolved = resolveCredentialMasterKey({
      baseDir,
      env: {},
      onWarn: (m) => warnings.push(m),
      keychain: poison,
    });
    assert.equal(resolved.source, "keyFile", "failed verification must keep file mode");
    assert.deepEqual(resolved.key, material);
    assert.ok(existsSync(keyFilePath), "key file must survive a failed migration");
    assert.equal(deleted, true, "the poisoned entry must be removed (keychain outranks the file)");
    assert.ok(warnings.some((line) => /verification failed/.test(line)));
  });
});

test("R1-b migration: keychain write failure skips migration and keeps file mode", () => {
  withTempDir((baseDir) => {
    const keychain = stubKeychain();
    const keyFilePath = resolveCredentialKeyFilePath({ baseDir, env: {} });
    const material = randomBytes(32);
    writeKeyFileFixture(keyFilePath, material);
    keychain.state.writeResult = { status: "error", reason: "keychain is locked" };

    const warnings = [];
    const resolved = resolveCredentialMasterKey({
      baseDir,
      env: {},
      onWarn: (m) => warnings.push(m),
      keychain,
    });
    assert.equal(resolved.source, "keyFile");
    assert.deepEqual(resolved.key, material);
    assert.ok(existsSync(keyFilePath));
    assert.equal(keychain.state.deletes, 0, "nothing was written, nothing to roll back");
    assert.ok(warnings.some((line) => /migration to the OS keychain was skipped/.test(line)));
  });
});

test("R1-b migration: unavailable keychain never attempts migration (headless stays on file)", () => {
  withTempDir((baseDir) => {
    const keychain = stubKeychain();
    const keyFilePath = resolveCredentialKeyFilePath({ baseDir, env: {} });
    writeKeyFileFixture(keyFilePath, randomBytes(32));
    keychain.state.readResult = { status: "unavailable", reason: "no secret service" };

    const resolved = resolveCredentialMasterKey({ baseDir, env: {}, onWarn: () => {}, keychain });
    assert.equal(resolved.source, "keyFile");
    assert.equal(keychain.state.writes, 0);
    assert.ok(existsSync(keyFilePath));
  });
});
