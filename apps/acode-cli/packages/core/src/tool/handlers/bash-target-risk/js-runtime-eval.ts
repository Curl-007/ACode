// JS 运行时（node/bun）内联 eval 旗标的词汇与纯谓词。
//
// 背景（用户报告「门禁不认 node -e 内联脚本」的根因）：node/bun/deno 在 grammar.ts
// 的 WRAPPER_PROGRAMS 里——`npx rimraf ~` 一类的真实动词在参数里，必须解包分级。
// 但 `node -e "<JS>"` 的旗标值是 **JS 源码**，不是 shell 命令；本层按设计不解析 JS
// （spec bash-target-blast-radius.md R6「node -e 的破坏发生在 JS 源里，本层看不见」、
// npm-script-body-scan.md R7 同登记）。此前 assess.ts 的解包循环不认 node 的
// `-e/--eval/-p/--print` 取值，把 JS 源首 token 当「程序名」分级，产生两类误报：
//   A. 动态命令名启发式：`node -e "console.log(1)"` 的 `(` 命中 `/[$(`]/` → confirm；
//   B. wrapper payload 不可见：`node --eval="..."`（值粘连）解包到尽头无 payload →
//      wrapperPayloadUnknown("node") → confirm。
// confirm 把 capability 升到 critical，并在 yolo/build 触发 J1-2 反射门首轮 deny——
// 良性内联脚本被门禁拒绝，正是用户所见。
//
// 修复口径：这些运行时的内联 eval 旗标按「取值＝不透明 JS 源」处理——停止解包、
// 不追加 payload 不可见 confirm。命令替换 `$(...)`/反引号在双引号内仍由 bash 先行
// 展开，由 assessInvocation 的 substitutionScanTexts 独立覆盖（不经本层），故
// `node -e "x=$(rm -rf ~)"` 仍 catastrophic；无 eval 旗标的 `node rimraf ~` 仍按
// 破坏性动词解包 → catastrophic。deno 的内联形态是子命令 `deno eval "<src>"`，其
// `eval` 词本就落「非破坏性 program → safe」，无需在此登记。

/** 有内联 eval 旗标、且其值为不透明 JS 源的运行时。 */
const JS_RUNTIME_EVAL_PROGRAMS: ReadonlySet<string> = new Set(["node", "bun"]);

/** 独立取值的内联 eval 旗标（值在下一个 token）：node/bun 的 `-e/--eval/-p/--print`。 */
const INLINE_EVAL_VALUE_FLAGS: ReadonlySet<string> = new Set(["-e", "--eval", "-p", "--print"]);

/** 粘连取值形态（JS 源在 `=` 之后，无需消费下一个 token）。 */
const INLINE_EVAL_EQUALS_PREFIXES: readonly string[] = ["--eval=", "--print="];

/** 求值/打印短旗标簇（`-pe`、`-ep`）：值在下一个 token。 */
const INLINE_EVAL_CLUSTER_PATTERN = /^-[pe]{1,2}$/;

/**
 * 该 token 是否是 JS 运行时（node/bun）的内联 eval 旗标——其值是 JS 源，不是 shell
 * 命令，本层不解析（见文件头 spec 依据）。program 须为归一后的 basename（调用方
 * assess.ts 的解包循环已按 programBasename 归一）。命中即「不透明 JS 源」，调用方
 * 据此停止解包、不升级 confirm。
 */
export function isJsRuntimeInlineEvalFlag(program: string, token: string): boolean {
  if (!JS_RUNTIME_EVAL_PROGRAMS.has(program)) return false;
  return (
    INLINE_EVAL_VALUE_FLAGS.has(token) ||
    INLINE_EVAL_CLUSTER_PATTERN.test(token) ||
    INLINE_EVAL_EQUALS_PREFIXES.some((prefix) => token.startsWith(prefix))
  );
}
