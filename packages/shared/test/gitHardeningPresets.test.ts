import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  CLI_GIT_PROTOCOL_NAMES,
  CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST,
  getCliGitGraftNullFilePath,
  getCliGitHardenedConfigEntries,
  getCliGitInvocationEnv,
  getCliGitInvocationEnvOverlay,
} from "../src/git-invocation-env.js";

/**
 * CLI git 漏斗硬化预设增量守护（apps/acode-cli/specs/git-invocation-hardening.md
 * R3 修订/R4/R5，镜像 packages/services/test/gitHardeningPresets.test.ts 测试面）。
 * 纯函数段：入站消毒增量、预设矩阵键值 + 全闭集、协议默认全拒 + marketplace
 * opt-in 同源构建、overlay 形态。功能段（真实 git 临时 fixture，git 不可用则
 * skip）：协议默认拒绝/显式放行、replace-ref 伪冒防御、bare repo 发现拒绝。
 */

const savedEnv = new Map<string, string | undefined>();

function polluteEnv(): void {
  // P2/P3 入站面：全局/系统配置重定向、协议名单透传、完整性变量弱化、编号键夹带。
  const pollution: Record<string, string> = {
    GIT_CONFIG_GLOBAL: "/evil/global-config",
    GIT_CONFIG_SYSTEM: "/evil/system-config",
    GIT_CONFIG_COUNT: "9",
    GIT_CONFIG_PARAMETERS: "'safe.directory=*'",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
    GIT_CONFIG_KEY_77: "alias.x",
    GIT_CONFIG_VALUE_77: "!sh -c evil",
    GIT_ALLOW_PROTOCOL: "ext:fd:file:git:http:https:ssh",
    GIT_GRAFT_FILE: "/evil/grafts",
    GIT_NO_REPLACE_OBJECTS: "0",
    GIT_REPLACE_REF_BASE: "refs/evil",
  };
  for (const [key, value] of Object.entries(pollution)) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv.clear();
}

/** 全矩阵键闭集（默认无放行，防漂移）：R2 基础 13 键 + R4 预设增量 + 协议矩阵。 */
const EXPECTED_FULL_CONFIG_KEYS_DEFAULT = [
  "core.hooksPath",
  "core.fsmonitor",
  "core.askPass",
  "core.excludesFile",
  "core.attributesFile",
  "gc.auto",
  "maintenance.auto",
  "core.commitGraph",
  "gc.writeCommitGraph",
  "log.showSignature",
  "core.logAllRefUpdates",
  "submodule.recurse",
  "filter.lfs.required",
  "core.useReplaceRefs",
  "safe.bareRepository",
  "help.autocorrect",
  "alias.remote-denied_by_acode.command",
  "rerere.enabled",
  "merge.directoryRenames",
  "merge.renameLimit",
  "diff.renameLimit",
  "core.splitIndex",
  "protocol.allow",
  "protocol.ext.allow",
  "protocol.fd.allow",
  "protocol.file.allow",
  "protocol.git.allow",
  "protocol.ssh.allow",
  "protocol.http.allow",
  "protocol.https.allow",
];

describe("cli git hardening presets (pure)", () => {
  test("P2 入站消毒：GLOBAL/SYSTEM 重定向、协议透传、完整性弱化、编号夹带全封", () => {
    polluteEnv();
    try {
      const env = getCliGitInvocationEnv();
      // 全局/系统配置重定向被剥离（等效任意 config 注入通道）。
      assert.equal(env["GIT_CONFIG_GLOBAL"], undefined);
      assert.equal(env["GIT_CONFIG_SYSTEM"], undefined);
      // 继承的全放行协议名单不透传：默认调用点 = 全拒（空串）。
      assert.equal(env["GIT_ALLOW_PROTOCOL"], "");
      // 完整性三件套 env 层不被继承值弱化。
      assert.equal(env["GIT_NO_REPLACE_OBJECTS"], "1");
      assert.equal(env["GIT_GRAFT_FILE"], getCliGitGraftNullFilePath());
      assert.notEqual(env["GIT_GRAFT_FILE"], "/evil/grafts");
      // replace base 只剥不写。
      assert.equal(env["GIT_REPLACE_REF_BASE"], undefined);
      // 编号键夹带：污染的 KEY_0 被矩阵覆盖、超界 KEY_77 被删除。
      assert.notEqual(env["GIT_CONFIG_KEY_0"], "safe.directory");
      assert.equal(env["GIT_CONFIG_KEY_77"], undefined);
      assert.equal(env["GIT_CONFIG_VALUE_77"], undefined);
      assert.equal(env["GIT_CONFIG_PARAMETERS"], undefined);

      // overlay 形态同源：unset 显式含 GIT_ALLOW_PROTOCOL，set 写 per-call 值。
      const overlay = getCliGitInvocationEnvOverlay();
      assert.ok(overlay.unset.includes("GIT_ALLOW_PROTOCOL"));
      assert.ok(overlay.unset.includes("GIT_CONFIG_GLOBAL"));
      assert.ok(overlay.unset.includes("GIT_CONFIG_SYSTEM"));
      assert.equal(overlay.set["GIT_ALLOW_PROTOCOL"], "");
      assert.equal(overlay.set["GIT_NO_REPLACE_OBJECTS"], "1");

      // opt-in 时污染值同样不透传：per-call 值是唯一来源。
      const opted = getCliGitInvocationEnv(process.env, process.platform, {
        allowedProtocols: CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST,
      });
      assert.equal(opted["GIT_ALLOW_PROTOCOL"], "file:http:https:ssh");
    } finally {
      restoreEnv();
    }
  });

  test("P3/P4 预设矩阵键值 + 全闭集守护（防漂移，spec R5）", () => {
    const entries = getCliGitHardenedConfigEntries("linux");
    assert.deepEqual(
      entries.map(([key]) => key),
      EXPECTED_FULL_CONFIG_KEYS_DEFAULT,
    );
    const asMap = new Map(entries);
    // P3 replace-ref 完整性 config 层。
    assert.equal(asMap.get("core.useReplaceRefs"), "false");
    // P4 kill switch 与副作用收口。
    assert.equal(asMap.get("safe.bareRepository"), "explicit");
    assert.equal(asMap.get("help.autocorrect"), "0");
    assert.equal(asMap.get("alias.remote-denied_by_acode.command"), "");
    assert.equal(asMap.get("rerere.enabled"), "false");
    assert.equal(asMap.get("merge.directoryRenames"), "false");
    assert.equal(asMap.get("merge.renameLimit"), "7000");
    assert.equal(asMap.get("diff.renameLimit"), "7000");
    assert.equal(asMap.get("core.splitIndex"), "false");
    // P1 默认协议矩阵：全局 never + 七协议逐个 never。
    assert.equal(asMap.get("protocol.allow"), "never");
    for (const protocol of CLI_GIT_PROTOCOL_NAMES) {
      assert.equal(asMap.get(`protocol.${protocol}.allow`), "never");
    }
    // P3 env 层：graft 空文件路径必然是不存在路径（可执行文件/空设备的子路径）。
    const graftPath = getCliGitGraftNullFilePath();
    assert.ok(graftPath.endsWith("no-grafts"), `graft 空路径应指向 no-grafts：${graftPath}`);
  });

  test("P1 协议默认全拒 + marketplace opt-in 同源构建（两层同源，无重复键）", () => {
    // 默认：env 空串全拒 + config 全 never。
    const denyEnv = getCliGitInvocationEnv();
    assert.equal(denyEnv["GIT_ALLOW_PROTOCOL"], "");
    const denyEntries = getCliGitHardenedConfigEntries(process.platform);
    assert.equal(denyEnv["GIT_CONFIG_COUNT"], String(denyEntries.length));
    assert.equal(new Set(denyEntries.map(([key]) => key)).size, denyEntries.length);

    // 显式放行（marketplace 调用点白名单）：env 串与 config always 同源构建。
    const allowEnv = getCliGitInvocationEnv(process.env, process.platform, {
      allowedProtocols: CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST,
    });
    assert.equal(allowEnv["GIT_ALLOW_PROTOCOL"], "file:http:https:ssh");
    const allowEntries = getCliGitHardenedConfigEntries(
      process.platform,
      CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST,
    );
    assert.equal(allowEnv["GIT_CONFIG_COUNT"], String(allowEntries.length));
    // 同一键不得重复出现（放行协议不再出现在 never 组）。
    assert.equal(new Set(allowEntries.map(([key]) => key)).size, allowEntries.length);
    const allowMap = new Map(
      getCliGitHardenedConfigEntries("linux", CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST),
    );
    assert.equal(allowMap.get("protocol.allow"), "never");
    for (const protocol of ["file", "http", "https", "ssh"] as const) {
      assert.equal(allowMap.get(`protocol.${protocol}.allow`), "always");
    }
    for (const protocol of ["ext", "fd", "git"] as const) {
      assert.equal(allowMap.get(`protocol.${protocol}.allow`), "never");
    }
    // 编号键与条目一一对应（注入通道完整性，P5）。
    allowEntries.forEach(([key, value], index) => {
      assert.equal(allowEnv[`GIT_CONFIG_KEY_${index}`], key);
      assert.equal(allowEnv[`GIT_CONFIG_VALUE_${index}`], value);
    });

    // overlay 形态的 opt-in 同源（ExecutionPort 消费面 API 对称性）。
    const overlay = getCliGitInvocationEnvOverlay(process.env, process.platform, {
      allowedProtocols: CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST,
    });
    assert.equal(overlay.set["GIT_ALLOW_PROTOCOL"], "file:http:https:ssh");
    assert.equal(overlay.set["GIT_CONFIG_COUNT"], String(allowEntries.length));
  });
});

// ---- 功能段：真实 git 临时 fixture（git 不可用则 skip）----

const gitProbe = spawnSync("git", ["--version"], { stdio: "ignore" });
const gitAvailable = gitProbe.status === 0;

describe(
  "cli git hardening presets functional (temp repos)",
  { skip: gitAvailable ? false : "git binary not available" },
  () => {
    let root: string;
    let originBare: string;
    let workRepo: string;
    let replaceRepo: string;

    /** fixture 专用 plain git（不带硬化 env，模拟用户终端语义）。 */
    function plain(args: string[], cwd: string): ReturnType<typeof spawnSync> {
      return spawnSync("git", args, { cwd, env: process.env, encoding: "utf8" });
    }

    /** 硬化 env 下跑 git（消费点直接 spawn 形态的等价链路）。 */
    function hardened(
      args: string[],
      cwd: string,
      envOverride?: Record<string, string>,
    ): ReturnType<typeof spawnSync> {
      return spawnSync("git", args, {
        cwd,
        env: { ...getCliGitInvocationEnv(), ...envOverride },
        encoding: "utf8",
        timeout: 30_000,
      });
    }

    before(async () => {
      root = await mkdtemp(join(tmpdir(), "acode-cli-git-presets-"));
      originBare = join(root, "origin.git");
      workRepo = join(root, "work");
      replaceRepo = join(root, "replace-repo");

      // 远端 fixture：bare origin + 工作 clone（marketplace clone 面的本地等价物）。
      assert.equal(plain(["init", "-q", "--bare", originBare], root).status, 0);
      const cloned = plain(["clone", "-q", originBare, workRepo], root);
      assert.equal(cloned.status, 0, cloned.stderr);
      // 空仓库 clone 的初始分支取决于用户全局 init.defaultBranch，显式钉死 main。
      assert.equal(plain(["symbolic-ref", "HEAD", "refs/heads/main"], workRepo).status, 0);
      plain(["config", "user.email", "presets@test.local"], workRepo);
      plain(["config", "user.name", "presets-test"], workRepo);
      await writeFile(join(workRepo, "a.txt"), "a\n");
      assert.equal(plain(["add", "a.txt"], workRepo).status, 0);
      assert.equal(plain(["commit", "-q", "-m", "seed"], workRepo).status, 0);

      // replace-ref 伪冒 fixture：真实历史 A → B（HEAD=B），
      // refs/replace/<B> 指向 A —— 无防御时读 B 得到 A 的内容（历史伪冒）。
      assert.equal(plain(["init", "-q", "-b", "main", replaceRepo], root).status, 0);
      plain(["config", "user.email", "presets@test.local"], replaceRepo);
      plain(["config", "user.name", "presets-test"], replaceRepo);
      assert.equal(
        plain(["commit", "-q", "--allow-empty", "-m", "SPOOFED_SUBJECT"], replaceRepo).status,
        0,
      );
      const spoofedSha = plain(["rev-parse", "HEAD"], replaceRepo).stdout.trim();
      assert.equal(
        plain(["commit", "-q", "--allow-empty", "-m", "REAL_SUBJECT"], replaceRepo).status,
        0,
      );
      assert.equal(plain(["replace", "HEAD", spoofedSha], replaceRepo).status, 0);
    });

    after(async () => {
      if (root) {
        await rm(root, { recursive: true, force: true, maxRetries: 5 });
      }
    });

    test("P1 协议默认全拒：ls-remote/clone 对本地 file 远端也被拒绝", () => {
      const lsRemote = hardened(["ls-remote", "origin"], workRepo);
      assert.notEqual(lsRemote.status, 0, "默认 env 下 file 传输必须被拒");
      assert.match(String(lsRemote.stderr), /not allowed/i);

      const clone = hardened(["clone", originBare, join(root, "denied-clone")], root);
      assert.notEqual(clone.status, 0, "默认 env 下 clone（file 远端）必须被拒");
      assert.match(String(clone.stderr), /not allowed/i);
    });

    test("P1 marketplace opt-in 放行：同命令成功，且 ext:: 在放行面下仍被拒", () => {
      const env = getCliGitInvocationEnv(process.env, process.platform, {
        allowedProtocols: CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST,
      });
      const lsRemote = spawnSync("git", ["ls-remote", "origin"], {
        cwd: workRepo,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(lsRemote.status, 0, lsRemote.stderr);

      // 放行面仍是最小集：ext（remote-helper RCE 主向量）在同一 env 下依旧被拒，
      // 且 remote-helper 不得被执行。
      const startedAt = Date.now();
      const ext = spawnSync("git", ["ls-remote", "ext::sh -c echo%20HACKED"], {
        cwd: workRepo,
        env,
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.notEqual(ext.status, 0, "ext 传输必须始终被拒");
      assert.ok(
        !`${ext.stderr}${ext.stdout}`.includes("HACKED"),
        "ext remote-helper 不得被执行",
      );
      assert.ok(Date.now() - startedAt < 20_000, "不得挂起等待输入");
    });

    test("P3 replace-ref 防御：硬化下读到真实内容，对照组读到伪冒内容", () => {
      // 对照组（plain env）：replace ref 生效，历史被伪冒——证明攻击面真实存在。
      const control = plain(["log", "-1", "--format=%s", "HEAD"], replaceRepo);
      assert.equal(control.status, 0, control.stderr);
      assert.equal(control.stdout.trim(), "SPOOFED_SUBJECT");

      // 硬化 env（GIT_NO_REPLACE_OBJECTS=1 + core.useReplaceRefs=false 双通道）：真实内容。
      const result = hardened(["log", "-1", "--format=%s", "HEAD"], replaceRepo);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "REAL_SUBJECT");

      // config 层独立生效：关掉 env 层 GIT_NO_REPLACE_OBJECTS，
      // core.useReplaceRefs=false 仍然挡住伪冒（"env 单独丢失"第二层防御）。
      const configOnly = hardened(["log", "-1", "--format=%s", "HEAD"], replaceRepo, {
        GIT_NO_REPLACE_OBJECTS: "0",
      });
      assert.equal(configOnly.status, 0, configOnly.stderr);
      assert.equal(configOnly.stdout.trim(), "REAL_SUBJECT");
    });

    test("P4 safe.bareRepository=explicit：bare 仓库内命令被拒绝（发现劫持面封死）", () => {
      // 对照组：plain env 下 bare 仓库内 rev-parse 正常工作。
      const control = plain(["rev-parse", "--git-dir"], originBare);
      assert.equal(control.status, 0, control.stderr);

      const result = hardened(["rev-parse", "--git-dir"], originBare);
      assert.notEqual(result.status, 0, "bare 仓库必须被 explicit 模式拒绝");
      assert.match(String(result.stderr), /bare repository/i);
    });
  },
);
