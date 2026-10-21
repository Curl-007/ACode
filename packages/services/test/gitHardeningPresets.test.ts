import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  GIT_PROTOCOL_NAMES,
  GIT_PUSH_PROTOCOL_ALLOWLIST,
  getGitCommandEnv,
  getGitGraftNullFilePath,
  getGitHardenedConfigEntries,
} from "../src/git/config.js";
import { createGitCommandProvider } from "../src/git/providers/gitCommandProvider.js";

/**
 * git 硬化预设增量守护（specs/git-hardening-presets.md P1–P6）。
 * 纯函数段：入站消毒增量、预设矩阵键值、协议默认全拒 + 按调用点放行。
 * 功能段（真实 git 临时 fixture，git 不可用则 skip）：协议默认拒绝/显式放行、
 * replace-ref 伪冒防御、bare repo 发现拒绝——全部经 gitCommandProvider.run
 * 链路级验证（config → provider → spawn）。
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

/** 全矩阵键闭集（默认无放行，防漂移）：R2 既有 13 键 + presets 增量键。 */
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

describe("git hardening presets (pure)", () => {
  test("P2 入站消毒：GLOBAL/SYSTEM 重定向、协议透传、完整性弱化、编号夹带全封", () => {
    polluteEnv();
    try {
      const env = getGitCommandEnv();
      // 全局/系统配置重定向被剥离（等效任意 config 注入通道）。
      assert.equal(env.GIT_CONFIG_GLOBAL, undefined);
      assert.equal(env.GIT_CONFIG_SYSTEM, undefined);
      // 继承的全放行协议名单不透传：默认调用点 = 全拒（空串）。
      assert.equal(env.GIT_ALLOW_PROTOCOL, "");
      // 完整性三件套 env 层不被继承值弱化。
      assert.equal(env.GIT_NO_REPLACE_OBJECTS, "1");
      assert.equal(env.GIT_GRAFT_FILE, getGitGraftNullFilePath());
      assert.notEqual(env.GIT_GRAFT_FILE, "/evil/grafts");
      // replace base 只剥不写。
      assert.equal(env.GIT_REPLACE_REF_BASE, undefined);
      // 编号键夹带：污染的 KEY_0 被矩阵覆盖、超界 KEY_77 被删除。
      assert.notEqual(env.GIT_CONFIG_KEY_0, "safe.directory");
      assert.equal(env.GIT_CONFIG_KEY_77, undefined);
      assert.equal(env.GIT_CONFIG_VALUE_77, undefined);
      assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
    } finally {
      restoreEnv();
    }
  });

  test("P3/P4 预设矩阵键值 + 全闭集守护（防漂移）", () => {
    const entries = getGitHardenedConfigEntries("linux");
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
    for (const protocol of GIT_PROTOCOL_NAMES) {
      assert.equal(asMap.get(`protocol.${protocol}.allow`), "never");
    }
    // P3 env 层：graft 空文件路径必然是不存在路径（可执行文件/空设备的子路径）。
    const graftPath = getGitGraftNullFilePath();
    assert.ok(graftPath.endsWith("no-grafts"), `graft 空路径应指向 no-grafts：${graftPath}`);
  });

  test("P1 协议默认全拒 + 按调用点显式放行（两层同源，无重复键）", () => {
    // 默认：env 空串全拒 + config 全 never。
    const denyEnv = getGitCommandEnv();
    assert.equal(denyEnv.GIT_ALLOW_PROTOCOL, "");
    const denyEntries = getGitHardenedConfigEntries("linux");
    assert.equal(denyEnv.GIT_CONFIG_COUNT, String(denyEntries.length));
    assert.equal(new Set(denyEntries.map(([key]) => key)).size, denyEntries.length);

    // 显式放行（push 调用点白名单）：env 串与 config always 同源构建。
    const allowEnv = getGitCommandEnv({ allowedProtocols: GIT_PUSH_PROTOCOL_ALLOWLIST });
    assert.equal(allowEnv.GIT_ALLOW_PROTOCOL, "file:https:ssh");
    // 编号键对照用默认 platform 构建（getGitCommandEnv 无 platform 参数，win32 下
    // hooksPath 与 "linux" 矩阵不同值）；协议断言用 "linux" 矩阵（协议键与平台无关）。
    const allowEntries = getGitHardenedConfigEntries(process.platform, GIT_PUSH_PROTOCOL_ALLOWLIST);
    assert.equal(allowEnv.GIT_CONFIG_COUNT, String(allowEntries.length));
    // 同一键不得重复出现（放行协议不再出现在 never 组）。
    assert.equal(new Set(allowEntries.map(([key]) => key)).size, allowEntries.length);
    const allowMap = new Map(getGitHardenedConfigEntries("linux", GIT_PUSH_PROTOCOL_ALLOWLIST));
    assert.equal(allowMap.get("protocol.allow"), "never");
    for (const protocol of ["file", "https", "ssh"] as const) {
      assert.equal(allowMap.get(`protocol.${protocol}.allow`), "always");
    }
    for (const protocol of ["ext", "fd", "git", "http"] as const) {
      assert.equal(allowMap.get(`protocol.${protocol}.allow`), "never");
    }
    // 编号键与条目一一对应（注入通道完整性，P5）。
    allowEntries.forEach(([key, value], index) => {
      assert.equal(allowEnv[`GIT_CONFIG_KEY_${index}`], key);
      assert.equal(allowEnv[`GIT_CONFIG_VALUE_${index}`], value);
    });
  });
});

// ---- 功能段：真实 git 临时 fixture（git 不可用则 skip）----

const gitProbe = spawnSync("git", ["--version"], { stdio: "ignore" });
const gitAvailable = gitProbe.status === 0;

describe(
  "git hardening presets functional (temp repos, provider chain)",
  { skip: gitAvailable ? false : "git binary not available" },
  () => {
    let root: string;
    let originBare: string;
    let workRepo: string;
    let replaceRepo: string;
    const provider = createGitCommandProvider();

    /** fixture 专用 plain git（不带硬化 env，模拟用户终端语义）。 */
    function plain(args: string[], cwd: string): ReturnType<typeof spawnSync> {
      return spawnSync("git", args, { cwd, env: process.env, encoding: "utf8" });
    }

    before(async () => {
      root = await mkdtemp(join(tmpdir(), "acode-git-presets-"));
      originBare = join(root, "origin.git");
      workRepo = join(root, "work");
      replaceRepo = join(root, "replace-repo");

      // 远端 fixture：bare origin + 工作 clone（含一个待 push 的本地 commit）。
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

    test("P1 协议默认全拒：ls-remote/push 对本地 file 远端也被拒绝", async () => {
      // posture 网关接线（specs/git-posture-gateway.md）：ls-remote 属 fetch 档、
      // push 档强制具体 refspec（R4-1，`push origin main` 无冒号形会被网关拒）——
      // 协议层断言需以合法档位+形状通过 argv 门，再验证 env 协议层拒绝。
      const lsRemote = await provider.run({
        cwd: workRepo,
        args: ["ls-remote", "origin"],
        posture: "fetch",
      });
      assert.notEqual(lsRemote.exitCode, 0, "默认 env 下 file 传输必须被拒");
      assert.match(lsRemote.stderr, /not allowed/i);

      const push = await provider.run({
        cwd: workRepo,
        args: ["push", "origin", "refs/heads/main:refs/heads/main"],
        posture: "push",
      });
      assert.notEqual(push.exitCode, 0, "默认 env 下 push（file 远端）必须被拒");
      assert.match(push.stderr, /not allowed/i);
    });

    test("P1 按调用点显式放行：envOptions file 后同命令成功（push 链路级）", async () => {
      const lsRemote = await provider.run({
        cwd: workRepo,
        args: ["ls-remote", "origin"],
        posture: "fetch",
        envOptions: { allowedProtocols: ["file"] },
      });
      assert.equal(lsRemote.exitCode, 0, lsRemote.stderr);

      const push = await provider.run({
        cwd: workRepo,
        args: ["push", "origin", "refs/heads/main:refs/heads/main"],
        posture: "push",
        envOptions: { allowedProtocols: GIT_PUSH_PROTOCOL_ALLOWLIST },
      });
      assert.equal(push.exitCode, 0, push.stderr);
      // push 确实到达远端（file 协议放行是功能性的，不是空转）。
      const remoteHead = plain(["rev-parse", "main"], originBare).stdout.trim();
      const localHead = plain(["rev-parse", "main"], workRepo).stdout.trim();
      assert.equal(remoteHead, localHead);
      // 放行面仍是最小集：ext 协议在放行了 file 的同一 env 下依旧被拒。
      const ext = await provider.run({
        cwd: workRepo,
        args: ["ls-remote", "ext::sh -c echo%20HACKED"],
        posture: "fetch",
        envOptions: { allowedProtocols: ["file"] },
        timeoutMs: 20_000,
      });
      assert.notEqual(ext.exitCode, 0, "ext 传输必须始终被拒");
      assert.ok(!ext.stderr.includes("HACKED"), "ext remote-helper 不得被执行");
    });

    test("P3 replace-ref 防御：硬化下读到真实内容，对照组读到伪冒内容", async () => {
      // 对照组（plain env）：replace ref 生效，历史被伪冒——证明攻击面真实存在。
      const control = plain(["log", "-1", "--format=%s", "HEAD"], replaceRepo);
      assert.equal(control.status, 0, control.stderr);
      assert.equal(control.stdout.trim(), "SPOOFED_SUBJECT");

      // 硬化 env（GIT_NO_REPLACE_OBJECTS=1 + core.useReplaceRefs=false 双通道）：真实内容。
      const hardened = await provider.run({
        cwd: replaceRepo,
        args: ["log", "-1", "--format=%s", "HEAD"],
      });
      assert.equal(hardened.exitCode, 0, hardened.stderr);
      assert.equal(hardened.stdout.trim(), "REAL_SUBJECT");

      // config 层独立生效：关掉 env 层 GIT_NO_REPLACE_OBJECTS，
      // core.useReplaceRefs=false 仍然挡住伪冒（"env 单独丢失"第二层防御）。
      const configOnly = await provider.run({
        cwd: replaceRepo,
        args: ["log", "-1", "--format=%s", "HEAD"],
        env: { GIT_NO_REPLACE_OBJECTS: "0" },
      });
      assert.equal(configOnly.exitCode, 0, configOnly.stderr);
      assert.equal(configOnly.stdout.trim(), "REAL_SUBJECT");
    });

    test("P4 safe.bareRepository=explicit：bare 仓库内命令被拒绝（发现劫持面封死）", async () => {
      // 对照组：plain env 下 bare 仓库内 rev-parse 正常工作。
      const control = plain(["rev-parse", "--git-dir"], originBare);
      assert.equal(control.status, 0, control.stderr);

      const hardened = await provider.run({ cwd: originBare, args: ["rev-parse", "--git-dir"] });
      assert.notEqual(hardened.exitCode, 0, "bare 仓库必须被 explicit 模式拒绝");
      assert.match(hardened.stderr, /bare repository/i);
    });
  },
);
