/**
 * `hole<T>(stage, prompt)` 调用的编译期校验（挖洞-填充）。
 *
 * 三条规则，同一个理由——**停靠必须在提交前就说清楚它等的是什么、站在哪里**：
 *   1. stage/prompt 是编译期字面量且非空：停靠行是观察面（通知、侧栏、fill 文件名）要
 *      展示的对象，与 `phase()` 的名字、`world.run` 的 cmd 同姿态——运行期才成形的停靠
 *      站没有可展示的东西；
 *   2. 调用必须是 `await` 的独立语句：splice（FillWorkflowHole）把洞调用**整体**替换成
 *      `await (async () => { <语句> })()`，一个待在初始化器/实参/三元臂里的洞没有可替换
 *      的语句位；而且 `await hole(...)` 之外的形态（赋值给变量、作为表达式求值）意味着
 *      作者想拿它的**值**——缺数据应该用 ask，不是洞；
 *   3. 不得出现在函数嵌套内（funcDepth > 0，首当其冲是 fan-out 回调）：回调体逐元素并发
 *      执行，一个等作者提交代码才解锁的停靠会把整个 fan-out 挂死在没人能填的位置上
 *      （元素已经在跑，洞却欠着一段还没写的代码）。**例外**：就地立即调用的 IIFE
 *      （`(async () => { … })()`）对 funcDepth 透明——它是外层语句的就地延伸而非回调，
 *      挖洞-填充的 splice 产物正是这个形态，fill 语句里允许再留 tail hole（嵌套生长）。
 *
 * 别名逃逸（`const h = hole`）不在这里——hole 是 facade 函数声明，facade-misuse 的
 * pass 1 拒绝任何非直接调用位置的引用；pass 2 的「site-producing 却没被 site 掉」是
 * misuse 兜底，与本趟的三条规则互补。
 */

import ts from "typescript";
import type { CompileDiagnostic, ScriptLoc, WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";

/** hole 调用的诊断码（9001 = facade-siting、9002 = schema、9003 = world-run、9004 = phase，顺延）。 */
export const HOLE_CALL_CODE = 9005;

const LITERAL_MESSAGE =
  "hole()'s stage and prompt must be compile-time string literals (\"triage\" or a " +
  "no-substitution template): they label the station the run parks on — the notification, " +
  "the run panel row and the fill file all show them — so a value that only exists at run " +
  "time has nothing to present. Interpolate what the decision needs into the prompt and " +
  "write the names inline.";

const EMPTY_MESSAGE =
  'hole("", …) has no station to name: the stage is what the run panel row and the fill ' +
  'file are called after. Give the gap a short, user-facing name ("决定分组", "triage the ' +
  'first failure"), in the user\'s language.';

const STATEMENT_MESSAGE =
  "hole(...) must be awaited in a spliceable statement position (`await hole(...);`, " +
  "`return await hole(...);` or `const v = await hole(...);`): an unawaited `hole(...)` or one " +
  "in an argument/ternary reads the call's VALUE, but a hole yields code, not data — when " +
  "only the data is missing, use a subagent ask. Those three positions are exactly where " +
  "FillWorkflowHole splices the body in as await (async () => { … })().";

const CALLBACK_MESSAGE =
  "hole(...) must not appear inside a callback or any nested function (a fan-out body like " +
  "xs.map(...), a helper function, an event handler): the surrounding callback runs once per " +
  "item and in parallel, while the hole parks until its body is written — the items would " +
  "wait on a gap nobody can fill for them. Hoist the decision out of the callback (ask for " +
  "the per-item values with a subagent, or decide once before the fan-out).";

/**
 * 校验收集到的 hole 站点。非空即脚本不可提交（`analyzeWorkflowScript` 与 phase / world.run
 * 同席处理）。一个洞可以同时犯多条（如回调里的 `const x = hole(s)`），全报：作者一次看全。
 */
export function collectHoleDiagnostics(
  workflow: WorkflowProgram,
  table: SiteTable,
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const push = (loc: ScriptLoc, message: string): void => {
    diagnostics.push({ code: HOLE_CALL_CODE, column: loc.column, line: loc.line, message });
  };

  for (const hole of table.holes) {
    // stage/prompt 的诊断落在出问题的表达式上（缺席时退回调用位置），与 phase 标记同姿态。
    const stageLoc =
      hole.stageExpr === undefined
        ? hole.loc
        : workflow.toScriptLoc(hole.stageExpr.getStart(workflow.scriptFile));
    if (hole.stage === undefined || hole.prompt === undefined) {
      push(stageLoc, LITERAL_MESSAGE);
    } else if (hole.stage.trim() === "" || hole.prompt.trim() === "") {
      push(stageLoc, EMPTY_MESSAGE);
    }
    if (hole.funcDepth > 0) {
      push(hole.loc, CALLBACK_MESSAGE);
      // 回调内的洞不再报语句形态：位置规则已被更深的那条覆盖，两条同点重复只会淹没要点。
      continue;
    }
    if (!isAwaitedStatement(hole.call)) {
      push(hole.loc, STATEMENT_MESSAGE);
    }
  }
  return diagnostics;
}

/**
 * `await hole(...)` 且这个 await 是**可替换语句位的直接操作数**，三种形态：
 *   - 独立语句 `await hole(...);`
 *   - return 语句 `return await hole(...);`（尾洞的生长惯用法，splice 后即
 *     `return await (async () => { … })();`）
 *   - 变量初始化 `const v = await hole(...);`（中段取值惯用法：fill 的 `return X` 即 v 的值，
 *     splice 后 `const v = await (async () => { … })();`）
 * 三者 FillWorkflowHole 都能把洞调用整体替换成 IIFE 且语义不漂移；其余形态（未 await、
 * 实参、三元臂、赋值右侧）没有这样的语句位，或意味着作者在读洞的**值**——那是 ask。
 */
function isAwaitedStatement(call: ts.CallExpression): boolean {
  const awaitNode = call.parent;
  if (!ts.isAwaitExpression(awaitNode)) return false;
  return (
    ts.isExpressionStatement(awaitNode.parent) ||
    ts.isReturnStatement(awaitNode.parent) ||
    ts.isVariableDeclaration(awaitNode.parent)
  );
}
