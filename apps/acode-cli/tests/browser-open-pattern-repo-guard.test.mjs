// 仓库级守护测试（26R2 流程失败修复）：禁止 cmd/start shell-opener 形态的第四份出货副本。
//
// 背景：Windows 打开 URL/文件的 `cmd.exe /c start "" <url>` 写法是命令注入面（cmd.exe 按 `"`
// 切换引号态，内嵌裸双引号即可逃逸执行后续命令）。该模式已在三处修复——
// bootstrap/src/app/platform-open-port.ts（H1，2026-10-04）、adapters/src/auth/browser.ts
// （R2-01，2026-10-26）、scripts/acode-distribution/runner.mjs（第三份出货副本，本轮）。
// 上一轮 review 的头号流程批评是「同一漏洞模式的修复没有全仓扫描同类副本」，导致第三份出货
// 副本在「扫描归零」宣称下幸存。本测试把该不变量机械化：全仓源码扫描，任何 spawn/execFile/exec
// 的 `cmd`+`start` 组合、或 `cmd.exe /c start` shell 字符串都令 CI 转红，使第四份副本无法落地。
//
// 关键设计——用 AST 而非文本扫描，天然不误伤根因注释：browser.ts / runner.mjs /
// platform-open-port.ts / browser-open-command-injection.test.ts / tooling-micro-additions.test.mjs
// 的根因注释**逐字引用**了旧写法（`cmd.exe /c start`、`spawn("cmd", ["/c","start","",url])`）
// 说明修复依据。这些是注释——在 TypeScript AST 里是 trivia，从不成为节点，故不参与匹配。
// 正则字面量（如 `/"cmd"|'cmd'/`）也被正确解析为单个节点而非散碎引号，不会像文本状态机那样错位。
// 只匹配**真实 call 形态**（spawn 家族 + cmd 字面量 executable + start 参数）与字符串/模板字面量
// 里的 shell 片段。auth-browser-opener.md 是 .md（不在扫描扩展名内），天然排除。
//
// 本文件自身含违规字符串（作真负例的合成 fixture，用 ts.createSourceFile 从源码字符串构造，
// 不是本文件的 AST 节点字面量——但源码里确实逐字写了违规形态），故扫描时按 basename 排除自己。

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const GUARD_TEST_BASENAME = "browser-open-pattern-repo-guard.test.mjs";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCAN_ROOTS = ["scripts", "packages", "apps"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".cjs", ".jsx"];
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  ".git",
  ".turbo",
  "win-unpacked",
]);

// spawn 家族：所有可能以 cmd 为 executable 启动子进程 / 执行 shell 字符串的入口。
const SPAWN_CALLEE_NAMES = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "exec",
  "execSync",
]);

// 形态 B 的 shell 字符串特征：`cmd /c start` / `cmd.exe /k start`（shell 字符串直传给 exec*，
// 含模板字面量形态）。要求 cmd 与 start 之间有 `/c` 或 `/k` 开关——这是 shell-opener 的特征，
// 普通 `cmd start` 文案（如 i18n「cmd start 漏洞写法」）不匹配，收窄误报面。
const SHELL_STRING_PATTERN = /\bcmd(?:\.exe)?\s+\/[ck]\s+start\b/i;

// 便宜预过滤：只解析同时含 `cmd` 与 `start`（大小写不敏感）的文件，避免 AST 解析全部 ~5000
// 源码文件（全量 walk 已近 3s，AST 解析全量会到分钟级）。违规形态必然同时含这两个词。
const PREFILTER = /cmd/i;
const PREFILTER_START = /start/i;

/** 取 call expression 的 callee 末段标识符名（`spawn` / `child_process.spawn` / `cp.execSync`）。 */
function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** 提取一个字符串/模板字面量节点的「文本内容」（模板取各无替换片段拼接，足够匹配 shell 特征）。 */
function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) text += span.literal.text;
    return text;
  }
  return null;
}

/**
 * 用 AST 检测一段源码里的 cmd/start shell-opener 违规形态。
 * 返回命中的形态名数组（"spawn-cmd-start" / "cmd-shell-string"）。注释是 trivia，不参与匹配。
 */
function detectCmdStartViolations(source, fileName = "input.ts") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits = new Set();
  function visit(node) {
    // 形态 A：spawn 家族 call，第一参数是 cmd/cmd.exe 字面量，其余参数（含数组元素）出现 "start"。
    if (ts.isCallExpression(node) && SPAWN_CALLEE_NAMES.has(calleeName(node.expression))) {
      const [first, ...rest] = node.arguments;
      const firstText = first ? literalText(first) : null;
      const firstIsCmd = firstText !== null && /^cmd(?:\.exe)?$/i.test(firstText.trim());
      if (firstIsCmd) {
        const restLiterals = [];
        for (const arg of rest) {
          if (ts.isArrayLiteralExpression(arg)) {
            for (const element of arg.elements) {
              const text = literalText(element);
              if (text !== null) restLiterals.push(text);
            }
          } else {
            const text = literalText(arg);
            if (text !== null) restLiterals.push(text);
          }
        }
        if (restLiterals.some((text) => text.trim().toLowerCase() === "start")) {
          hits.add("spawn-cmd-start");
        }
      }
      // 形态 B（call 内）：任一字符串实参是 `cmd /c start ...` shell 字符串。
      for (const arg of node.arguments) {
        const text = literalText(arg);
        if (text !== null && SHELL_STRING_PATTERN.test(text)) hits.add("cmd-shell-string");
      }
    }
    // 形态 B（call 外）：任何字符串/模板字面量含 shell 特征（如命令被赋给 const 再传出）。
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = literalText(node);
      if (text !== null && SHELL_STRING_PATTERN.test(text)) hits.add("cmd-shell-string");
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return [...hits];
}

async function* walkSourceFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      yield full;
    }
  }
}

const toPosix = (p) => p.split(sep).join("/");

test("守护自检（真负例）：合成的 cmd/start 违规形态被 AST 检出", () => {
  // 逐字复现 runner.mjs 出货的旧写法——守护必须在它再次落地时转红。
  assert.deepEqual(detectCmdStartViolations('spawn("cmd", ["/c", "start", "", url]);\n'), [
    "spawn-cmd-start",
  ]);

  // execSync 直传模板 shell 字符串形态。
  assert.ok(
    detectCmdStartViolations("execSync(`cmd.exe /c start \"\" ${url}`);\n").includes(
      "cmd-shell-string",
    ),
  );

  // exec 单引号 cmd + start 参数数组。
  assert.ok(detectCmdStartViolations("exec('cmd', ['/c', 'start', target]);\n").includes("spawn-cmd-start"));

  // execFile 带 .exe 后缀 + /k 开关。
  assert.ok(
    detectCmdStartViolations('execFile("cmd.exe", ["/k", "start", "", href]);\n').includes(
      "spawn-cmd-start",
    ),
  );

  // 命令被赋给 const 再传出（call 外字符串字面量）仍被形态 B 检出。
  assert.ok(detectCmdStartViolations('const c = "cmd /c start \\"\\" " + url;\nexec(c);\n').includes("cmd-shell-string"));
});

test("守护自检（无假阳）：explorer.exe 直传、根因注释、launchctl start、regex 字面量均不误报", () => {
  // 正确修复形态：非 shell 的 explorer.exe 直传。
  const fixed =
    'const command = process.platform === "win32" ? "explorer.exe" : "xdg-open";\n' +
    'const args = [url];\n' +
    'spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });\n';
  assert.deepEqual(detectCmdStartViolations(fixed), []);

  // 根因注释逐字引用旧写法——注释是 trivia，AST 里不成节点，不得匹配。
  const commentOnly =
    '// 原写法 `spawn("cmd", ["/c","start","",url])` 中，cmd.exe 按引号态逃逸。\n' +
    "/* 块注释也引用 cmd.exe /c start \"\" target */\n" +
    'const command = "explorer.exe";\n';
  assert.deepEqual(detectCmdStartViolations(commentOnly), []);

  // launchctl start：executable 非 cmd，start 是合法子命令，不得误报。
  assert.deepEqual(detectCmdStartViolations('await executor.run("launchctl", ["start", descriptor.name]);\n'), []);

  // 检测器源码里的 regex 字面量（含 cmd 但非 call 形态、非字符串字面量）不得自匹配。
  const regexLiteral = String.raw`const re = /executable:\s*["']cmd(?:\.exe)?["']/;` + "\n";
  assert.deepEqual(detectCmdStartViolations(regexLiteral), []);

  // i18n/文案里的 "cmd start"（无 /c 开关）不得误报。
  assert.deepEqual(detectCmdStartViolations('const msg = "cmd start 漏洞写法";\n'), []);
});

test("全仓扫描：scripts/packages/apps 源码无 cmd/start shell-opener 违规（第四份副本不可能落地）", async () => {
  const violations = [];
  let scanned = 0;
  let parsed = 0;
  for (const root of SCAN_ROOTS) {
    for await (const file of walkSourceFiles(join(REPO_ROOT, root))) {
      const base = file.split(sep).pop() ?? "";
      // 排除本守护文件自身（含合成违规字符串字面量）。
      if (base === GUARD_TEST_BASENAME) continue;
      scanned += 1;
      const source = await readFile(file, "utf8");
      // 便宜预过滤：违规形态必然同时含 cmd 与 start，二者缺一即跳过（不解析）。
      if (!PREFILTER.test(source) || !PREFILTER_START.test(source)) continue;
      parsed += 1;
      const hits = detectCmdStartViolations(source, toPosix(file));
      if (hits.length > 0) {
        violations.push(`${toPosix(relative(REPO_ROOT, file))}: ${hits.join(", ")}`);
      }
    }
  }
  // 自检：确实扫描/解析了足量文件（防止扫描器静默失效导致假绿）。
  assert.ok(scanned > 500, `扫描文件数异常偏少（${scanned}），扫描器可能失效`);
  assert.ok(parsed > 10, `预过滤后解析文件数异常偏少（${parsed}），预过滤可能过窄`);
  assert.deepEqual(
    violations,
    [],
    `发现 cmd/start shell-opener 违规（命令注入面）：\n${violations.join("\n")}\n` +
      "修复：win32 改用 explorer.exe <url> 直传（非 shell，argv 经 CreateProcess），" +
      "见 adapters/src/auth/browser.ts 与 auth-browser-opener.md。",
  );
});
