import { resolve } from "node:path";
import { createConfig, resolvePath } from "@acode/adapters/config";
import { createNodeSkillAdapter } from "@acode/adapters/skills";
import type { Logger, SkillContent, SkillDiagnostic, SkillLoadOutcome } from "@acode/contracts";
import { resolveBundledSkillRoots } from "./app/bundled-skills.js";
import { getCliStorageRoot } from "./app/paths.js";
import { resolveACodePlugins } from "./plugins.js";
import { collectDisabledPaths } from "./skill-command-overrides.js";

export interface ListACodeSkillsOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  workingDirectory?: string;
}

export interface InspectACodeSkillOptions extends ListACodeSkillsOptions {
  name: string;
}

export interface ACodeSkillInspection {
  diagnostics: SkillDiagnostic[];
  skill: SkillContent;
}

export async function listACodeSkills(
  options: ListACodeSkillsOptions = {},
): Promise<SkillLoadOutcome> {
  const discovery = await createSkillDiscovery(options);
  if (!discovery.enabled) {
    return {
      diagnostics: [],
      skills: [],
      totalDiscovered: 0,
    };
  }

  const outcome = await discovery.skillPort.discoverSkills({
    workingDirectory: discovery.workingDirectory,
  });
  // user-invocable:false 用户面隐藏（specs/skill-frontmatter-governance.md R6 消费
  // 接线）：三个用户可见面（/skill 列表、acode skills list、TUI slash 完成）都以本
  // 函数为清单单一来源，过滤在此一处收口（不在三处各抄一份判定）。模型面清单不受
  // 影响（runtime 走自己的 discoverSkills——「仅模型可调」技能对模型照常可见）；
  // inspect 保留但标注 hidden（见 cli skills-command 的呈现面）。
  return {
    ...outcome,
    skills: outcome.skills.filter((skill) => skill.governance?.userInvocable !== false),
  };
}

export async function inspectACodeSkill(
  options: InspectACodeSkillOptions,
): Promise<ACodeSkillInspection> {
  const discovery = await createSkillDiscovery(options);
  if (!discovery.enabled) {
    throw new Error("Skills are disabled.");
  }

  const outcome = await discovery.skillPort.discoverSkills({
    workingDirectory: discovery.workingDirectory,
  });
  if (
    !outcome.skills.some(
      (skill) => skill.name === options.name || skill.qualifiedName === options.name,
    )
  ) {
    throw new Error(`Skill not found: ${options.name}`);
  }

  const skill = await discovery.skillPort.loadSkill({
    name: options.name,
    workingDirectory: discovery.workingDirectory,
  });

  return {
    diagnostics: outcome.diagnostics,
    skill,
  };
}

async function createSkillDiscovery(options: ListACodeSkillsOptions): Promise<
  | {
      enabled: false;
      workingDirectory: string;
    }
  | {
      enabled: true;
      skillPort: ReturnType<typeof createNodeSkillAdapter>;
      workingDirectory: string;
    }
> {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult = createConfig({
    env: options.env,
    projectConfigPath: options.projectConfigPath,
    workingDirectory,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
  });

  if (!configResult.config.features.skill || !configResult.config.skills.enabled) {
    return {
      enabled: false,
      workingDirectory,
    };
  }
  const pluginOutcome = resolveACodePlugins({
    configResult,
    env: options.env,
    logger: options.logger,
    projectConfigPath: options.projectConfigPath,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
    workingDirectory,
  });

  // 内置技能包与插件技能根并列注入：`acode skills list`、引用目录与 runtime 看到同一份发现结果。
  const bundledSkillRoots = await resolveBundledSkillRoots({
    cliStorageRoot: getCliStorageRoot(resolvePath(configResult.config.storage.dir)),
    logger: options.logger,
  });

  return {
    enabled: true,
    skillPort: createNodeSkillAdapter({
      extraRoots: configResult.config.skills.roots,
      extraResolvedRoots: [...pluginOutcome.skillRoots, ...bundledSkillRoots],
      disabledPaths: collectDisabledPaths(configResult.config.skillOverrides),
    }),
    workingDirectory,
  };
}
