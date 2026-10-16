// MCP 协议协商记忆（specs/mcp-protocol-negotiation-increments.md R1「慢连接 server 记忆」）。
//
// 机制形态参照外部成熟实现的公开行为（discover 裁决持久记忆 + 新鲜窗 + 代际失效 +
// fail-open），实现与命名自撰。为什么需要记忆：auto 协商每次连接都先跑一轮
// server/discover probe（占用 probe 超时预算）；冷启动慢的 stdio server 经常在
// probe 窗口内答不上来、落到 legacy 握手——下一次连接若不记住这个事实，就要再付
// 一次 probe 超时（启动更慢、日志更吵）。记住「该 server 在当前协议代际下 probe
// 不出结果」后，7 天新鲜窗内直接走 legacy 路径（跳过 probe）；server 一旦在后续
// 连接里以 modern 纪元握手成功，记忆立即清除（自愈证据优先于记忆）。
//
// 边界与 fail-open 纪律：
// - 记忆只是 probe 的跳过依据，不改变任何显式配置（protocolVersion pin/legacy）；
// - 文件不可读 / 损坏 / 超大 / 代际不符 → 一律当作「没有记忆」，重新 probe
//   （宁可多探一次，不能因为记忆面故障拒绝连接）；
// - 写入是 best-effort：失败只记日志，绝不阻断连接流程；
// - 记忆按 server 稳定身份（stdio: command+args+env 摘要 / http|sse: url 摘要）
//   为键，改名即换键，旧条目随新鲜窗自然过期。

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client";
import type { McpServerConfig } from "@acode/contracts";
import type { Logger } from "@acode/contracts";

/** 慢连接 server 记忆的新鲜窗：7 天（窗口外重新 probe）。 */
export const MCP_NEGOTIATION_MEMORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 记忆文件读取上限：超过即整份作废（fail-open，与参考实现的 256KB 同级）。 */
export const MCP_NEGOTIATION_MEMORY_MAX_FILE_BYTES = 262_144;
/** 条目数护栏：超出按 observedAt 从旧到新逐出（防身份键高频变化导致无界增长）。 */
const MCP_NEGOTIATION_MEMORY_MAX_ENTRIES = 512;
const MEMORY_FILE_RELATIVE_PATH = join(".acode", "cli", "mcp", "protocol-memory.json");
const MEMORY_FILE_VERSION = 1;

interface NegotiationVerdict {
  observedAt: number;
  /** 记录时的最新协议代际；与当前 SDK LATEST_PROTOCOL_VERSION 不符即失效。 */
  latestProtocolVersion: string;
}

export interface McpNegotiationMemory {
  /** 新鲜窗内该 server 是否被记住为「probe 不出结果的 legacy 对端」。 */
  isRememberedLegacy(config: McpServerConfig): Promise<boolean>;
  /** auto 协商落到 legacy 纪元后记录（慢 server：新鲜窗内跳过 probe）。 */
  rememberLegacy(config: McpServerConfig): Promise<void>;
  /** modern 握手成功（自愈证据）后清除记忆。 */
  forget(config: McpServerConfig): Promise<void>;
}

/** server 稳定身份键（测试与日志可复用）；不可归一的配置返回 undefined（不记忆）。 */
export function mcpServerNegotiationIdentityKey(config: McpServerConfig): string | undefined {
  if (config.type === "stdio") {
    const envEntries = Object.entries(config.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .sort();
    const material = JSON.stringify({
      command: config.command,
      args: config.args ?? [],
      env: envEntries,
    });
    return `stdio:${digest(material)}`;
  }
  if (config.type === "http" || config.type === "sse") {
    return `${config.type}:${digest(config.url)}`;
  }
  return undefined;
}

function digest(material: string): string {
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export interface CreateMcpNegotiationMemoryOptions {
  /** 记忆文件路径；缺省 `<数据基目录>/.acode/cli/mcp/protocol-memory.json`。 */
  filePath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  logger?: Logger;
  now?: () => number;
}

export function createMcpNegotiationMemory(
  options: CreateMcpNegotiationMemoryOptions = {},
): McpNegotiationMemory {
  const now = options.now ?? Date.now;
  const logger = options.logger;
  const filePath = options.filePath ?? defaultNegotiationMemoryPath(options.env);

  // 读缓存：首次使用时读一次并缓存 promise；写成功后用新快照替换（读写同源，
  // 避免「刚写入又读到旧文件」的竞态）。文件故障时缓存空表并在下次写时重试落盘。
  let verdictsRead: Promise<Record<string, NegotiationVerdict>> | undefined;
  // 写串行化：并发连接共享一条写链，绝不交叉写坏文件。
  let writeChain: Promise<void> = Promise.resolve();

  function readVerdicts(): Promise<Record<string, NegotiationVerdict>> {
    verdictsRead ??= loadVerdicts(filePath, logger, now).catch(() => ({}));
    return verdictsRead;
  }

  function mutate(
    mutateFn: (
      verdicts: Record<string, NegotiationVerdict>,
    ) => Record<string, NegotiationVerdict> | undefined,
  ): Promise<void> {
    writeChain = writeChain
      .then(async () => {
        const current = await readVerdicts();
        const next = mutateFn(current);
        if (next === undefined) return;
        verdictsRead = Promise.resolve(next);
        const failure = await saveVerdicts(filePath, next);
        if (failure !== undefined) {
          // 写失败丢弃本次变更并作废读缓存：下次使用重新读盘（fail-open）。
          verdictsRead = undefined;
          logger?.warn("MCP negotiation memory could not be saved", {
            event: "mcp.negotiation_memory.save_failed",
            reason: failure,
          });
        }
      })
      .catch(() => {});
    return writeChain;
  }

  return {
    async isRememberedLegacy(config) {
      const key = mcpServerNegotiationIdentityKey(config);
      if (key === undefined) return false;
      const verdict = (await readVerdicts())[key];
      return isFreshVerdict(verdict, now());
    },
    async rememberLegacy(config) {
      const key = mcpServerNegotiationIdentityKey(config);
      if (key === undefined) return;
      await mutate((verdicts) => {
        const existing = verdicts[key];
        if (isFreshVerdict(existing, now())) return undefined;
        return pruneVerdicts({ ...verdicts, [key]: freshVerdict(now()) }, now());
      });
    },
    async forget(config) {
      const key = mcpServerNegotiationIdentityKey(config);
      if (key === undefined) return;
      await mutate((verdicts) => {
        if (!(key in verdicts)) return undefined;
        const next = { ...verdicts };
        delete next[key];
        return next;
      });
    },
  };
}

function freshVerdict(observedAt: number): NegotiationVerdict {
  return { observedAt, latestProtocolVersion: LATEST_PROTOCOL_VERSION };
}

function isFreshVerdict(
  verdict: NegotiationVerdict | undefined,
  nowMs: number,
): verdict is NegotiationVerdict {
  if (verdict === undefined) return false;
  // 代际失效：SDK 升级把最新协议版本推进后，旧代际的观察不再可信，重新 probe。
  if (verdict.latestProtocolVersion !== LATEST_PROTOCOL_VERSION) return false;
  const age = nowMs - verdict.observedAt;
  return age >= 0 && age < MCP_NEGOTIATION_MEMORY_TTL_MS;
}

function pruneVerdicts(
  verdicts: Record<string, NegotiationVerdict>,
  nowMs: number,
): Record<string, NegotiationVerdict> {
  const entries = Object.entries(verdicts).filter(([, verdict]) => isFreshVerdict(verdict, nowMs));
  if (entries.length > MCP_NEGOTIATION_MEMORY_MAX_ENTRIES) {
    entries.sort((a, b) => a[1].observedAt - b[1].observedAt);
    entries.splice(0, entries.length - MCP_NEGOTIATION_MEMORY_MAX_ENTRIES);
  }
  return Object.fromEntries(entries);
}

export function defaultNegotiationMemoryPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const baseDir = env.ACODE_DATA_BASE_DIR?.trim() || homedir();
  return join(resolveUserPath(baseDir), MEMORY_FILE_RELATIVE_PATH);
}

async function loadVerdicts(
  filePath: string,
  logger: Logger | undefined,
  now: () => number,
): Promise<Record<string, NegotiationVerdict>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      logger?.debug("MCP negotiation memory unreadable; servers are probed as if none was remembered", {
        event: "mcp.negotiation_memory.read_failed",
      });
    }
    return {};
  }
  if (raw.length > MCP_NEGOTIATION_MEMORY_MAX_FILE_BYTES) {
    logger?.debug("MCP negotiation memory oversized; ignoring it and re-probing servers", {
      event: "mcp.negotiation_memory.oversized",
    });
    return {};
  }
  // 过期判定必须用注入时钟：测试假时钟与生产 Date.now 走同一条读路径。
  return parseVerdictFile(raw, now()) ?? {};
}

function parseVerdictFile(
  raw: string,
  nowMs: number,
): Record<string, NegotiationVerdict> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  // 未来版本写入的文件：整份作废（不猜测未来语义），方向 = 没有记忆 = 重新 probe。
  if (record.version !== MEMORY_FILE_VERSION) return {};
  const verdicts = record.verdicts;
  if (typeof verdicts !== "object" || verdicts === null || Array.isArray(verdicts)) return {};
  const result: Record<string, NegotiationVerdict> = {};
  for (const [key, value] of Object.entries(verdicts as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.observedAt !== "number" || !Number.isFinite(candidate.observedAt)) {
      continue;
    }
    if (typeof candidate.latestProtocolVersion !== "string") continue;
    const verdict: NegotiationVerdict = {
      observedAt: candidate.observedAt,
      latestProtocolVersion: candidate.latestProtocolVersion,
    };
    if (isFreshVerdict(verdict, nowMs)) result[key] = verdict;
  }
  return result;
}

async function saveVerdicts(
  filePath: string,
  verdicts: Record<string, NegotiationVerdict>,
): Promise<string | undefined> {
  const payload = `${JSON.stringify({ version: MEMORY_FILE_VERSION, verdicts }, null, 2)}\n`;
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
