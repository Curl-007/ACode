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
  readonly commandText: string;
  readonly envAssignments: BashCommandEnvAssignment[];
  readonly hasAssignmentPrefix: boolean;
  readonly hasDynamicWords: boolean;
  readonly hasRedirects: boolean;
  readonly name: string;
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
  const argv = words.map(wordValue);
  const envAssignments = command.prefix.map((assignment) => ({
    name: assignment.name,
    value: assignment.value ? wordValue(assignment.value) : undefined,
  }));
  const hasDynamicWords =
    words.some(wordHasDynamicParts) ||
    command.prefix.some(
      (assignment) => assignment.value !== undefined && wordHasDynamicParts(assignment.value),
    ) ||
    redirectsHaveDynamicWords(redirects);

  if (hasDynamicWords) context.analysis.hasDynamicWords = true;
  if (redirects.length > 0) context.analysis.hasRedirects = true;

  const name = command.name ? wordValue(command.name) : "";
  context.analysis.commands.push({
    argv,
    commandText: source.slice(command.pos, command.end),
    envAssignments,
    hasAssignmentPrefix: command.prefix.length > 0,
    hasDynamicWords,
    hasRedirects: redirects.length > 0,
    name,
    operatorBefore: context.operatorBefore,
    redirects: redirects.map((redirect) => ({
      fileDescriptor: redirect.fileDescriptor,
      operator: redirect.operator,
      target: redirectTargetValue(redirect),
    })),
  });
}

function redirectTargetValue(redirect: Redirect): string {
  if (redirect.target !== undefined) return wordValue(redirect.target);
  return redirect.content ?? "";
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
