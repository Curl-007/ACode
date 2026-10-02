// ============================================================
// Section Descriptor - 注册表基础设施（P2）
// ============================================================
//
// specs/system-prompt-section-registry.md R1/R4/R5 的类型与纯函数承载点：
// - SectionDescriptor：命名段注册结构（id / source / group / boundary / channel /
//   enabled / build / persistable / owner）；
// - group 把既有 injectionTarget + cacheHint 合成一个可排序键（R1：一一对应，
//   不改 ContextSection 字段语义）；
// - channel 表达三条身份通道的互斥过滤（R5），替代散落在 build() 里的 if；
// - descriptor 只吃 SectionContext 纯数据，不读 process.env（R3，env 收敛在
//   registry.ts 管线入口一处）。

import type { Logger } from "@acode/contracts";
import type {
  ContextBuilderConfig,
  ContextCacheHint,
  ContextInjectionTarget,
  ContextSection,
  ContextSource,
} from "./types.js";
import type { PromptSectionFlags } from "./section-flags.js";
import { estimateTokens } from "./utils.js";

/** 投递通道 + cache 分组合成键（R1/R4）：决定段落哪个 system block / attachment。 */
export type SectionGroup =
  | "system-stable"
  | "system-dynamic"
  | "meta_user-stable"
  | "meta_user-dynamic";

/** 三条互斥身份通道（R5）：default = 默认 identity，custom = customSystemPrompt，workflow_actor = 工作流子代理。 */
export type SectionChannel = "default" | "custom" | "workflow_actor";

/** descriptor 的通道过滤：单通道、通道列表（如 cli_prefix 走 default+custom）或 "any"。 */
export type SectionChannelFilter = SectionChannel | "any" | readonly SectionChannel[];

/** group → 既有 ContextSection 投递字段的固定映射（R1：一一对应）。 */
export const SECTION_GROUP_DELIVERY: Readonly<
  Record<SectionGroup, { injectionTarget: ContextInjectionTarget; cacheHint: ContextCacheHint }>
> = Object.freeze({
  "system-stable": { injectionTarget: "system", cacheHint: "stable" },
  "system-dynamic": { injectionTarget: "system", cacheHint: "dynamic" },
  "meta_user-stable": { injectionTarget: "meta_user", cacheHint: "stable" },
  "meta_user-dynamic": { injectionTarget: "meta_user", cacheHint: "dynamic" },
});

/** 子代理组装路径特有的输入；主路径恒缺席（R7：共享 descriptor、不共享组装）。 */
export interface SubagentSectionInputs {
  readonly agentPrompt: string;
}

/**
 * descriptor 的唯一输入：已解析好的纯数据（R3）。
 * config = 既有 ContextBuilderConfig；channel = 管线解析出的当前身份通道；
 * flags = 本地诊断旗标（ACODE_PROMPT_SECTIONS_DISABLED / ACODE_PROMPT_MANIFEST_TRACE）。
 */
export interface SectionContext {
  readonly config: ContextBuilderConfig;
  readonly channel: SectionChannel;
  readonly flags: PromptSectionFlags;
  /** 可选诊断出口：管线 warn / manifest trace debug 都走它；缺席时静默。 */
  readonly logger?: Logger;
  readonly subagent?: Readonly<SubagentSectionInputs>;
}

/**
 * 命名段注册结构（R1）。注册表是声明序数组：段的相对顺序即注入顺序，
 * orderSectionsForInjection 的分组稳定排序保持不变（同组内按注册序）。
 */
export interface SectionDescriptor {
  /** 稳定 id，manifest 与诊断日志的键。点分命名：<area>.<name>。一旦发布不得改名（R2）。 */
  readonly id: string;
  /** 既有 ContextSource 协议面。一个 source 可承载多个 id（R2，例 session_guidance）。 */
  readonly source: ContextSource;
  /** 投递通道 + cache 分组（R4）：决定落哪个 system block / attachment。 */
  readonly group: SectionGroup;
  /**
   * 段左边界声明，由**组装器**施加、不进 descriptor 文本（R7）——否则同一份文本
   * 在两条路径上 hash 不同。主路径的边界是 assembleSystemMessages 的 "\n\n" join 与
   * dynamic block 前缀，不读本字段；子代理组装器按本字段给每段 system message 加前缀。
   */
  readonly boundary?: "\n" | "\n\n";
  /** 身份通道过滤（R5）：管线按当前通道过滤，替代散落 if。 */
  readonly channel: SectionChannelFilter;
  /**
   * 该段文本是否可进 manifest（R6）：含运行期数据（cwd/日期/git/工具面）或
   * 用户/项目/作者数据的段必须为 false。
   */
  readonly persistable: boolean;
  /** 归属文件（相对仓库根），manifest 的 owner 字段来源（R1/R6）。 */
  readonly owner: string;
  /**
   * 身份体三段专用（R3 例外）：build 失败必须抛，不允许 warn+skip——
   * 身份缺席的会话不该继续。其余段失败 warn+skip（一个诊断段不该把会话打死）。
   */
  readonly critical?: boolean;
  /** 纯谓词：本 ctx 下是否考虑该段。不得有副作用、不得读时钟/随机源/process.env（R3）。 */
  enabled(ctx: SectionContext): boolean;
  /** 允许 async；管线统一 await 解析（R3）。返回 null = 本次不产出。 */
  build(ctx: SectionContext): ContextSection | null | Promise<ContextSection | null>;
}

/** 解析产物：descriptor 与 section 成对返回，组装器据此施加 boundary（R7）。 */
export interface ResolvedSection {
  readonly descriptor: SectionDescriptor;
  readonly section: ContextSection;
}

/** Skill 工具的注册名（与 tool/handlers/skill.ts 的 metadata.name 同字面；contracts 没有常量）。 */
export const SKILL_TOOL_NAME = "Skill";

/**
 * 既有 skillToolAvailable 语义（原 builder.ts:225-228）：工具面表缺席
 * （undefined，测试/旧调用方）时视为可用——Skill 段缺席只损失一条提示。
 */
export function skillToolAvailable(guidanceToolNames: readonly string[] | undefined): boolean {
  return guidanceToolNames === undefined || guidanceToolNames.includes(SKILL_TOOL_NAME);
}

/** channel 过滤判定（R5）。 */
export function channelMatches(filter: SectionChannelFilter, channel: SectionChannel): boolean {
  if (filter === "any") return true;
  if (Array.isArray(filter)) return filter.includes(channel);
  return filter === channel;
}

/**
 * 解析当前身份通道，保留三选一互斥硬失败（R5，原 builder.ts:92-97 逐字保留）。
 * 工作流子代理身份是第三条路径，与 customSystemPrompt 互斥——两者同在只可能是
 * 接线错误（persona 该经 workflowActor 进来，不该再塞 systemPrompt），
 * 大声失败而不是默默二选一。
 */
export function resolveIdentityChannel(config: ContextBuilderConfig): SectionChannel {
  const hasCustomSystemPrompt = Boolean(config.customSystemPrompt?.trim());
  const workflowActor = config.workflowActor;
  if (workflowActor !== undefined && hasCustomSystemPrompt) {
    throw new Error("ContextBuilder: workflowActor and customSystemPrompt are mutually exclusive");
  }
  if (hasCustomSystemPrompt) return "custom";
  if (workflowActor !== undefined) return "workflow_actor";
  return "default";
}

/**
 * 生效的 output style：prompt 全空白视为缺席（原 builder.ts:84-86 语义），
 * identity.default 与 style.output 两段共用同一判定。
 */
export function resolveActiveOutputStyle(
  config: ContextBuilderConfig,
): ContextBuilderConfig["outputStyle"] {
  return config.outputStyle?.prompt.trim() ? config.outputStyle : undefined;
}

/** 注册表内联段的 ContextSection 构造（投递字段由 group 派生，单一来源）。 */
export function createRegistrySection(input: {
  name: string;
  source: ContextSource;
  group: SectionGroup;
  content: string;
}): ContextSection {
  const delivery = SECTION_GROUP_DELIVERY[input.group];
  return {
    name: input.name,
    source: input.source,
    injectionTarget: delivery.injectionTarget,
    cacheHint: delivery.cacheHint,
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    content: input.content,
    preview: input.content.slice(0, 100),
  };
}

/**
 * 管线出口对齐：section 的投递字段以 descriptor.group 为准（R1 单一来源）。
 * 既有 section builder 的字段与 group 一致时原样返回，不做拷贝。
 */
export function alignSectionToGroup(
  section: ContextSection,
  descriptor: SectionDescriptor,
): ContextSection {
  const delivery = SECTION_GROUP_DELIVERY[descriptor.group];
  if (
    section.injectionTarget === delivery.injectionTarget &&
    section.cacheHint === delivery.cacheHint
  ) {
    return section;
  }
  return { ...section, injectionTarget: delivery.injectionTarget, cacheHint: delivery.cacheHint };
}
