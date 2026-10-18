// ============================================================
// Context Builder - System prompt assembly（P2 注册表驱动）
// ============================================================
//
// specs/system-prompt-section-registry.md：build() 曾是硬编码调用序列，现在段的
// 启用条件与产出全部登记在 MAIN_SECTION_REGISTRY（context/registry-main.ts，声明序）。
// 本文件只剩**主组装器**职责：通道过滤 → enabled → build → 排序 → 最多 3 个
// system block（cli_prefix / stable body / dynamic）+ meta_user attachment。
//
// 不回退的硬约束（R4/R5）：
// - 三选一身份互斥硬失败：workflowActor 与 customSystemPrompt 同在 → 抛错
//   （resolveIdentityChannel，section-descriptors.ts，消息逐字保留）；
// - assembleSystemMessages 产出 ≤3 个 system block，全部带 ephemeral cacheControl，
//   dynamic block 自带 "\n\n" 左边界；
// - stable 前缀稳定性：system-stable 组文本不依赖会话内可变量。
//
// build() 保持同步签名：既有调用方（runtime/methods/context.ts:278、
// context-refresh.ts:37）同步消费 ContextBuildResult，迁移它们归 runtime 所有者；
// buildAsync() 是 spec R3「统一 await 解析」的完整通道。当前注册表全部 descriptor
// 同步产出，两条通道产物一致；同步通道遇到 async 段按 R3 的失败语义处理
// （critical 抛、其余 warn+skip，见 registry.ts resolveSectionEntriesSync）。

import type { ModelInputMessage } from "@acode/contracts";
import type {
  ContextMetaUserAttachment,
  ContextSection,
  ContextBuildResult,
  ContextBuilderConfig,
  EnvInfo,
} from "./types.js";
import type { ToolRegistry } from "../tool/registry.js";
import { estimateTokens } from "./utils.js";
import {
  getStablePrefixCache,
  serializeContextBuildResult,
  StablePrefixCache,
} from "./stable-prefix.js";
import {
  createMainSectionContext,
  emitSectionManifestTrace,
  MAIN_SECTION_REGISTRY,
  resolveSectionEntries,
  resolveSectionEntriesSync,
  type ResolvedSection,
  type SectionContext,
} from "./registry.js";

// -----------------------------------------------
// Context Builder
// -----------------------------------------------

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };

export class ContextBuilder {
  private config: ContextBuilderConfig;
  private customSections: ContextSection[] = [];
  /**
   * sessionId 缺席时的实例私有冻结缓存（specs/stable-prefix-pause-gate.md R1）：
   * 子代理 builder / 测试 / preview 路径绝不与其他会话共享冻结字节。
   */
  private readonly localStablePrefixCache = new StablePrefixCache();

  constructor(config: ContextBuilderConfig) {
    this.config = config;
  }

  /**
   * 保留兼容入口。工具说明由 model request 的 tools 字段承载，不再镜像进 system prompt。
   */
  setToolRegistry(_registry: ToolRegistry): this {
    return this;
  }

  setEnvInfo(envInfo: EnvInfo): this {
    this.config = {
      ...this.config,
      envInfo,
    };
    return this;
  }

  /**
   * 添加自定义 section（用于后续扩展）。不经注册表：在注册段之后追加，
   * 再随 orderSectionsForInjection 归组（既有扩展位语义不变）。
   */
  addSection(
    section: Omit<ContextSection, "chars" | "tokens" | "injectionTarget" | "cacheHint"> &
      Partial<Pick<ContextSection, "injectionTarget" | "cacheHint">>,
  ): this {
    this.customSections.push({
      ...section,
      injectionTarget: section.injectionTarget ?? "system",
      cacheHint: section.cacheHint ?? "dynamic",
      chars: section.content.length,
      tokens: estimateTokens(section.content),
    });
    return this;
  }

  /**
   * 构建 context，返回结构化结果（同步通道，既有调用方兼容入口）。
   */
  build(): ContextBuildResult {
    const ctx = createMainSectionContext(this.config);
    const entries = resolveSectionEntriesSync(MAIN_SECTION_REGISTRY, ctx);
    return this.assembleBuildResult(entries, ctx);
  }

  /**
   * 构建 context（async 通道）：descriptor.build 允许 async，管线统一 await 解析
   * （spec R3）。段解析失败：非身份段 warn+skip，身份体三段（critical）向上抛。
   */
  async buildAsync(): Promise<ContextBuildResult> {
    const ctx = createMainSectionContext(this.config);
    const entries = await resolveSectionEntries(MAIN_SECTION_REGISTRY, ctx);
    return this.assembleBuildResult(entries, ctx);
  }

  private assembleBuildResult(
    entries: readonly ResolvedSection[],
    ctx: SectionContext,
  ): ContextBuildResult {
    // ACODE_PROMPT_MANIFEST_TRACE：段 id 清单 + manifest hash 进 debug 级本地日志（不外发）。
    emitSectionManifestTrace(entries, ctx);

    const sections: ContextSection[] = [
      ...entries.map((entry) => entry.section),
      ...this.customSections,
    ];
    const orderedSections = orderSectionsForInjection(sections);

    // 计算总计
    const totalChars = orderedSections.reduce((sum, s) => sum + s.chars, 0);
    const totalTokens = orderedSections.reduce((sum, s) => sum + s.tokens, 0);

    const systemMessages = this.assembleSystemMessages(orderedSections);
    const metaUserAttachments = this.assembleMetaUserAttachments(orderedSections);

    return this.freezeStablePrefix({
      sections: orderedSections,
      totalChars,
      totalTokens,
      systemMessages,
      metaUserAttachments,
    });
  }

  /**
   * StablePrefix 冻结层（specs/stable-prefix-pause-gate.md R1）：组装结果先做
   * 显式序列化投影，与冻结快照逐字节比较——相等则返回**同一冻结对象**
   * （同引用 ⇒ 同字节 ⇒ provider prompt-cache 断点稳定），不等则重拍快照并
   * version++。段管线仍是文本唯一所有者；本层不改任何字节，只保证
   * 「同输入 ⇒ 同对象」，且旧 result 持有者的字节永不被原地改写。
   */
  private freezeStablePrefix(result: ContextBuildResult): ContextBuildResult {
    const cache = this.stablePrefixCache();
    const serialized = serializeContextBuildResult(result);
    const frozen = cache.reuse(serialized);
    if (frozen) return frozen;
    cache.store(serialized, result);
    return result;
  }

  /** 冻结缓存路由：sessionId 在场走模块注册表（跨 builder 实例冻结），缺席走实例私有。 */
  private stablePrefixCache(): StablePrefixCache {
    const key = this.config.sessionId?.trim();
    return key ? getStablePrefixCache(key) : this.localStablePrefixCache;
  }

  /**
   * 显式失效本 builder 路由到的冻结快照（omp StablePrefix.invalidate 语义）：
   * MCP 重连 / 工具集或技能集变更等外部事件后，强制下一次 build 重拍前缀。
   * 输入变化已反映在段输出上时指纹自然变化，无需显式调用。
   */
  invalidateStablePrefix(): void {
    this.stablePrefixCache().invalidate();
  }

  private assembleSystemMessages(sections: ContextSection[]): ModelInputMessage[] {
    const messages: ModelInputMessage[] = [];

    const cliPrefixContent = buildSectionContent(
      sections.filter(
        (section) => section.injectionTarget === "system" && section.source === "cli_prefix",
      ),
    );
    if (cliPrefixContent) {
      messages.push({
        role: "system",
        content: cliPrefixContent,
        cacheControl: EPHEMERAL_CACHE_CONTROL,
      });
    }

    const stableBodyContent = buildSectionContent(
      sections.filter(
        (section) =>
          section.injectionTarget === "system" &&
          section.cacheHint === "stable" &&
          section.source !== "cli_prefix",
      ),
    );
    if (stableBodyContent) {
      messages.push({
        role: "system",
        content: stableBodyContent,
        cacheControl: EPHEMERAL_CACHE_CONTROL,
      });
    }

    const dynamicSystemContent = buildSectionContent(
      sections.filter(
        (section) => section.injectionTarget === "system" && section.cacheHint === "dynamic",
      ),
    );
    if (dynamicSystemContent) {
      messages.push({
        role: "system",
        // ACode by design：Main Agent 的 dynamic system block 自带左边界，所有 provider 保持一致。
        content: `\n\n${dynamicSystemContent}`,
        cacheControl: EPHEMERAL_CACHE_CONTROL,
      });
    }

    return messages;
  }

  private assembleMetaUserAttachments(sections: ContextSection[]): ContextMetaUserAttachment[] {
    const attachments: ContextMetaUserAttachment[] = [];

    const skillsContent = buildSkillsMetaUserBody(
      sections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source === "skills",
      ),
    );
    if (skillsContent) {
      attachments.push({
        source: "skills_listing",
        content: skillsContent,
      });
    }

    const contextContent = buildContextMetaUserBody(
      sections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source !== "skills",
      ),
    );
    if (contextContent) {
      attachments.push({
        source: "context_prefix",
        content: contextContent,
      });
    }

    return attachments;
  }
}

function orderSectionsForInjection(sections: ContextSection[]): ContextSection[] {
  return [
    ...sections.filter(
      (section) => section.injectionTarget === "system" && section.cacheHint === "stable",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "system" && section.cacheHint === "dynamic",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.cacheHint === "stable",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.cacheHint === "dynamic",
    ),
  ];
}

export function buildContextMetaUserBody(sections: ContextSection[]): string | null {
  if (sections.length === 0) return null;

  return [
    "As you answer the user's questions, you can use the following context:",
    buildSectionContent(sections),
    "",
    "      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
  ].join("\n");
}

export function buildSkillsMetaUserBody(sections: ContextSection[]): string | null {
  const content = buildSectionContent(sections);
  if (!content) {
    return null;
  }

  return content;
}

function buildSectionContent(sections: ContextSection[]): string {
  return sections.map((section) => section.content).join("\n\n");
}

// -----------------------------------------------
// Factory
// -----------------------------------------------

export function createContextBuilder(config: ContextBuilderConfig): ContextBuilder {
  return new ContextBuilder(config);
}
