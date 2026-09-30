import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * J1 修复轮 2/3：对抗复审闭合测试（bash 目标 blast-radius 分级层）。
 *
 * 每个测试节对应一条对抗复审 finding（编号沿用复审报告；修复轮 3 使用 F-x 编号），
 * 同时给「绕过闭合」与「误报不回归」两面。规格条款见
 * apps/acode-cli/specs/bash-target-blast-radius.md 的 R2/R3/R4/R6 对应条目
 * （spec-first：每条修复先落 spec 再改实现）。
 */

const { assessBashCommandTargetRisk } = await import(
  "../packages/core/src/tool/handlers/bash-target-risk/index.ts"
);

// ── 固定上下文（与既有验收测试同一组确定性路径） ─────────────────────

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

function level(command, context = LINUX_CTX) {
  return assessBashCommandTargetRisk(command, context).level;
}
function atLeastConfirm(command, context = LINUX_CTX) {
  const result = level(command, context);
  return result === "confirm" || result === "catastrophic";
}
function expectLevels(cases, context) {
  for (const [command, want] of cases) {
    assert.equal(level(command, context), want, `${command} -> ${level(command, context)}`);
  }
}

// ── HIGH-1：cd 族 cwd 跟踪（spec R4「cwd 段级跟踪」） ─────────────────

test("(HIGH-1) cd/pushd/env -C/sudo --chdir rebase subsequent relative targets", () => {
  expectLevels(
    [
      ["cd ~ && rm -rf .ssh", "catastrophic"],
      ["cd / && rm -rf etc", "catastrophic"],
      ["cd /etc && rm -rf passwd", "catastrophic"],
      ["(cd ~; rm -rf .ssh)", "catastrophic"],
      ["sh -c 'cd ~ && rm -rf .ssh'", "catastrophic"],
      ["env -C ~ rm -rf .ssh", "catastrophic"],
      ["env --chdir=/etc rm -rf passwd", "catastrophic"],
      ["sudo --chdir /home/u rm -rf .ssh", "catastrophic"],
      ["cd ~/.ssh && rm -rf *", "catastrophic"],
      ["pushd ~; rm -rf .gnupg", "catastrophic"],
      ["cd ~ && shred .ssh/id_rsa", "catastrophic"],
    ],
    LINUX_CTX,
  );
});

test("(HIGH-1) unresolvable cwd changes fail closed for relative targets only", () => {
  expectLevels(
    [
      ["cd $X && rm -rf .ssh", "confirm"],
      ["cd $(pick-dir) && rm -rf .ssh", "confirm"],
      ["cd - && rm -rf .ssh", "confirm"],
      ["popd && rm -rf .ssh", "confirm"],
      ["pushd && rm -rf .ssh", "confirm"],
    ],
    LINUX_CTX,
  );
  // 绝对目标不受 cwd 跟踪影响：落点与 cwd 无关。
  assert.equal(level("cd $X && rm -rf /etc", LINUX_CTX), "catastrophic");
});

test("(HIGH-1) subshell boundaries restore cwd: no false catastrophic outside parens", () => {
  // 子壳内的 cd 不传播回外层（bash 语义）——外层相对目标仍按原 cwd 分级。
  assert.equal(level("(cd ~ && make); rm -rf node_modules", LINUX_CTX), "low");
  assert.equal(level("(cd /etc); rm -rf logs", LINUX_CTX), "low");
  // 管道段从管道起点分叉：cd 不跨 `|` 传播；管道喂 rm 的既有 confirm 规则照旧。
  assert.equal(level("cd ~; ls | rm -rf .ssh", LINUX_CTX), "catastrophic");
  assert.equal(atLeastConfirm("cd ~ | rm -rf .ssh", LINUX_CTX), true);
});

test("(HIGH-1) no regression: ordinary cd flows stay bounded (low/safe)", () => {
  expectLevels(
    [
      ["cd dist && rm -rf *", "low"],
      ["cd /tmp && rm -rf cache", "safe"],
      ["cd ~/projects/x && rm -rf build", "low"],
      ["cd node_modules && rm -rf .bin", "low"],
      ["cd /home/u/proj && rm -rf .cache", "low"],
    ],
    LINUX_CTX,
  );
});

// ── HIGH-2：brace 备选项内引号（spec R3「候选剥引号」） ───────────────

test("(HIGH-2) quoted brace alternatives still hit the protection tables", () => {
  expectLevels(
    [
      ['rm -rf ~/{".ssh",x}', "catastrophic"],
      ['find ~/{".ssh",x} -delete', "catastrophic"],
      ['shred -u ~/{".gnupg",x}', "catastrophic"],
      ["rm -rf ~/{'.ssh',x}", "catastrophic"],
      ['rm -rf ~/{".ssh",".gnupg"}', "catastrophic"],
      ['rm -rf /etc/{passwd,"shadow"}', "catastrophic"],
    ],
    LINUX_CTX,
  );
});

test("(HIGH-2) no regression: existing brace semantics unchanged", () => {
  // 嵌套/序列/超限/{a} 字面语义不变；cwd 内 brace 清理不打断。
  expectLevels(
    [
      ["rm -rf ~/{.ssh,{.gnupg,.aws}}", "catastrophic"],
      ["rm -rf /etc/{passwd,shadow}", "catastrophic"],
      ["rm -rf ~/{.ssh}", "low"],
      ["rm -rf {dist,build}", "low"],
      ["rimraf {dist,build}", "low"],
      ["rm -rf ~/{1..128}", "low"],
    ],
    LINUX_CTX,
  );
  assert.equal(
    atLeastConfirm(
      "rm -rf /tmp/{a,b,c,d,e,f,g,h,i,j,k}{a,b,c,d,e,f,g,h,i,j,k}{a,b,c,d,e,f,g,h,i,j,k}",
    ),
    true,
  );
});

// ── HIGH-3：Windows 尾点/尾空格组件规范化（spec R3「Win32 尾点/尾空格」） ──

test("(HIGH-3) Win32 trailing dots/spaces are stripped per component", () => {
  expectLevels(
    [
      ["rm -rf C:\\WINDOWS.", "catastrophic"],
      ["rm -rf C:\\WINDOWS.\\System32", "catastrophic"],
      ['rm -rf "C:\\WINDOWS \\System32"', "catastrophic"],
      ["rm -rf C:\\Users\\Z\\.ssh.", "catastrophic"],
      ['rd /s /q "C:\\Program Files . "', "catastrophic"],
    ],
    WIN_CTX,
  );
});

test("(HIGH-3) no regression: extended namespace keeps literal names; relative paths keep semantics", () => {
  // \\?\ 扩展命名空间保留字面（dir. 不剥）。
  assert.equal(level("rm -rf \\\\?\\C:\\dir.\\file", WIN_CTX), "low");
  assert.equal(level("rm -rf \\\\?\\C:\\Users\\Z\\proj\\dist", WIN_CTX), "low");
  // 相对路径尾点按原相对语义归位（cwd 内不误升）。
  assert.equal(level("rm -rf dist.", WIN_CTX), "low");
  // POSIX 下尾点是合法文件名字符，不受影响。
  assert.equal(level("rm -rf dist.", LINUX_CTX), "low");
});

// ── HIGH-4：裸重定向语句（spec R4「裸重定向语句」） ───────────────────

test("(HIGH-4) wordless redirect statements are graded like their colon-prefixed twins", () => {
  expectLevels(
    [
      ["> /etc/passwd", "catastrophic"],
      ["> ~/.ssh/authorized_keys", "catastrophic"],
      ["> /etc/passwd 2>&1", "catastrophic"],
      ["2> /etc/passwd", "catastrophic"],
      ["&> /etc/passwd", "catastrophic"],
      [">| /etc/passwd", "catastrophic"],
      ["> /etc/shadow && echo done", "catastrophic"],
    ],
    LINUX_CTX,
  );
  assert.equal(level("> C:/Windows/win.ini", WIN_CTX), "catastrophic");
});

test("(HIGH-4) no regression: appends, fd dups and cwd writes stay safe", () => {
  expectLevels(
    [
      [">> /etc/passwd", "safe"],
      [">> ~/.ssh/authorized_keys", "safe"],
      [">&2", "safe"],
      [">f", "safe"],
      ["echo hi > out.txt", "safe"],
      ["cat > helper.sh <<'EOF'\nbody\nEOF", "safe"],
    ],
    LINUX_CTX,
  );
});

// ── HIGH-5：`//` 双斜杠根（spec R3「前导双斜杠」） ────────────────────

test("(HIGH-5) leading double slashes fold to the POSIX root", () => {
  expectLevels(
    [
      ["rm -rf //", "catastrophic"],
      ["rm -rf ///", "catastrophic"],
      ["rm -rf --no-preserve-root //", "catastrophic"],
      ["rm -rf //etc", "catastrophic"],
      ["shred //etc/shadow", "catastrophic"],
    ],
    LINUX_CTX,
  );
  // win32 保留 UNC 语义：孤立 `//` 无主机段 → confirm（不是 low 静默放行）。
  assert.equal(atLeastConfirm("rm -rf //", WIN_CTX), true);
});

test("(HIGH-5) no regression: single root and POSIX-folded UNC stay correct", () => {
  expectLevels(
    [
      ["rm -rf /", "catastrophic"],
      ["rm -rf ///home/u/proj/x", "low"],
      ["rm -rf //server/share", "low"],
    ],
    LINUX_CTX,
  );
  // win32 的 \\server\share UNC 与 MSYS 挂载形处理不变。
  assert.equal(atLeastConfirm("rm -rf \\\\server\\share", WIN_CTX), true);
  assert.equal(level("rm -rf /c/Users/Z/proj/dist", WIN_CTX), "low");
});

// ── HIGH-6：8.3 短名（spec R2「8.3 短名」） ───────────────────────────

test("(HIGH-6) 8.3 short names escalate on win32-shaped absolute paths", () => {
  // 封闭常量（值可静态推出且在精确保护表内）→ catastrophic。
  expectLevels(
    [
      ["rd /s /q C:\\PROGRA~1", "catastrophic"],
      ["rm -rf /c/PROGRA~1", "catastrophic"],
      ["rd /s /q C:\\PROGRA~2", "catastrophic"],
    ],
    WIN_CTX,
  );
  // 其余短名：别名→长名映射静态不可知 → 至少 confirm。
  assert.equal(atLeastConfirm("rd /s /q C:\\Users\\ZHUA~1\\.ssh", WIN_CTX), true);
  assert.equal(atLeastConfirm("rm -rf C:\\backup~1", WIN_CTX), true);
});

test("(HIGH-6) no regression: relative backup-style filenames are not short names", () => {
  expectLevels(
    [
      ["rm file~1.txt", "safe"],
      ["rm dist/bundle~2.js", "safe"],
      ["rm -rf build~12", "low"],
    ],
    WIN_CTX,
  );
  // 非 Windows 形态的绝对路径不适用（POSIX 文件名可含 ~）。
  assert.equal(level("rm -rf /home/u/proj/archive~1", LINUX_CTX), "low");
});

// ── HIGH-7：含未解析段的 `..` 逃逸（spec R3「未解析段绝不 normalize 掉」） ──

test("(HIGH-7) dot-dot consuming an unresolved segment is catastrophic regardless of the folded form", () => {
  expectLevels(
    [
      ["rm -rf $UNKNOWN/../etc", "catastrophic"],
      ["rm -rf $UNKNOWN/../../etc", "catastrophic"],
      ["find $UNKNOWN/../etc -delete", "catastrophic"],
      ["rm -rf ~/../$UNKNOWN/..", "catastrophic"],
      ["rm -rf x/$VAR/..", "catastrophic"],
    ],
    LINUX_CTX,
  );
});

test("(HIGH-7) no regression: resolvable dot-dot and plain unresolved targets unchanged", () => {
  expectLevels(
    [
      ["rm -rf $UNKNOWN/..", "catastrophic"],
      ["rm -rf ../sibling", "low"],
      ["rm -rf $PWD/dist", "confirm"],
      ["rm -rf $UNKNOWN", "confirm"],
      ["rm -rf $UNKNOWN/x/../y", "confirm"],
      ["rm -rf ~/../..", "catastrophic"],
      ["rm -rf ..", "catastrophic"],
    ],
    LINUX_CTX,
  );
});

// ── HIGH-8：截断等价动词 tee / sed -i（spec R4 破坏性动词表） ─────────

test("(HIGH-8) tee (no -a) and sed -i truncate their targets like `>` does", () => {
  expectLevels(
    [
      ["echo pwn | tee /etc/passwd", "catastrophic"],
      ["tee ~/.ssh/authorized_keys < k", "catastrophic"],
      ["sed -i 's/root/x/' /etc/passwd", "catastrophic"],
      ["sed -i.bak 's/root/x/' /etc/shadow", "catastrophic"],
      ["sed --in-place 's/root/x/' /etc/passwd", "catastrophic"],
      ["sed -i '' 's/root/x/' /etc/passwd", "catastrophic"],
      ["tee /etc/shadow < f", "catastrophic"],
    ],
    LINUX_CTX,
  );
  assert.equal(level("echo pwn | tee C:/Windows/win.ini", WIN_CTX), "catastrophic");
});

test("(HIGH-8) no regression: appends, stdout-only sed, cwd targets stay quiet", () => {
  expectLevels(
    [
      ["tee out.txt", "safe"],
      ["tee -a log.txt", "safe"],
      ["tee -ap log.txt", "safe"],
      ["cat x | tee -a /etc/passwd", "safe"],
      ["sed 's/x/y/' f.txt", "safe"],
      ["sed -n '1,200p' file.txt", "safe"],
      ["sed -i 's/a/b/' src/main.ts", "safe"],
      ["sed -i 's/a/b/' out.txt", "safe"],
    ],
    LINUX_CTX,
  );
});

// ── MEDIUM-1：动态命令名（spec R4「动态命令名 → 至少 confirm」） ──────

test("(MEDIUM-1) dynamic command names escalate to at least confirm", () => {
  // shell 实证 `rm$IFS-rf$IFS~` 与 `$(echo rm) -rf ~` 真实执行 rm -rf ~，
  // 而查表不中会静默放行（连反射门都到不了）。
  assert.equal(atLeastConfirm("rm$IFS-rf$IFS~", LINUX_CTX), true);
  assert.equal(atLeastConfirm("$(echo rm) -rf ~", LINUX_CTX), true);
  assert.equal(atLeastConfirm("`echo rm` -rf ~", LINUX_CTX), true);
  assert.equal(atLeastConfirm("$RM -rf ~", LINUX_CTX), true);
  assert.equal(atLeastConfirm("find . -exec $PROGRAM {} +", LINUX_CTX), true);
});

test("(MEDIUM-1) no regression: ordinary commands and argument-position substitutions untouched", () => {
  expectLevels(
    [
      ["ls -la", "safe"],
      ["git status", "safe"],
      ["cargo build", "safe"],
    ],
    LINUX_CTX,
  );
  // 参数位的 $() 不因此规则升级：目标侧已有 unresolved 规则处理（仍 confirm）。
  assert.equal(level("rm -rf $(cat list.txt)", LINUX_CTX), "confirm");
  assert.equal(level("echo $(date)", LINUX_CTX), "safe");
});

// ── MEDIUM-2：cp/mv 目标分级（spec R4 破坏性动词表） ─────────────────

test("(MEDIUM-2) cp destinations and mv sources/destinations are graded as overwrite targets", () => {
  expectLevels(
    [
      ["cp evil /etc/passwd", "catastrophic"],
      ["mv /etc/passwd /tmp/x", "catastrophic"],
      ["mv ~/.ssh/id_rsa /tmp/", "catastrophic"],
      ["cp evil /etc/shadow", "catastrophic"],
    ],
    LINUX_CTX,
  );
  assert.equal(level("cp evil C:/Windows/System32/drivers/etc/hosts", WIN_CTX), "catastrophic");
});

test("(MEDIUM-2) no regression: workspace-local copies/moves stay quiet; flags parsed", () => {
  expectLevels(
    [
      ["cp a.txt b.txt", "safe"],
      ["mv x y", "safe"],
      ["cp -r a b", "safe"],
      ["mv -f x y", "safe"],
      ["cp -- a b", "safe"],
      ["cp --preserve=all a b", "safe"],
      ["cp README.md ~/projects/x/", "low"],
      // temp 目录本体按「具体路径」记 low（写不毁 temp 本体，但留在风险日志里），
      // 与既有 `rm -rf /tmp` 语义一致；其下的具体路径才是 safe。
      ["cp a.txt /tmp/", "low"],
      ["cp a.txt /tmp/out.txt", "safe"],
    ],
    LINUX_CTX,
  );
});

// ── MEDIUM-3：超限 brace 序列 fail-closed（spec R3「超限序列不是字面」） ──

test("(MEDIUM-3) over-limit brace sequences fail closed to confirm, not literal", () => {
  assert.equal(level("rm -rf /tmp/x{1..200}", LINUX_CTX), "confirm");
  assert.equal(level("rm -rf ~/x{1..200}", LINUX_CTX), "confirm");
  assert.equal(atLeastConfirm("rm -rf /tmp/y{a..z}{a..z}", LINUX_CTX), true);
});

test("(MEDIUM-3) no regression: in-limit sequences still enumerate; {a} stays literal", () => {
  expectLevels(
    [
      ["rm -rf ~/{1..128}", "low"],
      ["rm -rf /tmp/x{1..5}", "safe"],
      ["rm -rf ~/{.ssh}", "low"],
    ],
    LINUX_CTX,
  );
  assert.equal(
    atLeastConfirm("rm -rf {a..k}{a..k}{a..k}", LINUX_CTX),
    true,
    "组合数超限仍 confirm",
  );
});

// ── MEDIUM-4：%HOMEPATH%/%HOMEDRIVE%（spec R3 受信变量表） ───────────

test("(MEDIUM-4) HOMEPATH/HOMEDRIVE are trusted and adjacent concat expands", () => {
  expectLevels(
    [
      ["rd /s /q %HOMEPATH%", "catastrophic"],
      ["rd /s /q %HOMEDRIVE%%HOMEPATH%", "catastrophic"],
      ["rd /s /q %HOMEPATH%\\.ssh", "catastrophic"],
      ["rm -rf %HOMEDRIVE%%HOMEPATH%\\.ssh", "catastrophic"],
      // 对照：%USERPROFILE% 既有判定不变。
      ["rd /s /q %USERPROFILE%", "catastrophic"],
    ],
    WIN_CTX,
  );
  // PowerShell 拼写同表（bash 里 `\.` 会剥成 `.`，这里用 `/` 作分隔符）。
  assert.equal(level("rm -rf $env:HOMEPATH/.ssh", WIN_CTX), "catastrophic");
  assert.equal(level("rm -rf $env:HOMEPATH", WIN_CTX), "catastrophic");
});

test("(MEDIUM-4) no regression: unknown vars and %TEMP% stay confirm", () => {
  expectLevels(
    [
      ["rm -rf %SOME_UNKNOWN_DIR%", "confirm"],
      ["rm -rf %TEMP%", "confirm"],
      ["rm -rf %TMP%", "confirm"],
    ],
    WIN_CTX,
  );
});

// ── LOW-13：git 全局旗标后定位子命令（spec R4「git 全局旗标跳过」） ───

test("(LOW-13) git -C <dir> clean grades like git clean -fdx <dir>", () => {
  assert.equal(level("git -C ~ clean -fdx", LINUX_CTX), "catastrophic");
  assert.equal(level("git clean -fdx ~", LINUX_CTX), "catastrophic");
  assert.equal(level("git -C /etc clean -fdx", LINUX_CTX), "catastrophic");
  assert.equal(atLeastConfirm("git -C $X clean -fdx", LINUX_CTX), true);
  // clean 的显式路径在 -C 目录下解析。
  assert.equal(level("git -C ~ clean -fdx .ssh", LINUX_CTX), "catastrophic");
});

test("(LOW-13) no regression: plain git clean and non-clean subcommands unchanged", () => {
  assert.equal(level("git clean -fdx", LINUX_CTX), "low");
  assert.equal(level("git -C ~/proj clean -fdx", LINUX_CTX), "low");
  assert.equal(level("git -C ~/proj status", LINUX_CTX), "safe");
  assert.equal(level("git status", LINUX_CTX), "safe");
  assert.equal(level("git log --oneline", LINUX_CTX), "safe");
});

// ── LOW-14：UNC 网络共享删除（spec R6「UNC/网络共享删除」） ───────────

test("(LOW-14) UNC shares and \\?\\UNC forms escalate to confirm on win32", () => {
  assert.equal(level("rm -rf \\\\server\\share", WIN_CTX), "confirm");
  assert.equal(level("rm -rf \\\\?\\UNC\\server\\share", WIN_CTX), "confirm");
  assert.equal(level("rm -rf \\\\server\\share\\data", WIN_CTX), "confirm");
  assert.equal(level("rm -rf \\\\", WIN_CTX), "confirm");
  // 设备命名空间与保护表命中仍优先（catastrophic 严于 confirm）。
  assert.equal(level("dd of='\\\\.\\PhysicalDrive0'", WIN_CTX), "catastrophic");
});

// ── LOW-15：受信 Windows 变量平台门（spec R3「平台门」） ──────────────

test("(LOW-15) trusted Windows vars only expand on win32 or Windows-shaped targets", () => {
  // linux 上 %WINDIR% 是合法字面文件名：不再 catastrophic 绝对 deny。
  assert.equal(level("rm -rf %WINDIR%", LINUX_CTX), "confirm");
  assert.equal(level("rd /s /q %WINDIR%", LINUX_CTX), "confirm");
  // Windows 形态目标（盘符/反斜杠）在非 win32 平台仍展开。
  assert.equal(level("rm -rf %WINDIR%\\System32", LINUX_CTX), "catastrophic");
  assert.equal(level("rm -rf %USERPROFILE%\\.ssh", LINUX_CTX), "catastrophic");
  // win32 平台行为不变。
  assert.equal(level("rd /s /q %WINDIR%", WIN_CTX), "catastrophic");
});

// ── LOW-16：全引号 tilde/brace（spec R3/R6「全引号降级」） ────────────

test("(LOW-16) fully quoted tilde/brace targets degrade catastrophic to confirm", () => {
  // bash 引号内不展开：这是字面相对路径，catastrophic（永久 deny 无申诉）代价过高。
  assert.equal(level('rm -rf "~"', LINUX_CTX), "confirm");
  assert.equal(level('rm -rf "~/.ssh"', LINUX_CTX), "confirm");
  assert.equal(level('rm -rf "~/{.ssh,.gnupg}"', LINUX_CTX), "confirm");
  assert.equal(level("rm -rf '~/.ssh'", LINUX_CTX), "confirm");
  // fallback 路径同口径（一层括号不改变降级）。
  assert.equal(level('(rm -rf "~/.ssh")', LINUX_CTX), "confirm");
});

test("(LOW-16) no regression: quoted non-expansion targets and unquoted forms keep their grades", () => {
  // 全引号但非 tilde/brace 形：照常分级（绝对路径仍 catastrophic）。
  assert.equal(level('rm -rf "$HOME"', LINUX_CTX), "catastrophic");
  assert.equal(level("rm -rf '/home/u'", LINUX_CTX), "catastrophic");
  assert.equal(level('rm -rf "C:\\Users\\Z\\.ssh"', WIN_CTX), "catastrophic");
  assert.equal(level('rm -rf "%USERPROFILE%\\.ssh"', WIN_CTX), "catastrophic");
  // 外层无引号：HIGH-2 候选剥引号路径不被本条打开。
  assert.equal(level('rm -rf ~/{".ssh",x}', LINUX_CTX), "catastrophic");
});

// ── LOW-17：递归深度守卫（spec R4「递归深度上限 4」） ─────────────────

test("(LOW-17) fifth nesting level hits the depth guard with confirm", () => {
  const nest = (n) => {
    let inner = "echo hi";
    for (let i = 0; i < n; i += 1) inner = `sh -c ${JSON.stringify(inner)}`;
    return inner;
  };
  // 守卫语义 depth > 4：第 5 层 payload 触发 confirm（spec 与实现一致的钉子）。
  assert.match(
    assessBashCommandTargetRisk(nest(5), LINUX_CTX).findings.map((f) => f.reason).join(" "),
    /too deep/,
  );
  assert.equal(level(nest(5), LINUX_CTX), "confirm");
  // 4 层以内正常评估（echo hi 无破坏 → safe）。
  assert.equal(level(nest(4), LINUX_CTX), "safe");
});

// ── LOW-18：shell 枚举含 csh/tcsh（spec R4 与实现对齐） ──────────────

test("(LOW-18) csh/tcsh inline payloads are recursively assessed like other shells", () => {
  assert.equal(level("csh -c 'rm -rf ~'", LINUX_CTX), "catastrophic");
  assert.equal(level("tcsh -c 'rm -rf /etc'", LINUX_CTX), "catastrophic");
  assert.equal(level("csh -c 'echo hi'", LINUX_CTX), "safe");
});

// ── F-1（修复轮 3）：fallback 控制词边界（spec R4「词法 fallback 控制词边界」） ──

test("(F-1) cd after shell control words is tracked by the lexical fallback", () => {
  // 修复前：then/do/{ 之后的 cd 拿不到段首标记，`cd ~; rm -rf .ssh` 被按工作区内
  // `.ssh` 定基判 low，端到端 yolo 静默 allow（真实执行删 ~/.ssh）。
  expectLevels(
    [
      ["if true; then cd ~; rm -rf .ssh; fi", "catastrophic"],
      ["while true; do cd ~; rm -rf .ssh; break; done", "catastrophic"],
      ["until false; do cd ~; rm -rf .ssh; done", "catastrophic"],
      ["{ cd ~; rm -rf .ssh; }", "catastrophic"],
      ["elif true; then cd ~; rm -rf .ssh; then :; fi", "catastrophic"],
      // 目标按新 cwd 归位：/etc/passwd，而不是 proj/passwd（修复前 low）。
      ["if true; then cd /etc; rm -rf passwd; fi", "catastrophic"],
      ["elif true; then cd /etc; rm -rf passwd; fi", "catastrophic"],
      // cd 直接跟在控制词后（中间无操作符）同样处于命令位。
      ["if cd ~ && rm -rf .ssh; then :; fi", "catastrophic"],
      // 内联脚本递归同口径。
      ["sh -c 'if true; then cd ~; rm -rf .ssh; fi'", "catastrophic"],
    ],
    LINUX_CTX,
  );
});

test("(F-1) no regression: subshell restore, pipe fork, quoted data and comments stay correct", () => {
  expectLevels(
    [
      // 复核已确认正确的既有形态不回归。
      ["case x in x) cd ~; rm -rf .ssh;; esac", "catastrophic"],
      ["(cd ~; rm -rf .ssh)", "catastrophic"],
      ["if true\nthen\ncd ~\nrm -rf .ssh\nfi", "catastrophic"],
      // 子壳括号按 parenDelta 保存/恢复：外层 cwd 不受组内 cd 影响。
      ["(cd ~ && make); rm -rf node_modules", "low"],
    ],
    LINUX_CTX,
  );
  // cd 不跨管道：confirm 来自「管道喂 rm」规则，不是 cwd 泄漏。
  assert.equal(level("cd ~ | rm x", LINUX_CTX), "confirm");
  // 引号内是数据：字符串里的控制词不产生边界副作用。
  assert.equal(level('for x in 1; do echo "rm -rf ~"; done', LINUX_CTX), "safe");
  // 命令位判定只在消费侧生效，不改写 tokenizer 段边界：find 的根扫描以操作符段
  // 边界截断，`-delete` 不因谓词值恰为控制词而落到段外被漏判（fail-open 防护）。
  assert.equal(level("find . -name then -delete", LINUX_CTX), "low");
  // 零 command 防护不误伤注释与纯赋值行。
  assert.equal(level("# rm -rf ~", LINUX_CTX), "safe");
  assert.equal(level("FOO=bar", LINUX_CTX), "safe");
});

// ── F-2（修复轮 3）：cp/mv 的 -t/--target-directory 目的提取（spec R4 破坏性动词表） ──

test("(F-2) cp/mv -t/--target-directory consume their value and grade dest/basename", () => {
  // 修复前 isFlagToken 只跳过 -t 不消费其值：/etc 被当操作数，「最后一个操作数=
  // 目的」不成立，`cp -t /etc passwd` 判 safe（真实执行覆写 /etc/passwd）。
  expectLevels(
    [
      ["cp -t /etc passwd", "catastrophic"],
      ["cp --target-directory=/etc passwd", "catastrophic"],
      ["cp -t/etc passwd", "catastrophic"],
      ["mv -t /etc passwd", "catastrophic"],
      // 目录之后仍可有旗标；拼接路径 dest/basename 进分级。
      ["cp -t /etc -r passwd", "catastrophic"],
    ],
    LINUX_CTX,
  );
  // 非保护目录：拼接路径定档（/tmp/out.txt → safe），目录本体 /tmp → low。
  assert.equal(level("cp -t /tmp out.txt", LINUX_CTX), "low");
});

test("(F-2) no regression: plain destinations and clustered flags keep their grades", () => {
  expectLevels(
    [
      ["cp a.txt /tmp/out.txt", "safe"],
      ["cp --preserve=all a b", "safe"],
      ["cp -- a b", "safe"],
      ["cp -r a b", "safe"],
    ],
    LINUX_CTX,
  );
});

// ── F-3（修复轮 3）：CDPATH 内联赋值（spec R4「CDPATH 内联赋值」） ─────────

test("(F-3) inline CDPATH assignment rebases cd onto the CDPATH candidate", () => {
  // 修复前按「相对当前目录」定基：`cd .ssh && rm -rf *` 判工作区内 low，
  // 真实 bash cd 命中 CDPATH → 清空的是凭据库。
  expectLevels(
    [
      ["CDPATH=/home/u cd .ssh && rm -rf *", "catastrophic"],
      ["env CDPATH=/home/u cd .ssh && rm -rf *", "catastrophic"],
      // 绝对目标不走 CDPATH：按绝对路径原语义。
      ["CDPATH=/home/u cd /etc && rm -rf passwd", "catastrophic"],
    ],
    LINUX_CTX,
  );
  // CDPATH 值不可静态解析 → cwd 记 unresolved，相对目标 fail-closed 至少 confirm。
  assert.equal(level("CDPATH=$X cd .ssh && rm -rf *", LINUX_CTX), "confirm");
  // 无破坏行为不升级。
  assert.equal(level("CDPATH=/home/u cd .ssh", LINUX_CTX), "safe");
});

test("(F-3) no regression: post-command CDPATH tokens are data; plain cd unchanged", () => {
  // `echo CDPATH=/x` 的 CDPATH= 是 echo 的数据参数，不作用于后续 cd。
  assert.equal(level("echo CDPATH=/home/u; cd .ssh && rm -rf *", LINUX_CTX), "low");
  assert.equal(level("cd .ssh && rm -rf *", LINUX_CTX), "low");
  expectLevels([["cd dist && rm -rf *", "low"]], LINUX_CTX);
});

// ── F-4（修复轮 3）：busybox/toybox wrapper 解包（spec R4 wrapper 表） ──────

test("(F-4) busybox/toybox applets are unpacked like any other wrapper payload", () => {
  // 修复前 name=busybox 不在破坏性表、也不在 wrapper 表：类 1 熔断与本层双盲区。
  expectLevels(
    [
      ["busybox rm -rf ~", "catastrophic"],
      ['busybox sh -c "rm -rf ~"', "catastrophic"],
      ["busybox tee /etc/passwd", "catastrophic"],
      ["toybox rm -rf ~", "catastrophic"],
      ["sudo busybox rm -rf ~", "catastrophic"],
    ],
    LINUX_CTX,
  );
  // 无 applet 形态：payload 不可见 → confirm（不崩、也不静默放行）。
  assert.equal(level("busybox --help", LINUX_CTX), "confirm");
  assert.equal(level("busybox", LINUX_CTX), "confirm");
});

// ── F-5（修复轮 3）：gsed 与 sed 同列（spec R4 破坏性动词表） ──────────────

test("(F-5) gsed grades like sed for in-place rewrites", () => {
  // macOS brew 的 GNU sed 别名：`gsed -i` 与 `sed -i` 是同一就地截断重写。
  assert.equal(level("gsed -i 's/x/y/' /etc/passwd", LINUX_CTX), "catastrophic");
  assert.equal(level("sed -i 's/x/y/' /etc/passwd", LINUX_CTX), "catastrophic");
  assert.equal(level("gsed 's/x/y/' f.txt", LINUX_CTX), "safe");
  assert.equal(level("gsed -i 's/a/b/' src/main.ts", LINUX_CTX), "safe");
});

// ── F-6a（修复轮 3）：cp/mv 源侧与目录放置语义（spec R4 破坏性动词表） ──────

test("(F-6a) cp sources are reads not writes; destinations use placement vs overwrite grading", () => {
  // cp 源不再按写目标分级（敏感读由既有类 3 熔断兜底，不在本层）：
  // `cp /etc/passwd /etc/passwd.bak` 修复前因源侧命中递归保护判 catastrophic。
  assert.equal(level("cp /etc/passwd /etc/passwd.bak", LINUX_CTX), "confirm");
  // 目录放置（受保护目录本体 / 尾斜杠）：放入一个文件不毁目录 → confirm。
  expectLevels(
    [
      ["cp a.txt ~", "confirm"],
      ["cp a.txt /etc", "confirm"],
      ["cp a.txt /etc/", "confirm"],
      ["mv a.txt /etc", "confirm"],
    ],
    LINUX_CTX,
  );
  // 文件覆写：关键系统文件与凭据库内路径保持 catastrophic。
  expectLevels(
    [
      ["cp evil /etc/passwd", "catastrophic"],
      ["cp evil /etc/shadow", "catastrophic"],
      ["cp evil ~/.ssh/authorized_keys", "catastrophic"],
      ["mv /etc/passwd /tmp/x", "catastrophic"],
      ["mv ~/.ssh/id_rsa /tmp/", "catastrophic"],
    ],
    LINUX_CTX,
  );
  assert.equal(level("cp evil C:/Windows/System32/drivers/etc/hosts", WIN_CTX), "catastrophic");
});

test("(F-6a) no regression: workspace-local copies/moves and mv source grading unchanged", () => {
  expectLevels(
    [
      ["cp a.txt b.txt", "safe"],
      ["mv x y", "safe"],
      ["cp -r a b", "safe"],
      ["mv -f x y", "safe"],
      ["cp README.md ~/projects/x/", "low"],
      ["cp a.txt /tmp/", "low"],
      ["cp a.txt /tmp/out.txt", "safe"],
      ["cp a.txt /home/u/other/x", "low"],
    ],
    LINUX_CTX,
  );
});

// ── F-6b（修复轮 3）：brace/引号部分包裹保守噪声（spec R6 登记，刻意不放宽） ──

test("(F-6b) partially quoted brace clusters stay catastrophic (registered conservative noise)", () => {
  // spec R6：引号处理的任何放宽都是 HIGH-2 的藏身处——维持保守分级并登记理由。
  expectLevels(
    [
      ['rm -rf ~/{".ssh",x}', "catastrophic"],
      ["rm -rf ~/{\".ssh',x}", "catastrophic"],
      ['rm -rf ~/{".ssh,x"}', "catastrophic"],
      ['rm -rf "~"/.ssh', "catastrophic"],
    ],
    LINUX_CTX,
  );
});

// ── F-7（修复轮 4）：词法 fallback 覆盖条件破坏动词（spec R4「条件破坏动词的目标
// ── 同样分级」）───────────────────────────────────────────────────────

test("(F-7) fallback grades cp/mv/sed -i/gsed/tee targets with the AST path's own verb logic", () => {
  // 修复前 assessRawText 只对既有破坏性动词表产出 finding：一层括号把
  // catastrophic 降成 safe（HIGH-4 同威胁族：子壳吞掉目标维度的破坏）。
  expectLevels(
    [
      ["(cp evil /etc/passwd)", "catastrophic"],
      ["(sed -i s/x/y/ /etc/passwd)", "catastrophic"],
      ["(gsed -i 's/x/y/' /etc/passwd)", "catastrophic"],
      ["(tee /etc/passwd)", "catastrophic"],
      ["(echo x | tee /etc/passwd)", "catastrophic"],
      ["if true; then cp evil /etc/passwd; fi", "catastrophic"],
      ["while true; do tee ~/.ssh/authorized_keys; break; done", "catastrophic"],
      ["(mv /etc/passwd /tmp/x)", "catastrophic"],
      // cp -t/--target-directory 形态与 AST 同一识别逻辑（共用函数）。
      ["(cp -t /etc passwd)", "catastrophic"],
      // 段内 cd 跟踪 + fallback 动词分级叠加：相对目标按新 cwd 归位。
      ["(cd /etc; tee passwd)", "catastrophic"],
    ],
    LINUX_CTX,
  );
});

test("(F-7) no regression: harmless literal forms inside parens stay quiet", () => {
  expectLevels(
    [
      ["(cp a.txt b.txt)", "safe"],
      ["(mv x y)", "safe"],
      ["(tee out.txt)", "safe"],
      ["(tee -a out.txt)", "safe"],
      ["(sed s/x/y/ f.txt)", "safe"],
      ["(gsed 's/x/y/' f.txt)", "safe"],
      ["(sed -i s/a/b/ src/main.ts)", "safe"],
      ["(cat file)", "safe"],
      ["(echo hi > out.txt)", "safe"],
    ],
    LINUX_CTX,
  );
});

test("(F-7) no regression: the AST path grades the same commands identically without parens", () => {
  // AST 路径行为零变化：同命令不带括号仍走 AST 主路径（共享函数纯提取，无语义改动）。
  expectLevels(
    [
      ["cp evil /etc/passwd", "catastrophic"],
      ["sed -i s/x/y/ /etc/passwd", "catastrophic"],
      ["gsed -i 's/x/y/' /etc/passwd", "catastrophic"],
      ["tee /etc/passwd", "catastrophic"],
      ["echo x | tee /etc/passwd", "catastrophic"],
      ["cp -t /etc passwd", "catastrophic"],
      ["cp a.txt b.txt", "safe"],
      ["tee out.txt", "safe"],
      ["sed s/x/y/ f.txt", "safe"],
    ],
    LINUX_CTX,
  );
});

test("(F-7) fail-closed: unresolved operands in fallback verb targets escalate to confirm", () => {
  // 切分含糊/未解析 `$` 按 unresolved 口径升级（recall 偏向：不放行）。
  expectLevels(
    [
      ["(cp evil $dest)", "confirm"],
      ["(sed -i s/x/y/ $target)", "confirm"],
    ],
    LINUX_CTX,
  );
});

// ── 综合回归：修复不得破坏既有日常形态 ────────────────────────────────

test("(sweep) routine work across all new rules stays quiet", () => {
  for (const command of [
    "rm -rf node_modules",
    "git clean -fdx",
    "cp a b",
    "mv old new",
    "tee out.txt",
    "sed -i 's/a/b/' src/main.ts",
    "cd dist && rm -rf *",
    "git -C . status",
    "npm ci",
    "ls -la",
  ]) {
    const result = level(command, LINUX_CTX);
    assert.ok(result === "safe" || result === "low", `${command} -> ${result}`);
  }
});
