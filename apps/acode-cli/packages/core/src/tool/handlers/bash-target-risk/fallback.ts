/* eslint-disable max-lines -- 存量基线豁免:该文件先于 CLI lint 门禁建立即超限(根 lint 的 ignorePatterns 排除 apps/acode-cli,turbo lint 因此从未变绿)。头注豁免以恢复门禁信号;拆分重构超出本批范围。 */
// 词法 fallback（AST 不可用时）（J1-1）。
// 规格见 apps/acode-cli/specs/bash-target-blast-radius.md R4「词法 fallback」。
//
// 机制参照 jcode (MIT, github.com/1jehuang/jcode)
// crates/jcode-command-risk/src/tokenize.rs 的引号感知切分，
// 自撰 TypeScript 实现。jcode 的主路径就是自己的 tokenizer；本仓库主路径是
// unbash AST，这里只兜 AST 覆盖不到的形态（subshell/if/while/case、解析失败、
// 超长文本），走同一套动词/目标分级：
// - `(rm -rf ~)`、`if true; then rm -rf ~; fi` 判 catastrophic；
// - 引号内的字符串（`echo "rm -rf ~"`）是单个 token，不会被误判成动词+目标对；
// - 条件破坏动词（tee/sed -i/gsed/cp/mv）的目标同样分级（对抗复核 F-7），与 AST
//   路径共用 overwrite-verbs.ts 的同一套分级函数；
// - 找不到破坏性动词时不产生任何 finding（非删除类命令不因解析失败被本层拦截，
//   类 1 熔断的 fail-closed 照旧兜底）。
// heredoc body 不剥离，属已知边界（spec R6）。
//
// HIGH-1（对抗复审）：fallback 同样做 cwd 段级跟踪——`(cd ~; rm -rf .ssh)` 不得因
// 一层括号被当成删工作区内的 `.ssh` 放行。括号边界保存/恢复 cwd 状态（子壳语义），
// 管道段从管道起点分叉；`cd`/`pushd`/`popd` 在段首出现时更新跟踪状态。

import {
  classifyDestructiveTargetToken,
  createHomeAssignmentScanner,
  destructiveTargetValue,
  HOME_ASSIGNMENT_PATTERN,
  HOME_REASSIGN_REASON,
  isDestructiveProgramName,
  isFlagToken,
  isRecursiveFlag,
  PIPE_FED_REASON_SUFFIX,
  programBasename,
  pushFinding,
  SHELL_CONTROL_WORDS,
  UNKNOWN_BLAST_RADIUS_REASON_SUFFIX,
} from "./grammar.js";
import {
  assessPackageManagerScriptInFallback,
  isPackageManagerAtRunnablePosition,
} from "./npm-scripts.js";
import { assessCopyMove, assessSed, assessTee } from "./overwrite-verbs.js";
import {
  classifyTarget,
  initialTrackedCwd,
  isSafeWriteSink,
  resolveCdTargetWithCdpath,
} from "./paths.js";
import type { ScriptAssessor } from "./grammar.js";
import type { TargetRiskContext, TargetRiskFinding, TrackedCwd } from "./types.js";

/** cwd 跟踪可变游标（与 assess.ts 同构；独立声明避免跨模块导出内部形态）。 */
interface CwdCursor {
  state: TrackedCwd;
}

/** 任意 shell 变量赋值词元（`CDPATH=…` 的捕获只在其处于赋值位时生效）。 */
const VARIABLE_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CDPATH_ASSIGNMENT_PATTERN = /^CDPATH=(.+)$/;

/**
 * shell 内建 cd/pushd/popd 的 cwd 变更解析（与 assess.ts 的 applyShellCdBuiltin
 * 同一口径）：popd/pushd 无参/`cd -` 静态不可知；目标词经词法解析，含未解析段
 * → unresolved（后续相对目标 fail-closed）。段内命令词之前的 CDPATH= 赋值对同一
 * cd 生效（对抗复核 F-3）。
 */
function applyFallbackCdBuiltin(
  name: string,
  target: string | undefined,
  context: TargetRiskContext,
  currentState: TrackedCwd,
  cdpath?: string,
): TrackedCwd {
  if (name === "popd") return { unresolved: true };
  let resolved: string | undefined;
  if (target === undefined) {
    if (name === "pushd") return { unresolved: true };
    resolved = "~";
  } else if (target === "-") {
    return { unresolved: true };
  }
  const change = resolveCdTargetWithCdpath(
    resolved ?? target!,
    cdpath,
    contextWithCwd(context, currentState),
  );
  if (change.unresolved || change.resolved === undefined) return { unresolved: true };
  return { resolved: change.resolved, unresolved: false };
}

/** 把 cwd 跟踪状态编码进派生 context（与 assess.ts 同一口径）。 */
function contextWithCwd(context: TargetRiskContext, state: TrackedCwd): TargetRiskContext {
  const current = context.trackedCwd;
  if (current === undefined) {
    if (state.unresolved === false && state.resolved === undefined) return context;
  } else if (current.unresolved === state.unresolved && current.resolved === state.resolved) {
    return context;
  }
  return { ...context, trackedCwd: state };
}

export function assessRawText(
  text: string,
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
  cursor?: CwdCursor,
  // 本段文本的递归深度（R6 边界⑥的 body 递归守卫沿用它；入口为 0，assessText
  // 透传自身深度）。
  depth = 0,
  // recurse：assessText 回调（assess.ts 注入，避免循环依赖）。`npm run x` 的 body
  // 递归（R6 边界⑥）经它走 AST 主路径；缺省时跳过 manager 挂点（不递归＝维持
  // 旧 fallback 行为，不会 fail-open 到「看不见 body 就放行 run」——run 族判定
  // 本身需要 map，legacy 上下文本就直通）。
  recurse?: ScriptAssessor,
): void {
  const tokens = fallbackTokenize(text);
  // HOME= 只在赋值位才算重赋值（与 AST 路径同一口径）：`(grep HOME= f)` 里的 `HOME=`
  // 是 grep 的 pattern 参数，不能因为落在 fallback 就升级成 confirm（评审 J1-1 修复）。
  const homeScanner = createHomeAssignmentScanner();
  const activeCursor: CwdCursor = cursor ?? {
    state: context.trackedCwd ?? initialTrackedCwd(context),
  };
  // 子壳括号栈：`(` 保存当前状态、`)` 恢复——`(cd ~); rm x` 的外层 cwd 不变。
  const savedStates: TrackedCwd[] = [];
  // 管道段从管道起点分叉（HIGH-1）：段内 cd 不跨 `|` 传播。
  let pipelineBase = activeCursor.state;
  // 段内命令词之前的 CDPATH= 赋值（对抗复核 F-3）：对同一命令的 cd 生效，消费后
  // 即失效（bash 前缀赋值只作用于一条命令）。
  let segmentCdpath: string | undefined;
  // 段内是否已出现命令词：其后的 `CDPATH=` 词元是数据参数（`echo CDPATH=/x; cd y`
  // 的 cd 不受影响），不得当作赋值捕获。
  let sawCommandWord = false;
  // 最近一个非旗标词（R6 边界⑥ fallback 挂点用：`sudo npm run x` 的 npm 不在
  // 命令位，但其前是 wrapper 词，同样要进入 run 族解析）。
  let previousCommandToken: string | undefined;
  // F-1（对抗复核）：shell 控制词（then/do/{/else/elif/…）是普通词 token，不在
  // 操作符字符集内——其后的词必然处于命令位，却拿不到操作符带来的段首标记，
  // `if true; then cd ~; rm -rf .ssh; fi` 的 cd 因此脱离跟踪（曾判 low、yolo 静默
  // allow）。命令位判定放在消费侧（只作用于 cd 跟踪），不在 tokenizer 里改写
  // segmentStart：find 的搜索根扫描与破坏性动词的目标扫描以「操作符段边界」截断，
  // 词法层改写会让 `find . -name then -delete` 的 -delete 落到段外被漏判（fail-open）。
  let previousTokenWasControlWord = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.parenDelta > 0) {
      for (let k = 0; k < token.parenDelta; k += 1) savedStates.push(activeCursor.state);
    } else if (token.parenDelta < 0) {
      for (let k = 0; k < -token.parenDelta && savedStates.length > 0; k += 1) {
        activeCursor.state = savedStates.pop()!;
      }
      pipelineBase = activeCursor.state;
    }
    if (token.segmentStart) {
      homeScanner.reset();
      segmentCdpath = undefined;
      sawCommandWord = false;
      if (token.pipeFed) {
        activeCursor.state = pipelineBase;
      } else {
        pipelineBase = activeCursor.state;
      }
    }
    const atCommandPosition = token.segmentStart || i === 0 || previousTokenWasControlWord;
    const derived = contextWithCwd(context, activeCursor.state);
    if (token.redirect !== "none") {
      // 截断重定向目标（评审 J1-1 修复）：spec R4 要求 `>`/`>|`/`&>` 的目标按非递归写
      // 分级，且 fallback 走「同一套动词/目标分级」。此前 `>` 只被当段边界丢弃，于是
      // `(echo x > /etc/passwd)`、`if true; then echo x > /etc/passwd; fi` 判 safe，
      // 而同一命令不加括号是 catastrophic——一层括号就把绝对 deny 变成 yolo 静默放行。
      assessRawRedirectTarget(token.text, token.redirect, derived, findings);
      previousTokenWasControlWord = SHELL_CONTROL_WORDS.has(token.text);
      continue;
    }
    if (homeScanner.isReassignment(token.text)) {
      pushFinding(findings, { level: "confirm", reason: HOME_REASSIGN_REASON });
      previousTokenWasControlWord = SHELL_CONTROL_WORDS.has(token.text);
      continue;
    }
    if (!sawCommandWord && VARIABLE_ASSIGNMENT_PATTERN.test(token.text)) {
      // 赋值位的 CDPATH= 词元（对抗复核 F-3）：`CDPATH=/home/u cd .ssh` 的 cd 先查
      // CDPATH。只捕获命令词之前的词元；其余赋值词元本就不是动词/目标，跳过无害。
      const cdpathMatch = token.text.match(CDPATH_ASSIGNMENT_PATTERN);
      if (cdpathMatch) segmentCdpath = cdpathMatch[1]!;
      previousTokenWasControlWord = SHELL_CONTROL_WORDS.has(token.text);
      continue;
    }
    const name = programBasename(token.text);
    // HIGH-1 fallback cwd 跟踪：命令位（段首/文本首 token/控制词之后）的
    // cd/pushd/popd 更新跟踪状态。
    if (atCommandPosition && (name === "cd" || name === "pushd" || name === "popd")) {
      activeCursor.state = applyFallbackCdBuiltin(
        name,
        fallbackCdTarget(tokens, i),
        context,
        activeCursor.state,
        segmentCdpath,
      );
      segmentCdpath = undefined;
      sawCommandWord = true;
      previousTokenWasControlWord = false;
      continue;
    }
    if (!isFlagToken(token.text)) {
      sawCommandWord = true;
      previousCommandToken = token.text;
    }
    previousTokenWasControlWord = SHELL_CONTROL_WORDS.has(token.text);
    if (token.pipeFed && isDestructiveProgramName(name)) {
      pushFinding(findings, {
        level: "confirm",
        reason: `\`${name}\` ${PIPE_FED_REASON_SUFFIX}`,
      });
    }
    if (name === "find") {
      assessRawFind(tokens, i, derived, findings);
      continue;
    }
    // F-7（对抗复核）：条件破坏动词的目标在 fallback 与 AST 路径同一套分级——
    // `(cp evil /etc/passwd)`、`(sed -i s/x/y/ /etc/passwd)`、`(tee /etc/passwd)`、
    // `if true; then cp evil /etc/passwd; fi` 此前一层括号即降 safe，而同命令不带
    // 括号是 catastrophic（HIGH-4 同威胁族）。分级函数复用 overwrite-verbs.ts，
    // 不在词法层复制第二套逻辑。
    if (name === "tee") {
      assessTee(fallbackVerbArgs(tokens, i), derived, findings);
      continue;
    }
    if (name === "sed" || name === "gsed") {
      assessSed(fallbackVerbArgs(tokens, i), derived, findings);
      continue;
    }
    if (name === "cp" || name === "mv") {
      assessCopyMove(name, fallbackVerbArgs(tokens, i), derived, findings);
      continue;
    }
    // R6 边界⑥收口（fallback 口径）：subshell/if/while 包裹的 `npm run x` 与裸命令
    // 同判（母层 F-1：一层括号不得降级）。run 族解析在 npm-scripts.ts，body 经
    // recurse 回调走 AST 主路径递归；recurse 缺省（不应发生）时跳过。
    if (
      recurse !== undefined &&
      isPackageManagerAtRunnablePosition(token.text, previousCommandToken, atCommandPosition)
    ) {
      assessPackageManagerScriptInFallback(tokens, i, derived, findings, depth, recurse, {
        // 对抗验证 F3：xargs payload 位/管道喂入位的无名 run 由 stdin 提供名字
        //（`(echo clean | xargs npm run)` 一层括号不得降级）。
        throughXargs:
          previousCommandToken !== undefined && programBasename(previousCommandToken) === "xargs",
        receivesPipe: token.pipeFed,
      });
    }
    if (!isDestructiveProgramName(name)) continue;
    assessRawDestructiveVerb(tokens, i, name, derived, findings);
  }
}

/** `>&` 的操作数是 fd 号（或 `-` 关闭描述符）时不写文件，其余情况等价于截断写。 */
const FD_OPERAND_PATTERN = /^(?:\d+|-)$/;

/** 重定向写目标：安全汇与纯 fd 操作豁免，其余按非递归写分级（与 AST 路径同款）。 */
function assessRawRedirectTarget(
  target: string,
  redirect: "truncate" | "dup",
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
): void {
  if (target.length === 0 || isSafeWriteSink(target)) return;
  if (redirect === "dup" && FD_OPERAND_PATTERN.test(target)) return;
  pushFinding(findings, classifyTarget(target, context, { recursive: false }));
}

/** cd/pushd/popd 在 fallback token 流中的目标词：跳过旗标与 `--`，段边界即止。 */
function fallbackCdTarget(tokens: readonly FallbackToken[], verbIndex: number): string | undefined {
  for (let j = verbIndex + 1; j < tokens.length; j += 1) {
    const candidate = tokens[j]!;
    if (candidate.segmentStart) return undefined;
    if (candidate.text === "--") continue;
    if (isFlagToken(candidate.text)) continue;
    return candidate.text;
  }
  return undefined;
}

/** fallback 只识别 find 最危险的形态：-delete 把搜索根升级为删除目标。 */
function assessRawFind(
  tokens: readonly FallbackToken[],
  verbIndex: number,
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
): void {
  const roots: string[] = [];
  let hasDelete = false;
  let seenNonRoot = false;
  for (let j = verbIndex + 1; j < tokens.length; j += 1) {
    const candidate = tokens[j]!;
    // 段边界（含重定向目标）之后是另一条命令/另一个语法的 token，不是搜索根。
    if (candidate.segmentStart) break;
    if (SHELL_CONTROL_WORDS.has(candidate.text)) break;
    if (candidate.text === "-delete") {
      hasDelete = true;
      continue;
    }
    if (
      isFlagToken(candidate.text) ||
      isDestructiveProgramName(programBasename(candidate.text))
    ) {
      // payload 里的破坏性动词（-exec rm …）留给外层循环按普通动词处理。
      seenNonRoot = true;
      continue;
    }
    if (!seenNonRoot) roots.push(candidate.text);
  }
  if (!hasDelete) return;
  for (const root of roots.length > 0 ? roots : ["."]) {
    pushFinding(findings, classifyTarget(root, context, { recursive: true }));
  }
}

/**
 * F-7（对抗复核）：提取词法段内 tee/sed/gsed/cp/mv 的参数词元（字符串形态），交给
 * overwrite-verbs.ts 的共享分级函数消费。切分边界与 assessRawDestructiveVerb 同一口径：
 * - 操作符段边界（`;`/`&&`/`||`/`|` 之后）即止——后续是另一条命令的 token；
 * - 控制词跳过（`if true; then cp evil /etc/passwd; fi` 的 `fi` 不是 cp 的参数；
 *   有效 bash 中控制词总在操作符边界之后，segmentStart 已截断，这里是兜底）；
 * - 破坏性动词名即止（`cp a rm -rf ~` 的 `rm` 由外层循环按动词处理，不并入 cp 操作数）；
 * - `HOME=` 赋值词元即止（与破坏性动词的目标扫描同口径）。
 * 旗标不在此过滤：tee 的 `-a` 簇、sed 的 `-i`/`-e <v>`、cp 的 `-t <v>` 各自的取值
 * 语义都在共享函数里（与 AST 路径同一识别）。重定向目标词必带 segmentStart（tokenizer
 * 不变量），由主循环的 assessRawRedirectTarget 分级，不会落入参数。含未解析 `$` 的
 * 词元原样传递，由 classifyTarget 按 unresolved → confirm 兜底（recall 偏向）。
 */
function fallbackVerbArgs(tokens: readonly FallbackToken[], verbIndex: number): string[] {
  const args: string[] = [];
  for (let j = verbIndex + 1; j < tokens.length; j += 1) {
    const candidate = tokens[j]!;
    if (candidate.segmentStart) break;
    if (SHELL_CONTROL_WORDS.has(candidate.text)) continue;
    if (isDestructiveProgramName(programBasename(candidate.text))) break;
    if (HOME_ASSIGNMENT_PATTERN.test(candidate.text)) break;
    args.push(candidate.text);
  }
  return args;
}

function assessRawDestructiveVerb(
  tokens: readonly FallbackToken[],
  verbIndex: number,
  name: string,
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
): void {
  const targets: { readonly text: string; readonly fullyQuoted: boolean }[] = [];
  let recursive = false;
  for (let j = verbIndex + 1; j < tokens.length; j += 1) {
    const candidate = tokens[j]!;
    // 段边界（; && || | 之后）：后面是另一条命令的 token，不是本动词的目标。
    if (candidate.segmentStart) break;
    if (SHELL_CONTROL_WORDS.has(candidate.text)) continue;
    if (isDestructiveProgramName(programBasename(candidate.text))) break;
    if (HOME_ASSIGNMENT_PATTERN.test(candidate.text)) break;
    if (isFlagToken(candidate.text)) {
      if (isRecursiveFlag(candidate.text, name)) recursive = true;
      continue;
    }
    targets.push({ text: candidate.text, fullyQuoted: candidate.fullyQuoted });
  }
  if (targets.length === 0) {
    pushFinding(findings, {
      level: "confirm",
      reason: `\`${name}\` ${UNKNOWN_BLAST_RADIUS_REASON_SUFFIX}`,
    });
    return;
  }
  for (const target of targets) {
    const value = destructiveTargetValue(name, target.text);
    if (value === undefined) continue;
    pushFinding(
      findings,
      classifyDestructiveTargetToken(value, target.fullyQuoted, context, { recursive }),
    );
  }
}

interface FallbackToken {
  readonly text: string;
  /** 所在段的操作数来自上游管道输出（段首 `|`/`|&`，`||` 不算）。 */
  readonly pipeFed: boolean;
  /** 该 token 是一段的首个 token（前面有操作符边界）。 */
  readonly segmentStart: boolean;
  /**
   * 该 token 是重定向目标：`truncate` 必然截断写（`>`/`>|`/`&>`/`2>`），`dup` 是 `>&`
   * （目标是 fd 号时只是复制描述符，是文件名时等价于截断写）。不是动词、也不是动词的操作数。
   */
  readonly redirect: "none" | "truncate" | "dup";
  /**
   * 段首操作符串里的括号净变化（`(` 记正、`)` 记负）：子壳边界，cwd 跟踪据此
   * 保存/恢复（HIGH-1）。
   */
  readonly parenDelta: number;
  /** 整个 token 被引号完整包裹（LOW-16 全引号 tilde/brace 降级判定的依据）。 */
  readonly fullyQuoted: boolean;
}

/**
 * 操作符串里是否含「截断写」重定向。`>>`（追加）、`>(`（进程替换，内层命令由动词
 * 扫描自己覆盖）不算破坏；fd 数字（`2>`）在词法层是独立 token，不出现在操作符串里，
 * 所以 `2> /etc/passwd` 同样命中。
 */
function isTruncatingRedirectOps(ops: string): boolean {
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i] !== ">") continue;
    const next = ops[i + 1];
    if (next === ">") {
      // `>>` 是追加：两个字符一起消费，否则第二个 `>` 会被当成截断写
      // （`(echo x >> /etc/passwd)` 曾因此被误判 catastrophic）。
      i += 1;
      continue;
    }
    if (next === "(") continue;
    if (next === "&") {
      // `>&`：目标是 fd 号还是文件名要看下一个词，交给 isDuplicateOrTruncateOps 分支。
      i += 1;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * 操作符串是否以 `>&` 结束（bash：`>&word`，word 非数字时等价于 `>word 2>&1`，
 * 同样截断文件）。是不是破坏要看紧随的目标词，故与 truncate 分开标记。
 */
function isDuplicateOrTruncateOps(ops: string): boolean {
  return ops.endsWith(">&");
}

/**
 * 引号感知的粗切分：操作符 `; | & ( ) < >` 与空白为界；引号解析后剥除。
 * pipeFed 是段级属性——`cat x | xargs rm` 里 rm 与 xargs 同段，都算管道喂入。
 */
function fallbackTokenize(text: string): FallbackToken[] {
  const tokens: FallbackToken[] = [];
  let current = "";
  let hasContent = false;
  let opsBuffer = "";
  let segmentPipeFed = false;
  let segmentStart = true;
  let segmentRedirect: FallbackToken["redirect"] = "none";
  // 段首操作符串的括号净变化：必须在 beginContent 结算 opsBuffer 时计算（清空后就丢了）。
  let segmentParenDelta = 0;
  // LOW-16：token 是否被引号完整包裹（以引号开块、以配对引号收尾）。
  let startsWithQuote = false;
  let lastEventWasQuoteClose = false;
  const beginContent = (): void => {
    if (!hasContent && current.length === 0) {
      if (opsBuffer.length > 0) {
        segmentPipeFed = opsBuffer === "|" || opsBuffer === "|&";
        segmentRedirect = isTruncatingRedirectOps(opsBuffer)
          ? "truncate"
          : isDuplicateOrTruncateOps(opsBuffer)
            ? "dup"
            : "none";
        segmentParenDelta = countChar(opsBuffer, "(") - countChar(opsBuffer, ")");
        segmentStart = true;
        opsBuffer = "";
      } else {
        segmentStart = false;
        segmentRedirect = "none";
        // 无操作符边界的 token 必须清零：括号净变化是「段首一次性」属性，
        // 泄漏到后续 token 会让子壳恢复多弹一次（(cd x); y 曾因此判错）。
        segmentParenDelta = 0;
      }
    }
  };
  const flushToken = (): void => {
    if (hasContent || current.length > 0) {
      tokens.push({
        text: current,
        pipeFed: segmentPipeFed,
        segmentStart,
        redirect: segmentRedirect,
        parenDelta: segmentParenDelta,
        fullyQuoted: startsWithQuote && lastEventWasQuoteClose,
      });
    }
    current = "";
    hasContent = false;
    startsWithQuote = false;
    lastEventWasQuoteClose = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "'" || char === '"' || char === "`") {
      beginContent();
      if (!hasContent && current.length === 0 && char !== "`") startsWithQuote = true;
      hasContent = true;
      lastEventWasQuoteClose = false;
      const quote = char;
      i += 1;
      while (i < text.length) {
        const inner = text[i]!;
        if (inner === "\\" && quote !== "'") {
          const next = text[i + 1];
          if (next !== undefined) {
            current += next;
            lastEventWasQuoteClose = false;
            i += 2;
            continue;
          }
        }
        if (inner === quote) break;
        current += inner;
        lastEventWasQuoteClose = false;
        i += 1;
      }
      // 闭引号：token 仍处于「被引号完整包裹」候选态。
      lastEventWasQuoteClose = startsWithQuote;
      continue;
    }
    if (char === "\\" && i + 1 < text.length) {
      beginContent();
      current += text[i + 1];
      hasContent = true;
      lastEventWasQuoteClose = false;
      i += 1;
      continue;
    }
    if (";|&()<>\n".includes(char)) {
      flushToken();
      opsBuffer += char;
      continue;
    }
    if (/\s/.test(char)) {
      flushToken();
      continue;
    }
    beginContent();
    current += char;
    hasContent = true;
    lastEventWasQuoteClose = false;
  }
  flushToken();
  return tokens;
}

function countChar(text: string, char: string): number {
  let count = 0;
  for (const item of text) {
    if (item === char) count += 1;
  }
  return count;
}
