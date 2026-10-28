// ============================================================
// 世界读取的执行侧（Boundary B 的 executeWorldRead）
// ============================================================
// 从 workflow-driver.ts 里分出来的一半。driver 那边是 actor 会话、turn 编排与 submit 桥接；
// 这边是"把一个 (op, args) 变成一次真实的只读观察"——两者唯一的接触面是
// {@link executeWorldRead}，且这一半完全不碰会话、模型与 journal。
//
// 三件事在这里，而且只在这里：
//   1. **每个 op 的元数与实参校验**。Boundary A 的 `worldRead(siteId, op, args)` 只承诺
//      "实参按位置原样送达"（lowering 不看 op），所以"一个 pattern / 一个 base ref 长什么样"
//      归这一侧。
//   2. **上限的执行**。常量在纯包（`@acode/dynamic-workflow` 的 WORLD_READ_CAPS），执行在这里，
//      因为只有这一侧能"不生产"——让 ripgrep 在 2000 条上停手，胜过物化一百万条再回头量。
//   3. **git 的固定 argv**。构造在 workflow-git-world-read.ts（纯），spawn 在这里。
//
// 本文件同时是**桶文件**：原 649 行的实现已按职责拆成三个叶（拆分原因：400 行文件级门禁），
// 依赖方向单向（叶 → 基础叶，本桶只 re-export）：
//   - world-read-files.ts     基础叶：WorldReadDeps、路径安全原语、实参校验器、files.read
//   - world-read-search.ts    files.glob / files.grep
//   - world-read-git-exec.ts  git.* 与 world.run 的端口执行侧
// 所有公开符号仍从本文件路径导出，消费方零改动。

import { WorkflowError, type WorldReadOp } from "@acode/dynamic-workflow";
import {
  worldRead,
  worldReadOptionalCount,
  worldReadOptionalStringArgs,
  worldReadStringArgs,
  type WorldReadDeps,
} from "./world-read-files.js";
import { worldGlob, worldGrep } from "./world-read-search.js";
import {
  gitChangedFiles,
  gitDiff,
  gitLog,
  gitStatus,
  worldRun,
} from "./world-read-git-exec.js";

export { resolveWithinWorkspace, toWorkspaceRelative, type WorldReadDeps } from "./world-read-files.js";
export { worldGrep, type GrepMatch } from "./world-read-search.js";
export { worldRun, type WorldRunResult } from "./world-read-git-exec.js";

/**
 * 按 op 从**位置实参数组**里取参并执行一次世界读取。Boundary A 只承诺"实参按位置原样送达"
 * （lowering 不看 op），所以每个 op 的元数与类型校验就在这里——这一侧才是知道
 * "一个 pattern / 一个 base ref 长什么样"的那一侧。
 * 形状不符一律以结构化 `DriverError` 拒绝该节点，绝不静默强转：一个被 `String(undefined)`
 * 悄悄变成 `"undefined"` 的路径，会读出一个查不明白的失败，而不是一条能改的错误。
 *
 * 声明成 `async` 是有意的：实参校验的抛错必须变成**该节点的 promise 拒绝**。同步抛错会从
 * `engine.worldRead` 里穿出去（引擎在准入落 journal 之后才 `.then(...)`），留下一个永远
 * running 的节点。
 */
export async function executeWorldRead(
  deps: WorldReadDeps,
  op: WorldReadOp,
  args: unknown[],
): Promise<unknown> {
  switch (op) {
    case "glob":
      return await worldGlob(deps, worldReadStringArgs(op, args, ["pattern"])[0]!);
    case "read":
      return await worldRead(deps, worldReadStringArgs(op, args, ["path"])[0]!);
    case "grep": {
      const [pattern, glob] = worldReadOptionalStringArgs(op, args, ["pattern"], ["glob"]);
      return await worldGrep(deps, pattern!, glob);
    }
    case "git-changed-files": {
      const [base] = worldReadOptionalStringArgs(op, args, [], ["base"]);
      return await gitChangedFiles(deps, base);
    }
    case "git-diff": {
      const [base, path] = worldReadOptionalStringArgs(op, args, [], ["base", "path"]);
      return await gitDiff(deps, base, path);
    }
    case "git-status": {
      // 无参 op：`names` 为空即"恰好 0 个实参"，多传一个仍然大声失败。
      worldReadStringArgs(op, args, []);
      return await gitStatus(deps);
    }
    case "git-log":
      return await gitLog(deps, worldReadOptionalCount(op, args, "count"));
    case "run":
      return await worldRun(deps, args);
    default: {
      // op 词汇表由 world-read 注册表推导：新增一行而这里没接上，就会落到这里大声失败。
      const unknownOp: never = op;
      throw new WorkflowError("DriverError", `Unsupported world-read op "${String(unknownOp)}".`);
    }
  }
}
