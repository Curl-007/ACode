import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * J1-1 验收测试：bash 目标 blast-radius 风险分级。
 *
 * 覆盖规格 apps/acode-cli/specs/bash-target-blast-radius.md 的 R1–R5 与验收矩阵。
 * 用例对照 jcode (MIT) crates/jcode-command-risk 的测试集翻译（自撰 TS，不拷 Rust）。
 * 纯函数测试 + 熔断器/PermissionService/capability 接线断言，无文件系统副作用。
 */

const { assessBashCommandTargetRisk } = await import(
  "../packages/core/src/tool/handlers/bash-target-risk/index.ts"
);
const { evaluateBypassImmuneBreakers } = await import(
  "../packages/core/src/permission/bypass-immune-breakers.ts"
);
const { PermissionService } = await import("../packages/core/src/permission/service.ts");
const { bashToolEntry } = await import("../packages/core/src/tool/handlers/bash.ts");
const { resolveBashPermissionRulePolicy } = await import(
  "../packages/core/src/tool/handlers/bash-command-permission-policy.ts"
);

// ── 固定上下文（确定性路径断言用；接线断言用真实 homedir） ─────────────

const LINUX_CTX = {
  workingDirectory: "/home/u/proj",
  workspaceRoot: "/home/u/proj",
  homeDirectory: "/home/u",
  platform: "linux",
};
const WIN_CTX = {
  workingDirectory: "C:\\Users\\Z\\proj",
  workspaceRoot: "C:\\Users\\Z\\proj",
  homeDirectory: "C:\\Users\\Z",
  platform: "win32",
};
const MAC_CTX = {
  workingDirectory: "/Users/u/proj",
  workspaceRoot: "/Users/u/proj",
  homeDirectory: "/Users/u",
  platform: "darwin",
};

function assess(command, context = LINUX_CTX) {
  return assessBashCommandTargetRisk(command, context);
}
function level(command, context = LINUX_CTX) {
  return assess(command, context).level;
}
function immediate(command, context = LINUX_CTX) {
  const result = level(command, context);
  return result === "safe" || result === "low";
}
function atLeastConfirm(command, context = LINUX_CTX) {
  const result = level(command, context);
  return result === "confirm" || result === "catastrophic";
}

// ── R1/R3：home 与根的每一种拼写都必须 catastrophic ──────────────────

test("home directory is catastrophic in every spelling (verb x flag x spelling sweep)", () => {
  const verbs = ["rm", "/bin/rm", "shred", "srm", "rmdir", "unlink"];
  const flags = ["-rf", "-fr", "-r -f", "--recursive --force", "-Rf"];
  const homes = [
    "~",
    "~/",
    "$HOME",
    "${HOME}",
    '"$HOME"',
    "'/home/u'",
    "/home/u",
    "/home/u/",
    "/home/u/.",
    "/home/u/x/..",
    "/home/./u",
  ];
  const escaped = [];
  for (const verb of verbs) {
    for (const flag of flags) {
      for (const home of homes) {
        const command = `${verb} ${flag} ${home}`;
        if (level(command) !== "catastrophic") escaped.push(command);
      }
    }
  }
  assert.deepEqual(escaped, [], `${escaped.length} command(s) reached home ungated`);
});

test("`..` traversal out of home reaches root and is caught", () => {
  for (const command of ["rm -rf ~/../..", "rm -rf /home/u/../..", "rm -rf ~/../../"]) {
    assert.equal(level(command), "catastrophic", command);
  }
  // 从项目目录向上一级就是 home 本体。
  assert.equal(level("rm -rf .."), "catastrophic");
});

test("root and system paths are catastrophic, including single files inside recursive tables", () => {
  for (const command of [
    "rm -rf /",
    "rm -rf /*",
    "rm -rf /etc",
    "rm --recursive --force /usr",
    "rm -f /etc/passwd",
    "rm -rf /usr/bin/env",
    "rm /boot/vmlinuz",
    "shred /etc/shadow",
    "rm -rf /var/lib/docker",
  ]) {
    assert.equal(level(command), "catastrophic", command);
  }
  // /var 精确匹配不递归：/var/log 是具体路径 low。
  assert.equal(level("rm -rf /var/log"), "low");
});

test("credential stores are recursively protected; config dirs exact-match only", () => {
  for (const command of ["rm -rf ~/.ssh", "shred ~/.gnupg", "rm -rf ~/.aws", "rm -rf ~/.ssh/id_rsa"]) {
    assert.equal(level(command), "catastrophic", command);
  }
  assert.equal(level("rm -rf ~/.config"), "catastrophic");
  assert.equal(level("rm -rf ~/.acode"), "catastrophic");
  // 精确匹配：目录本身保护、其下具体文件合法。
  assert.equal(level("rm -rf ~/.config/app/x.toml"), "low");
});

test("/home and /Users are deliberately NOT recursive: projects under them stay workable", () => {
  assert.equal(level("rm -rf /home/u/proj/target"), "low");
  assert.equal(immediate("rm -rf /home/u/proj/target"), true);
  assert.equal(level("rm -rf /home/u/other-project"), "low");
  assert.equal(level("rm -rf /srv/data"), "low");
  // 但 /home 与 /Users 本体仍是 catastrophic。
  assert.equal(level("rm -rf /home"), "catastrophic");
  assert.equal(level("rm -rf /Users"), "catastrophic");
});

// ── R2/R3：glob、设备、未解析变量 ────────────────────────────────────

test("bare globs over protected directories are catastrophic; bounded globs are low", () => {
  assert.equal(level("rm -rf ~/*"), "catastrophic");
  assert.equal(level("rm -rf /*"), "catastrophic");
  assert.equal(level("rm -rf /etc/*"), "catastrophic");
  // 文件名位 glob 逃不出具体父目录：cwd/temp 内 low（可见、不打断）。
  assert.equal(level("rm -f build-2026-*.json"), "low");
  assert.equal(level("rm -f /tmp/acode-*.json"), "low");
  // 通配目录段保守 confirm（父目录不是真实展开边界）。
  assert.equal(level("rm -rf /home/u/*/node_modules"), "confirm");
});

test("device node writes are catastrophic; safe sinks are exempt for redirects and dd of=", () => {
  assert.equal(level("dd of=/dev/sda"), "catastrophic");
  assert.equal(level("dd if=/dev/zero of=/dev/sda"), "catastrophic");
  assert.equal(level("echo x > /dev/sda"), "catastrophic");
  // 显式删除设备节点不豁免（rm /dev/null 由 /dev 递归保护命中）。
  assert.equal(level("rm /dev/null"), "catastrophic");
  // 写 bit bucket 无破坏：重定向与 dd of= 都豁免。
  assert.equal(level("dd if=disk.img of=/dev/null"), "safe");
  assert.equal(level("find / -name x 2>/dev/null"), "safe");
});

test("unresolved substitutions are never normalized away", () => {
  // $UNKNOWN/.. 词法归约到根：变量为空/多段时可达 / → catastrophic。
  assert.equal(level("rm -rf $UNKNOWN/.."), "catastrophic");
  // 单纯未解析目标 → confirm（看不见落点）。
  assert.equal(level("rm -rf $TARGET"), "confirm");
  assert.equal(atLeastConfirm("rm -rf $(cat list.txt)"), true);
  assert.equal(atLeastConfirm("rm -rf `echo ~`"), true);
  // $HOME 是已知前缀：展开后就是受保护路径 → 直接 deny 而非仅询问。
  assert.equal(level("rm -rf $HOME"), "catastrophic");
  // ~user 形态静态不可知 → confirm。
  assert.equal(level("rm -rf ~root"), "confirm");
});

// ── R4：wrapper / shell / eval / 命令替换 / 结构 fallback ────────────

test("wrapper commands do not hide the real program (sweep)", () => {
  const wrappers = [
    "sudo",
    "doas",
    "env",
    "nice -n 10",
    "ionice -c 3",
    "time",
    "timeout 5",
    "nohup",
    "setsid",
    "stdbuf -o0",
    "command",
    "exec",
    "sudo -u root",
    "env FOO=bar",
    "watch",
  ];
  const escaped = [];
  for (const wrapper of wrappers) {
    for (const tail of ["rm -rf ~", "rm -rf $HOME", "rm -rf /"]) {
      const command = `${wrapper} ${tail}`;
      if (level(command) !== "catastrophic") escaped.push(command);
    }
  }
  assert.deepEqual(escaped, [], `wrapper bypass: ${escaped.join(", ")}`);
  // 嵌套 wrapper 一解到底；wrapper 取值旗标不能吃掉真实程序。
  assert.equal(level("sudo env nice -n 5 rm -rf ~"), "catastrophic");
  assert.equal(level("timeout 5 sudo rm -rf /"), "catastrophic");
  assert.equal(level("timeout -s KILL 5 rm -rf ~"), "catastrophic");
  assert.equal(level("xargs -n 1 rm -rf ~"), "catastrophic");
});

test("ordinary wrapped commands are not noisy", () => {
  for (const command of [
    "sudo apt update",
    "env RUST_LOG=debug cargo test",
    "timeout 30 cargo build",
    "nice -n 10 make",
    "time ls -la",
    "xargs echo",
    "sh -c 'echo hello'",
    "bash -c 'cargo build'",
    "sudo rm -rf /home/u/proj/target",
  ]) {
    assert.equal(immediate(command), true, `${command} -> ${level(command)}`);
  }
  // command -v 是只读查询；env 单独是打印环境。
  for (const command of [
    "env",
    "env -i",
    "env FOO=bar",
    "sudo env",
    "command -v sudo",
    "command -V rm",
    "command -pv sudo env rm",
    "env command -v sudo",
    "command -v rm -rf /",
    "env -u UNUSED",
  ]) {
    assert.equal(level(command), "safe", command);
  }
  for (const command of ["command -p rm -rf ~", "env rm -rf ~", "command -- rm -rf ~"]) {
    assert.equal(level(command), "catastrophic", command);
  }
});

test("a wrapper hiding an unparseable payload escalates", () => {
  assert.equal(atLeastConfirm("sudo"), true);
});

test("inline shell scripts, eval and command substitutions are assessed, not skipped", () => {
  for (const command of [
    'sh -c "rm -rf ~"',
    "bash -c 'rm -rf $HOME'",
    'sudo sh -c "rm -rf /"',
    'eval "rm -rf ~"',
    "x=$(rm -rf ~)",
  ]) {
    assert.equal(level(command), "catastrophic", command);
  }
  // 内层替换本身按命令评估；外层含替换的目标按未解析升级。
  assert.equal(atLeastConfirm("rm -rf $(echo ~)"), true);
  // env -S 的 split-string payload 不可静态识别。
  assert.equal(atLeastConfirm("env -S"), true);
  for (const command of [
    "env -S='rm -rf /'",
    "env --split-string='rm -rf /'",
    "env -u FOO -S 'rm -rf /'",
    "env -iS 'rm -rf /'",
  ]) {
    assert.equal(atLeastConfirm(command), true, command);
  }
});

test("unsupported shell constructs cannot launder catastrophic commands (lexical fallback)", () => {
  for (const command of [
    "(rm -rf ~)",
    "case x in y) rm -rf ~;; esac",
    "if true; then rm -rf ~; fi",
    "while true; do rm -rf ~; done",
  ]) {
    assert.equal(level(command), "catastrophic", command);
  }
  // 引号内的字符串是数据不是命令：fallback 不得误判成动词+目标对。
  assert.equal(immediate('for x in 1; do echo "rm -rf ~"; done'), true);
  assert.equal(immediate('echo "never run rm -rf ~ on prod"'), true);
});

test("chaining in every separator form does not launder a catastrophic command", () => {
  for (const sep of ["&&", "||", ";", "|", "\n"]) {
    for (const command of [
      `echo safe ${sep} rm -rf ~`,
      `rm -rf ~ ${sep} echo done`,
      `cd /tmp ${sep} rm -rf $HOME`,
    ]) {
      assert.equal(level(command), "catastrophic", `${command} (sep=${JSON.stringify(sep)})`);
    }
  }
});

// ── R4：find 专门处理 ────────────────────────────────────────────────

test("find -delete upgrades search roots to deletion targets", () => {
  assert.equal(level("find ~ -delete"), "catastrophic");
  assert.equal(level("find /home/u -delete"), "catastrophic");
  assert.equal(level("find -L ~ -delete"), "catastrophic");
  assert.equal(level("find ~ -exec cat {} \\; -delete"), "catastrophic");
  // 只读 find 不升级搜索根。
  assert.equal(level("find ~ -type f -name '*.log'"), "safe");
  assert.equal(
    level("find /home/u/.acode -maxdepth 3 -type f -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -20"),
    "safe",
  );
});

test("find -exec payloads are recursively assessed with {} substitution", () => {
  // 工作目录内的 -exec rm：payload 代入搜索根后仍在 cwd → confirm（find 的完整效果
  // 无法静态确定），不升 catastrophic。
  assert.equal(level("find . -exec rm {} +"), "confirm");
  for (const action of ["-exec", "-execdir", "-ok", "-okdir"]) {
    for (const payload of ["rm -rf {}", "sudo rm -rf {}", "shred {}"]) {
      assert.equal(level(`find ~ ${action} ${payload} \\;`), "catastrophic", `${action} ${payload}`);
    }
    for (const payload of ["mystery {}", "$PROGRAM {}", "sed -i 's/a/b/' {}"]) {
      assert.equal(atLeastConfirm(`find / ${action} ${payload} \\;`), true, `${action} ${payload}`);
    }
  }
  assert.equal(level("find / -exec cat {} \\; -exec rm -rf {} +"), "catastrophic");
  assert.equal(level("find . -exec rm -rf /etc \\;"), "catastrophic");
  // 未终止的 -exec 更可疑而非更安全。
  for (const command of ["find / -exec", "find / -exec cat {}", "find / -execdir mystery {} +"]) {
    assert.equal(atLeastConfirm(command), true, command);
  }
});

test("read-only find -exec payloads do not delete search roots", () => {
  for (const action of ["-exec", "-execdir", "-ok", "-okdir"]) {
    for (const payload of ["cat {}", "/bin/cat -- {}", "readlink -f {}", "sed -n '1,200p' {}"]) {
      for (const root of ["/", "~", "~/.ssh", "/etc"]) {
        for (const terminator of ["\\;", "+"]) {
          const command = `find ${root} -type f ${action} ${payload} ${terminator}`;
          assert.equal(level(command), "safe", command);
        }
      }
    }
  }
});

test("find output actions classify their destinations; predicate literals are not actions", () => {
  for (const action of ["-fprint", "-fprint0", "-fls", "-fprintf"]) {
    const suffix = action === "-fprintf" ? " '%p'" : "";
    assert.equal(level(`find / ${action} /etc/passwd${suffix}`), "catastrophic", action);
    assert.equal(level(`find / ${action} $UNKNOWN${suffix}`), "confirm", action);
    assert.equal(level(`find / ${action} /tmp/find-output${suffix}`), "safe", action);
    assert.equal(level(`find / ${action} /dev/null${suffix}`), "safe", action);
  }
  for (const command of ["find / -name '-delete'", "find / -printf '-delete'", "find / -name '-exec'"]) {
    assert.equal(level(command), "safe", command);
  }
});

// ── R4：管道升级、无目标、HOME= 重赋值 ───────────────────────────────

test("pipe-fed destructive commands escalate: neither segment reveals the deletion alone", () => {
  for (const command of [
    "find ~ -type f | xargs rm -rf",
    "find / -name '*.conf' | xargs rm",
    "cat paths.txt | xargs rm -rf",
  ]) {
    assert.equal(atLeastConfirm(command), true, command);
    assert.equal(level(command), "confirm", command);
  }
});

test("a destructive command without a parsable target is more suspicious, not safer", () => {
  assert.equal(atLeastConfirm("rm -rf"), true);
  assert.equal(level("rm -rf"), "confirm");
});

test("HOME reassignment escalates but never launders the trusted home", () => {
  assert.equal(level("HOME=/tmp rm -rf ~"), "catastrophic");
  assert.equal(level("HOME=/tmp; rm -rf /home/u"), "catastrophic");
  assert.equal(level("env HOME=/tmp rm -rf ~/.ssh"), "catastrophic");
  assert.equal(atLeastConfirm("HOME=/etc; rm -rf $HOME/cache"), true);
  assert.equal(level("env -u UNUSED rm -rf ~"), "catastrophic");
  // confirm finding 与 catastrophic finding 并存，级别取更严者。
  const assessment = assess("HOME=/tmp rm -rf ~");
  assert.equal(assessment.level, "catastrophic");
  assert.ok(assessment.findings.length >= 2);
  assert.ok(assessment.findings.some((f) => f.level === "confirm" && /HOME/.test(f.reason)));
});

test("truncating redirects are classified; appends and heredoc bodies are not commands", () => {
  assert.equal(level("echo '' > /home/u/other/important.conf"), "low");
  assert.equal(level("echo line >> /home/u/other/log.txt"), "safe");
  assert.equal(level("echo hi > out.txt"), "safe");
  assert.equal(level("env > /etc/passwd"), "catastrophic");
  assert.equal(level("command -v sudo > /etc/passwd"), "catastrophic");
  assert.equal(level("sh -c 'echo hello' > $UNKNOWN"), "confirm");
  // heredoc body 是数据不是命令（jcode issue 922 教训）。
  assert.equal(immediate("cat > helper.sh <<'EOF'\n#!/bin/bash\nrm -f \"$SOME_VAR\"\nEOF"), true);
  // 但 heredoc 之外的真实命令照常被评估。
  assert.equal(level("cat <<'EOF'\nrm -rf ~\nEOF\nrm -rf ~"), "catastrophic");
});

// ── R1：low 档「有界破坏」白名单（日常操作不得被打断） ────────────────

test("routine project work never escalates past low", () => {
  for (const command of [
    "rm -rf node_modules",
    "rm -rf target",
    "rm -rf ./target",
    "rm -rf build dist",
    "rm -rf dist",
    "rm -f a.txt b.txt",
    "rm -rf src/generated",
    "rm -rf /home/u/proj/.cache",
    "rm -rf /tmp/scratch",
    "rm -rf /tmp/x",
    "git clean -fdx",
    "git status",
    "cargo build",
    "npm ci",
    "mkdir -p out",
    "cp a b",
    "mv old new",
    "cat Cargo.toml",
    "grep -r TODO src",
    "ls -la",
  ]) {
    assert.equal(immediate(command), true, `${command} -> ${level(command)}`);
  }
  // 任务矩阵点名单独断言。
  assert.equal(level("rm -rf node_modules"), "low");
  assert.equal(level("rm -rf /tmp/scratch"), "safe");
  // git clean 无显式路径时有界于仓库工作树 → low（可见、不打断）。
  assert.equal(level("git clean -fdx"), "low");
  // 条件破坏：chmod -R 指向 home 仍 catastrophic。
  assert.equal(level("chmod -R 777 ~"), "catastrophic");
});

// ── R2：三平台路径保护表 ─────────────────────────────────────────────

test("windows protection table (%USERPROFILE% equivalents, drive roots, devices, MSYS mounts)", () => {
  const win = WIN_CTX;
  assert.equal(level('rm -rf "C:\\Users\\Z\\.ssh"', win), "catastrophic");
  assert.equal(level('rm -rf "C:\\Users\\Z"', win), "catastrophic");
  assert.equal(level("rm -rf C:/Users/Z", win), "catastrophic");
  // Git Bash / MSYS 挂载形。
  assert.equal(level("rm -rf /c/Users/Z/.ssh", win), "catastrophic");
  assert.equal(level('rd /s /q "C:\\Users\\Z"', win), "catastrophic");
  assert.equal(level('del /f /q "%USERPROFILE%\\*"', win), "catastrophic");
  assert.equal(level("rm -rf C:/*", win), "catastrophic");
  assert.equal(level("rm -rf C:\\", win), "catastrophic");
  assert.equal(level("format C:", win), "catastrophic");
  assert.equal(level('rm -rf "C:\\Windows\\System32"', win), "catastrophic");
  assert.equal(level("dd of='\\\\.\\PhysicalDrive0'", win), "catastrophic");
  assert.equal(level('rm -rf "%USERPROFILE%\\.ssh"', win), "catastrophic");
  assert.equal(level('rm -rf "C:\\Users\\Z\\AppData"', win), "catastrophic");
  assert.equal(level('rm -rf "C:\\Program Files"', win), "catastrophic");
  // 工作目录内与用户 temp 内是日常操作。
  assert.equal(level('rm -rf "C:\\Users\\Z\\proj\\dist"', win), "low");
  assert.equal(level('rm -rf "C:\\Users\\Z\\AppData\\Local\\Temp\\cache"', win), "safe");
  // 凭据文件精确表。
  assert.equal(level('rm -f "C:\\Users\\Z\\.git-credentials"', win), "low");
});

test("macos protection table (Keychains recursive, /System, home dirs, case-insensitive)", () => {
  const mac = MAC_CTX;
  assert.equal(level("rm -rf ~/Library/Keychains", mac), "catastrophic");
  assert.equal(level("rm -rf ~/library/keychains", mac), "catastrophic"); // darwin 大小写不敏感
  assert.equal(level("rm -rf /System", mac), "catastrophic");
  assert.equal(level("rm -rf /Library", mac), "catastrophic");
  assert.equal(level("rm -rf /System/Library/x", mac), "catastrophic"); // /System 递归保护
  assert.equal(level("rm -rf ~/Documents", mac), "catastrophic");
  assert.equal(level("rm -rf ~/Documents/report.md", mac), "low");
  assert.equal(level("rm -rf /Applications/Safari.app", mac), "low"); // /Applications 精确不递归
  assert.equal(level("rm -rf /Users/u/proj/build", mac), "low");
  assert.equal(level("rm -rf /private/tmp/x", mac), "safe");
});

test("linux table: /etc recursive, /home exact-only, credential files under home", () => {
  assert.equal(level("rm -rf /etc/cron.d"), "catastrophic"); // /etc 递归保护
  assert.equal(level("rm -rf /usr/local/bin/tool"), "catastrophic"); // /usr 递归保护
  assert.equal(level("rm -rf /home/u/proj"), "low"); // /home 不递归
  assert.equal(level("rm -rf ~/.kube/config"), "catastrophic"); // 凭据目录递归
  assert.equal(level("rm -rf ~/scratchpad"), "low");
});

// ── R1：assessment 形状与严重度合并 ──────────────────────────────────

test("assessment is total over garbage input and worst finding wins", () => {
  for (const command of ["", "   ", "'", "\\", ";;;", "&&", 'rm -rf "unterminated']) {
    assert.doesNotThrow(() => assess(command));
  }
  // Low finding 不得掩盖同一命令里的 Catastrophic。
  const assessment = assess("rm -rf target && rm -rf ~");
  assert.equal(assessment.level, "catastrophic");
  assert.ok(assessment.findings.length >= 2);
  // targets 是 finding 目标的去重投影；deny 文案要点名 offending target。
  assert.ok(assessment.targets.length > 0);
  const homeAssessment = assess("rm -rf ~");
  assert.ok(homeAssessment.targets.some((t) => t.includes("/home/u")));
});

// ── R5 接线点 2：熔断器 catastrophic 命中类（deny 级） ───────────────

// %TEMP% 在本机是 Windows 8.3 短名（C:\Users\ADMINI~1\...）：短名 workspace 会让相对
// 目标命中「8.3 长名无法静态验证」的反射门，R5 接线点断言测到的就是短名形态而不是
// catastrophic/confirm 分档语义。只展开已存在的 %TEMP%，避免对未创建目录调 realpath。
const WORKSPACE = join(realpathSync.native(tmpdir()), "acode-j1-target-risk-workspace");

function bashContext(command, extra = {}) {
  return { toolName: "Bash", input: { command }, ...extra };
}

test("breaker: catastrophic target registers as a deny-behavior hit", () => {
  const hit = evaluateBypassImmuneBreakers(bashContext("rm -rf ~"));
  assert.equal(hit?.ruleId, "breaker.bashTargetCatastrophic");
  assert.equal(hit?.behavior, "deny");
  assert.match(hit.reason, /never permitted/);

  const literal = evaluateBypassImmuneBreakers(bashContext(`rm -rf "${homedir()}"`));
  assert.equal(literal?.ruleId, "breaker.bashTargetCatastrophic");
  assert.equal(literal?.behavior, "deny");

  // 普通工作区删除不触发本类（yolo 照常直通）。
  assert.equal(evaluateBypassImmuneBreakers(bashContext("rm -rf ./build")), undefined);
  assert.equal(evaluateBypassImmuneBreakers(bashContext("ls -la")), undefined);
});

test("breaker: existing classes keep their ruleIds and ask semantics (only-tighten invariant)", () => {
  // 类 1：confirm 级目标风险不抢既有 ruleId（catastrophic 类排在最前，ask 类命中
  // 由既有三类先返回）。
  const dynamicDelete = evaluateBypassImmuneBreakers(bashContext('rm -rf "$BUILD_DIR"/'));
  assert.equal(dynamicDelete?.ruleId, "breaker.bashRootDelete");
  assert.equal(dynamicDelete?.behavior, undefined);

  // 类 3：敏感位置读照旧。
  const sensitive = evaluateBypassImmuneBreakers(bashContext("cat ~/.aws/credentials"));
  assert.equal(sensitive?.ruleId, "breaker.sensitiveRead");

  // 解析失败的删除文本仍走类 1 fail-closed（catastrophic 档需要路径确定性，弃权）。
  const huge = `rm -rf ${"x".repeat(20_000)}`;
  const hugeHit = evaluateBypassImmuneBreakers(bashContext(huge));
  assert.equal(hugeHit?.ruleId, "breaker.bashRootDelete");
});

// ── R5：PermissionService 收口（deny 压过 allow 与 ask） ─────────────

function makeService(extra = {}) {
  return new PermissionService({
    allowedTools: new Set(),
    disallowedTools: new Set(extra.disallowedTools ?? []),
    autoApproveHighRisk: extra.autoApproveHighRisk ?? false,
    allowMediumRiskInAutoMode: false,
  });
}

function permissionCtx(command, mode = "yolo") {
  return {
    toolName: "Bash",
    input: { command },
    riskLevel: "high",
    mode,
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
  };
}

test("service: catastrophic is denied in yolo — bypass-immune, no ask", () => {
  const decision = makeService().checkPermission(permissionCtx("rm -rf ~"));
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "breaker.bashTargetCatastrophic");
  assert.match(decision.reason, /never permitted/);
});

test("service: catastrophic overrides ask too (build mode never routes it to approval)", () => {
  const decision = makeService().checkPermission(permissionCtx("rm -rf ~", "build"));
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "breaker.bashTargetCatastrophic");
});

test("service: autoApproveHighRisk cannot auto-approve confirm-level commands (critical upgrade)", () => {
  const capability = {
    destructive: true,
    needsApproval: true,
    readOnly: false,
    riskLevel: "critical",
    sideEffectScope: "system",
    permission: { needsApproval: true, riskLevel: "critical", sideEffectScope: "system" },
  };
  // capability 层的 critical 映射独立成立：safe 命令 + critical capability 在
  // autoApproveHighRisk 下仍必 ask（反射门对 safe 命令直通，不干扰本断言）。
  const criticalAsk = makeService({ autoApproveHighRisk: true }).checkPermission(
    permissionCtx("ls -la", "build"),
    capability,
  );
  assert.equal(criticalAsk.decision, "ask");
  assert.equal(criticalAsk.ruleId, "mode.build.criticalRisk");

  // J1-2 之后 confirm 级命令的完整链路：首次调用被反射门 deny，携带有效
  // justification 后收敛到 ask——autoApproveHighRisk 在任何一步都变不成 allow。
  const service = makeService({ autoApproveHighRisk: true });
  const first = service.checkPermission(
    permissionCtx("cat paths.txt | xargs rm -rf", "build"),
    capability,
  );
  assert.equal(first.decision, "deny");
  assert.equal(first.ruleId, "gate.bashConfirmReflex.reflect");
  const justifiedCtx = {
    ...permissionCtx("cat paths.txt | xargs rm -rf", "build"),
    input: {
      command: "cat paths.txt | xargs rm -rf",
      justification: "The user asked to delete exactly the files listed in paths.txt here",
    },
  };
  const justified = service.checkPermission(justifiedCtx, capability);
  assert.equal(justified.decision, "ask");
});

test("service: deny decisions keep precedence and ask keeps its original ruleId", () => {
  // disallowedTools deny 先于熔断器（deny 分支不经过熔断器，不可能被放宽）。
  const denied = makeService({ disallowedTools: ["Bash"] }).checkPermission(
    permissionCtx("rm -rf ~"),
  );
  assert.equal(denied.decision, "deny");
  assert.equal(denied.ruleId, "rule.disallowedTools");

  // build 模式的既有 ask 不被 ask 级命中覆写 ruleId。
  const buildAsk = makeService().checkPermission(permissionCtx('rm -rf "$OUT"/', "build"));
  assert.equal(buildAsk.decision, "ask");
  assert.notEqual(buildAsk.ruleId, "breaker.bashRootDelete");

  // yolo 下普通命令照常直通。
  const allowed = makeService().checkPermission(permissionCtx("rm -rf ./build"));
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.ruleId, "mode.yolo");
});

// ── R5 接线点 1：bash.ts capability 合并（取更严者） ──────────────────

test("capability: confirm/catastrophic raise riskLevel to critical; readonly fast path only for safe", () => {
  const resolve = bashToolEntry.resolvePermissionCapability;
  const context = { workingDirectory: WORKSPACE, workspaceRoot: WORKSPACE };

  const catastrophic = resolve({ command: "rm -rf ~" }, context);
  assert.equal(catastrophic?.riskLevel, "critical");
  assert.equal(catastrophic?.permission?.riskLevel, "critical");
  assert.equal(catastrophic?.destructive, true);
  assert.equal(catastrophic?.needsApproval, true);
  assert.equal(catastrophic?.readOnly, false);

  const confirmLevel = resolve({ command: "cat paths.txt | xargs rm -rf" }, context);
  assert.equal(confirmLevel?.riskLevel, "critical");

  // low：回落 entry 默认（high+needsApproval），不产生运行时覆盖。
  assert.equal(resolve({ command: "rm -rf node_modules" }, context), undefined);

  // safe + 只读：readonly 快径保留。
  const readOnly = resolve({ command: "ls -la" }, context);
  assert.equal(readOnly?.readOnly, true);
  assert.equal(readOnly?.riskLevel, "low");
  assert.equal(readOnly?.needsApproval, false);
});

// ── R5 接线点 3：规则建议收窄 ────────────────────────────────────────

test("rule policy: confirm/catastrophic commands never earn wildcard prefix rules", () => {
  const context = { workingDirectory: WORKSPACE, workspaceRoot: WORKSPACE };
  const policy = resolveBashPermissionRulePolicy({ command: "find . -exec rm {} +" }, context);
  const suggestions = policy?.suggestedPermissionUpdates ?? [];
  assert.ok(suggestions.length > 0);
  for (const update of suggestions) {
    for (const rule of update.rules) {
      assert.equal(rule.ruleContent.includes("*"), false, `wildcard rule leaked: ${rule.ruleContent}`);
    }
  }

  // 回归守护：普通安全命令的稳定前缀规则不受影响。
  const normal = resolveBashPermissionRulePolicy({ command: "npm run build" }, context);
  const normalRules = (normal?.suggestedPermissionUpdates ?? []).flatMap((u) => u.rules);
  assert.ok(
    normalRules.some((rule) => rule.ruleContent === "npm run build:*"),
    `expected stable prefix rule, got ${JSON.stringify(normalRules)}`,
  );
});

// ── J1 独立评审修复：以下每条对应一个评审 finding ─────────────────────

test("(review F0) brace expansion cannot launder a protected target", () => {
  // `~/{.ssh,.gnupg}` 会被 shell 展开成两个真实目标，此前原样进词法比较 → low。
  assert.equal(level("find ~/{.ssh,.gnupg} -delete"), "catastrophic");
  assert.equal(level("rm -rf ~/{.ssh,.gnupg}"), "catastrophic");
  assert.equal(level("rm -rf ~/{.ssh,.gnupg}/{a,b}"), "catastrophic");
  assert.equal(level("shred ~/{.aws,.kube}/x"), "catastrophic");
  // 嵌套与序列形态同样展开。
  assert.equal(level("rm -rf ~/{.ssh,{.gnupg,.aws}}"), "catastrophic");
  assert.equal(level("rm -rf /etc/{passwd,shadow}"), "catastrophic");
  // Windows 形态（盘符 + 反斜杠）。
  assert.equal(level("rm -rf C:/Users/Z/{.ssh,.aws}", WIN_CTX), "catastrophic");
  // 工作区内的 brace 展开仍是有界破坏：不打断日常清理。
  assert.equal(immediate("rm -rf {dist,build}"), true);
  assert.equal(immediate("rimraf {dist,build}"), true);
  // bash 不展开的形态（单项、无逗号无序列）保持字面：`~/{.ssh}` 是一个名为
  // `{.ssh}` 的目录，不是凭据库——不为它编造 catastrophic。
  assert.equal(level("rm -rf ~/{.ssh}"), "low");
  assert.equal(level("find . -exec rm {} +"), "confirm");
  // 组合数超出静态枚举上限：足迹不可知 → confirm（fail-closed，不放行）。
  const wide = "rm -rf /tmp/{a,b,c,d,e,f,g,h,i,j,k}{a,b,c,d,e,f,g,h,i,j,k}{a,b,c,d,e,f,g,h,i,j,k}";
  assert.equal(atLeastConfirm(wide), true, level(wide));
});

test("(review F1) <drive>:/Users is exact-protected like /home and /Users", () => {
  // spec R2「刻意不递归：/home、/Users、C:/Users 只精确匹配」——盘符形态此前缺表。
  assert.equal(level("rm -rf C:/Users", WIN_CTX), "catastrophic");
  assert.equal(level("rm -rf C:\\Users", WIN_CTX), "catastrophic");
  assert.equal(level("cmd /c rd /s /q C:/Users", WIN_CTX), "catastrophic");
  // MSYS 挂载形同样命中（win32 上 /c/Users 就是 c:/Users）。
  assert.equal(level("rm -rf /c/Users", WIN_CTX), "catastrophic");
  // 非 win32 宿主上出现盘符形态也按 Windows 路径判（词法空间与平台无关）。
  assert.equal(level("rm -rf C:/Users"), "catastrophic");
  // 刻意不递归：用户项目住在它下面，正常工作不能被拦死。
  assert.equal(level("rm -rf C:/Users/Z/proj/dist", WIN_CTX), "low");
  assert.equal(level("rm -rf /home/u/other-project"), "low");
});

test("(review F2) the \\\\?\\ extended-length prefix is stripped before the glob check", () => {
  // 前缀里的 `?` 是 Windows 命名空间标记，不是通配符：此前先落进 glob 分支被降级成
  // confirm（一次反射 + 25 字符论证即可放行），spec R2 要求剥前缀后按其余规则判。
  assert.equal(level("rm -rf \\\\?\\C:\\Windows", WIN_CTX), "catastrophic");
  assert.equal(level("rd /s /q \\\\?\\C:\\Windows", WIN_CTX), "catastrophic");
  assert.equal(level("rm -rf \\\\?\\C:\\Users\\Z\\.ssh", WIN_CTX), "catastrophic");
  assert.equal(level("rm -rf \\\\?\\C:\\", WIN_CTX), "catastrophic");
  assert.equal(level("rm -rf //?/C:/Windows", WIN_CTX), "catastrophic");
  assert.equal(level("rm -rf \\\\?\\C:\\Windows\\Temp", WIN_CTX), "catastrophic");
  // 剥前缀不改变工作区内日常操作的判定。
  assert.equal(level("rm -rf \\\\?\\C:\\Users\\Z\\proj\\dist", WIN_CTX), "low");
  // 设备命名空间 //./ 的 `.` 不是「当前目录」，仍然递归保护。
  assert.equal(level("rm -rf \\\\.\\PhysicalDrive0", WIN_CTX), "catastrophic");
});

test("(review F3) lexical fallback grades truncating redirect targets", () => {
  // 一层括号/一个 if 曾把绝对 deny 变成 safe（`>` 只被当段边界丢弃）。
  assert.equal(level("(echo x > /etc/passwd)"), "catastrophic");
  assert.equal(level("if true; then echo x > /etc/passwd; fi"), "catastrophic");
  assert.equal(level("(echo x 2> /etc/passwd)"), "catastrophic");
  assert.equal(level("(echo x >| /etc/passwd)"), "catastrophic");
  assert.equal(level("(echo x &> /etc/passwd)"), "catastrophic");
  // `>& <文件名>` 在 bash 里等价于 `>word 2>&1`：同样截断（AST 与 fallback 同口径）。
  assert.equal(level("echo x >& /etc/passwd"), "catastrophic");
  assert.equal(level("(echo x >& /etc/passwd)"), "catastrophic");
  assert.equal(level("while true; do echo x >& /etc/passwd; done"), "catastrophic");
  // 非破坏形态不被误伤：追加、fd dup/关闭、安全汇、工作区内文件。
  assert.equal(level("(echo x >> /etc/passwd)"), "safe");
  assert.equal(level("echo x >> /etc/passwd"), "safe");
  assert.equal(level("(echo x >&2)"), "safe");
  assert.equal(level("echo x >&2"), "safe");
  assert.equal(level("echo x >&-"), "safe");
  assert.equal(level("(echo x > /dev/null)"), "safe");
  assert.equal(level("(echo x > out.txt)"), "safe");
  assert.equal(level("(rm -rf ~ > /dev/null)"), "catastrophic");
});

test("(review F4) trusted Windows environment variables expand onto the protection table", () => {
  const win = WIN_CTX;
  // plan J1-1「需补 Windows（… C:\Windows …）」：cmd/PS 拼写不展开就等于没有保护。
  assert.equal(level("rd /s /q %WINDIR%", win), "catastrophic");
  assert.equal(level("rd /s /q %SystemRoot%", win), "catastrophic");
  assert.equal(level("cmd /c rd /s /q %WINDIR%", win), "catastrophic");
  assert.equal(level("rm -rf %WINDIR%/System32", win), "catastrophic");
  assert.equal(level("rm -rf %APPDATA%", win), "catastrophic");
  assert.equal(level("rm -rf %LOCALAPPDATA%", win), "catastrophic");
  assert.equal(level("rm -rf %LOCALAPPDATA%/Microsoft/Credentials", win), "catastrophic");
  assert.equal(level("rm -rf %ProgramData%", win), "catastrophic");
  assert.equal(level('rm -rf "%ProgramFiles%"', win), "catastrophic");
  assert.equal(level("rm -rf %SystemDrive%", win), "catastrophic");
  // PowerShell 拼写。
  assert.equal(
    level("powershell -Command Remove-Item -Recurse -Force $env:SystemRoot", win),
    "catastrophic",
  );
  assert.equal(
    level("pwsh -Command Remove-Item -Recurse $env:USERPROFILE/.ssh", win),
    "catastrophic",
  );
  // 对照：既有 %USERPROFILE% 形态不受影响。
  assert.equal(level("rm -rf %USERPROFILE%", win), "catastrophic");
  // 不在受信表内的变量仍未解析（confirm），不被猜值。
  assert.equal(level("rm -rf %SOME_UNKNOWN_DIR%", win), "confirm");
  // 刻意不展开 %TEMP%/%TMP%：展开会把既有 confirm 放宽成 temp 豁免。
  assert.equal(level("rm -rf %TEMP%", win), "confirm");
  // 工作区内的 PS/cmd 清理照旧不打断。
  assert.equal(level("rd /s /q %CD%\\dist", win), "confirm");
});

test("(review F5) globs that can only land on protected entries are catastrophic", () => {
  // 递归保护区内的文件名位 glob：任何展开结果都在保护区内，「足迹未知」不成立。
  assert.equal(level("rm -rf /etc/pass?"), "catastrophic");
  assert.equal(level("rm -rf /etc/passw*"), "catastrophic");
  assert.equal(level("rm -f /usr/li*"), "catastrophic");
  assert.equal(level("rm -rf /var/lib/mysql/da*"), "catastrophic");
  assert.equal(level("rm -rf ~/.ssh/id_*"), "catastrophic");
  assert.equal(level("rm -rf /System/Library/Fram*"), "catastrophic");
  // 必然命中 home 下受保护条目的 glob（.ssh/.gnupg/.config、Documents/Desktop/Downloads）。
  assert.equal(level("rm -rf ~/.*"), "catastrophic");
  assert.equal(level("find ~/.* -delete"), "catastrophic");
  assert.equal(level("rm -rf ~/Doc*"), "catastrophic");
  assert.equal(level("rm -rf ~/Dow*"), "catastrophic");
  assert.equal(level("rm -rf ~/**"), "catastrophic");
  assert.equal(level("rm -rf /b*"), "catastrophic");
  // 大小写敏感性跟随宿主：linux 上 `[a-z]*` 证明不可能命中任何受保护条目
  // （它们都以 `.` 或大写字母开头），Windows/macOS 上则命中 Documents。
  assert.equal(level("rm -rf ~/[a-z]*"), "confirm");
  assert.equal(level("rm -rf ~/[a-z]*", WIN_CTX), "catastrophic");
  assert.equal(level("rm -rf ~/[a-z]*", MAC_CTX), "catastrophic");
  // 既有语义不变：cwd/temp 内的文件名位 glob 是 low，通配目录段保守 confirm。
  assert.equal(level("rm -f build-2026-*.json"), "low");
  assert.equal(level("rm -f /tmp/acode-*.json"), "low");
  assert.equal(level("rm -rf ./*"), "low");
  assert.equal(level("rm -rf /home/u/*/node_modules"), "confirm");
  assert.equal(level("rm -rf /home/u/other/*"), "confirm");
});

test("(review F6) a literal HOME= argument is not a HOME reassignment", () => {
  // spec R4 声称已收窄到赋值形态、避免 `grep HOME= f` 误丢 readonly 快径，
  // 但实现曾按「argv 里任一 token 以 HOME= 开头」判定 → 只读命令被升级成 confirm。
  for (const command of [
    "grep HOME= f",
    "grep -rn HOME= .",
    'rg "HOME=" src',
    'git log -S "HOME="',
    "echo HOME=",
    "(grep HOME= f)",
    "if true; then grep HOME= f; fi",
    "cat README.md | grep HOME=",
  ]) {
    assert.equal(level(command), "safe", `${command} -> ${level(command)}`);
  }
  // readonly 快径因此保留（build 模式下不再被硬拒一轮）。
  const resolve = bashToolEntry.resolvePermissionCapability;
  const context = { workingDirectory: WORKSPACE, workspaceRoot: WORKSPACE };
  const readOnly = resolve({ command: "grep -rn HOME= ." }, context);
  assert.equal(readOnly?.readOnly, true);
  assert.equal(readOnly?.riskLevel, "low");
  assert.equal(readOnly?.needsApproval, false);
  // 端到端（真实 capability + PermissionService）：只读 grep 回到 allow(mode.build.readOnly)，
  // 而真实重赋值（赋值型内建）仍然进 J1-2 反射门。
  const service = makeService();
  const capabilityFor = (command) => {
    const runtime = resolve({ command }, context);
    return {
      ...bashToolEntry.metadata,
      ...runtime,
      permission: { ...bashToolEntry.permission, ...runtime?.permission },
    };
  };
  const buildCtx = (command) => ({
    toolName: "Bash",
    input: { command },
    riskLevel: bashToolEntry.metadata.riskLevel,
    mode: "build",
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
  });
  const grepDecision = service.checkPermission(
    buildCtx("grep -rn HOME= ."),
    capabilityFor("grep -rn HOME= ."),
  );
  assert.equal(grepDecision.decision, "allow");
  assert.equal(grepDecision.ruleId, "mode.build.readOnly");
  const exportDecision = service.checkPermission(
    buildCtx("export HOME=/tmp"),
    capabilityFor("export HOME=/tmp"),
  );
  assert.equal(exportDecision.decision, "deny");
  assert.equal(exportDecision.ruleId, "gate.bashConfirmReflex.reflect");
  // recall 不减：真实重赋值形态仍然全部覆盖（前导赋值、赋值型内建、wrapper 之下、
  // 内联脚本、以及 AST 不可用时的词法 fallback）。
  assert.equal(level("HOME=/tmp rm -rf ~"), "catastrophic");
  assert.equal(level("env HOME=/tmp rm -rf ~/.ssh"), "catastrophic");
  assert.equal(level("sudo env HOME=/tmp rm -rf ~"), "catastrophic");
  assert.equal(level("export HOME=/tmp"), "confirm");
  assert.equal(level("(HOME=/tmp rm -rf ~)"), "catastrophic");
  assert.equal(level("bash -c 'HOME=/tmp rm -rf ~'"), "catastrophic");
  assert.ok(assess("HOME=/tmp rm -rf ~").findings.some((f) => /HOME/.test(f.reason)));
  assert.ok(assess("env HOME=/tmp true").findings.some((f) => /HOME/.test(f.reason)));
});

test("(review F8) JS package runners and rimraf are unpacked like any other delete path", () => {
  // ACode 跑在 JS monorepo 里：rimraf/npx 是最常见的递归删除形态，此前整条路径 safe。
  assert.equal(level("npx rimraf ~"), "catastrophic");
  assert.equal(level("bunx rimraf ~/.ssh"), "catastrophic");
  assert.equal(level("pnpm dlx rimraf ~"), "catastrophic");
  assert.equal(level("yarn rimraf /etc"), "catastrophic");
  assert.equal(level("npx rm -rf ~"), "catastrophic");
  assert.equal(level("pnpm exec rimraf /usr"), "catastrophic");
  assert.equal(level("rimraf ~"), "catastrophic");
  // rimraf 天生递归：工作区内记 low（与 `rm -rf dist` 同语义），不是无痕 safe。
  assert.equal(level("rimraf dist"), "low");
  assert.equal(level("pnpm exec rimraf dist"), "low");
  // 非删除语义的包管理器命令不被误伤。
  for (const command of [
    "npm run clean",
    "npm run build",
    "node script.js",
    "deno run x.ts",
    "bun test",
    "pnpm install",
    "npm rm -g typescript",
    "npx tsc --noEmit",
  ]) {
    assert.equal(immediate(command), true, `${command} -> ${level(command)}`);
  }
});
