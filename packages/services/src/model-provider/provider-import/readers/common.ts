// 契约形状参照 Fynvra（Apache-2.0），见 docs/specs/provider-config-import.md
// readers 的共享纯函数与类型（docs/specs/provider-config-import.md R2 三层结构）：
// 只做「原始内容 → DiscoveredProvider」的纯解析，**不碰文件系统、不读 process.env、
// 不写日志**。坏内容一律返回空并记 warning（只给位置/结构信息，不带原文片段）。
import { parse as parseToml } from "smol-toml";
import type { ProviderApiType } from "@acode/provider";
import type { ProviderImportSource, ProviderImportWarning } from "../providerImportTypes.js";
import { PROVIDER_API_TYPES } from "../providerImportTypes.js";

/** 注入式环境变量视图；reader 绝不直接读 `process.env`（R2/R1 来源 2 的 env_key）。 */
export type Env = Readonly<Record<string, string | undefined>>;

export interface DiscoveredProviderModel {
  readonly id: string;
  readonly name: string;
}

/** 单次 scan 的解析产物；含明文 apiKey，是宿主内存内部结构，绝不进入任何 view/RPC 载荷。 */
export interface DiscoveredProvider {
  readonly source: ProviderImportSource;
  readonly sourceLabel: string;
  readonly name: string;
  readonly api: ProviderApiType;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly DiscoveredProviderModel[];
  readonly isCurrent: boolean;
}

export interface ReaderResult {
  readonly providers: readonly DiscoveredProvider[];
  readonly warnings: readonly ProviderImportWarning[];
}

export function emptyReaderResult(): ReaderResult {
  return { providers: [], warnings: [] };
}

/** 非空字符串（trim 后）或 null；用于任何来自外部文本的字段。 */
export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON 文本 → 对象；非法/非对象返回 null（调用方决定记哪种 warning）。 */
export function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** TOML 文本 → 对象；非法返回 null。错误信息可能含原文片段，故只取行号、绝不外泄 message。 */
export function parseTomlObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = parseToml(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** TOML 解析失败时只提取行号（不含 message —— smol-toml 的 message 带源码片段）。 */
export function tomlErrorLine(raw: string | null): number | null {
  if (raw === null) return null;
  try {
    parseToml(raw);
    return null;
  } catch (error) {
    const line = (error as { line?: unknown }).line;
    return typeof line === "number" && Number.isFinite(line) ? line : null;
  }
}

/**
 * baseUrl 归一（R3）：trim + 去尾部 `/`；空串视为未填返回 null。
 * 不做路径大小写折叠（路径大小写敏感）；指纹与展示共用本函数，保证单一口径。
 */
export function baseUrlOf(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const normalized = raw.replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : null;
}

export function isProviderApiType(value: unknown): value is ProviderApiType {
  return (
    typeof value === "string" && (PROVIDER_API_TYPES as readonly string[]).includes(value)
  );
}

/** 模型 id 归一（R3）：trim、去空、单条来源内去重；保序。 */
export function modelEntries(ids: readonly unknown[], names?: ReadonlyMap<string, string>): DiscoveredProviderModel[] {
  const seen = new Set<string>();
  const result: DiscoveredProviderModel[] = [];
  for (const raw of ids) {
    const id = text(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name: names?.get(id) ?? id });
  }
  return result;
}