import { join } from "node:path";
// W1-R3 宿主解耦（spec 规则 3）：常量定义在 @acode/contracts（新包公开面 re-export 同一常量），
// 引擎不再从 bootstrap 的 bundled-skills.ts 反向取用。
import {
  DYNAMIC_WORKFLOW_SKILL_NAME,
  RUN_WORKFLOW_SKILL_NAME,
  type SkillRoot,
} from "@acode/contracts";

/**
 * App 装配层按动态工作流开关过滤配套技能。
 * 工具面的减法在 core 的 registerBuiltInTools，`/` 目录与 `/workflow` 展开的减法分别在
 * acode-protocol/slash-commands.ts 与 builtin-prompt-command.ts；这里只放需要 bootstrap 侧路径推导的技能剔除。
 */

const SKILL_MANIFEST_FILE_NAME = "SKILL.md";

/**
 * 受同一道可用性开关管辖的两份编写契约：dwf 的 `dynamic-workflows`（CreateWorkflow 家族）
 * 与脚本工作流的 `script-workflows`（RunWorkflow）。
 *
 * 为什么是同一个开关：core 的 GATED_WORKFLOW_TOOL_NAMES 把 dwf 十个工具与 RunWorkflow 一起
 * 下架，技能面必须跟着同一结论走。少剔一份的后果不是「多一段没用的文档」——那两份技能都写着
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
