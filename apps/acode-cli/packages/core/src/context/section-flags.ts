// ============================================================
// Prompt Section Flags - 本地诊断旗标（P2）
// ============================================================
//
// specs/system-prompt-section-registry.md R3 的两个本地开关。红线：
// - 只有本地诊断用途，不打 applied 遥测、不做服务端 A/B、不产生任何网络请求
//   （specs/no-telemetry.md）；
// - manifest trace 只进 debug 级本地日志；
// - 解析是纯函数：调用方（registry.ts 管线入口）传入 env 快照与可选 logger，
//   descriptor 永远只吃解析结果，不读 process.env（R3）。

import { createHash } from "node:crypto";
import type { Logger } from "@acode/contracts";

/** 按段 id 排除段（逗号分隔）。诊断开关，不用于产品功能开关。默认空 = 零行为变化。 */
export const PROMPT_SECTIONS_DISABLED_ENV = "ACODE_PROMPT_SECTIONS_DISABLED";
/** 把本次组装的段 id 清单 + manifest hash 写进 debug 级日志。默认 false。 */
export const PROMPT_MANIFEST_TRACE_ENV = "ACODE_PROMPT_MANIFEST_TRACE";

const TRUTHY_TRACE_VALUES: ReadonlySet<string> = new Set(["1", "true"]);
const FALSY_TRACE_VALUES: ReadonlySet<string> = new Set(["0", "false"]);
const DISABLED_SEPARATOR = ",";
const MANIFEST_HASH_ALGORITHM = "sha256";
const MANIFEST_ENTRY_SEPARATOR = "\n\n";

export interface PromptSectionFlags {
  /** 生效的排除段 id 列表（已去重；未知 id 已被忽略并 warn）。 */
  readonly disabledSections: readonly string[];
  /** 是否在 debug 级日志输出段 id 清单 + manifest hash。 */
  readonly manifestTrace: boolean;
}

export const DEFAULT_PROMPT_SECTION_FLAGS: PromptSectionFlags = Object.freeze({
  disabledSections: Object.freeze([]) as readonly string[],
  manifestTrace: false,
});

export interface ResolvePromptSectionFlagsOptions {
  /** 可选诊断出口；缺席时静默（错误行为不变：仍按 spec 的降级方向解析）。 */
  readonly logger?: Logger;
  /** 注册表全量段 id；在场时对未知 id 记 warn（不 fail-closed，R3）。 */
  readonly knownSectionIds?: readonly string[];
}

// 同一进程内同一条解析告警只记一次：context 每轮重建，诊断旗标的告警不该随轮次刷屏。
const warnedKeys = new Set<string>();

function warnOnce(
  logger: Logger | undefined,
  key: string,
  message: string,
  context: Record<string, unknown>,
): void {
  if (!logger || warnedKeys.has(key)) return;
  warnedKeys.add(key);
  logger.warn(message, context);
}

/**
 * 解析两个旗标（R3 表）：
 * - ACODE_PROMPT_SECTIONS_DISABLED：空串/全空白 → 空数组；未知 id → 忽略该项 + warn
 *   （拼错一个 id 不该让整个提示词体系降级）；重复 id 去重；
 * - ACODE_PROMPT_MANIFEST_TRACE：1/true（大小写不敏感）为真；0/false 为假；
 *   其余非法值 → 按 false 处理 + warn。任何取值都不产生网络请求。
 */
export function resolvePromptSectionFlags(
  env: Record<string, string | undefined>,
  options: ResolvePromptSectionFlagsOptions = {},
): PromptSectionFlags {
  return {
    disabledSections: parseDisabledSections(env[PROMPT_SECTIONS_DISABLED_ENV], options),
    manifestTrace: parseManifestTrace(env[PROMPT_MANIFEST_TRACE_ENV], options.logger),
  };
}

function parseDisabledSections(
  raw: string | undefined,
  options: ResolvePromptSectionFlagsOptions,
): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  const known = options.knownSectionIds;
  const ids: string[] = [];
  for (const part of raw.split(DISABLED_SEPARATOR)) {
    const id = part.trim();
    if (id.length === 0) continue;
    if (ids.includes(id)) continue;
    if (known && !known.includes(id)) {
      // 未知 id：忽略该项并 warn，其余项照常生效（R3 错误行为，不 fail-closed）。
      warnOnce(
        options.logger,
        `disabled-sections:unknown:${id}`,
        "Prompt sections flag ignored an unknown section id",
        {
          event: "prompt.flags.unknown_section_id",
          module: "core.context",
          sectionId: id,
          envVar: PROMPT_SECTIONS_DISABLED_ENV,
        },
      );
      continue;
    }
    ids.push(id);
  }
  return ids;
}

function parseManifestTrace(raw: string | undefined, logger: Logger | undefined): boolean {
  if (raw === undefined || raw.trim().length === 0) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  if (TRUTHY_TRACE_VALUES.has(normalized)) return true;
  if (FALSY_TRACE_VALUES.has(normalized)) return false;
  // 非法值：按 false 处理 + warn（R3 错误行为）。
  warnOnce(
    logger,
    `manifest-trace:invalid:${normalized}`,
    "Prompt manifest trace flag got an invalid value; treated as false",
    {
      event: "prompt.flags.invalid_manifest_trace",
      module: "core.context",
      envVar: PROMPT_MANIFEST_TRACE_ENV,
    },
  );
  return false;
}

/**
 * manifest 规范化文本（R6）：统一换行为 \n、去除行尾空白、不做大小写折叠。
 */
export function normalizeSectionText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

/**
 * manifest hash（R6 的本地 trace 形态）：对 persistable 段的
 * `id + 规范化文本` 做 sha256。只进 debug 级本地日志，不外发。
 * P3 的构建期 manifest 生成归版本清单专项；本函数是同一规范化规则的运行期复用点。
 */
export function computePersistableSectionsHash(
  entries: readonly { id: string; persistable: boolean; content: string }[],
): string {
  const payload = entries
    .filter((entry) => entry.persistable)
    .map((entry) => `${entry.id}\n${normalizeSectionText(entry.content)}`)
    .join(MANIFEST_ENTRY_SEPARATOR);
  return createHash(MANIFEST_HASH_ALGORITHM).update(payload).digest("hex");
}
