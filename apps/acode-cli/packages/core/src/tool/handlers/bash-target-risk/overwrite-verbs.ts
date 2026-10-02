// 条件破坏动词（tee / sed -i / gsed / cp / mv）的目标操作数分级（对抗复核 F-7）。
// 规格见 apps/acode-cli/specs/bash-target-blast-radius.md R4「条件破坏动词的目标
// 同样分级」。
//
// 这些动词的目标语义各不相同（tee 的文件操作数被截断写、sed -i 就地重写输入文件、
// cp 只覆盖目的、mv 既删源又覆盖目的），此前分级逻辑只挂在 AST 主路径（assess.ts），
// 词法 fallback（subshell/if/while 形态）对它们不产出 finding——一层括号即把
// catastrophic 降成 safe。本文件把三套操作数提取/分级提取为**独立共享层**，AST 主路径
// 与词法 fallback 共同消费：禁止在任一侧复制第二套逻辑，避免两条路径再次漂移。
// 依赖只落在 grammar.ts（词汇表）与 paths.ts（分级唯一所有者），与 assess/fallback
// 无反向引用，不引入模块内循环依赖。

import { classifyDestructiveTargetToken, isFlagToken, pushFinding } from "./grammar.js";
import { classifyDestinationTarget } from "./paths.js";
import type { TargetRiskContext, TargetRiskFinding } from "./types.js";

/**
 * tee（对抗复审 HIGH-8）：非追加模式下每个文件操作数被截断写，与 `> file` 同一
 * 破坏行为。`-a`/`--append`（含短簇 `-ap`）是追加、操作数 `-` 是 stdout，都豁免。
 * args 是程序名之后的参数（AST 路径来自 invocation.argv、fallback 来自词法切分）。
 */
export function assessTee(
  args: readonly string[],
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
): void {
  let append = false;
  let endOfFlags = false;
  const files: string[] = [];
  for (const arg of args) {
    if (!endOfFlags) {
      if (arg === "--") {
        endOfFlags = true;
        continue;
      }
      if (isFlagToken(arg)) {
        if (arg === "--append" || /^-[a-z]*a/i.test(arg)) append = true;
        continue;
      }
    }
    files.push(arg);
  }
  if (append) return;
  for (const file of files) {
    if (file === "-") continue;
    pushFinding(findings, classifyDestructiveTargetToken(file, false, context, { recursive: false }));
  }
}

/**
 * sed（对抗复审 HIGH-8）：`-i`（含 `-i.bak`、`-i''` 剥引号后的 `-i`、
 * `--in-place[=.suffix]`）就地截断重写输入文件——按非递归截断写分级。无 `-i` 时
 * 只写 stdout，不分级。`-i` 后紧跟的空操作数是 BSD 后缀（`sed -i '' …`）不是目标。
 * args 是程序名之后的参数（`gsed` 与 `sed` 同列，对抗复核 F-5）。
 */
export function assessSed(
  args: readonly string[],
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
): void {
  let inPlace = false;
  let sawScriptFlag = false;
  let endOfFlags = false;
  const operands: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!endOfFlags) {
      if (arg === "--") {
        endOfFlags = true;
        continue;
      }
      if (isFlagToken(arg)) {
        if (arg === "-i" || /^-i[^-]/.test(arg) || /^--in-place/.test(arg)) inPlace = true;
        if (arg === "-e" || arg === "-f" || arg === "--expression" || arg === "--file") {
          sawScriptFlag = true;
          i += 1;
          continue;
        }
        if (arg.startsWith("--expression=") || arg.startsWith("--file=")) sawScriptFlag = true;
        continue;
      }
    }
    operands.push(arg);
  }
  if (!inPlace) return;
  if (operands[0] === "") operands.shift();
  // 第一个操作数是脚本（无 -e/-f 时），其余是输入文件。
  const files = sawScriptFlag ? operands : operands.slice(1);
  for (const file of files) {
    pushFinding(findings, classifyDestructiveTargetToken(file, false, context, { recursive: false }));
  }
}

/** cp/mv 的目的目录旗标：`-t <v>`、`--target-directory <v>`（对抗复核 F-2）。 */
const COPYMOVE_TARGET_DIRECTORY_FLAG = /^(?:--target-directory|-t)$/;
/** 短旗标簇以 t 结尾（`-ft`/`-it`…）：t 消费下一个参数作为目录值。 */
const COPYMOVE_TARGET_DIRECTORY_CLUSTER = /^-[a-zA-Z]*t$/;

/**
 * cp/mv（对抗复审 MEDIUM-2、F-2、F-6a）：cp 只分级**目的**操作数——源是读取不是
 * 破坏（敏感读由既有类 3 熔断兜底），`cp /etc/passwd /etc/passwd.bak` 不再因源侧
 * 命中递归保护被拦截；mv 既删**源**又覆盖**目的**——源保持按删除语义分级（搬走=
 * 从原位置移除）。目的按「目录放置 vs 文件覆写」分级（classifyDestinationTarget）。
 * `-t <v>`/`-t<v>`/`--target-directory[=<v>]`（F-2）的值是目的目录：目录本体 +
 * 拼接路径 dest/basename 一并进分级取严。旗标（-r/-f/--preserve 等）与 `--`
 * 分隔符正确跳过；操作数不足两个（缺源或目的）无从谈覆盖，不分级。
 * args 是程序名之后的参数（AST 路径与词法 fallback 共用，F-7）。
 */
export function assessCopyMove(
  programName: string,
  args: readonly string[],
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
): void {
  const operands: string[] = [];
  let targetDirectory: string | undefined;
  let endOfFlags = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!endOfFlags) {
      if (arg === "--") {
        endOfFlags = true;
        continue;
      }
      if (COPYMOVE_TARGET_DIRECTORY_FLAG.test(arg)) {
        targetDirectory = args[i + 1];
        i += 1;
        continue;
      }
      if (arg.startsWith("--target-directory=")) {
        targetDirectory = arg.slice("--target-directory=".length);
        continue;
      }
      if (arg.startsWith("-t") && arg.length > 2) {
        // `-t<v>` 粘连形态（`-t/etc`）：-t 后的剩余字符就是目录值。
        targetDirectory = arg.slice(2);
        continue;
      }
      if (COPYMOVE_TARGET_DIRECTORY_CLUSTER.test(arg)) {
        // 以 t 结尾的短旗标簇（`-ft`/`-it`，t 是最后一个旗标、值未粘连）：
        // t 消费下一个参数作为目录值。
        targetDirectory = args[i + 1];
        i += 1;
        continue;
      }
      if (isFlagToken(arg)) continue;
    }
    operands.push(arg);
  }
  if (targetDirectory !== undefined && targetDirectory.length > 0) {
    pushFinding(findings, classifyDestinationTarget(targetDirectory, context));
    for (const source of operands) {
      const base = copySourceBasename(source);
      if (base.length === 0) continue;
      pushFinding(
        findings,
        classifyDestinationTarget(
          targetDirectory.endsWith("/") ? `${targetDirectory}${base}` : `${targetDirectory}/${base}`,
          context,
        ),
      );
    }
    return;
  }
  if (operands.length < 2) return;
  if (programName === "cp") {
    pushFinding(findings, classifyDestinationTarget(operands[operands.length - 1]!, context));
    return;
  }
  for (const operand of operands.slice(0, -1)) {
    // mv 源：搬走=从原位置移除，按删除语义（非递归）分级。
    pushFinding(
      findings,
      classifyDestructiveTargetToken(operand, false, context, { recursive: false }),
    );
  }
  pushFinding(findings, classifyDestinationTarget(operands[operands.length - 1]!, context));
}

/** cp -t 的源 basename（拼接 dest/basename 用）；去尾部斜杠后取末段。 */
function copySourceBasename(source: string): string {
  const trimmed = source.replace(/[/\\]+$/, "");
  if (trimmed.length === 0) return "";
  const normalized = trimmed.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
