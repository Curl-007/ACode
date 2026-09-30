// bash 命令目标 blast-radius 评估器（J1-1）：入口与段级分派。
// 规格见 apps/acode-cli/specs/bash-target-blast-radius.md R4。
//
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-command-risk/src/lib.rs
// 的 assess / assess_segment，自撰 TypeScript 实现：jcode 自带 tokenizer，这里改为消费
// 仓库既有的 analyzeBashCommand（unbash AST），AST 看不到的形态由 fallback.ts 的词法
// 切分兜底。两处遵循同一产品语义：
//
// 1. 按 blast radius 分类而非命令名 denylist——问「这会毁掉什么、能否撤销」；
// 2. 硬性偏向 recall：解析含糊时升级而非放行（误报花一个确认回合，漏报花一个
//    home 目录）。
//
// 纯函数、无 IO：homedir/platform 由调用方经 TargetRiskContext 注入。
// 路径分级唯一所有者是 paths.ts；find 的 action 分派在 find-actions.ts；
// 外方言 shell 与命令替换在 payloads.ts；共享词汇表在 grammar.ts。
//
// cwd 段级跟踪（对抗复审 HIGH-1）：评估逐 invocation 进行，而 shell 的 cwd 是会话
// 状态——不跟踪 `cd` 就等于让所有相对目标以固定基准分级。跟踪状态经 CwdCursor
// 在顺序调用间传递、经 context.trackedCwd 在签名受限的递归（find -exec、外方言
// shell）中传递；子壳/管道边界按 bash 语义保存/恢复（见 assessBashCommandTargetRisk
// 与 assessText 的 pipelineBase 逻辑、fallback.ts 的括号栈）。

import {
  analyzeBashCommand,
  type BashCommandInvocation,
} from "../bash-command-parser.js";
import { assessFind } from "./find-actions.js";
import { assessRawText } from "./fallback.js";
import {
  BARE_DURATION_PATTERN,
  CONDITIONALLY_DESTRUCTIVE_FLAGS,
  classifyDestructiveTargetToken,
  createHomeAssignmentScanner,
  DestructiveTarget,
  extractDestructiveTargets,
  destructiveTargetValue,
  FOREIGN_SHELL_PROGRAMS,
  hasUnresolvedMarker,
  HOME_REASSIGN_REASON,
  isAlwaysRecursiveProgram,
  isCommandNameLookup,
  isDestructiveProgramName,
  isEnvSplitStringFlag,
  isFlagToken,
  isRecursiveFlag,
  isTruncatingRedirect,
  MAX_RECURSION_DEPTH,
  PIPE_FED_REASON_SUFFIX,
  programBasename,
  pushFinding,
  SHELL_PROGRAMS,
  UNKNOWN_BLAST_RADIUS_REASON_SUFFIX,
  WRAPPER_PROGRAMS,
  buildAssessment,
  wrapperFlagTakesValue,
  wrapperPayloadUnknown,
} from "./grammar.js";
import { assessForeignShellPayload, extractCommandSubstitutions } from "./payloads.js";
import {
  classifyTarget,
  initialTrackedCwd,
  isSafeWriteSink,
  resolveCdTargetWithCdpath,
  resolveCwdTargetLexical,
} from "./paths.js";
import { assessCopyMove, assessSed, assessTee } from "./overwrite-verbs.js";
import type {
  TargetRiskAssessment,
  TargetRiskContext,
  TargetRiskFinding,
  TrackedCwd,
} from "./types.js";

/**
 * 评估一条 bash 命令文本的目标 blast-radius。入口是全函数式的：任何输入（包括
 * 垃圾）都产出 assessment 而不是抛错。
 */
export function assessBashCommandTargetRisk(
  command: string,
  context: TargetRiskContext = {},
): TargetRiskAssessment {
  const findings: TargetRiskFinding[] = [];
  const analysis = analyzeBashCommand(command);
  const cursor: CwdCursor = { state: initialTrackedCwd(context) };
  // 管道段各在子壳中运行：每段从管道开始时的同一 cwd 分叉，段内 cd 不跨 `|` 传播。
  // 非管道边界（sequence/&&/||/段首）更新分叉基准。
  let pipelineBase = cursor.state;

  for (const invocation of analysis.commands) {
    if (invocation.operatorBefore === "|" || invocation.operatorBefore === "|&") {
      cursor.state = pipelineBase;
    } else {
      pipelineBase = cursor.state;
    }
    assessInvocation(invocation, context, findings, 0, cursor);
  }
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax || parserSwallowedCommandText(command, analysis)) {
    // AST 看不到的形态（subshell/if/while/case、解析失败、超长文本）：词法
    // fallback 兜底——拦不住解析器覆盖不到的危险形态就等于没有这一层。
    assessRawText(command, context, findings, cursor);
  }

  return buildAssessment(findings);
}

/**
 * 解析器静默吞掉整段文本的 fail-open 防护（对抗复核 F-1 附带发现）：unbash 对某些
 * 畸形输入（如以 `elif` 开头的残缺复合命令）返回零 command 且不设任何错误标记——
 * AST 与 fallback 都不运行，`elif true; then cd ~; rm -rf .ssh; then :; fi` 曾整体
 * 判 safe。非注释、非空的命令文本在零 command 时按不可解析处理，交给词法 fallback
 * （recall 偏向：宁可多一次词法扫描，不留「整段被静默丢弃」的直通路径）。纯注释
 * 行（`# …`）在 bash 里不执行任何命令，维持 safe。
 */
function parserSwallowedCommandText(command: string, analysis: { readonly commands: readonly unknown[] }): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return false;
  return analysis.commands.length === 0;
}

/** cwd 跟踪的可变游标：顺序调用间共享，子壳/命令替换传快照副本。 */
interface CwdCursor {
  state: TrackedCwd;
}

/**
 * 把 cwd 跟踪状态编码进派生 context（签名受限的递归用）：find-actions / payloads
 * 只收 context，内部经 assessTokens/assessText 入口还原游标。状态与初始语义一致时
 * 返回原 context，避免无意义拷贝。
 */
function contextWithCwd(context: TargetRiskContext, state: TrackedCwd): TargetRiskContext {
  const current = context.trackedCwd;
  if (current === undefined) {
    if (state.unresolved === false && state.resolved === undefined) return context;
  } else if (current.unresolved === state.unresolved && current.resolved === state.resolved) {
    return context;
  }
  return { ...context, trackedCwd: state };
}

/**
 * shell 内建 cd/pushd/popd 的 cwd 变更解析（对抗复审 HIGH-1）：
 * - popd（弹栈到栈顶目录）、pushd 无参（交换栈顶）、`cd -`（OLDPWD）静态不可知；
 * - cd 无参 = HOME；
 * - 目标词交给 paths.resolveCdTargetWithCdpath：含未解析段 → unresolved（后续相对
 *   目标 fail-closed 升至少 confirm，绝对目标不受影响）；命令内可见 CDPATH= 赋值时
 *   相对目标先按 CDPATH 候选重定基（对抗复核 F-3）。
 */
function applyShellCdBuiltin(
  name: string,
  args: readonly string[],
  context: TargetRiskContext,
  currentState: TrackedCwd,
  cdpath?: string,
): TrackedCwd {
  if (name === "popd") return { unresolved: true };
  let target: string | undefined;
  let endOfFlags = false;
  for (const arg of args) {
    if (!endOfFlags) {
      if (arg === "--") {
        endOfFlags = true;
        continue;
      }
      if (isFlagToken(arg)) continue;
    }
    target = arg;
    break;
  }
  if (target === undefined) {
    // cd（无参）= HOME；pushd（无参）交换目录栈顶 = 静态不可知。
    if (name === "pushd") return { unresolved: true };
    target = "~";
  }
  if (target === "-") return { unresolved: true };
  const change = resolveCdTargetWithCdpath(target, cdpath, contextWithCwd(context, currentState));
  if (change.unresolved || change.resolved === undefined) return { unresolved: true };
  return { resolved: change.resolved, unresolved: false };
}

function assessInvocation(
  invocation: BashCommandInvocation,
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
  depth: number,
  cursor: CwdCursor,
): void {
  // 重定向先于一切分类：即使 wrapper 只打印信息，`> /etc/passwd` 也会发生。
  // `>& <文件名>` 同样是截断写（bash：等价于 `>word 2>&1`），只有 `>&2`/`>&-` 豁免。
  // 重定向目标以本命令执行前的 cwd 为基准（本命令自身的 cd 不影响它的重定向）。
  const stateHere = cursor.state;
  const ctxHere = contextWithCwd(context, stateHere);
  for (const redirect of invocation.redirects) {
    if (!isTruncatingRedirect(redirect)) continue;
    if (!redirect.target || isSafeWriteSink(redirect.target)) continue;
    pushFinding(findings, classifyTarget(redirect.target, ctxHere, { recursive: false }));
  }

  // 命令替换在主命令之前、子壳中执行：继承当前 cwd，内部 cd 不写回（HIGH-1 边界语义）。
  for (const text of substitutionScanTexts(invocation)) {
    for (const script of extractCommandSubstitutions(text)) {
      assessText(script, context, findings, depth + 1, { state: stateHere });
    }
  }

  // HOME= 重赋值：命令自带的赋值会让 `~`/`$HOME` 的运行时落点偏离受信 homedir，
  // 静态判定失效 → confirm。受信保护表不受影响（展开始终用注入的 homedir）。
  if (hasHomeReassignment(invocation)) {
    pushFinding(findings, { level: "confirm", reason: HOME_REASSIGN_REASON });
  }

  // 动态命令名（对抗复审 MEDIUM-1）：parser 标记命令词含动态展开时，argv[0] 是
  // 运行时计算的——分级查表依赖可靠的命令名。参数位的动态展开不在此升级。
  if (invocation.nameIsDynamic) {
    pushFinding(findings, {
      level: "confirm",
      reason:
        "command name contains unresolved expansion, so the program being invoked cannot be identified statically",
    });
  }

  assessTokens(
    invocation.argv,
    {
      receivesPipe: invocation.operatorBefore === "|" || invocation.operatorBefore === "|&",
      commandText: invocation.commandText,
      // CDPATH 前缀赋值对同一命令的 cd 可见（对抗复核 F-3）：`CDPATH=/home/u cd .ssh`。
      cdpath: invocation.envAssignments.find((assignment) => assignment.name === "CDPATH")?.value,
    },
    context,
    findings,
    depth,
    cursor,
    invocation.argvFullyQuoted,
  );
}

/**
 * HOME 重赋值判定（评审 J1-1 修复）：AST 已提取的前导赋值（`HOME=/tmp rm -rf ~`）
 * 走 envAssignments；argv 里的 `HOME=` 词元只有处于**赋值位**才算重赋值
 * （`env/export/declare/local/typeset/readonly/set HOME=…`，含 wrapper 之下的形态）。
 * `grep HOME= f`、`rg "HOME=" src`、`git log -S HOME=` 里的 `HOME=` 是只读命令的
 * pattern 参数，不是赋值——此前按裸 token 前缀判定，会在 build 模式下把一次只读
 * grep 直接 deny 一轮，正是 spec R4 声称已避免的误报形态。
 */
function hasHomeReassignment(invocation: BashCommandInvocation): boolean {
  if (invocation.envAssignments.some((assignment) => assignment.name === "HOME")) return true;
  const scanner = createHomeAssignmentScanner();
  return invocation.argv.some((token) => scanner.isReassignment(token));
}

function substitutionScanTexts(invocation: BashCommandInvocation): string[] {
  const texts: string[] = [...invocation.argv];
  for (const assignment of invocation.envAssignments) {
    if (assignment.value !== undefined) texts.push(assignment.value);
  }
  for (const redirect of invocation.redirects) {
    if (redirect.target) texts.push(redirect.target);
  }
  return texts;
}

/**
 * 对一段 token 序列分类：wrapper 逐层解包 → 真实程序 → find/shell/破坏性动词分派。
 * 各 wrapper 的 flag 取值规则不同（`nice -n 10` 取值而 `sudo -n` 不取），必须按表跳过，
 * 否则 wrapper 自身的操作数会被误认成程序。
 *
 * cursor 缺省时从 context.trackedCwd 还原（find -exec / 外方言 shell 递归路径）；
 * argQuoted 与 tokens 平行（仅顶层 invocation 提供；合成段无引号信息按未包裹处理）。
 */
function assessTokens(
  tokens: readonly string[],
  meta: { readonly receivesPipe: boolean; readonly commandText?: string; readonly cdpath?: string },
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
  depth: number,
  cursor?: CwdCursor,
  argQuoted?: readonly boolean[],
): void {
  if (tokens.length === 0) return;
  if (depth > MAX_RECURSION_DEPTH) {
    pushFinding(findings, {
      level: "confirm",
      reason: "command payload nesting is too deep to verify statically",
    });
    return;
  }
  const activeCursor: CwdCursor = cursor ?? {
    state: context.trackedCwd ?? initialTrackedCwd(context),
  };

  // wrapper payload 的 cwd 覆盖（env -C / sudo --chdir，HIGH-1）：只作用于本
  // payload，不写回会话状态。
  let wrapperCwdValue: string | undefined;
  const effectiveState = (): TrackedCwd => {
    if (wrapperCwdValue === undefined) return activeCursor.state;
    const change = resolveCwdTargetLexical(
      wrapperCwdValue,
      contextWithCwd(context, activeCursor.state),
    );
    return change.unresolved || change.resolved === undefined
      ? { unresolved: true }
      : { resolved: change.resolved, unresolved: false };
  };

  let index = 0;
  let wrappedBy: string | undefined;
  // env 透传的 CDPATH 赋值（对抗复核 F-3）：`env CDPATH=/home/u cd .ssh` 对 cd 生效。
  let cdpathFromArgs: string | undefined;
  for (;;) {
    if (index >= tokens.length) {
      // 解包到尽头还看不到 payload：不可见 ≠ 安全。
      if (wrappedBy) pushFinding(findings, wrapperPayloadUnknown(wrappedBy));
      return;
    }
    const token = tokens[index]!;
    const name = programBasename(token);

    if (name === "eval") {
      const payload = tokens.slice(index + 1);
      if (payload.length === 0) {
        pushFinding(findings, wrapperPayloadUnknown("eval"));
        return;
      }
      if (payload.some(hasUnresolvedMarker)) {
        pushFinding(findings, {
          level: "confirm",
          reason: "`eval` payload is computed at runtime and cannot be identified statically",
        });
      }
      // eval 在当前 shell 展开：其 payload 内的 cd 写回会话状态（HIGH-1）。
      const evalCursor: CwdCursor = { state: effectiveState() };
      assessText(payload.join(" "), context, findings, depth + 1, evalCursor);
      activeCursor.state = evalCursor.state;
      return;
    }

    if (SHELL_PROGRAMS.has(name)) {
      // 内联脚本递归评估；脚本文件参数（`bash script.sh`）按普通段评估后自然安全。
      // 子壳边界：payload 继承当前 cwd，内部 cd 不写回（HIGH-1）。
      const inherited = effectiveState();
      for (const arg of tokens.slice(index + 1)) {
        if (isFlagToken(arg)) continue;
        assessText(arg, context, findings, depth + 1, { state: inherited });
      }
      return;
    }

    if (FOREIGN_SHELL_PROGRAMS.has(name)) {
      assessForeignShellPayload(
        name,
        tokens.slice(index + 1),
        contextWithCwd(context, effectiveState()),
        findings,
        depth,
        assessText,
      );
      return;
    }

    if (!WRAPPER_PROGRAMS.has(name)) break;
    wrappedBy = name;
    index += 1;

    // `command -v/-V` 只描述名字（包括 wrapper 的名字）：仅检查其自身 option 前缀，
    // 绝不检查属于其 payload 的 option。
    if (name === "command" && isCommandNameLookup(tokens, index)) return;

    let positionalSkipped = false;
    while (index < tokens.length) {
      const wrapperToken = tokens[index]!;
      // env -C/--chdir、sudo -D/--chdir（HIGH-1）：捕获 payload cwd 覆盖值。
      if (name === "env" || name === "sudo") {
        if (wrapperToken === "-C" && name === "env") {
          wrapperCwdValue = tokens[index + 1];
        } else if (wrapperToken === "-D" && name === "sudo") {
          wrapperCwdValue = tokens[index + 1];
        } else if (wrapperToken === "--chdir") {
          wrapperCwdValue = tokens[index + 1];
        } else if (wrapperToken.startsWith("--chdir=")) {
          wrapperCwdValue = wrapperToken.slice(8);
        }
      }
      if (name === "env" && isEnvSplitStringFlag(wrapperToken)) {
        // env -S/--split-string（含 -iS 簇形态）：payload 是一次再分词，静态不可靠。
        pushFinding(findings, {
          level: "confirm",
          reason: "`env` split-string payload cannot be identified statically",
        });
        const payload = tokens.slice(index + 1);
        if (payload.length > 0) {
          assessText(payload.join(" "), context, findings, depth + 1, {
            state: effectiveState(),
          });
        }
        return;
      }
      if (wrapperToken === "--") {
        index += 1;
        break;
      }
      if (name === "su" && (wrapperToken === "-c" || wrapperToken === "--command")) {
        // su -c <script>：payload 经登录 shell 执行，按内联脚本递归评估。
        const script = tokens[index + 1];
        if (script === undefined) {
          pushFinding(findings, wrapperPayloadUnknown("su"));
          return;
        }
        assessText(script, context, findings, depth + 1, { state: effectiveState() });
        return;
      }
      if (wrapperToken.includes("=")) {
        // env 的 VAR=value 赋值（sudo 等无此形态，宽松跳过无害）；CDPATH 是 cd 的
        // 查找路径表，对同一命令的 cd 生效（对抗复核 F-3），必须捕获。
        if (wrapperToken.startsWith("CDPATH=")) cdpathFromArgs = wrapperToken.slice("CDPATH=".length);
        index += 1;
        continue;
      }
      if (isFlagToken(wrapperToken)) {
        index += 1;
        if (wrapperFlagTakesValue(name, wrapperToken) && index < tokens.length) index += 1;
        continue;
      }
      if (BARE_DURATION_PATTERN.test(wrapperToken)) {
        // 裸时长是 wrapper 自身的操作数（`timeout 5`），不是要运行的程序。
        index += 1;
        continue;
      }
      // chroot 的第一个位置参数是 newroot、su 的是用户名：各跳过一次再继续解包。
      if ((name === "chroot" || name === "su") && !positionalSkipped) {
        positionalSkipped = true;
        index += 1;
        continue;
      }
      break;
    }
    if (name === "env" && index >= tokens.length) {
      // `env` / `env -i` / `env FOO=bar`：打印环境，安全。
      return;
    }
    // 嵌套 wrapper（sudo env nice …）：继续外层循环逐层解包。
  }

  const program = tokens[index]!;
  const programName = programBasename(program);
  const rest = tokens.slice(index);
  const restQuoted = argQuoted?.slice(index + 1);

  // wrapper 的 -C/--chdir 只影响 payload：本段所有分级用它派生 context（HIGH-1）。
  const state = effectiveState();
  const ctx = contextWithCwd(context, state);

  // 动态命令名（对抗复审 MEDIUM-1）：命令名位含 `$(`、反引号或其它未解析展开时，
  // 程序本身运行时才确定（shell 分词后 `rm$IFS-rf$IFS~` 真实执行 `rm -rf ~`）。
  // 覆盖 find -exec 代入等合成段；参数位的动态展开不因此升级（目标侧已有
  // unresolved 规则）。
  if (/[$(`]/.test(program)) {
    pushFinding(findings, {
      level: "confirm",
      reason:
        "command name is computed at runtime, so the invoked program cannot be identified statically",
    });
  }

  if (programName === "find") {
    assessFind(rest, meta, ctx, findings, depth, assessTokens);
    return;
  }

  if (programName === "git") {
    assessGit(rest, ctx, findings);
    return;
  }

  // tee / sed -i / cp / mv（对抗复审 HIGH-8、MEDIUM-2）：目标被覆盖/截断写与
  // `>` 重定向同罪，但目标语义各不相同（tee 文件操作数、sed 输入文件、cp 目的、
  // mv 源+目的），走专门的操作数提取。分级函数在 overwrite-verbs.ts，与词法
  // fallback 共用同一套（对抗复核 F-7：一层括号不得降级）。
  if (programName === "tee") {
    assessTee(rest.slice(1), ctx, findings);
    return;
  }
  if (programName === "sed" || programName === "gsed") {
    // gsed 与 sed 同列（对抗复核 F-5）：macOS brew 的 GNU sed 别名，`gsed -i` 与
    // `sed -i` 是同一就地截断重写行为的两种拼写。
    assessSed(rest.slice(1), ctx, findings);
    return;
  }
  if (programName === "cp" || programName === "mv") {
    assessCopyMove(programName, rest.slice(1), ctx, findings);
    return;
  }

  // shell 内建 cd 族（HIGH-1）：更新会话 cwd 跟踪状态，供后续 invocation 定基。
  if (programName === "cd" || programName === "pushd" || programName === "popd") {
    activeCursor.state = applyShellCdBuiltin(
      programName,
      rest.slice(1),
      context,
      state,
      meta.cdpath ?? cdpathFromArgs,
    );
    return;
  }

  const conditionalFlags = CONDITIONALLY_DESTRUCTIVE_FLAGS[programName];
  // rimraf 这类动词无旗标也是整树删除：递归语义来自动词本身，不来自旗标。
  const recursive =
    isAlwaysRecursiveProgram(programName) ||
    rest.slice(1).some((arg) => isRecursiveFlag(arg, programName));
  const destructive =
    isDestructiveProgramName(programName) ||
    (conditionalFlags !== undefined &&
      rest.slice(1).some((arg) => conditionalFlags.has(arg) || isRecursiveFlag(arg, programName)));
  if (!destructive) return;

  // 管道喂给破坏性命令：操作数来自上游输出，静态不可枚举——两段单独看都不暴露
  // （`find ~ | xargs rm`），必须升级。
  if (meta.receivesPipe) {
    pushFinding(findings, {
      level: "confirm",
      reason: `\`${programName}\` ${PIPE_FED_REASON_SUFFIX}`,
    });
  }

  const targets: readonly DestructiveTarget[] = extractDestructiveTargets(
    programName,
    rest.slice(1),
    restQuoted,
  );
  // 破坏性命令无可解析目标 = 更可疑而非更安全：看不到它要碰什么。
  if (targets.length === 0) {
    pushFinding(findings, {
      level: "confirm",
      reason: `\`${programName}\` ${UNKNOWN_BLAST_RADIUS_REASON_SUFFIX}`,
    });
    return;
  }

  for (const target of targets) {
    const value = destructiveTargetValue(programName, target.value);
    if (value === undefined) continue; // dd of=安全汇：写 bit bucket 无破坏
    pushFinding(
      findings,
      classifyDestructiveTargetToken(value, target.fullyQuoted, ctx, { recursive }),
    );
  }
}

/**
 * git 子命令定位（对抗复审 LOW-13）：跳过 git 全局旗标（`-C <v>`、`-c <v>`、
 * `--git-dir`、`--work-tree`、`--namespace`、`--super-prefix`、`--exec-path`，含
 * key=value 形态）后再找子命令——`git -C ~ clean -fdx` 与 `git clean -fdx ~` 是
 * 同一破坏行为，此前硬性要求 rest[1] === "clean" 留下直通缺口。
 */
function assessGit(
  tokens: readonly string[],
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
): void {
  const GIT_VALUE_FLAGS = new Set(["-c", "--exec-path", "--super-prefix"]);
  const GIT_VALUE_LONG_FLAGS = ["--git-dir", "--work-tree", "--namespace", "--super-prefix"];

  let index = 1;
  let chdirValue: string | undefined;
  let chdirPresent = false;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "-C") {
      chdirPresent = true;
      const value = tokens[index + 1];
      if (value !== undefined) chdirValue = value;
      index += value === undefined ? 1 : 2;
      continue;
    }
    if (token.startsWith("-C") && token.length > 2) {
      // `git -C<path>` 宽容处理（值粘连形态）。
      chdirPresent = true;
      chdirValue = token.slice(2);
      index += 1;
      continue;
    }
    if (GIT_VALUE_FLAGS.has(token)) {
      index += 2;
      continue;
    }
    const longValueFlag = GIT_VALUE_LONG_FLAGS.find(
      (flag) => token === flag || token.startsWith(`${flag}=`),
    );
    if (longValueFlag !== undefined) {
      index += token === longValueFlag ? 2 : 1;
      continue;
    }
    if (isFlagToken(token)) {
      index += 1;
      continue;
    }
    break;
  }

  const subcommand = tokens[index];
  if (subcommand === undefined || programBasename(subcommand) !== "clean") return;
  index += 1;

  // clean 自身旗标：-e <pattern> 消费一个值；-- 之后全部是路径操作数。
  const paths: string[] = [];
  let endOfFlags = false;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (!endOfFlags) {
      if (token === "--") {
        endOfFlags = true;
        index += 1;
        continue;
      }
      if (token === "-e" || token === "--exclude") {
        index += 2;
        continue;
      }
      if (token.startsWith("--exclude=")) {
        index += 1;
        continue;
      }
      if (isFlagToken(token)) {
        index += 1;
        continue;
      }
    }
    paths.push(token);
    index += 1;
  }

  if (chdirPresent) {
    const change =
      chdirValue === undefined
        ? { unresolved: true as const }
        : resolveCwdTargetLexical(chdirValue, context);
    if (change.unresolved || change.resolved === undefined) {
      // -C 的值不可静态解析：clean 的作用范围随之不可知（fail-closed）。
      pushFinding(findings, {
        level: "confirm",
        reason:
          "`git -C` target directory cannot be resolved statically, so the clean scope is unknown",
      });
      return;
    }
    const chdirContext = contextWithCwd(context, { resolved: change.resolved, unresolved: false });
    if (paths.length === 0) {
      // git -C <dir> clean 无显式路径 = 清理 <dir> 的工作树，等价 git clean -fdx <dir>。
      pushFinding(
        findings,
        classifyDestructiveTargetToken(chdirValue!, false, chdirContext, { recursive: true }),
      );
      return;
    }
    for (const path of paths) {
      pushFinding(
        findings,
        classifyDestructiveTargetToken(path, false, chdirContext, { recursive: true }),
      );
    }
    return;
  }

  if (paths.length === 0) {
    // git clean 无显式路径时天然有界于仓库工作树：low（可见、不打断）。
    pushFinding(findings, {
      level: "low",
      reason: "git clean deletes untracked files inside the repository working tree",
    });
    return;
  }
  for (const path of paths) {
    pushFinding(
      findings,
      classifyDestructiveTargetToken(path, false, context, { recursive: true }),
    );
  }
}

/** 把一段脚本文本重新解析并评估（sh -c / eval / env -S / su -c / 外方言 payload）。 */
function assessText(
  text: string,
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
  depth: number,
  cursor?: CwdCursor,
): void {
  if (depth > MAX_RECURSION_DEPTH) {
    pushFinding(findings, {
      level: "confirm",
      reason: "command payload nesting is too deep to verify statically",
    });
    return;
  }
  if (text.trim().length === 0) return;
  const analysis = analyzeBashCommand(text);
  const activeCursor: CwdCursor = cursor ?? {
    state: context.trackedCwd ?? initialTrackedCwd(context),
  };
  // 与入口一致的管道边界语义：payload 内 `|` 段的 cd 不跨管道传播。
  let pipelineBase = activeCursor.state;
  for (const invocation of analysis.commands) {
    if (invocation.operatorBefore === "|" || invocation.operatorBefore === "|&") {
      activeCursor.state = pipelineBase;
    } else {
      pipelineBase = activeCursor.state;
    }
    assessInvocation(invocation, context, findings, depth, activeCursor);
  }
  if (
    analysis.hasParseErrors ||
    analysis.hasUnsupportedSyntax ||
    parserSwallowedCommandText(text, analysis)
  ) {
    assessRawText(text, context, findings, activeCursor);
  }
}
