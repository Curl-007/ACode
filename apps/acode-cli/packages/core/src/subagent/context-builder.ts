import type { Logger, Model, ModelInputMessage } from "@acode/contracts";
import { ContextBuilder } from "../context/builder.js";
import {
  buildContextMetaUserBody,
  buildSkillsMetaUserBody,
  type ContextBuilderConfig,
  type ContextBuildResult,
  type EnvInfo,
} from "../context/index.js";
import {
  createSubagentSectionContext,
  emitSectionManifestTrace,
  resolveSectionEntries,
  resolveSectionEntriesSync,
  SUBAGENT_SECTION_REGISTRY,
  type ResolvedSection,
  type SectionContext,
} from "../context/registry.js";
import type { PromptSectionFlags } from "../context/section-flags.js";

export interface SubagentContextBuilderConfig {
  agentPrompt: string;
  currentDate?: string;
  envInfo: EnvInfo;
  model?: Model;
  skillMetadataBudget?: number;
  skills?: ContextBuilderConfig["skills"];
  userInstructions?: ContextBuilderConfig["userInstructions"];
  /** 本地诊断旗标显式覆盖位（缺席时管线入口解析 env，见 context/registry.ts）。 */
  prompt?: PromptSectionFlags;
  /** 可选诊断出口：管线 warn / manifest trace debug 走它；缺席时静默。 */
  logger?: Logger;
}

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };

/**
 * 子代理组装器（specs/system-prompt-section-registry.md R7）：与主路径共享
 * descriptor 基础设施与共享段实例（SUBAGENT_SECTION_REGISTRY 引用 registry-shared.ts
 * 的同一对象），但**保留独立组装**——每个 system 段各自一条 system message、
 * 各自带 ephemeral breakpoint（R4：刻意的 cache 设计，不得统一成主路径 3-block 形态）。
 * 段的左边界由本组装器按 descriptor.boundary 施加（agent_prompt "\n"、其余 "\n\n"），
 * 不进 descriptor 文本——同一份共享文本在两条路径上 hash 一致（R6/R7）。
 */
export class SubagentContextBuilder extends ContextBuilder {
  private subagentConfig: SubagentContextBuilderConfig;

  constructor(config: SubagentContextBuilderConfig) {
    super(toBaseContextBuilderConfig(config));
    this.subagentConfig = config;
  }

  override setEnvInfo(envInfo: EnvInfo): this {
    this.subagentConfig = {
      ...this.subagentConfig,
      envInfo,
    };
    return this;
  }

  override build(): ContextBuildResult {
    const ctx = this.createSectionContext();
    const entries = resolveSectionEntriesSync(SUBAGENT_SECTION_REGISTRY, ctx);
    return this.assembleSubagentResult(entries, ctx);
  }

  override async buildAsync(): Promise<ContextBuildResult> {
    const ctx = this.createSectionContext();
    const entries = await resolveSectionEntries(SUBAGENT_SECTION_REGISTRY, ctx);
    return this.assembleSubagentResult(entries, ctx);
  }

  private createSectionContext(): SectionContext {
    return createSubagentSectionContext({
      config: toSectionContextConfig(this.subagentConfig),
      subagent: { agentPrompt: this.subagentConfig.agentPrompt },
      prompt: this.subagentConfig.prompt,
      logger: this.subagentConfig.logger,
    });
  }

  private assembleSubagentResult(
    entries: readonly ResolvedSection[],
    ctx: SectionContext,
  ): ContextBuildResult {
    emitSectionManifestTrace(entries, ctx);

    const orderedEntries = orderSubagentEntries(entries);
    const orderedSections = orderedEntries.map((entry) => entry.section);
    const totalChars = orderedSections.reduce((sum, section) => sum + section.chars, 0);
    const totalTokens = orderedSections.reduce((sum, section) => sum + section.tokens, 0);
    const systemMessages = orderedEntries
      .filter((entry) => entry.section.injectionTarget === "system")
      .map(
        (entry): ModelInputMessage => ({
          role: "system",
          // 左边界由组装器施加（R7）：descriptor 文本保持纯净，boundary 声明在 descriptor 上。
          content: `${entry.descriptor.boundary ?? ""}${entry.section.content}`,
          // subagent context builder 不走 main ContextBuilder 的 system 组装，
          // 仍需在每段稳定 child system prompt 上保留 provider cache breakpoint。
          cacheControl: EPHEMERAL_CACHE_CONTROL,
        }),
      );
    const skillsContent = buildSkillsMetaUserBody(
      orderedSections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source === "skills",
      ),
    );
    const contextContent = buildContextMetaUserBody(
      orderedSections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source !== "skills",
      ),
    );

    return {
      sections: orderedSections,
      totalChars,
      totalTokens,
      systemMessages,
      metaUserAttachments: [
        ...(skillsContent
          ? [
              {
                source: "skills_listing" as const,
                content: skillsContent,
              },
            ]
          : []),
        ...(contextContent
          ? [
              {
                source: "context_prefix" as const,
                content: contextContent,
              },
            ]
          : []),
      ],
    };
  }
}

export function createSubagentContextBuilder(
  config: SubagentContextBuilderConfig,
): SubagentContextBuilder {
  return new SubagentContextBuilder(config);
}

function orderSubagentEntries(entries: readonly ResolvedSection[]): ResolvedSection[] {
  return [
    ...entries.filter((entry) => entry.section.injectionTarget === "system"),
    ...entries.filter((entry) => entry.section.injectionTarget === "meta_user"),
  ];
}

function toBaseContextBuilderConfig(config: SubagentContextBuilderConfig): ContextBuilderConfig {
  return {
    workingDirectory: config.envInfo.cwd,
    envInfo: config.envInfo,
    model: config.model,
    currentDate: config.currentDate,
    skillMetadataBudget: config.skillMetadataBudget,
    skills: config.skills,
  };
}

/** SectionContext 用的完整折算：比基类 config 多带 userInstructions（共享段 ruc 的输入）。 */
function toSectionContextConfig(config: SubagentContextBuilderConfig): ContextBuilderConfig {
  return {
    ...toBaseContextBuilderConfig(config),
    userInstructions: config.userInstructions,
  };
}
