import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findACodeAgentRuntimeNodeBundle } from "../runtime-tools/providerRuntimeResolver.js";

/** bundled 内容包内的内置技能目录：<pack root>/skills，与 agents/ 平级（specs/skills-bundled-visibility-and-official-cache-authority.md I1）。 */
const BUNDLED_PACK_SKILLS_SEGMENTS = ["packages", "bundled-skills", "skills"] as const;

/**
 * 按与 agent spawn（acode.cjs）同一条资源定位链推导内置技能目录。
 *
 * 与 subagentStorage.ts resolveBundledAgentsRoot 同款候选推导（findACodeAgentRuntimeNodeBundle
 * 同级目录 + monorepo cwd 候选），仅把末端段从 agents 换成 skills。找不到返回 undefined，
 * 调用方按缺省姿态降级（设置页不显示「内置技能」分组、不报错、不伪造条目）。
 *
 * TODO：与 subagentStorage.ts:22-24 的既有 TODO 同源——待 services/desktop → bootstrap
 * 依赖方向确认合法后，两条候选推导一并收敛到 @acode/bootstrap 导出的 resolveBundledContentPackRoot；
 * 本文件必须与该 TODO 互相引用，防止第三份候选布局滋生。
 *
 * 边界（specs/skills-bundled-visibility-and-official-cache-authority.md I1 边界诚实声明）：
 * 本解析指向「与 agent spawn 同一条资源定位链上的 staged 内容包」，与 CLI 进程实际加载的
 * bundled 根在桌面/远端形态下是同一份目录；SEA 单二进制形态无设置页（headless），不在覆盖内。
 * 若未来出现「CLI 实际加载根 ≠ host 解析根」的部署形态，需回到协议下发方案重新评估。
 */
export function resolveBundledSkillsRoot(): string | undefined {
  const candidates: string[] = [];
  const nodeBundlePath = findACodeAgentRuntimeNodeBundle();
  if (nodeBundlePath) {
    candidates.push(join(dirname(nodeBundlePath), ...BUNDLED_PACK_SKILLS_SEGMENTS));
  }
  const cwd = process.cwd();
  candidates.push(resolve(cwd, "apps", "acode-cli", ...BUNDLED_PACK_SKILLS_SEGMENTS));
  candidates.push(resolve(cwd, "..", "..", "apps", "acode-cli", ...BUNDLED_PACK_SKILLS_SEGMENTS));
  // 与 providerRuntimeResolver 的启动期资源定位同款：装配是同步上下文，只做存在性探测。
  return candidates.find((candidate) => existsSync(candidate));
}
