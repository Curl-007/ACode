import { parse } from "unbash";
import type {
  AndOr,
  Command,
  Node,
  Pipeline,
  Redirect,
  Script,
  Statement,
  Word,
  WordPart,
} from "unbash";

export type BashCommandOperator = "&&" | "||" | "|" | "|&" | "sequence";

export interface BashCommandEnvAssignment {
  readonly name: string | undefined;
  readonly value: string | undefined;
}

export interface BashCommandRedirect {
  readonly fileDescriptor: number | undefined;
  readonly operator: Redirect["operator"];
  readonly target: string;
}

export interface BashCommandInvocation {
  readonly argv: string[];
  /** 与 argv 平行：该词在源码里是否被引号完整包裹（LOW-16 全引号降级判定用）。 */
  readonly argvFullyQuoted: boolean[];
  readonly commandText: string;
  readonly envAssignments: BashCommandEnvAssignment[];
  readonly hasAssignmentPrefix: boolean;
  readonly hasDynamicWords: boolean;
  readonly hasRedirects: boolean;
  readonly name: string;
  /** 命令词（argv[0]）本身含动态展开（`$()`、反引号、参数展开等）（MEDIUM-1）。 */
  readonly nameIsDynamic: boolean;
  readonly operatorBefore?: BashCommandOperator;
  readonly redirects: BashCommandRedirect[];
}

export interface BashCommandAnalysis {
  readonly commands: BashCommandInvocation[];
  readonly hasDynamicWords: boolean;
  readonly hasParseErrors: boolean;
  readonly hasRedirects: boolean;
  readonly hasUnsupportedSyntax: boolean;
  readonly unsupportedNodeTypes: string[];
}

const MAX_BASH_PARSE_LENGTH = 10_000;
const SUPPORTED_CONTAINER_NODES = new Set(["AndOr", "Pipeline", "Statement"]);

export function analyzeBashCommand(command: string): BashCommandAnalysis {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return emptyAnalysis();
  }
  if (command.length > MAX_BASH_PARSE_LENGTH) {
    return {
      ...emptyAnalysis(),
      hasParseErrors: true,
    };
  }

  let script: Script & { errors?: unknown[] };
  try {
    script = parse(command);
  } catch {
    return {
      ...emptyAnalysis(),
      hasParseErrors: true,
    };
  }

  const analysis: MutableBashCommandAnalysis = {
    commands: [],
    hasDynamicWords: false,
    hasParseErrors: Boolean(script.errors?.length),
    hasRedirects: false,
    unsupportedNodeTypes: new Set(),
  };

  for (let index = 0; index < script.commands.length; index += 1) {
    collectStatementCommands(command, script.commands[index]!, {
      analysis,
      operatorBefore: index === 0 ? undefined : "sequence",
      statementRedirects: [],
    });
  }

  return freezeAnalysis(analysis);
}

export function isBashCommandPermissionSafe(analysis: BashCommandAnalysis): boolean {
  return !analysis.hasParseErrors && !analysis.hasUnsupportedSyntax && !analysis.hasDynamicWords;
}

/**
 * 安全加固 P2：「递归/强制删除类调用」的结构特征（纯数据，不含任何执行语义）。
 * 供权限层的旁路免疫熔断器（permission/bypass-immune-breakers.ts）判定
 * 「空变量根删除」形态：hasDynamicWords=true 表示路径参数含未解析展开，
 * pathArguments 是去掉旗标后的字面路径参数。
 */
export interface ForcedDeleteCandidate {
  readonly hasDynamicWords: boolean;
  readonly pathArguments: readonly string[];
}

/**
 * 从 AST 分析结果里提取删除类调用的危险特征。程序名集合与旗标判定由调用方注入
 * （策略属于权限层，本模块只做结构查询）；本函数不执行、不改写任何命令文本。
 */
export function extractForcedDeleteCandidates(
  analysis: BashCommandAnalysis,
  programNames: ReadonlySet<string>,
  isRecursiveOrForceFlag: (arg: string) => boolean,
): readonly ForcedDeleteCandidate[] {
  const candidates: ForcedDeleteCandidate[] = [];
  for (const invocation of analysis.commands) {
    if (!programNames.has(invocation.name.toLowerCase())) continue;
    const args = invocation.argv.slice(1);
    if (!args.some(isRecursiveOrForceFlag)) continue;
    candidates.push({
      hasDynamicWords: invocation.hasDynamicWords,
      pathArguments: args.filter((arg) => !arg.startsWith("-")),
    });
  }
  return candidates;
}

interface MutableBashCommandAnalysis {
  commands: BashCommandInvocation[];
  hasDynamicWords: boolean;
  hasParseErrors: boolean;
  hasRedirects: boolean;
  unsupportedNodeTypes: Set<string>;
}

interface CollectContext {
  analysis: MutableBashCommandAnalysis;
  operatorBefore?: BashCommandOperator;
  statementRedirects: Redirect[];
}

function collectStatementCommands(
  source: string,
  statement: Statement,
  context: CollectContext,
): void {
  if (statement.background) {
    context.analysis.unsupportedNodeTypes.add("background");
  }
  if (statement.redirects.length > 0) {
    context.analysis.hasRedirects = true;
    if (redirectsHaveDynamicWords(statement.redirects)) context.analysis.hasDynamicWords = true;
  }

  collectNodeCommands(source, statement.command, {
    ...context,
    statementRedirects: [...context.statementRedirects, ...statement.redirects],
  });
}

function collectNodeCommands(source: string, node: Node, context: CollectContext): void {
  switch (node.type) {
    case "Command":
      collectSimpleCommand(source, node, context);
      return;
    case "AndOr":
      collectAndOrCommands(source, node, context);
      return;
    case "Pipeline":
      collectPipelineCommands(source, node, context);
      return;
    case "Statement":
      collectStatementCommands(source, node, context);
      return;
    default:
      context.analysis.unsupportedNodeTypes.add(node.type);
  }
}

function collectAndOrCommands(source: string, node: AndOr, context: CollectContext): void {
  for (let index = 0; index < node.commands.length; index += 1) {
    collectNodeCommands(source, node.commands[index]!, {
      ...context,
      operatorBefore: index === 0 ? context.operatorBefore : node.operators[index - 1],
    });
  }
}

function collectPipelineCommands(source: string, node: Pipeline, context: CollectContext): void {
  for (let index = 0; index < node.commands.length; index += 1) {
    collectNodeCommands(source, node.commands[index]!, {
      ...context,
      operatorBefore: index === 0 ? context.operatorBefore : node.operators[index - 1],
    });
  }
}

function collectSimpleCommand(source: string, command: Command, context: CollectContext): void {
  const redirects = [...context.statementRedirects, ...command.redirects];
  const words = [command.name, ...command.suffix].filter(isWord);
  // HIGH-4（对抗复审）：unbash 对无命令词语句（`> /etc/passwd`）会整体丢弃
  // redirects，解析出空 argv——同一截断写行为少写一个命令词就完全逃逸分级
  // （`: > /etc/passwd` 是 catastrophic，`> /etc/passwd` 却是 safe）。对无词、无
  // 赋值前缀、AST 无 redirects 的 Command 节点，对原始文本做词法重定向提取，产出
  // 与 AST 同形的 redirects（截断与否的判定单一事实源仍是消费方的
  // isTruncatingRedirect）。
  const wordless = words.length === 0 && command.prefix.length === 0 && redirects.length === 0;
  const lexicalRedirects = wordless
    ? extractLexicalRedirects(source.slice(command.pos, command.end))
    : [];
  const argv = words.map(wordValue);
  const envAssignments = command.prefix.map((assignment) => ({
    name: assignment.name,
    value: assignment.value ? wordValue(assignment.value) : undefined,
  }));
  const effectiveRedirects: BashCommandRedirect[] = [
    ...redirects.map((redirect) => ({
      fileDescriptor: redirect.fileDescriptor,
      operator: redirect.operator,
      target: redirectTargetValue(redirect),
    })),
    ...lexicalRedirects,
  ];
  const hasDynamicWords =
    words.some(wordHasDynamicParts) ||
    command.prefix.some(
      (assignment) => assignment.value !== undefined && wordHasDynamicParts(assignment.value),
    ) ||
    redirectsHaveDynamicWords(redirects) ||
    lexicalRedirects.some((redirect) => /[$`%]/.test(redirect.target));

  if (hasDynamicWords) context.analysis.hasDynamicWords = true;
  if (effectiveRedirects.length > 0) context.analysis.hasRedirects = true;

  const name = command.name ? wordValue(command.name) : "";
  context.analysis.commands.push({
    argv,
    argvFullyQuoted: words.map((word) => wordFullyQuoted(source, word)),
    commandText: source.slice(command.pos, command.end),
    envAssignments,
    hasAssignmentPrefix: command.prefix.length > 0,
    hasDynamicWords,
    hasRedirects: effectiveRedirects.length > 0,
    name,
    // MEDIUM-1（对抗复审）：命令词本身是运行时计算（`$(echo rm) -rf ~`、
    // `rm$IFS-rf$IFS~`）时分级查表无从下手——上游按 name 查表不中即放行。
    nameIsDynamic:
      command.name !== undefined &&
      (wordHasDynamicParts(command.name) || /[$(`]/.test(wordValue(command.name))),
    operatorBefore: context.operatorBefore,
    redirects: effectiveRedirects,
  });
}

function redirectTargetValue(redirect: Redirect): string {
  if (redirect.target !== undefined) return wordValue(redirect.target);
  return redirect.content ?? "";
}

/**
 * HIGH-4（对抗复审）：无命令词语句的词法重定向提取。unbash 对 `> /etc/passwd`
 * 这类形态丢弃全部结构，这里只做**最粗粒度**的恢复：fd 前缀（`2>`）、12 种重定向
 * 操作符、引号感知的目标词捕获。产出的 operator/target 形态与 AST redirects 一致，
 * 截断写与否仍由消费方（bash-target-risk 的 isTruncatingRedirect）统一判定。
 */
const LEXICAL_REDIRECT_OPERATORS: readonly string[] = [
  "<<-",
  "<<<",
  "<<",
  ">>",
  "&>>",
  ">&",
  "&>",
  ">|",
  ">",
  "<&",
  "<>",
  "<",
];

function matchRedirectOperator(text: string, at: number): string | undefined {
  for (const op of LEXICAL_REDIRECT_OPERATORS) {
    if (text.startsWith(op, at)) return op;
  }
  return undefined;
}

function extractLexicalRedirects(text: string): BashCommandRedirect[] {
  const redirects: BashCommandRedirect[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    // fd 前缀：数字后紧跟操作符（`2>`）才算 fd，否则是普通词的一部分。
    let fd: number | undefined;
    let cursor = i;
    while (cursor < text.length && text[cursor]! >= "0" && text[cursor]! <= "9") cursor += 1;
    if (
      cursor > i &&
      cursor < text.length &&
      !/\s/.test(text[cursor]!) &&
      matchRedirectOperator(text, cursor) !== undefined
    ) {
      fd = Number(text.slice(i, cursor));
      i = cursor;
    }
    const operator = matchRedirectOperator(text, i);
    if (operator === undefined) {
      // 无命令词语句里的非重定向词（容错）：整词跳过。
      while (i < text.length && !/[\s<>]/.test(text[i]!)) i += 1;
      continue;
    }
    i += operator.length;
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    // 引号感知的目标词捕获（与 bash quote removal 一致地剥引号）。
    let target = "";
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\\" && i + 1 < text.length) {
        target += text[i + 1]!;
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        const quote = c;
        i += 1;
        while (i < text.length && text[i] !== quote) {
          target += text[i]!;
          i += 1;
        }
        i += 1;
        continue;
      }
      if (/\s/.test(c) || "<>;|&()".includes(c)) break;
      target += c;
      i += 1;
    }
    if (target.length > 0) {
      redirects.push({
        fileDescriptor: fd,
        operator: operator as Redirect["operator"],
        target,
      });
    }
  }
  return redirects;
}

/**
 * LOW-16（对抗复审）：该词在源码里是否被引号完整包裹（`"~/.ssh"`、`'~/{a,b}'`）。
 * 引号内 bash 不做 tilde/brace 展开，catastrophic 会变成无申诉的永久拒绝——
 * 消费方据此降 confirm。宽松近似：以配对引号开头并以其结尾即视为完整包裹。
 */
function wordFullyQuoted(source: string, word: Word): boolean {
  const raw = source.slice(word.pos, word.end);
  if (raw.length < 2) return false;
  const first = raw[0]!;
  return (first === "'" || first === '"') && raw.endsWith(first);
}

function redirectsHaveDynamicWords(redirects: Redirect[]): boolean {
  return redirects.some((redirect) => {
    return (
      (redirect.target !== undefined && wordHasDynamicParts(redirect.target)) ||
      (redirect.body !== undefined && wordHasDynamicParts(redirect.body))
    );
  });
}

function wordHasDynamicParts(word: Word): boolean {
  // 命令替换和进程替换会在主命令前执行，权限判断不能把它们当成普通 argv。
  return word.parts?.some(partHasDynamicExecution) ?? false;
}

function partHasDynamicExecution(part: WordPart): boolean {
  switch (part.type) {
    case "AnsiCQuoted":
    case "Literal":
    case "SingleQuoted":
      return false;
    case "DoubleQuoted":
    case "LocaleString":
      return part.parts.some(partHasDynamicExecution);
    case "CommandExpansion":
    case "ProcessSubstitution":
      return true;
    case "ArithmeticExpansion":
    case "BraceExpansion":
    case "ExtendedGlob":
    case "ParameterExpansion":
    case "SimpleExpansion":
      return true;
    default:
      return true;
  }
}

function wordValue(word: Word): string {
  return word.value ?? word.text;
}

function isWord(word: Word | undefined): word is Word {
  return word !== undefined;
}

function emptyAnalysis(): BashCommandAnalysis {
  return {
    commands: [],
    hasDynamicWords: false,
    hasParseErrors: false,
    hasRedirects: false,
    hasUnsupportedSyntax: false,
    unsupportedNodeTypes: [],
  };
}

function freezeAnalysis(analysis: MutableBashCommandAnalysis): BashCommandAnalysis {
  const unsupportedNodeTypes = [...analysis.unsupportedNodeTypes].filter(
    (type) => !SUPPORTED_CONTAINER_NODES.has(type),
  );

  return {
    commands: analysis.commands,
    hasDynamicWords: analysis.hasDynamicWords,
    hasParseErrors: analysis.hasParseErrors,
    hasRedirects: analysis.hasRedirects,
    hasUnsupportedSyntax: unsupportedNodeTypes.length > 0,
    unsupportedNodeTypes,
  };
}
