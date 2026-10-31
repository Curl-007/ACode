// 启动硬化（specs/desktop-startup-hardening.md §1/§2/§3/§4a/§5）的纯函数与门控测试。
// Electron main 难以直接单测的部分，把可判定逻辑抽成纯函数后覆盖；带 import 副作用的
// startupSanitation 用受控 electron/env stub 分实例加载，绝不污染真实 process.env。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { generateKeyPairSync, sign as signData, createPublicKey } from "node:crypto";
import { transpileModule, ModuleKind } from "typescript";

const nodeRequire = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);

async function readSource(relative) {
  return readFile(new URL(relative, root), "utf8");
}

async function loadMain(relative, imports = {}) {
  const source = await readSource(`src/main/${relative}.ts`);
  const output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => {
    if (name.startsWith("node:")) {
      return nodeRequire(name);
    }
    assert.ok(name in imports, `unexpected runtime import: ${name}`);
    return imports[name];
  }, exports);
  return exports;
}

// ── 测试内令牌签发（不依赖仓外私钥，独立生成临时密钥对） ──

function makeTestKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKeySpkiBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

function issueToken({ userDataPath, privateKey, issuedAtMs = Date.now() }) {
  const payload = Buffer.from(userDataPath, "utf8").toString("base64url");
  const signedPayload = `${issuedAtMs}.${payload}`;
  const sig = signData(null, Buffer.from(signedPayload, "utf8"), privateKey).toString("base64url");
  return `${signedPayload}.${sig}`;
}

// ══════════════════════════════════════════════════════════════
// §3 签名短时调试令牌
// ══════════════════════════════════════════════════════════════

test("§3 debug token: valid token passes, four rejection reasons are a closed set", async () => {
  const gate = await loadMain("debugTokenGate");
  const { verifySignedDebugToken } = gate;
  const { privateKey, publicKeySpkiBase64 } = makeTestKeypair();
  const publicKeys = [publicKeySpkiBase64];
  const dir = "C:\\Users\\e2e\\userData";
  const now = () => 1_000_000;

  // 有效令牌（当前时间签发）
  const good = issueToken({ userDataPath: dir, privateKey, issuedAtMs: now() });
  assert.deepEqual(verifySignedDebugToken(good, dir, { now, publicKeys }), { valid: true });

  // malformed：分段数不对 / 时间戳非整数 / payload 空
  assert.equal(verifySignedDebugToken("a.b", dir, { now, publicKeys }).reason, "malformed");
  assert.equal(verifySignedDebugToken("a.b.c.d", dir, { now, publicKeys }).reason, "malformed");
  assert.equal(
    verifySignedDebugToken(`notanint.${Buffer.from(dir).toString("base64url")}.sig`, dir, {
      now,
      publicKeys,
    }).reason,
    "malformed",
  );

  // path_mismatch：payload 解出的是另一个路径
  const otherDirToken = issueToken({ userDataPath: "D:\\elsewhere", privateKey, issuedAtMs: now() });
  assert.equal(
    verifySignedDebugToken(otherDirToken, dir, { now, publicKeys }).reason,
    "path_mismatch",
  );

  // expired：年龄 > 300s；未来钟超过 60s skew 也按 expired
  const oldToken = issueToken({ userDataPath: dir, privateKey, issuedAtMs: now() - 300_001 });
  assert.equal(verifySignedDebugToken(oldToken, dir, { now, publicKeys }).reason, "expired");
  const futureToken = issueToken({ userDataPath: dir, privateKey, issuedAtMs: now() + 60_001 });
  assert.equal(verifySignedDebugToken(futureToken, dir, { now, publicKeys }).reason, "expired");

  // 边界：年龄恰好 300s 内、未来钟恰好 60s 内 → 通过
  const edgeOld = issueToken({ userDataPath: dir, privateKey, issuedAtMs: now() - 300_000 });
  assert.deepEqual(verifySignedDebugToken(edgeOld, dir, { now, publicKeys }), { valid: true });
  const edgeFuture = issueToken({ userDataPath: dir, privateKey, issuedAtMs: now() + 60_000 });
  assert.deepEqual(verifySignedDebugToken(edgeFuture, dir, { now, publicKeys }), { valid: true });

  // invalid_signature：篡改签名字节（翻转首字节全部位）。
  // 注意不能只改 base64url 末字符——末尾字符的低位在解码时被丢弃，改成 'A' 有约一半
  // 概率解出完全相同的签名字节（仍有效），会造成 flaky；必须在字节级篡改。
  const parts = good.split(".");
  const sigBytes = Buffer.from(parts[2], "base64url");
  sigBytes[0] ^= 0xff;
  const tamperedSig = sigBytes.toString("base64url");
  assert.equal(
    verifySignedDebugToken(`${parts[0]}.${parts[1]}.${tamperedSig}`, dir, { now, publicKeys })
      .reason,
    "invalid_signature",
  );

  // 用错误公钥验签 → invalid_signature
  const otherKp = makeTestKeypair();
  assert.equal(
    verifySignedDebugToken(good, dir, { now, publicKeys: [otherKp.publicKeySpkiBase64] }).reason,
    "invalid_signature",
  );
});

test("§3 debug token: non-ed25519 embedded key is rejected as invalid_signature (fail-closed)", async () => {
  const gate = await loadMain("debugTokenGate");
  const { privateKey } = makeTestKeypair();
  const dir = "/tmp/x";
  const token = issueToken({ userDataPath: dir, privateKey });
  // 一个 RSA 公钥（SPKI DER base64）——非 ed25519，asymmetricKeyType 校验应使其不可用。
  const rsa = nodeRequire("node:crypto").generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaSpki = rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.equal(
    gate.verifySignedDebugToken(token, dir, { publicKeys: [rsaSpki] }).reason,
    "invalid_signature",
  );
});

test("§3 debug token: embedded public key constant is a loadable ed25519 SPKI key", async () => {
  const gate = await loadMain("debugTokenGate");
  assert.ok(Array.isArray(gate.EMBEDDED_DEBUG_TOKEN_PUBLIC_KEYS));
  assert.ok(gate.EMBEDDED_DEBUG_TOKEN_PUBLIC_KEYS.length >= 1);
  for (const b64 of gate.EMBEDDED_DEBUG_TOKEN_PUBLIC_KEYS) {
    const key = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
    assert.equal(key.asymmetricKeyType, "ed25519");
  }
  assert.equal(gate.MAX_DEBUG_TOKEN_AGE_MS, 300_000);
  assert.equal(gate.DEBUG_TOKEN_CLOCK_SKEW_MS, 60_000);
});

test("§3 resolveDebugTokenDecision: requires paired user-data-dir claim, warns closed-set reasons", async () => {
  const gate = await loadMain("debugTokenGate");
  const { privateKey, publicKeySpkiBase64 } = makeTestKeypair();
  const dir = "/data/ud";
  const warns = [];
  const warn = (m) => warns.push(m);
  const now = () => 5_000_000;
  const publicKeys = [publicKeySpkiBase64];

  // 无令牌 → tokenPresent false，不 warn
  const none = gate.resolveDebugTokenDecision({ env: {}, now, publicKeys, warn });
  assert.deepEqual(none, { tokenPresent: false, tokenValid: false });
  assert.equal(warns.length, 0);

  // 有令牌但缺 ACODE_DESKTOP_USER_DATA_DIR → path_mismatch + warn
  const token = issueToken({ userDataPath: dir, privateKey, issuedAtMs: now() });
  const noClaim = gate.resolveDebugTokenDecision({
    env: { ACODE_DEBUG_TOKEN: token },
    now,
    publicKeys,
    warn,
  });
  assert.equal(noClaim.tokenValid, false);
  assert.equal(noClaim.rejectionReason, "path_mismatch");
  assert.equal(warns.length, 1);

  // 令牌 + 配套路径 → 有效
  const ok = gate.resolveDebugTokenDecision({
    env: { ACODE_DEBUG_TOKEN: token, ACODE_DESKTOP_USER_DATA_DIR: dir },
    now,
    publicKeys,
    warn,
  });
  assert.equal(ok.tokenValid, true);
});

test("§3 issue-debug-token.mjs: signs a token the gate verifies with the same key", async () => {
  const script = await import(new URL("scripts/issue-debug-token.mjs", root).href);
  const { privateKeyPem, publicKeySpkiBase64 } = script.generateDebugTokenKeypair();
  const dir = "C:\\data\\e2e";
  const token = script.issueDebugToken({ userDataPath: dir, privateKeyPem });
  // 私钥导出的公钥与 generate 报告的一致
  assert.equal(script.publicKeySpkiBase64FromPrivate(privateKeyPem), publicKeySpkiBase64);

  const gate = await loadMain("debugTokenGate");
  assert.deepEqual(
    gate.verifySignedDebugToken(token, dir, { publicKeys: [publicKeySpkiBase64] }),
    { valid: true },
  );
  assert.equal(token.split(".").length, 3);
});

// ══════════════════════════════════════════════════════════════
// §1 argv 开关拒启表
// ══════════════════════════════════════════════════════════════

test("§1 denylist: 16 switches, normalization strips prefix/case/=value", async () => {
  const mod = await loadMain("bootSwitchDenylist");
  const { DENIED_BOOT_SWITCHES, normalizeBootSwitchArg, findDeniedBootSwitches } = mod;
  assert.equal(DENIED_BOOT_SWITCHES.length, 16);
  for (const expected of [
    "remote-debugging-port",
    "remote-debugging-pipe",
    "ignore-certificate-errors",
    "host-resolver-rules",
    "host-rules",
    "disable-web-security",
    "log-net-log",
    "net-log-capture-mode",
    "ssl-key-log-file",
    "renderer-cmd-prefix",
    "utility-cmd-prefix",
    "gpu-launcher",
    "zygote-cmd-prefix",
    "ppapi-plugin-launcher",
    "nacl-loader-cmd-prefix",
    "browser-subprocess-path",
  ]) {
    assert.ok(DENIED_BOOT_SWITCHES.includes(expected), `denylist must contain ${expected}`);
  }

  // 归一化：去 --/-// 前缀、小写、截 =
  assert.equal(normalizeBootSwitchArg("--Remote-Debugging-Port=9229"), "remote-debugging-port");
  assert.equal(normalizeBootSwitchArg("-gpu-launcher"), "gpu-launcher");
  assert.equal(normalizeBootSwitchArg("/HOST-RULES=x"), "host-rules");
  assert.equal(normalizeBootSwitchArg("--disable-web-security"), "disable-web-security");

  // 命中：三种前缀形态 + 带值
  assert.deepEqual(
    findDeniedBootSwitches(["/app", "--remote-debugging-port=0", "--enable-logging"]),
    ["remote-debugging-port"],
  );
  assert.deepEqual(findDeniedBootSwitches(["-ignore-certificate-errors"]), [
    "ignore-certificate-errors",
  ]);
  // 未命中
  assert.deepEqual(findDeniedBootSwitches(["/app", "--open-workspace", "C:\\x"]), []);
  // 多命中去重保序
  assert.deepEqual(
    findDeniedBootSwitches(["--host-rules=a", "--gpu-launcher=b", "--host-rules=c"]),
    ["host-rules", "gpu-launcher"],
  );
});

test("§1 denylist: decision matrix (dev warn / packaged refuse / packaged+token warn)", async () => {
  const mod = await loadMain("bootSwitchDenylist");
  const { resolveBootSwitchDenylistDecision } = mod;
  const argv = ["/app", "--remote-debugging-port=9222"];

  // dev 命中 → allow-with-warning
  assert.equal(
    resolveBootSwitchDenylistDecision({ argv, isPackaged: false, tokenValid: false }).action,
    "allow-with-warning",
  );
  // dev 未命中 → allow
  assert.equal(
    resolveBootSwitchDenylistDecision({ argv: ["/app"], isPackaged: false, tokenValid: false })
      .action,
    "allow",
  );
  // 打包 + 无令牌 命中 → refuse
  assert.equal(
    resolveBootSwitchDenylistDecision({ argv, isPackaged: true, tokenValid: false }).action,
    "refuse",
  );
  // 打包 + 有效令牌 命中 → allow-with-warning
  assert.equal(
    resolveBootSwitchDenylistDecision({ argv, isPackaged: true, tokenValid: true }).action,
    "allow-with-warning",
  );
  // 打包 未命中 → allow
  assert.equal(
    resolveBootSwitchDenylistDecision({ argv: ["/app"], isPackaged: true, tokenValid: false })
      .action,
    "allow",
  );
});

test("§1 enforceBootSwitchDenylist: refuse writes stderr reason and exit(1); warn path does not exit", async () => {
  const mod = await loadMain("bootSwitchDenylist");
  const { enforceBootSwitchDenylist } = mod;

  // refuse
  const stderrChunks = [];
  let exitCode = null;
  enforceBootSwitchDenylist({
    decision: { action: "refuse", deniedSwitches: ["remote-debugging-port"] },
    writeStderr: (m) => stderrChunks.push(m),
    exit: (c) => {
      exitCode = c;
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(stderrChunks.length, 1);
  assert.match(stderrChunks[0], /拒绝启动/);
  assert.match(stderrChunks[0], /remote-debugging-port/);
  // 开关值不得进拒绝文案（只有归一化名）
  assert.ok(!stderrChunks[0].includes("9222"));

  // allow-with-warning → warn，不 exit
  const warns = [];
  let warnedExit = null;
  enforceBootSwitchDenylist({
    decision: { action: "allow-with-warning", deniedSwitches: ["gpu-launcher"] },
    warn: (m) => warns.push(m),
    exit: (c) => {
      warnedExit = c;
    },
  });
  assert.equal(warnedExit, null);
  assert.equal(warns.length, 1);

  // allow → 完全静默
  let allowExit = null;
  const allowWarns = [];
  enforceBootSwitchDenylist({
    decision: { action: "allow", deniedSwitches: [] },
    warn: (m) => allowWarns.push(m),
    exit: (c) => {
      allowExit = c;
    },
  });
  assert.equal(allowExit, null);
  assert.equal(allowWarns.length, 0);
});

// ══════════════════════════════════════════════════════════════
// §2 打包态 env 清洗单一漏斗
// ══════════════════════════════════════════════════════════════

test("§2 sanitizePackagedBootEnvironment: drops closed-set keys only when packaged && !tokenValid", async () => {
  const mod = await loadMain("startupSanitation", {
    electron: { app: { isPackaged: false } },
    "./bootSwitchDenylist.js": await loadMain("bootSwitchDenylist"),
    "./debugTokenGate.js": { getBootDebugTokenDecision: () => ({ tokenPresent: false, tokenValid: false }) },
  });
  const { sanitizePackagedBootEnvironment, PACKAGED_BOOT_ENV_DROP_KEYS } = mod;

  const buildEnv = () => {
    const env = { KEEP_ME: "1", PATH: "/usr/bin" };
    for (const key of PACKAGED_BOOT_ENV_DROP_KEYS) {
      env[key] = "secret-or-flag";
    }
    return env;
  };

  // dev（未打包）：一个键都不删
  const devEnv = buildEnv();
  assert.deepEqual(sanitizePackagedBootEnvironment({ env: devEnv, isPackaged: false, tokenValid: false }), []);
  assert.equal(devEnv.SSLKEYLOGFILE, "secret-or-flag");
  assert.equal(devEnv.ACODE_ENV, "secret-or-flag");

  // 打包 + 有效令牌：一个键都不删
  const tokenEnv = buildEnv();
  assert.deepEqual(sanitizePackagedBootEnvironment({ env: tokenEnv, isPackaged: true, tokenValid: true }), []);
  assert.equal(tokenEnv.SSLKEYLOGFILE, "secret-or-flag");

  // 打包 + 无令牌：闭集键全删，返回被删键名，非闭集键保留
  const prodEnv = buildEnv();
  const dropped = sanitizePackagedBootEnvironment({ env: prodEnv, isPackaged: true, tokenValid: false });
  for (const key of PACKAGED_BOOT_ENV_DROP_KEYS) {
    assert.equal(prodEnv[key], undefined, `${key} must be dropped`);
    assert.ok(dropped.includes(key));
  }
  assert.equal(prodEnv.KEEP_ME, "1");
  assert.equal(prodEnv.PATH, "/usr/bin");
  // 大小写双拼 SSLKEYLOGFILE / sslkeylogfile 都在闭集内
  assert.ok(PACKAGED_BOOT_ENV_DROP_KEYS.includes("SSLKEYLOGFILE"));
  assert.ok(PACKAGED_BOOT_ENV_DROP_KEYS.includes("sslkeylogfile"));
  assert.ok(PACKAGED_BOOT_ENV_DROP_KEYS.includes("ACODE_ENV"));
});

test("§2 sanitize: CUA dev 覆盖旗标在 drop 闭集内且仅 packaged 生效（cua-enablement-authority R2 / 验收 4）", async () => {
  const mod = await loadMain("startupSanitation", {
    electron: { app: { isPackaged: false } },
    "./bootSwitchDenylist.js": await loadMain("bootSwitchDenylist"),
    "./debugTokenGate.js": { getBootDebugTokenDecision: () => ({ tokenPresent: false, tokenValid: false }) },
  });
  const { sanitizePackagedBootEnvironment, PACKAGED_BOOT_ENV_DROP_KEYS } = mod;

  // R2 钉①：两键必须入闭集——否则打包态导出 dev 旗标会绕过设置页开关（启用单一权威）。
  assert.ok(PACKAGED_BOOT_ENV_DROP_KEYS.includes("ACODE_CUA_DEV_MODE"));
  assert.ok(PACKAGED_BOOT_ENV_DROP_KEYS.includes("ACODE_CUA_PRODUCT_HELPER"));

  // R2 钉②（验收 4）：packaged + 无令牌 → 两键被删，覆盖不生效。
  const prodEnv = { ACODE_CUA_DEV_MODE: "1", ACODE_CUA_PRODUCT_HELPER: "1" };
  const dropped = sanitizePackagedBootEnvironment({ env: prodEnv, isPackaged: true, tokenValid: false });
  assert.equal(prodEnv.ACODE_CUA_DEV_MODE, undefined);
  assert.equal(prodEnv.ACODE_CUA_PRODUCT_HELPER, undefined);
  assert.ok(dropped.includes("ACODE_CUA_DEV_MODE"));
  assert.ok(dropped.includes("ACODE_CUA_PRODUCT_HELPER"));

  // R2 钉③：dev 构建不受影响（dev 一键链回归不变）。
  const devEnv = { ACODE_CUA_DEV_MODE: "1", ACODE_CUA_PRODUCT_HELPER: "1" };
  assert.deepEqual(
    sanitizePackagedBootEnvironment({ env: devEnv, isPackaged: false, tokenValid: false }),
    [],
  );
  assert.equal(devEnv.ACODE_CUA_DEV_MODE, "1");
  assert.equal(devEnv.ACODE_CUA_PRODUCT_HELPER, "1");
});

test("§2 sanitize: dropped diagnostics record key names only, never values", async () => {
  const mod = await loadMain("startupSanitation", {
    electron: { app: { isPackaged: false } },
    "./bootSwitchDenylist.js": await loadMain("bootSwitchDenylist"),
    "./debugTokenGate.js": { getBootDebugTokenDecision: () => ({ tokenPresent: false, tokenValid: false }) },
  });
  const env = { SSLKEYLOGFILE: "/tmp/keys.log-SUPERSECRETVALUE" };
  const dropped = mod.sanitizePackagedBootEnvironment({ env, isPackaged: true, tokenValid: false });
  assert.deepEqual(dropped, ["SSLKEYLOGFILE"]);
  // 返回值只含键名，绝不含值
  assert.ok(!JSON.stringify(dropped).includes("SUPERSECRETVALUE"));
});

test("§5 hygiene side effect: NoDefaultCurrentDirectoryInExePath=1 and stackTraceLimit=20 applied on import", async () => {
  // 记录并在测试后恢复被副作用改写的全局，避免影响同进程其它测试。
  const prevNoDefault = process.env.NoDefaultCurrentDirectoryInExePath;
  const prevStackLimit = Error.stackTraceLimit;
  delete process.env.NoDefaultCurrentDirectoryInExePath;
  try {
    await loadMain("startupSanitation", {
      electron: { app: { isPackaged: false } },
      "./bootSwitchDenylist.js": await loadMain("bootSwitchDenylist"),
      "./debugTokenGate.js": { getBootDebugTokenDecision: () => ({ tokenPresent: false, tokenValid: false }) },
    });
    assert.equal(process.env.NoDefaultCurrentDirectoryInExePath, "1");
    assert.equal(Error.stackTraceLimit, 20);
  } finally {
    if (prevNoDefault === undefined) {
      delete process.env.NoDefaultCurrentDirectoryInExePath;
    } else {
      process.env.NoDefaultCurrentDirectoryInExePath = prevNoDefault;
    }
    Error.stackTraceLimit = prevStackLimit;
  }
});

test("§2 runBootEnvironmentGate: packaged+no-token drops from process.env and records ignoredEnvKeys; memoized", async () => {
  const saved = {};
  for (const key of ["SSLKEYLOGFILE", "ACODE_ENV", "ACODE_E2E_RUN_ID", "ACODE_DESKTOP_USER_DATA_DIR"]) {
    saved[key] = process.env[key];
    process.env[key] = "flagged";
  }
  let bootDenylistEnforced = null;
  try {
    const mod = await loadMain("startupSanitation", {
      electron: { app: { isPackaged: true } },
      "./bootSwitchDenylist.js": {
        resolveBootSwitchDenylistDecision: () => ({ action: "allow", deniedSwitches: [] }),
        enforceBootSwitchDenylist: (o) => {
          bootDenylistEnforced = o.decision;
        },
      },
      "./debugTokenGate.js": { getBootDebugTokenDecision: () => ({ tokenPresent: false, tokenValid: false }) },
    });
    // 副作用已在 load 时跑过一次；决策应记录被忽略键名，且真实 process.env 已清洗
    const decision = mod.getBootEnvironmentDecision();
    assert.equal(decision.isPackaged, true);
    assert.equal(decision.tokenValid, false);
    assert.ok(decision.ignoredEnvKeys.includes("SSLKEYLOGFILE"));
    assert.ok(decision.ignoredEnvKeys.includes("ACODE_ENV"));
    assert.equal(process.env.SSLKEYLOGFILE, undefined);
    assert.equal(process.env.ACODE_ENV, undefined);
    // memoized：再次调用返回同一对象，enforce 只发生一次
    assert.equal(mod.getBootEnvironmentDecision(), decision);
    assert.deepEqual(bootDenylistEnforced, { action: "allow", deniedSwitches: [] });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

// ══════════════════════════════════════════════════════════════
// §4a argv 字节预算 + 防循环 relaunch
// ══════════════════════════════════════════════════════════════

const deepLinkUrlStub = { DEEP_LINK_SCHEME: "acode" };

test("§4a argvBudget: within-budget untouched, oversized deep-link truncated to fit", async () => {
  const mod = await loadMain("argvBudget", { "./desktopDeepLinkUrl.js": deepLinkUrlStub });
  const { capDeepLinkArgv, DEEP_LINK_ARGV_BYTE_BUDGET, argvByteCost, totalArgvByteCost } = mod;

  assert.equal(DEEP_LINK_ARGV_BYTE_BUDGET, 26624);

  // 预算内 → null（无需处理）
  assert.equal(capDeepLinkArgv(["acode://oauth/callback?state=x"]), null);

  // 超预算：非深链参数原样，深链参数被截断到剩余预算内
  const bigDeepLink = `acode://workspace/open?path=${"a".repeat(40000)}`;
  const capped = capDeepLinkArgv(["--open-workspace", "C:\\keep", bigDeepLink]);
  assert.ok(Array.isArray(capped));
  assert.equal(capped[0], "--open-workspace");
  assert.equal(capped[1], "C:\\keep");
  assert.ok(totalArgvByteCost(capped) <= DEEP_LINK_ARGV_BYTE_BUDGET);
  // 截断后仍是深链形态（前缀保留）
  assert.ok(capped[2].startsWith("acode:"));
  assert.ok(argvByteCost(capped[2]) < argvByteCost(bigDeepLink));
});

test("§4a truncateUtf8Arg: never splits a multibyte char, strips trailing partial percent-escape", async () => {
  const mod = await loadMain("argvBudget", { "./desktopDeepLinkUrl.js": deepLinkUrlStub });
  const { truncateUtf8Arg } = mod;

  // 多字节：'€' 是 3 字节（E2 82 AC），截断点落在中间时回退到字符边界
  const s = "a€b"; // bytes: 61 E2 82 AC 62
  const buf = Buffer.from(s, "utf8");
  assert.equal(buf.length, 5);
  // 截到 3 字节会落在 € 的续字节上 → 回退到 1（只留 'a'），不产出半个 €
  const cut3 = truncateUtf8Arg(s, 3);
  assert.equal(cut3, "a");
  assert.ok(!Buffer.from(cut3, "utf8").includes(0xac));
  // 截到 4 字节正好含完整 €
  assert.equal(truncateUtf8Arg(s, 4), "a€");

  // 残缺 percent-escape：尾部 '%4' / '%E' 被剥除，完整 '%41' 保留
  assert.equal(truncateUtf8Arg("abc%4", 5), "abc");
  assert.equal(truncateUtf8Arg("abc%", 4), "abc");
  assert.equal(truncateUtf8Arg("abc%41", 6), "abc%41");
});

test("§4a argvBudget: uncappable when non-deep-link args alone exceed budget", async () => {
  const mod = await loadMain("argvBudget", { "./desktopDeepLinkUrl.js": deepLinkUrlStub });
  const { capDeepLinkArgv, DEEP_LINK_ARGV_BYTE_BUDGET } = mod;
  // 一个巨大的非深链参数：无法截断 → null
  const hugePlain = "x".repeat(DEEP_LINK_ARGV_BYTE_BUDGET + 100);
  assert.equal(capDeepLinkArgv([hugePlain]), null);
});

test("§4a maybeRelaunch: caps+relaunch+exit(0); anti-loop flag prevents second relaunch", async () => {
  const mod = await loadMain("argvBudget", { "./desktopDeepLinkUrl.js": deepLinkUrlStub });
  const { maybeRelaunchWithCappedDeepLinkArgv, DEEP_LINK_ARGV_RELAUNCH_FLAG } = mod;
  assert.equal(DEEP_LINK_ARGV_RELAUNCH_FLAG, "--acode-relaunched-after-deep-link-cap");

  const bigDeepLink = `acode://workspace/open?path=${"a".repeat(40000)}`;

  // 超预算 → relaunch([...capped, flag]) + exit(0)
  let relaunchArgs = null;
  let exitCode = null;
  const r1 = maybeRelaunchWithCappedDeepLinkArgv({
    argv: ["/exe", "--open-workspace", "C:\\keep", bigDeepLink],
    relaunch: (o) => {
      relaunchArgs = o.args;
    },
    exit: (c) => {
      exitCode = c;
    },
  });
  assert.equal(r1.relaunched, true);
  assert.equal(r1.outcome, "relaunched");
  assert.equal(exitCode, 0);
  assert.equal(relaunchArgs[relaunchArgs.length - 1], DEEP_LINK_ARGV_RELAUNCH_FLAG);
  assert.ok(relaunchArgs.includes("--open-workspace"));

  // 已带防循环标志 → 不再 relaunch
  let relaunch2 = false;
  const r2 = maybeRelaunchWithCappedDeepLinkArgv({
    argv: ["/exe", bigDeepLink, DEEP_LINK_ARGV_RELAUNCH_FLAG],
    relaunch: () => {
      relaunch2 = true;
    },
    exit: () => {},
  });
  assert.equal(r2.relaunched, false);
  assert.equal(r2.outcome, "already-relaunched");
  assert.equal(relaunch2, false);

  // 预算内 → within-budget，不 relaunch
  const r3 = maybeRelaunchWithCappedDeepLinkArgv({
    argv: ["/exe", "acode://oauth/callback?state=x"],
    relaunch: () => {
      relaunch2 = true;
    },
    exit: () => {},
  });
  assert.equal(r3.relaunched, false);
  assert.equal(r3.outcome, "within-budget");
});
