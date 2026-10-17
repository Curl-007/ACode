// SSH config 别名不支持指令检测测试
// （spec: packages/services/specs/ssh-config-alias-proxy-rejection.md 验收场景 1-5）。
// 不依赖真实 SSH 服务器：单元部分为纯函数；集成部分用临时 HOME 下的 config，
// 对 ssh -G 可用与不可用两种环境分别断言（以 detectedBy 分支）。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSSHConfigAliasRejection,
  detectUnsupportedDirectiveReason,
  detectUnsupportedInSshGOutput,
  evaluateMatchApplicability,
} from "../src/system/sshConfigAliasUnsupported.js";
import { listSSHConfigAliasesFromLocalConfig } from "../src/system/sshConfigAlias.js";

const exactMatcher = (pattern: string, alias: string): boolean =>
  pattern === "*" || pattern === alias;

test("-G output detection: proxy keys are rejected, look-alikes are not (验收 1/2)", () => {
  const proxyJump = detectUnsupportedInSshGOutput(
    "user bob\nhostname 10.0.0.1\nport 22\nproxyjump bastion\n",
  );
  assert.equal(proxyJump?.reason, "proxy_jump_unsupported");
  assert.equal(proxyJump?.directive, "ProxyJump");
  assert.equal(proxyJump?.detectedBy, "ssh-g");

  const proxyCommand = detectUnsupportedInSshGOutput(
    "hostname 10.0.0.2\r\nproxycommand ssh -W %h:%p bastion\r\n",
  );
  assert.equal(proxyCommand?.reason, "proxy_command_unsupported");

  const localCommand = detectUnsupportedInSshGOutput("localcommand echo hi\nhostname x\n");
  assert.equal(localCommand?.reason, "local_command_unsupported");

  // permitlocalcommand/proxyusefdpass 是恒出现的独立键，不得前缀误报
  assert.equal(
    detectUnsupportedInSshGOutput("permitlocalcommand no\nproxyusefdpass no\nhostname x\n"),
    undefined,
  );
  // ProxyCommand none 是「显式禁用代理」，不构成代理依赖
  assert.equal(detectUnsupportedInSshGOutput("proxycommand none\nhostname x\n"), undefined);
  // 干净输出
  assert.equal(detectUnsupportedInSshGOutput("user bob\nhostname 10.0.0.4\nport 2222\n"), undefined);
  assert.equal(detectUnsupportedInSshGOutput(""), undefined);
});

test("-G detection message carries the directive label and the direct-connect guidance (验收 5)", () => {
  const rejection = buildSSHConfigAliasRejection("proxy_jump_unsupported", "ssh-g");
  assert.match(rejection.message, /ProxyJump（跳板机）/u);
  assert.match(rejection.message, /直连目标主机/u);
  assert.match(rejection.message, /跳板拓扑/u);
  const matchRejection = buildSSHConfigAliasRejection("match_unsupported", "static-fallback");
  assert.match(matchRejection.message, /Match（条件配置块）/u);
  assert.match(matchRejection.message, /直连目标主机/u);
});

test("static directive detection skips disabled and empty values", () => {
  assert.equal(
    detectUnsupportedDirectiveReason([{ key: "proxyjump", value: "bastion" }]),
    "proxy_jump_unsupported",
  );
  assert.equal(
    detectUnsupportedDirectiveReason([{ key: "proxycommand", value: "none" }]),
    undefined,
  );
  assert.equal(detectUnsupportedDirectiveReason([{ key: "localcommand", value: "  " }]), undefined);
  assert.equal(
    detectUnsupportedDirectiveReason([
      { key: "hostname", value: "10.0.0.1" },
      { key: "identityfile", value: "~/.ssh/id_rsa" },
    ]),
    undefined,
  );
});

test("Match applicability: static host/all only, everything else indeterminate (验收 3)", () => {
  assert.equal(evaluateMatchApplicability(["all"], "target", exactMatcher), "applies");
  assert.equal(evaluateMatchApplicability(["host", "target"], "target", exactMatcher), "applies");
  assert.equal(
    evaluateMatchApplicability(["host", "other"], "target", exactMatcher),
    "not_applicable",
  );
  assert.equal(
    evaluateMatchApplicability(["host", "!target"], "target", exactMatcher),
    "not_applicable",
  );
  // 只有否定模式且未命中别名 → host 条件成立
  assert.equal(
    evaluateMatchApplicability(["host", "!other"], "target", exactMatcher),
    "applies",
  );
  // 逗号列表：OR 语义
  assert.equal(
    evaluateMatchApplicability(["host", "a,target,b"], "target", exactMatcher),
    "applies",
  );
  // exec 不可判定
  assert.equal(
    evaluateMatchApplicability(["exec", "check.sh"], "target", exactMatcher),
    "indeterminate",
  );
  // AND 短路：host 已确定不成立时 exec 不再引入不可判定
  assert.equal(
    evaluateMatchApplicability(["host", "!target", "exec", "x.sh"], "target", exactMatcher),
    "not_applicable",
  );
  // host 成立 + exec 不可判定 → 整块不可判定
  assert.equal(
    evaluateMatchApplicability(["host", "target", "exec", "x.sh"], "target", exactMatcher),
    "indeterminate",
  );
  // user/address/canonical/final 均不可判定
  assert.equal(evaluateMatchApplicability(["user", "bob"], "target", exactMatcher), "indeterminate");
  assert.equal(
    evaluateMatchApplicability(["address", "10.0.0.0/8"], "target", exactMatcher),
    "indeterminate",
  );
  assert.equal(evaluateMatchApplicability(["canonical"], "target", exactMatcher), "indeterminate");
  assert.equal(evaluateMatchApplicability(["final"], "target", exactMatcher), "indeterminate");
  // 裸 Match（无条件 token）不可判定
  assert.equal(evaluateMatchApplicability([], "target", exactMatcher), "indeterminate");
});

const INTEGRATION_CONFIG = `Host jumpbox-target
  HostName 10.0.0.1
  ProxyJump bastion

Host cmd-target
  HostName 10.0.0.2
  ProxyCommand ssh -W %h:%p bastion

Host match-exec-target
  HostName 10.0.0.3

Host clean-target
  HostName 10.0.0.4
  User bob

Host match-not-target
  HostName 10.0.0.5

Match exec "test -f /nonexistent-acode-probe"
  HostName 10.9.9.9

Match host other-host
  ProxyCommand ssh -W %h:%p nowhere
`;

test("alias listing marks proxy-dependent aliases instead of silently dropping them (验收 3/4)", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-ssh-alias-"));
  const sshDir = join(root, ".ssh");
  await mkdir(sshDir, { recursive: true });
  await writeFile(join(sshDir, "config"), INTEGRATION_CONFIG, "utf8");

  const savedHome = process.env["HOME"];
  const savedProfile = process.env["USERPROFILE"];
  process.env["HOME"] = root;
  process.env["USERPROFILE"] = root;
  try {
    const options = await listSSHConfigAliasesFromLocalConfig();
    const byAlias = new Map(options.map((option) => [option.alias, option] as const));

    // Match 条件 token 不会成为别名，也不会把 Match 块指令并入 Host 块
    assert.equal(byAlias.has("other-host"), false);
    assert.equal(byAlias.has("exec"), false);
    assert.equal(byAlias.size, 5);

    const jumpbox = byAlias.get("jumpbox-target");
    assert.equal(jumpbox?.unsupported?.reason, "proxy_jump_unsupported");
    // 结构化拒绝保留解析字段（供 UI 解释），不静默移除别名
    assert.equal(jumpbox?.host, "10.0.0.1");

    const cmd = byAlias.get("cmd-target");
    assert.equal(cmd?.unsupported?.reason, "proxy_command_unsupported");

    const viaSshG = jumpbox?.unsupported?.detectedBy === "ssh-g";
    if (viaSshG) {
      // -G 权威路径：Match exec 已被真实 ssh 求值（探针文件不存在 → 不适用），
      // clean/match-exec/match-not 目标均无拒绝。
      assert.equal(byAlias.get("match-exec-target")?.unsupported, undefined);
      assert.equal(byAlias.get("clean-target")?.unsupported, undefined);
      assert.equal(byAlias.get("match-not-target")?.unsupported, undefined);
    } else {
      // 静态回退路径：Match exec 不可判定 → 保守拒绝所有别名（match_unsupported），
      // 指令类拒绝仍优先。
      assert.equal(
        byAlias.get("match-exec-target")?.unsupported?.reason,
        "match_unsupported",
      );
      assert.equal(byAlias.get("clean-target")?.unsupported?.reason, "match_unsupported");
      assert.equal(
        byAlias.get("match-not-target")?.unsupported?.reason,
        "match_unsupported",
      );
    }

    // 平铺键解析行为不回退
    const clean = byAlias.get("clean-target");
    assert.equal(clean?.host, "10.0.0.4");
    assert.equal(clean?.username, "bob");
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = savedProfile;
    await rm(root, { recursive: true, force: true });
  }
});
