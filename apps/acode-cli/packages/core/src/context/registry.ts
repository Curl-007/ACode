// ============================================================
// Section Registry - 声明序注册表门面 + 条件组装管线（P2）
// ============================================================
//
// specs/system-prompt-section-registry.md 的接口承载点：
// - MAIN_SECTION_REGISTRY / SUBAGENT_SECTION_REGISTRY（声明序数组，段相对顺序即注入顺序）；
// - resolveSections：通道过滤 → enabled → await build → null 过滤 → 声明序（R3）；
// - SectionContext 构造：身份通道解析（含 R5 互斥硬失败）+ 本地旗标解析。
//
// 旗标 env 读取收敛在本文件的管线入口**一处**（resolveSectionFlags）：descriptor 只吃
// 解析结果（R3「descriptor 不得自己读 process.env」）。spec R3 的完整接线
// （adapters/env-config.adapter → contracts/RuntimeConfig.prompt）归那两个包的所有者，
// 本管线以 ContextBuilderConfig.prompt 显式覆盖位对接：config.prompt 在场时优先，
// 缺席时按 spec 的名称/默认值/错误行为直接解析 env（零配置下两个旗标均为默认值，
// 零行为变化）。

import type { Logger } from "@acode/contracts";
import type { ContextBuilderConfig, ContextSection } from "./types.js";
import {
  alignSectionToGroup,
  channelMatches,
  resolveIdentityChannel,
  type ResolvedSection,
  type SectionContext,
  type SectionDescriptor,
  type SubagentSectionInputs,
} from "./section-descriptors.js";
import {
  computePersistableSectionsHash,
  resolvePromptSectionFlags,
  type PromptSectionFlags,
} from "./section-flags.js";
import {
  computeManifestSectionsHash,
  computePromptManifestSections,
  PROMPT_MANIFEST_VERSION,
} from "./manifest.js";
import { MAIN_SECTION_REGISTRY } from "./registry-main.js";
import { SUBAGENT_SECTION_REGISTRY } from "./registry-subagent.js";

export * from "./section-descriptors.js";
export {
  computePersistableSectionsHash,
  normalizeSectionText,
  resolvePromptSectionFlags,
  DEFAULT_PROMPT_SECTION_FLAGS,
  PROMPT_MANIFEST_TRACE_ENV,
  PROMPT_SECTIONS_DISABLED_ENV,
  type PromptSectionFlags,
} from "./section-flags.js";
export {
  CLI_PREFIX_SECTION,
  CURRENT_DATE_SECTION,
  REQUEST_USER_CONTEXT_SECTION,
  SKILLS_LISTING_SECTION,
} from "./registry-shared.js";
export { MAIN_SECTION_REGISTRY } from "./registry-main.js";
export { SUBAGENT_SECTION_REGISTRY } from "./registry-subagent.js";

/** 两条注册表的全量段 id（去重；旗标解析的未知 id 判定 + 诊断用）。 */
export const ALL_SECTION_IDS: readonly string[] = Object.freeze(
  Array.from(new Set([...MAIN_SECTION_REGISTRY, ...SUBAGENT_SECTION_REGISTRY].map((d) => d.id))),
);

// -----------------------------------------------
// SectionContext 构造（管线入口，唯一 env 读取点）
// -----------------------------------------------

function resolveSectionFlags(
  explicit: PromptSectionFlags | undefined,
  logger: Logger | undefined,
): PromptSectionFlags {
  if (explicit) return explicit;
  return resolvePromptSectionFlags(process.env, { logger, knownSectionIds: ALL_SECTION_IDS });
}

/** 主路径 ctx：身份通道解析（R5 互斥硬失败在此抛出）+ 旗标解析。 */
export function createMainSectionContext(config: ContextBuilderConfig): SectionContext {
  return {
    config,
    channel: resolveIdentityChannel(config),
    flags: resolveSectionFlags(config.prompt, config.logger),
    logger: config.logger,
  };
}

export interface SubagentSectionContextInput {
  /** 由子代理配置折算的 ContextBuilderConfig（含 userInstructions/skills/currentDate 等）。 */
  readonly config: ContextBuilderConfig;
  readonly subagent: SubagentSectionInputs;
  readonly prompt?: PromptSectionFlags;
  readonly logger?: Logger;
}

/**
 * 子代理路径 ctx：无三选一身份通道（子代理身份是 agent_prompt 段），channel 恒 "default"
 * ——共享 cli_prefix descriptor 的 ["default","custom"] 过滤因此在子代理路径放行，
 * 与注册表化前「子代理恒含 cli_prefix」一致。
 */
export function createSubagentSectionContext(input: SubagentSectionContextInput): SectionContext {
  return {
    config: input.config,
    channel: "default",
    flags: resolveSectionFlags(input.prompt, input.logger),
    logger: input.logger,
    subagent: input.subagent,
  };
}

// -----------------------------------------------
// 条件组装管线（R3：通道过滤 → enabled → build → null 过滤 → 声明序）
// -----------------------------------------------

function shouldConsider(descriptor: SectionDescriptor, ctx: SectionContext): boolean {
  if (!channelMatches(descriptor.channel, ctx.channel)) return false;
  if (ctx.flags.disabledSections.includes(descriptor.id)) return false;
  return descriptor.enabled(ctx);
}

function warnSectionSkipped(
  ctx: SectionContext,
  descriptor: SectionDescriptor,
  error: unknown,
): void {
  // 非身份段失败：warn + 跳过，不让一个诊断段把会话打死（R3）。
  ctx.logger?.warn("Prompt section build failed; section skipped", {
    event: "prompt.section.build_failed",
    module: "core.context",
    sectionId: descriptor.id,
    reason: error instanceof Error ? error.message : String(error),
  });
}

function pushResolved(
  out: ResolvedSection[],
  descriptor: SectionDescriptor,
  section: ContextSection | null,
): void {
  if (section) {
    out.push({ descriptor, section: alignSectionToGroup(section, descriptor) });
  }
}

/**
 * async 解析：统一 await 每个 descriptor 的 build（R3）。
 * 非 critical 段失败 warn+skip；critical（身份体三段）失败向上抛（R3 例外）。
 */
export async function resolveSectionEntries(
  registry: readonly SectionDescriptor[],
  ctx: SectionContext,
): Promise<ResolvedSection[]> {
  const out: ResolvedSection[] = [];
  for (const descriptor of registry) {
    try {
      if (!shouldConsider(descriptor, ctx)) continue;
      pushResolved(out, descriptor, await descriptor.build(ctx));
    } catch (error) {
      if (descriptor.critical) throw error;
      warnSectionSkipped(ctx, descriptor, error);
    }
  }
  return out;
}

/** spec 接口面：resolveSections = entries 的 section 投影。 */
export async function resolveSections(
  registry: readonly SectionDescriptor[],
  ctx: SectionContext,
): Promise<ContextSection[]> {
  const entries = await resolveSectionEntries(registry, ctx);
  return entries.map((entry) => entry.section);
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * 同步解析：build() 兼容入口用（既有调用方 runtime/methods/context.ts:278 与
 * context-refresh.ts:37 同步消费 ContextBuildResult；把它们迁到 await 归 runtime
 * 所有者，见 buildAsync）。当前两条注册表的全部 descriptor 均同步产出，
 * 同步路径与 async 路径产物一致。若某 descriptor 返回 Promise：critical 抛错，
 * 其余 warn+skip（同步管线无法 await，跳过优于产出半截段）。
 */
export function resolveSectionEntriesSync(
  registry: readonly SectionDescriptor[],
  ctx: SectionContext,
): ResolvedSection[] {
  const out: ResolvedSection[] = [];
  for (const descriptor of registry) {
    try {
      if (!shouldConsider(descriptor, ctx)) continue;
      const built = descriptor.build(ctx);
      if (isThenable(built)) {
        throw new Error(
          `Section "${descriptor.id}" returned a promise during synchronous build; use buildAsync()`,
        );
      }
      pushResolved(out, descriptor, built);
    } catch (error) {
      if (descriptor.critical) throw error;
      warnSectionSkipped(ctx, descriptor, error);
    }
  }
  return out;
}

// -----------------------------------------------
// Manifest trace（R3/R6：只进 debug 级本地日志，不外发）
// -----------------------------------------------

/**
 * ACODE_PROMPT_MANIFEST_TRACE=1/true 时，把本次组装的段 id 清单 + manifest hash
 * 写进 debug 级日志。字段两层：
 * - sectionsHash：本次组装中 persistable 段的规范化文本摘要（组装级，随通道/旗标变化）；
 * - manifestVersion / manifestSectionsHash：构建期 prompt-manifest 的同源目录摘要
 *   （context/manifest.ts，与 scripts/generate-prompt-manifest.mjs 产物一致），
 *   用于把运行期组装对照到版本清单。
 * hash 只覆盖 persistable 段的规范化文本（R6）；logger 缺席时静默。
 * 任何取值都不产生网络请求（no-telemetry 红线）。
 */
export function emitSectionManifestTrace(
  entries: readonly ResolvedSection[],
  ctx: SectionContext,
): void {
  if (!ctx.flags.manifestTrace || !ctx.logger) return;
  // 目录摘要计算失败不得打死组装（trace 是诊断面）：降级为只报组装级字段。
  let manifestFields: { manifestVersion?: number; manifestSectionsHash?: string } = {};
  try {
    const catalog = computePromptManifestSections();
    manifestFields = {
      manifestVersion: PROMPT_MANIFEST_VERSION,
      manifestSectionsHash: computeManifestSectionsHash(catalog),
    };
  } catch {
    manifestFields = {};
  }
  ctx.logger.debug("Prompt section manifest trace", {
    event: "prompt.manifest_trace",
    module: "core.context",
    sectionIds: entries.map((entry) => entry.descriptor.id),
    sectionsHash: computePersistableSectionsHash(
      entries.map((entry) => ({
        id: entry.descriptor.id,
        persistable: entry.descriptor.persistable,
        content: entry.section.content,
      })),
    ),
    ...manifestFields,
    disabledSections: [...ctx.flags.disabledSections],
  });
}
