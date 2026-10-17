// stat 通道 skew 自检探针（价值提取第二轮 T3 条目，SafeFs 身份复核的配套自检）。
//
// 动机：某些卷（网络重定向、容器 overlay、文件系统翻译层）上，按名 lstat 与按句柄
// fstat 报告的 dev/ino 不在同一编号通道，身份复核会产生系统性假阳性。探针把
// "本目录是否存在 stat 通道 skew"变成实测事实：在锚目录 O_EXCL 建临时文件，比对
// 两个通道的身份字段；首测 skew 必须复测一次且 dev 走向一致才判定成立，避免把
// 瞬时噪声当成可容忍的 skew（fail-closed：测不准一律 unmeasured，不容忍）。
//
// 规格：packages/services/specs/file-containment-trust-tiers.md R2。
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export type StatChannelSkewKind = "none" | "skew" | "unmeasured";

export interface StatChannelSkewResult {
  kind: StatChannelSkewKind;
  /** kind === "skew" 时：按名 lstat 报告的 dev（字符串化 bigint，可跨 RPC 序列化）。 */
  byNameDev?: string;
  /** kind === "skew" 时：按句柄 fstat 报告的 dev。 */
  byHandleDev?: string;
  /** kind === "skew" 时：两次实测一致的 ino 差值；复测不一致则为 null（不可用于容忍判定）。 */
  inoDelta?: string | null;
}

// unmeasured 结论允许 30s 后重测（瞬时失败不应永久钉死）；none/skew 本进程内缓存。
const PROBE_RETRY_WINDOW_MS = 30_000;

interface ProbeCacheEntry {
  retryAt: number;
  result: Promise<StatChannelSkewResult>;
}

const probeCache = new Map<string, ProbeCacheEntry>();

/** 单次实测：O_EXCL 建临时文件 → 按句柄 fstat vs 按名 lstat → 比对身份字段。 */
async function measureStatChannelOnce(anchorDir: string): Promise<StatChannelSkewResult> {
  const probePath = join(anchorDir, `.acode-stat-probe-${randomBytes(8).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      probePath,
      (fsConstants.O_WRONLY ?? 0) | (fsConstants.O_CREAT ?? 0) | (fsConstants.O_EXCL ?? 0),
      0o600,
    );
  } catch {
    // 锚目录不可写/不存在：测不准，按 fail-closed 处理（unmeasured 不容忍任何 mismatch）。
    return { kind: "unmeasured" };
  }
  try {
    const byHandle = await handle.stat({ bigint: true });
    const byName = await lstat(probePath, { bigint: true });
    // 按名侧必须看到一个"刚创建的普通空文件"，且两通道非身份字段一致，
    // 否则说明测量本身被干扰（杀软/索引器/通道噪声），判 unmeasured。
    if (
      !byName.isFile() ||
      byName.size !== 0n ||
      byName.nlink !== 1n ||
      byName.size !== byHandle.size ||
      byName.nlink !== byHandle.nlink ||
      byName.birthtimeNs !== byHandle.birthtimeNs ||
      byName.mtimeNs !== byHandle.mtimeNs
    ) {
      return { kind: "unmeasured" };
    }
    // 身份字段不可用（0）或 dev 一致：本目录不存在可测量的通道分裂。
    if (
      byName.dev === 0n ||
      byHandle.dev === 0n ||
      byName.ino === 0n ||
      byHandle.ino === 0n ||
      byName.dev === byHandle.dev
    ) {
      return { kind: "none" };
    }
    return {
      kind: "skew",
      byNameDev: byName.dev.toString(),
      byHandleDev: byHandle.dev.toString(),
      inoDelta: (byHandle.ino - byName.ino).toString(),
    };
  } catch {
    return { kind: "unmeasured" };
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(probePath).catch(() => undefined);
  }
}

/** skew 判定必须复测一次：两次同向且 dev 走向一致才成立，否则降级 unmeasured。 */
async function measureWithRetest(anchorDir: string): Promise<StatChannelSkewResult> {
  const first = await measureStatChannelOnce(anchorDir);
  if (first.kind !== "skew") {
    return first;
  }
  const second = await measureStatChannelOnce(anchorDir);
  if (
    second.kind !== "skew" ||
    second.byNameDev !== first.byNameDev ||
    second.byHandleDev !== first.byHandleDev
  ) {
    return { kind: "unmeasured" };
  }
  return {
    kind: "skew",
    byNameDev: first.byNameDev,
    byHandleDev: first.byHandleDev,
    inoDelta: second.inoDelta === first.inoDelta ? first.inoDelta : null,
  };
}

/**
 * 取锚目录的 stat 通道 skew 结论（带进程内缓存；unmeasured 30s 后可重测）。
 * 身份复核路径在 dev/ino 不一致时调用；调用方必须只在 kind === "skew" 且
 * dev 走向/inoDelta 与实测吻合时容忍（见 fileContainment.ts）。
 */
export function getStatChannelSkew(anchorDir: string): Promise<StatChannelSkewResult> {
  const key = resolve(anchorDir);
  const cached = probeCache.get(key);
  if (cached !== undefined && Date.now() < cached.retryAt) {
    return cached.result;
  }
  const entry: ProbeCacheEntry = {
    retryAt: Number.POSITIVE_INFINITY,
    result: Promise.resolve({ kind: "unmeasured" }),
  };
  entry.result = (async () => {
    const measured = await measureWithRetest(key);
    if (measured.kind === "unmeasured") {
      entry.retryAt = Date.now() + PROBE_RETRY_WINDOW_MS;
    }
    return measured;
  })();
  probeCache.set(key, entry);
  return entry.result;
}

/** 仅供测试：清空探针缓存，避免用例间串扰。 */
export function resetStatSkewProbeCache(): void {
  probeCache.clear();
}

/** 探针结论的可读描述（拼进拒绝文案，便于现场诊断通道形态）。 */
export function describeStatChannelSkew(result: StatChannelSkewResult): string {
  if (result.kind === "skew") {
    return `skew{dev=${result.byNameDev}->${result.byHandleDev}, inoDelta=${result.inoDelta ?? "inconsistent"}}`;
  }
  return result.kind;
}
