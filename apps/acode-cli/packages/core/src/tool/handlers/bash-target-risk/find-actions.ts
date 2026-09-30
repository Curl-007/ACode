// find 的 action 分级（J1-1）。规格见 apps/acode-cli/specs/bash-target-blast-radius.md R4。
//
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-command-risk/src/lib.rs
// 的 assess_find / read_only_find_payload，自撰 TypeScript 实现。
//
// find 的 action 是另一套 argv：搜索根只在 -delete（或破坏性 -exec payload 代入）
// 时才是删除目标，只读检查（-exec cat）不升级搜索根。

import {
  FIND_EXEC_ACTIONS,
  FIND_PAYLOAD_CUT_TOKENS,
  FIND_PRINT_ACTIONS,
  FIND_VALUE_PREDICATES,
  isFlagToken,
  programBasename,
  pushFinding,
  type SegmentAssessor,
  type TokenRunMeta,
} from "./grammar.js";
import { classifyTarget, isSafeWriteSink } from "./paths.js";
import type { TargetRiskContext, TargetRiskFinding } from "./types.js";

export function assessFind(
  tokens: readonly string[],
  meta: TokenRunMeta,
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
  depth: number,
  assessSegment: SegmentAssessor,
): void {
  const args = tokens.slice(1);

  // 搜索根：跳过 -H/-L/-P/--，取到第一个旗标/操作符为止。
  const roots: string[] = [];
  let cursor = 0;
  while (cursor < args.length) {
    const token = args[cursor]!;
    if (token === "-H" || token === "-L" || token === "-P" || token === "--") {
      cursor += 1;
      continue;
    }
    break;
  }
  while (cursor < args.length) {
    const token = args[cursor]!;
    if (isFlagToken(token) || token === "!" || token === "(") break;
    roots.push(token);
    cursor += 1;
  }
  const effectiveRoots = roots.length > 0 ? roots : ["."];

  const classifyRootsAsDeleted = (): void => {
    for (const root of effectiveRoots) {
      pushFinding(findings, classifyTarget(root, context, { recursive: true }));
    }
  };

  let index = 0;
  while (index < args.length) {
    const token = args[index]!;
    if (token === "-delete") {
      // -delete 把搜索根升级为递归删除目标。
      classifyRootsAsDeleted();
      index += 1;
      continue;
    }
    if (FIND_PRINT_ACTIONS.has(token) || token === "-fprintf") {
      const target = args[index + 1];
      if (target === undefined) {
        pushFinding(findings, {
          level: "confirm",
          reason: "`find` output target cannot be identified statically",
        });
      } else if (!isSafeWriteSink(target)) {
        pushFinding(findings, classifyTarget(target, context, { recursive: false }));
      }
      index += token === "-fprintf" ? 3 : 2;
      continue;
    }
    if (FIND_VALUE_PREDICATES.has(token)) {
      // 谓词消费字面数据：`-name '-delete'` 不是删除 action。
      index += 2;
      continue;
    }
    if (FIND_EXEC_ACTIONS.has(token)) {
      index = assessFindExec(
        args,
        index,
        meta,
        context,
        findings,
        depth,
        assessSegment,
        effectiveRoots,
      );
      continue;
    }
    index += 1;
  }
}

/** 处理一个 -exec 族 action，返回继续扫描的下标。 */
function assessFindExec(
  args: readonly string[],
  actionIndex: number,
  meta: TokenRunMeta,
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
  depth: number,
  assessSegment: SegmentAssessor,
  effectiveRoots: readonly string[],
): number {
  const start = actionIndex + 1;
  let end = args.length;
  let explicitTerminator = false;
  for (let k = start; k < args.length; k += 1) {
    const candidate = args[k]!;
    if (candidate === ";" || candidate === "+") {
      end = k;
      explicitTerminator = true;
      break;
    }
    // 未终止形态（AST 会把 `\;` 转义吃掉）：payload 到下一个 find action 为止，
    // 否则 `-exec cat {} \; -delete` 会把 -delete 吞进只读 payload 里放行。
    if (FIND_PAYLOAD_CUT_TOKENS.has(candidate)) {
      end = k;
      break;
    }
  }
  // 终止符缺失时用原始命令文本补判 `\;`，避免把常见只读形态误当未终止。
  const terminated = explicitTerminator || Boolean(meta.commandText?.includes("\\;"));
  const payload = args.slice(start, end);
  if (!isReadOnlyFindPayload(payload) || !terminated) {
    assessSegment(payload, { receivesPipe: false }, context, findings, depth + 1);
    if (payload.some((part) => part.includes("{}"))) {
      for (const root of effectiveRoots) {
        assessSegment(
          payload.map((part) => part.replaceAll("{}", root)),
          { receivesPipe: false },
          context,
          findings,
          depth + 1,
        );
      }
    }
    pushFinding(findings, {
      level: "confirm",
      reason: "`find` action may modify files and its full effects cannot be determined statically",
    });
  }
  return explicitTerminator ? end + 1 : end;
}

/** find -exec 的只读 payload 白名单：cat/readlink、sed 纯打印脚本。 */
function isReadOnlyFindPayload(payload: readonly string[]): boolean {
  const program = payload[0];
  if (program === undefined) return false;
  const name = programBasename(program);
  if (name === "cat" || name === "readlink") return true;
  if (name !== "sed") return false;
  // sed 能执行命令、能写文件（即使没有 -i）：只认「行号打印」这类纯打印脚本，
  // 不对任意 sed 代码做猜测。
  const args = payload.slice(1);
  const scriptIndex = args[0] === "-n" ? 1 : 0;
  const script = args[scriptIndex];
  if (script === undefined || !script.endsWith("p")) return false;
  const address = script.slice(0, -1);
  if (!/^[0-9,$]*$/.test(address)) return false;
  return args.slice(scriptIndex + 1).every((arg) => !arg.startsWith("-"));
}
