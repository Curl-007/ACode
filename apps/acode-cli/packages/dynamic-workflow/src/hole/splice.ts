/**
 * 洞的 splice（挖洞-填充，specs/workflow-holes.md）：把作者提交的 fill **语句**替换进脚本
 * 草稿——`await hole<T>(stage, prompt)` 的**洞调用表达式**整体变成
 * `await (async () => { <语句> })()`。
 *
 * 实现形态（AST 定位 + fill 自上下文重打印 + 区间替换；产物全量重编译）：
 *   1. 定位按**节点身份**：站点表持有的 `call` 节点（ts.Node 相等）在 wrapped 文本里取精确
 *      起止区间——绝不按名字/形状重新识别（与 lowering 同一条纪律，不造第二份真相）；
 *   2. fill 语句先**用自己的源文件上下文重打印**成规范文本（TypeScript printer 按节点位置
 *      从传入的 sourceFile 提取字面量原文——跨文件嵌入的节点会打印出错位文本，实测如此，
 *      所以不能把 fill 文件里 parse 出的节点直接塞进脚本树里一起打印）；
 *   3. 区间替换是「一个完整表达式 → 一个完整带括号的表达式」：块平衡不可能被打破，缩进
 *      与行号偏移对产物无意义——诊断在产物上**重新编译**得出，不携带旧坐标；
 *   4. 产物必然再走完整编译/分析管线（调用方保证；fill 引用的绑定、类型、新 world.run
 *      命令都在那里裁决）。
 *
 * splice 的语义钉死（filled-once-run-per-reach）：IIFE 位于原洞位置，后续轮次直接执行
 * body、只有首次到达停靠；fill 语句里允许再留 `hole()`（嵌套生长——它在新脚本的编译里
 * 拿自己的 `hole#N` 站点 id）。
 */

import ts from "typescript";
import {
  collectDiagnostics,
  createWorkflowProgram,
  SCRIPT_EPILOGUE,
  SCRIPT_PRELUDE,
  type CompileDiagnostic,
} from "../compiler/compile.js";
import { collectSites } from "../analysis/sites.js";

/** splice 的结构化失败原因。三者对调用方是三个不同的下一步（改 fill / 换 hole_ref / 修脚本）。 */
export type HoleSpliceFailureReason =
  /** 草稿里没有这个站点 id：hole_ref 拼错，或前驱脚本已换（stale 引用）。 */
  | "hole_not_found"
  /** fill 本身语法不成立（不是一串语句，或是空语句串）。诊断按 fill 文件自己的坐标给。 */
  | "fill_invalid"
  /** 草稿自身编不过（等待中的 run 不该发生；防御，拒绝 splice）。 */
  | "script_invalid";

export type HoleSpliceResult =
  | { ok: true; scriptText: string }
  | { ok: false; reason: HoleSpliceFailureReason; diagnostics: CompileDiagnostic[] };

/**
 * 把 `fill`（一串**语句**）splice 进 `scriptText` 里站点 id 为 `siteId`（`hole#N`）的洞。
 *
 * 纯函数、确定性：同一对输入逐字节相同的输出。诊断坐标全部落在作者坐标（fill 的行号是
 * fill 文件自己的行号，脚本的行号是脚本自己的行号）。
 */
export function spliceWorkflowHole(scriptText: string, siteId: string, fill: string): HoleSpliceResult {
  // fill 先做纯语法检查：一串不成立的语句不值得起一次 Program。transpileModule 只报
  // 句法诊断（不做类型检查），坐标就是 fill 文本自己的行/列——模型改的正是这个文件。
  const fillDiagnostics = transpileDiagnostics(fill);
  if (fillDiagnostics.length > 0) {
    return { ok: false, reason: "fill_invalid", diagnostics: fillDiagnostics };
  }

  const workflow = createWorkflowProgram(scriptText);
  const scriptDiagnostics = collectDiagnostics(workflow.program);
  if (scriptDiagnostics.length > 0) {
    return { ok: false, reason: "script_invalid", diagnostics: scriptDiagnostics };
  }

  const table = collectSites(workflow);
  const hole = table.holes.find((candidate) => candidate.id === siteId);
  if (hole === undefined) {
    return { ok: false, reason: "hole_not_found", diagnostics: [] };
  }

  // fill 语句用**它自己的源文件**重打印（见模块头注释的打印机限制）：这一步同时把 fill
  // 的缩进/引号形态归一。空语句串在这里拒绝——空 fill 是「声称补上了洞的 no-op」。
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  const fillFile = ts.createSourceFile("workflow-hole-fill.ts", fill, ts.ScriptTarget.ES2022, true);
  if (fillFile.statements.length === 0) {
    return {
      ok: false,
      reason: "fill_invalid",
      diagnostics: [
        {
          code: 9005,
          column: 1,
          line: 1,
          message:
            "A fill must contain at least one statement — the body the hole's splice runs. " +
            "An empty fill would splice in a no-op while claiming the gap was closed; if the " +
            "hole should stand, do not fill it at all.",
        },
      ],
    };
  }
  const fillPrinted = fillFile.statements
    .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, fillFile))
    .join("\n");

  // 区间替换：洞调用（`hole<T>("stage","prompt")`，含类型实参）整体换成带括号的 IIFE，
  // 外层的 `await` / `return await` 原样保留（9005 诊断已保证洞一定在这样的语句位上）。
  const wrapped = workflow.scriptFile.text;
  const start = hole.call.getStart(workflow.scriptFile);
  const end = hole.call.end;
  const replacement = `(async () => {\n${fillPrinted}\n})()`;
  const splicedWrapped = `${wrapped.slice(0, start)}${replacement}${wrapped.slice(end)}`;
  return { ok: true, scriptText: splicedWrapped.slice(SCRIPT_PRELUDE.length, splicedWrapped.length - SCRIPT_EPILOGUE.length) };
}

/** fill 的句法诊断（transpileModule 只做句法分析；坐标即 fill 文本自己的坐标）。 */
function transpileDiagnostics(fill: string): CompileDiagnostic[] {
  const { diagnostics } = ts.transpileModule(fill, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      newLine: ts.NewLineKind.LineFeed,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  return (diagnostics ?? []).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      return { code: diagnostic.code, column: 1, line: 1, message };
    }
    const { character, line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return { code: diagnostic.code, column: character + 1, line: line + 1, message };
  });
}
