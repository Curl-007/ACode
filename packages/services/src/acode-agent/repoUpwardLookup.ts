// ============================================================
// 仓库内相对路径的向上查找（叶子模块，零跨包依赖）
//
// 从 process.cwd() 逐级向上找 <current>/<relativePath> 是否存在。用于在 monorepo dev 态
// 定位仓库内产物（如 apps/acode-cli/packages/cli/dist/acode.cjs），不依赖 cwd 恰好在仓库根。
//
// 抽成独立模块的理由：acodeAgentProcessManager.ts 与 storageEntryResolver.ts 都需要它，
// 两处各写一份会形成重复实现（根 AGENTS.md「避免重复状态和多条写入路径」）。
// ============================================================

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 从 process.cwd() 向上查找仓库内相对路径，命中即返回绝对路径，到文件系统根仍未命中返回 null。
 *
 * 同步 existsSync 是既有契约（command resolver 全链同步，调用方在同步上下文里取命令），
 * 不是遗漏：改成异步会波及 resolveDefaultACodeAgentCommand 的所有调用点。
 */
export function findUpwardRepoFile(relativePath: string): string | null {
  let current = process.cwd();
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    // 到文件系统根（parent === current）仍未命中。
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
