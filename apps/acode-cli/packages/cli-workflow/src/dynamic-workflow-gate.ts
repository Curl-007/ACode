import { join } from "node:path";
// W1-R3 宿主解耦（spec 规则 3）：常量定义在 @acode/contracts（新包公开面 re-export 同一常量），
// 引擎不再从 bootstrap 的 bundled-skills.ts 反向取用。
import {
  DYNAMIC_WORKFLOW_SKILL_NAME,
  RUN_WORKFLOW_SKILL_NAME,
  type SkillRoot,
} from "@acode/contracts";

/**
 * App 装配层按两道工作流开关（dwf 总闸 + 脚本工作流产品开关）过滤配套技能。
 * 工具面的减法在 core 的 registerBuiltInTools，`/` 目录与 `/workflow`、`/ultracode` 展开的
 * 减法分别在 acode-protocol/slash-commands.ts 与 builtin-prompt-command.ts；这里只放需要
 * bootstrap 侧路径推导的技能剔除，两道门的矩阵见 collectWorkflowDisabledSkillPaths。
 */

const SKILL_MANIFEST_FILE_NAME = "SKILL.md";

/**
 * 受 dwf 总闸管辖的两份编写契约：dwf 的 `dynamic-workflows`（CreateWorkflow 家族）
 * 与脚本工作流的 `script-workflows`（RunWorkflow）。
 *
 * 为什么 dwf 总闸管两份：core 的 GATED_WORKFLOW_TOOL_NAMES 把 dwf 十个工具与 RunWorkflow
 * 一起下架，技能面必须跟着同一结论走。少剔一份的后果不是「多一段没用的文档」——那两份技能都写着
 * 「未加载就拒绝接受脚本」，留着一份指向已下架工具的编写契约，只会让模型加载它、然后对着一个
 * 不存在的工具反复重试。
 */
const GATED_WORKFLOW_SKILL_NAMES: readonly string[] = [
  DYNAMIC_WORKFLOW_SKILL_NAME,
  RUN_WORKFLOW_SKILL_NAME,
];

/**
 * 动态工作流关闭时要从技能发现中剔除的 SKILL.md 绝对路径。
 *
 * 为什么按路径而不是按 root 过滤：NodeSkillAdapter 只提供 `disabledPaths` 这一个剔除机制
 * （config.json 的 `skill.<path>.enable=false` 走的也是它）。传入的是内置技能包的根
 * （bundled-skills.ts），路径不存在时只是一个永不命中的 Set 成员，没有副作用；技能包日后再放
 * 与动态工作流开关无关的技能时，它们也不会被连坐。
 */
export function collectDynamicWorkflowDisabledSkillPaths(
  bundledSkillRoots: readonly SkillRoot[],
): string[] {
  return bundledSkillRoots.flatMap((root) =>
    GATED_WORKFLOW_SKILL_NAMES.map((skillName) =>
      join(root.path, skillName, SKILL_MANIFEST_FILE_NAME),
    ),
  );
}

/**
 * 技能面的两道工作流开关矩阵（P2 修复：第二道 script 门此前没接到技能面）。判定与门
 * 推导同址；结论必须与工具注册门、reminder 门、命令面一致
 * （ultracode-keyword.ts:54「技能面……必须同结论」）：
 *
 * - `dynamicWorkflowEnabled === false`（dwf 总闸）：GATED_WORKFLOW_SKILL_NAMES 两份全剔——
 *   十个创作工具与 RunWorkflow 一起下架，两份编写契约都指向不存在的工具；
 * - `scriptWorkflowEnabled === false`（脚本工作流自己的产品开关，dwf 总闸开着）：只再剔
 *   `RUN_WORKFLOW_SKILL_NAME` 一份——此时 dwf 十工具仍在场，`dynamic-workflows` 技能必须
 *   保留，只把指向已下架 RunWorkflow 的那份摘掉；
 * - 两门都关：并集去重（script-workflows 的路径在两份名单里都出现，不能重复登记）；
 * - 极性与工具注册门一致：只有**显式 false** 才剔（缺席 = 调用方不参与门控 = 全保留）。
 */
export function collectWorkflowDisabledSkillPaths(input: {
  bundledSkillRoots: readonly SkillRoot[];
  dynamicWorkflowEnabled?: boolean;
  scriptWorkflowEnabled?: boolean;
}): string[] {
  const paths = new Set<string>();
  if (input.dynamicWorkflowEnabled === false) {
    for (const path of collectDynamicWorkflowDisabledSkillPaths(input.bundledSkillRoots)) {
      paths.add(path);
    }
  }
  if (input.scriptWorkflowEnabled === false) {
    for (const root of input.bundledSkillRoots) {
      paths.add(join(root.path, RUN_WORKFLOW_SKILL_NAME, SKILL_MANIFEST_FILE_NAME));
    }
  }
  return [...paths];
}
