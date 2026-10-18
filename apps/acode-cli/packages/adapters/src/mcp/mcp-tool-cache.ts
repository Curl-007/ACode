// MCP 工具磁盘缓存（specs/mcp-startup-gate-breaker.md R1 快启门的缓存兜底）。
//
// 机制形态参照外部成熟实现的公开行为（每 server 持久化上次 tools/list 结果 +
// 配置指纹校验 + 启动门内未就绪 server 用缓存先注册 Deferred 工具），实现自撰。
// 为什么需要缓存：快启门只保证「慢 server 不阻塞启动」；门到期时若没有任何工具
// 清单，模型这一轮就完全看不到该 server。缓存把上一次成功握手的工具清单（名字 /
// description / inputSchema / outputSchema / annotations）在磁盘上留档，下次启动
// 直接先注册——配置没变时，这套 schema 极大概率就是 server 即将给出的清单。
//
// 一致性规则：schema 变更以新握手结果为准——每次 tools/list 成功都 best-effort
// 覆写缓存；指纹（展开后配置的稳定 JSON 摘要）不一致 = 配置变了 = 缓存不用于
// Deferred（宁可少注册，不可拿旧配置的工具冒充新 server）。
//
// fail-open 纪律与协商记忆（negotiation-memory.ts）一致：读失败 / 损坏 / 超大 /
// 过期 / 版本不符 → 当作没有缓存；写入 best-effort，绝不阻断连接。
// 身份键复用 mcpServerNegotiationIdentityKey（一条路径，不另造身份摘要）。

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Logger, McpServerConfig, McpToolDescriptor } from "@acode/contracts";
import { mcpServerNegotiationIdentityKey } from "./negotiation-memory.js";

/** 缓存条目新鲜窗：30 天（窗口外视为没有缓存）。 */
export const MCP_TOOL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 缓存文件读取上限：超过即整份作废（工具 schema 可能较大，1 MiB 量级）。 */
export const MCP_TOOL_CACHE_MAX_FILE_BYTES = 1024 * 1024;
/** 条目数护栏：超出按 observedAt 从旧到新逐出。 */
const MCP_TOOL_CACHE_MAX_ENTRIES = 256;
const CACHE_FILE_RELATIVE_PATH = join(".acode", "cli", "mcp", "tool-cache.json");
const CACHE_FILE_VERSION = 1;

interface ToolCacheEntry {
  observedAt: number;
  configFingerprint: string;
  tools: McpToolDescriptor[];
}

export interface McpToolCache {
  /** 指纹一致且新鲜窗内的缓存工具清单；否则 null。 */
  get(serverName: string, config: McpServerConfig): Promise<McpToolDescriptor[] | null>;
  /** tools/list 成功后的 best-effort 覆写（schema 变更以新握手为准）。 */
  set(serverName: string, config: McpServerConfig, tools: readonly McpToolDescriptor[]): Promise<void>;
}

export interface CreateMcpToolCacheOptions {
  /** 缓存文件路径；缺省 `<数据基目录>/.acode/cli/mcp/tool-cache.json`。 */
  filePath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  logger?: Logger;
  now?: () => number;
}

export function createMcpToolCache(options: CreateMcpToolCacheOptions = {}): McpToolCache {
  const now = options.now ?? Date.now;
  const logger = options.logger;
  const filePath = options.filePath ?? defaultToolCachePath(options.env);

  // 读缓存与写串行化沿用协商记忆的同一形态：首次读一次并缓存 promise，写成功后
  // 用新快照替换（读写同源）；写失败作废读缓存，下次使用重新读盘（fail-open）。
  let entriesRead: Promise<Record<string, ToolCacheEntry>> | undefined;
  let writeChain: Promise<void> = Promise.resolve();

  function readEntries(): Promise<Record<string, ToolCacheEntry>> {
    entriesRead ??= loadEntries(filePath, logger, now).catch(() => ({}));
    return entriesRead;
  }

  return {
    async get(serverName, config) {
      const key = mcpServerNegotiationIdentityKey(config);
      if (key === undefined) return null;
      const entry = (await readEntries())[key];
      if (!isFreshEntry(entry, now())) return null;
      let fingerprint: string;
      try {
        fingerprint = mcpToolCacheConfigFingerprint(config);
      } catch {
        return null;
      }
      if (entry.configFingerprint !== fingerprint) return null;
      const tools = entry.tools.filter(isWellFormedDescriptor);
      return tools.length > 0 ? tools : null;
    },

    async set(serverName, config, tools) {
      const key = mcpServerNegotiationIdentityKey(config);
      if (key === undefined || tools.length === 0) return;
      writeChain = writeChain
        .then(async () => {
          let fingerprint: string;
          try {
            fingerprint = mcpToolCacheConfigFingerprint(config);
          } catch {
            return;
          }
          const current = await readEntries();
          const next = pruneEntries(
            { ...current, [key]: { observedAt: now(), configFingerprint: fingerprint, tools: [...tools] } },
            now(),
          );
          entriesRead = Promise.resolve(next);
          const failure = await saveEntries(filePath, next);
          if (failure !== undefined) {
            entriesRead = undefined;
            logger?.warn("MCP tool cache could not be saved", {
              event: "mcp.tool_cache.save_failed",
              mcpServerName: serverName,
              reason: failure,
            });
          }
        })
        .catch(() => {});
      await writeChain;
    },
  };
}

/** 配置指纹：展开后配置的稳定 JSON SHA-256 前 32 位（与身份键同一摘要宽度）。 */
export function mcpToolCacheConfigFingerprint(config: McpServerConfig): string {
  return createHash("sha256").update(JSON.stringify(stableConfigValue(config))).digest("hex").slice(0, 32);
}

/** 键序无关的稳定序列化：同一配置无论键序如何变化，指纹不变。 */
function stableConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableConfigValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, stableConfigValue(item)]),
    );
  }
  return value;
}

function isFreshEntry(entry: ToolCacheEntry | undefined, nowMs: number): entry is ToolCacheEntry {
  if (!entry) return false;
  if (typeof entry.observedAt !== "number" || !Number.isFinite(entry.observedAt)) return false;
  if (typeof entry.configFingerprint !== "string" || entry.configFingerprint.length === 0) return false;
  const age = nowMs - entry.observedAt;
  return age >= 0 && age < MCP_TOOL_CACHE_TTL_MS;
}

/** 缓存内容的最小形态校验：Deferred 物化会再走完整注册边界，这里只挡明显损坏。 */
function isWellFormedDescriptor(tool: unknown): tool is McpToolDescriptor {
  if (typeof tool !== "object" || tool === null) return false;
  const candidate = tool as Record<string, unknown>;
  return (
    typeof candidate.serverName === "string" &&
    typeof candidate.toolName === "string" &&
    typeof candidate.inputSchema === "object" &&
    candidate.inputSchema !== null
  );
}

function pruneEntries(
  entries: Record<string, ToolCacheEntry>,
  nowMs: number,
): Record<string, ToolCacheEntry> {
  const fresh = Object.entries(entries).filter(([, entry]) => isFreshEntry(entry, nowMs));
  if (fresh.length > MCP_TOOL_CACHE_MAX_ENTRIES) {
    fresh.sort((a, b) => a[1].observedAt - b[1].observedAt);
    fresh.splice(0, fresh.length - MCP_TOOL_CACHE_MAX_ENTRIES);
  }
  return Object.fromEntries(fresh);
}

export function defaultToolCachePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const baseDir = env.ACODE_DATA_BASE_DIR?.trim() || homedir();
  return join(resolveUserPath(baseDir), CACHE_FILE_RELATIVE_PATH);
}

async function loadEntries(
  filePath: string,
  logger: Logger | undefined,
  now: () => number,
): Promise<Record<string, ToolCacheEntry>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      logger?.debug("MCP tool cache unreadable; servers start without deferred tool hints", {
        event: "mcp.tool_cache.read_failed",
      });
    }
    return {};
  }
  if (raw.length > MCP_TOOL_CACHE_MAX_FILE_BYTES) {
    logger?.debug("MCP tool cache oversized; ignoring it", {
      event: "mcp.tool_cache.oversized",
    });
    return {};
  }
  return parseToolCacheFile(raw, now()) ?? {};
}

function parseToolCacheFile(raw: string, nowMs: number): Record<string, ToolCacheEntry> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  // 未来版本写入的文件整份作废（不猜测未来语义），方向 = 没有缓存。
  if (record.version !== CACHE_FILE_VERSION) return {};
  const servers = record.servers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return {};
  const result: Record<string, ToolCacheEntry> = {};
  for (const [key, value] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.observedAt !== "number" || !Number.isFinite(candidate.observedAt)) continue;
    if (typeof candidate.configFingerprint !== "string") continue;
    if (!Array.isArray(candidate.tools)) continue;
    const tools = candidate.tools.filter(isWellFormedDescriptor);
    if (tools.length === 0) continue;
    result[key] = {
      observedAt: candidate.observedAt,
      configFingerprint: candidate.configFingerprint,
      tools,
    };
  }
  return pruneEntries(result, nowMs);
}

async function saveEntries(
  filePath: string,
  servers: Record<string, ToolCacheEntry>,
): Promise<string | undefined> {
  const payload = `${JSON.stringify({ version: CACHE_FILE_VERSION, servers }, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, filePath);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function resolveUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return resolve(value);
}
