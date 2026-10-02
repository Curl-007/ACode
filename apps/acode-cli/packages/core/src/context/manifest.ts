// ============================================================
// Prompt Manifest - 构建期版本清单的数据核心（P3）
// ============================================================
//
// specs/system-prompt-section-registry.md R6 + 方案 §10.1：
// - 每个 persistable: true 的注册段一条 { id, group, source, owner, hash }；
// - 顶层 { version, generatedAt, sections, sectionsHash }；
// - hash = 段**规范化文本**的 sha256（规范化 = 统一换行为 \n、去行尾空白、
//   不做大小写折叠，复用 section-flags.ts 的 normalizeSectionText）；
// - 共享段（双路径同一 descriptor 实例）在 manifest 里**只有一条**，owner 指向
//   registry-shared.ts（「一份文本一处所有」的机器化表达）；
// - manifest 与 hash 只进本地文件/debug 日志，不外发（no-telemetry 红线）。
//
// 本模块只产出**数据**（纯函数 + node:crypto 本地哈希），文件 I/O 与 CLI 参数
// 归 apps/acode-cli/scripts/{generate-prompt-manifest,check-prompt-parity}.mjs；
// 「manifest 与代码一致」的硬校验（verifyPromptManifest）与 parity 差异报告
// （仅报告不阻断）都以此处为唯一计算源。

import { createHash } from "node:crypto";
import type { ContextBuilderConfig, ContextSource, EnvInfo } from "./types.js";
import {
  alignSectionToGroup,
  type SectionContext,
  type SectionDescriptor,
  type SectionGroup,
} from "./section-descriptors.js";
import { DEFAULT_PROMPT_SECTION_FLAGS, normalizeSectionText } from "./section-flags.js";
import { MAIN_SECTION_REGISTRY } from "./registry-main.js";
import { SUBAGENT_SECTION_REGISTRY } from "./registry-subagent.js";

/** manifest schema 版本（方案 §10.1 草图的 version: 1）。 */
export const PROMPT_MANIFEST_VERSION = 1;

const HASH_ALGORITHM = "sha256";
const ENTRY_SEPARATOR = "\n\n";

export interface PromptManifestSection {
  readonly id: string;
  readonly group: SectionGroup;
  readonly source: ContextSource;
  readonly owner: string;
  readonly hash: string;
}

export interface PromptManifest {
  readonly version: number;
  readonly generatedAt: string;
  readonly sections: readonly PromptManifestSection[];
  /** 全目录摘要：sha256(每条 `id\n段hash` 以 "\n\n" 连接)。与 R6 顶层 sectionsHash 对应。 */
  readonly sectionsHash: string;
}

// -----------------------------------------------
// 规范化上下文：manifest 的文本必须不含任何运行期数据（R6）
// -----------------------------------------------

/** 规范化 envInfo：全空占位。persistable 段的文本不得依赖这些值（R4/R6 前提）。 */
const CANONICAL_ENV_INFO: EnvInfo = Object.freeze({
  cwd: "",
  platform: "",
  shell: "",
  osVersion: "",
  nodeVersion: "",
});

const CANONICAL_CONFIG: ContextBuilderConfig = Object.freeze({
  workingDirectory: "",
  envInfo: CANONICAL_ENV_INFO,
  // 显式旗标：manifest 生成不受宿主 env（ACODE_PROMPT_*）影响，保证确定性。
  prompt: DEFAULT_PROMPT_SECTION_FLAGS,
});

/**
 * 规范化 SectionContext：channel 取 "default"（persistable 目录段里没有
 * custom/workflow_actor 专属段——两者都是 persistable: false），subagent 输入
 * 为空占位（subagent.agent_prompt 同为 persistable: false）。
 */
export function createCanonicalSectionContext(): SectionContext {
  return {
    config: CANONICAL_CONFIG,
    channel: "default",
    flags: DEFAULT_PROMPT_SECTION_FLAGS,
    subagent: { agentPrompt: "" },
  };
}

// -----------------------------------------------
// 目录计算
// -----------------------------------------------

export interface PromptCatalogRegistries {
  readonly mainRegistry?: readonly SectionDescriptor[];
  readonly subagentRegistry?: readonly SectionDescriptor[];
}

/**
 * persistable 段全目录：MAIN → SUBAGENT 声明序、按 id 去重。
 * 共享段（同一 descriptor 实例出现在两条注册表）天然只出现一次（R6）。
 * 参数可注入替换注册表：漂移检测测试用它模拟「改一个段文本」。
 */
export function listPersistableDescriptors(
  registries: PromptCatalogRegistries = {},
): readonly SectionDescriptor[] {
  const main = registries.mainRegistry ?? MAIN_SECTION_REGISTRY;
  const subagent = registries.subagentRegistry ?? SUBAGENT_SECTION_REGISTRY;
  const seen = new Set<string>();
  const out: SectionDescriptor[] = [];
  for (const descriptor of [...main, ...subagent]) {
    if (!descriptor.persistable || seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    out.push(descriptor);
  }
  return out;
}

/** 段 hash（R6）：规范化文本的 sha256。 */
export function hashSectionText(text: string): string {
  return createHash(HASH_ALGORITHM).update(normalizeSectionText(text)).digest("hex");
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * 计算 manifest 段条目（同步）。persistable 段必须同步产出且非 null——
 * manifest 完整性是硬要求（R6 CI 硬校验的计算源），失败即抛。
 */
export function computePromptManifestSections(
  options: PromptCatalogRegistries & { readonly ctx?: SectionContext } = {},
): PromptManifestSection[] {
  const ctx = options.ctx ?? createCanonicalSectionContext();
  return listPersistableDescriptors(options).map((descriptor) => {
    const built = descriptor.build(ctx);
    if (isThenable(built)) {
      throw new Error(
        `Persistable section "${descriptor.id}" must build synchronously for manifest generation`,
      );
    }
    if (!built) {
      throw new Error(`Persistable section "${descriptor.id}" produced no canonical text`);
    }
    const section = alignSectionToGroup(built, descriptor);
    return {
      id: descriptor.id,
      group: descriptor.group,
      source: descriptor.source,
      owner: descriptor.owner,
      hash: hashSectionText(section.content),
    };
  });
}

/** 顶层 sectionsHash：全目录摘要（只依赖条目 id+hash，与 generatedAt 无关 → 确定性）。 */
export function computeManifestSectionsHash(sections: readonly PromptManifestSection[]): string {
  const payload = sections.map((section) => `${section.id}\n${section.hash}`).join(ENTRY_SEPARATOR);
  return createHash(HASH_ALGORITHM).update(payload).digest("hex");
}

export interface BuildPromptManifestOptions extends PromptCatalogRegistries {
  /** 可钉住时间戳（可重复构建/测试用）；缺省取当前时间。 */
  readonly generatedAt?: string;
  readonly ctx?: SectionContext;
}

/** 生成完整 manifest（构建脚本与测试的唯一入口）。 */
export function buildPromptManifest(options: BuildPromptManifestOptions = {}): PromptManifest {
  const sections = computePromptManifestSections(options);
  return {
    version: PROMPT_MANIFEST_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sections,
    sectionsHash: computeManifestSectionsHash(sections),
  };
}

// -----------------------------------------------
// 硬校验：「manifest 与代码一致」（R6 CI 阻断项的计算核心）
// -----------------------------------------------

export interface PromptManifestVerification {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 校验一份（通常来自 repo 内文件的）manifest 与当前注册表代码是否一致：
 * - 每个 persistable 注册段有且仅有一条（缺失/多余/重复都报）；
 * - 每条的 group/source/owner/hash 与代码产出相符；
 * - 条目顺序与目录声明序一致（防手工编辑）；
 * - 顶层 version/sectionsHash 相符。
 * generatedAt 是构建时间戳，**不**参与一致性判定。
 */
export function verifyPromptManifest(
  manifest: unknown,
  registries: PromptCatalogRegistries = {},
): PromptManifestVerification {
  const problems: string[] = [];
  if (!isRecord(manifest)) {
    return { ok: false, problems: ["manifest is not an object"] };
  }
  if (manifest.version !== PROMPT_MANIFEST_VERSION) {
    problems.push(
      `manifest version ${String(manifest.version)} !== expected ${PROMPT_MANIFEST_VERSION}`,
    );
  }
  if (typeof manifest.generatedAt !== "string" || manifest.generatedAt.length === 0) {
    problems.push("manifest generatedAt is missing or not a non-empty string");
  }
  const sections = manifest.sections;
  if (!Array.isArray(sections)) {
    return { ok: false, problems: [...problems, "manifest sections is not an array"] };
  }

  const expected = computePromptManifestSections(registries);
  const expectedById = new Map(expected.map((entry) => [entry.id, entry]));
  const actualIds: string[] = [];
  for (const entry of sections) {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      problems.push(`manifest section entry is malformed: ${JSON.stringify(entry)}`);
      continue;
    }
    actualIds.push(entry.id);
    const want = expectedById.get(entry.id);
    if (!want) {
      // 多余条目：persistable: false 的段、已移除的段或手工伪造的条目（R6：一条也不该有）。
      problems.push(
        `section "${entry.id}" is not a persistable registry section (unexpected manifest entry)`,
      );
      continue;
    }
    for (const field of ["group", "source", "owner", "hash"] as const) {
      if (entry[field] !== want[field]) {
        problems.push(
          `section "${entry.id}" field ${field} drifted: manifest has ${JSON.stringify(entry[field])}, code produces ${JSON.stringify(want[field])}`,
        );
      }
    }
  }

  const duplicates = actualIds.filter((id, index) => actualIds.indexOf(id) !== index);
  for (const id of new Set(duplicates)) {
    problems.push(
      `section "${id}" appears more than once (shared sections must have exactly one entry)`,
    );
  }
  for (const entry of expected) {
    if (!actualIds.includes(entry.id)) {
      problems.push(`persistable section "${entry.id}" is missing from the manifest`);
    }
  }
  const expectedOrder = expected.map((entry) => entry.id).join(",");
  const actualOrder = [...new Set(actualIds)].join(",");
  if (expectedOrder !== actualOrder && duplicates.length === 0) {
    problems.push(
      `section order drifted: manifest [${actualOrder}] !== catalog [${expectedOrder}]`,
    );
  }
  const expectedSectionsHash = computeManifestSectionsHash(expected);
  if (manifest.sectionsHash !== expectedSectionsHash) {
    problems.push(
      `manifest sectionsHash drifted: file has ${String(manifest.sectionsHash)}, code produces ${expectedSectionsHash}`,
    );
  }

  return { ok: problems.length === 0, problems };
}
