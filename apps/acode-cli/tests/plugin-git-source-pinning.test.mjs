import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 安全加固 P2 #8 的验收测试：插件 git 源 commit 固定 + host 白名单（纯判定层）。
 *
 * 判定是安装策略的唯一事实源（marketplace.ts 在仓库源物化前统一执行），这里不真跑
 * git clone，只断言「是否允许安装 / 锚点是什么 / 违规原因」。
 */

const pinning = await import("../packages/adapters/src/plugins/git-source-pinning.ts");
const { readPluginSourceIdentityPin } = await import(
  "../packages/adapters/src/plugins/marketplace.ts"
);

const {
  PLUGIN_REPOSITORY_SOURCE_ALLOWED_HOSTS,
  describePluginRepositorySourcePolicyViolation,
  isPluginGitSourceHostAllowed,
  parsePluginRepositorySourceHost,
  resolvePluginRepositorySourcePinDecision,
} = pinning;

test("pinned sources: sha/commit field wins, 40-hex ref counts as a pin", () => {
  const bySha = resolvePluginRepositorySourcePinDecision({
    ref: "main",
    sha: "1234567890abcdef1234567890abcdef12345678",
  });
  assert.equal(bySha.action, "install-pinned");
  assert.equal(bySha.pin, "1234567890abcdef1234567890abcdef12345678");

  // 兼容写法 commit 与 zip sha256 都经 readPluginSourceIdentityPin 汇入同一判定。
  const byCommitField = resolvePluginRepositorySourcePinDecision({
    sha: readPluginSourceIdentityPin({ commit: "a".repeat(40) }),
  });
  assert.equal(byCommitField.action, "install-pinned");
  const byZipSha256 = resolvePluginRepositorySourcePinDecision({
    sha: readPluginSourceIdentityPin({
      sha256: "b".repeat(64),
      source: "url",
      type: "zip",
      url: "https://example.com/plugin.zip",
    }),
  });
  assert.equal(byZipSha256.action, "install-pinned");

  const byRefSha = resolvePluginRepositorySourcePinDecision({
    ref: "c".repeat(40),
  });
  assert.equal(byRefSha.action, "install-pinned");
  assert.equal(byRefSha.pin, "c".repeat(40));
});

test("floating refs are rejected by default with actionable guidance", () => {
  for (const input of [
    { ref: "main" },
    { ref: "v1.2.3" },
    {},
    { ref: "release" },
  ]) {
    const decision = resolvePluginRepositorySourcePinDecision(input);
    assert.equal(decision.action, "reject-floating");
    assert.match(decision.reason, /"sha"/u);
    assert.match(decision.reason, /allowFloatingRef/u);
  }
  // 缺省 HEAD 的拒绝消息要能指认浮动对象。
  const head = resolvePluginRepositorySourcePinDecision({});
  assert.match(head.reason, /"HEAD"/u);
  // 空白/非字符串 ref 视作浮动，不得被解析成锚点。
  assert.equal(resolvePluginRepositorySourcePinDecision({ ref: "  " }).action, "reject-floating");
  assert.equal(resolvePluginRepositorySourcePinDecision({ ref: "main", sha: "" }).action, "reject-floating");
  // 短 SHA 不是不可变锚点（可被碰撞/歧义），不能当 pin 放行。
  assert.equal(resolvePluginRepositorySourcePinDecision({ ref: "1234567" }).action, "reject-floating");
});

test("allowFloatingRef: true is the explicit opt-in for legacy floating behaviour", () => {
  const optedIn = resolvePluginRepositorySourcePinDecision({
    ref: "main",
    allowFloatingRef: true,
  });
  assert.equal(optedIn.action, "install-floating");

  // 逃生门必须是严格布尔 true，其他真值不构成同意。
  for (const value of ["true", 1, "yes", null]) {
    assert.equal(
      resolvePluginRepositorySourcePinDecision({ ref: "main", allowFloatingRef: value }).action,
      "reject-floating",
    );
  }
  // 显式 opt-in 不覆盖已声明的锚点语义：有 sha 仍按 pinned。
  const pinnedWithOptIn = resolvePluginRepositorySourcePinDecision({
    ref: "main",
    sha: "d".repeat(40),
    allowFloatingRef: true,
  });
  assert.equal(pinnedWithOptIn.action, "install-pinned");
});

test("host allowlist: only github over TLS/SSH, scp-like syntax included", () => {
  assert.deepEqual([...PLUGIN_REPOSITORY_SOURCE_ALLOWED_HOSTS].sort(), [
    "github.com",
    "www.github.com",
  ]);
  for (const url of [
    "https://github.com/owner/repo.git",
    "https://GitHub.com/owner/repo",
    "https://www.github.com/owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
  ]) {
    assert.equal(isPluginGitSourceHostAllowed(url), true, url);
  }
  for (const url of [
    "https://gitlab.com/owner/repo.git",
    "https://bitbucket.org/owner/repo.git",
    "http://github.com/owner/repo.git", // 明文 http 一律拒绝
    "http://192.168.1.10/repo.git",
    "git@evil.example:owner/repo.git",
    "git@127.0.0.1:owner/repo.git",
    "file:///tmp/repo",
    "https://github.com.evil.example/owner/repo.git",
    "ftp://github.com/owner/repo.git",
    "not a url",
    "",
  ]) {
    assert.equal(isPluginGitSourceHostAllowed(url), false, url);
  }
});

test("host parsing handles URLs and scp-like syntax, lowercase normalized", () => {
  assert.equal(parsePluginRepositorySourceHost("https://GitHub.com/owner/repo.git"), "github.com");
  assert.equal(parsePluginRepositorySourceHost("ssh://git@github.com/owner/repo.git"), "github.com");
  assert.equal(parsePluginRepositorySourceHost("git@github.com:owner/repo.git"), "github.com");
  assert.equal(parsePluginRepositorySourceHost("git@evil.example:owner/repo.git"), "evil.example");
  assert.equal(parsePluginRepositorySourceHost(""), null);
  assert.equal(parsePluginRepositorySourceHost("garbage"), null);
});

test("combined policy: host violation is reported before missing pin", () => {
  const violation = describePluginRepositorySourcePolicyViolation({
    ref: "main",
    url: "https://gitlab.com/owner/repo.git",
  });
  assert.match(violation, /host is not allowed/u);
  assert.match(violation, /github\.com/u);

  const floating = describePluginRepositorySourcePolicyViolation({
    ref: "main",
    url: "https://github.com/owner/repo.git",
  });
  assert.match(floating, /floating ref "main"/u);

  // 允许安装（pinned）与显式 opt-in（floating）都返回 null。
  assert.equal(
    describePluginRepositorySourcePolicyViolation({
      sha: "e".repeat(40),
      url: "https://github.com/owner/repo.git",
    }),
    null,
  );
  assert.equal(
    describePluginRepositorySourcePolicyViolation({
      ref: "main",
      allowFloatingRef: true,
      url: "git@github.com:owner/repo.git",
    }),
    null,
  );
});
