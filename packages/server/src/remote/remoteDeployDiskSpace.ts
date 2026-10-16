// 远端磁盘余量预检（部署补强）。
// 规格见 packages/server/specs/remote-deploy-hardening.md R1。
//
// 修复原因：部署（上传/远端下载 + 解包 + 版本目录并存 + GC 滞后）可能耗尽
// 远端磁盘，失败形态是中途 ENOSPC 并留下半成品部署目录。这里在任何远端写入
// 前用 df 等价探测要求余量 ≥ 7× 估算资产大小，不足即拒绝并解释。
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { IRemoteBackend } from "@acode/server/remote/backend.js";
import type { DeployLoggers } from "@acode/server/remote/deployShared.js";
import { REMOTE_BASE } from "@acode/server/remote/deployShared.js";
import { quotePosixPathArg } from "@acode/server/remote/posixShell.js";

/** 7× 覆盖「下载 + 解包 + 版本目录并存 + GC 滞后」的峰值占用。 */
export const REMOTE_DEPLOY_DISK_HEADROOM_MULTIPLIER = 7;

const PROBE_TIMEOUT_MS = 10_000;

export class RemoteDeployDiskSpaceError extends Error {
  readonly code = "remote-disk-space-insufficient" as const;

  constructor(message: string) {
    super(message);
    this.name = "RemoteDeployDiskSpaceError";
  }
}

export interface RemoteDiskProbeResult {
  readonly availableBytes: number;
  readonly probedPath: string;
}

export function formatRemoteAssetBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return `${bytes}B`;
  }
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${bytes}B`;
}

/**
 * 解析 df 输出的 Available（1024-blocks）列并换算字节。
 * 兼容 GNU/BusyBox 形态与「Filesystem 名过长换行」：优先定位 `NN%` 容量列，
 * Available 恒在其前一列；无容量列时回退「第 3 个纯数字字段」
 * （POSIX 列序：Filesystem blocks Used Available Capacity Mounted-on）。
 */
export function parseDfAvailableBytes(stdout: string): number | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    return null;
  }
  const fields = (lines[lines.length - 1] ?? "").split(/\s+/);
  if (fields.length < 4) {
    return null;
  }

  const toBytes = (field: string | undefined): number | null => {
    if (field == null || !/^\d+$/.test(field)) {
      return null;
    }
    const kb = Number.parseInt(field, 10);
    return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null;
  };

  const capacityIndex = fields.findIndex((field) => /^\d{1,3}%$/.test(field));
  if (capacityIndex >= 1) {
    const fromCapacity = toBytes(fields[capacityIndex - 1]);
    if (fromCapacity != null) {
      return fromCapacity;
    }
  }
  const numericFields = fields.filter((field) => /^\d+$/.test(field));
  if (numericFields.length >= 3) {
    return toBytes(numericFields[2]);
  }
  return null;
}

async function runRemoteProbeCommand(
  backend: IRemoteBackend,
  command: string,
): Promise<{ code: number; stdout: string } | null> {
  try {
    const stream = await backend.exec(command);
    let stdout = "";
    stream.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 64_000) {
        stdout += chunk.toString();
      }
    });
    const code = await Promise.race([
      new Promise<number>((resolve) => {
        stream.onClose((exitCode) => resolve(exitCode));
      }),
      new Promise<number>((resolve) => {
        // 探测命令必须有界：df 挂起不能把整个部署拖死，超时按探测失败处理。
        setTimeout(() => resolve(-1), PROBE_TIMEOUT_MS).unref?.();
      }),
    ]);
    return { code, stdout };
  } catch {
    return null;
  }
}

function buildDfProbeCommand(quotedTarget: string): string {
  // -P 是 POSIX 稳定输出形态；老 BusyBox 可能不识别 -P，逐级回退。
  return (
    `df -Pk ${quotedTarget} 2>/dev/null || ` +
    `df -k ${quotedTarget} 2>/dev/null || ` +
    `df ${quotedTarget} 2>/dev/null`
  );
}

/**
 * 依序探测 REMOTE_BASE → $HOME → /，返回第一个可解析的余量结果。
 * 全部失败返回 null（调用方 warn 后继续部署：无法测量 ≠ 余量充足，
 * 但上传失败的 ENOSPC 会自然暴露，不用臆造数字拒绝部署）。
 */
export async function probeRemoteDiskSpace(
  backend: IRemoteBackend,
): Promise<RemoteDiskProbeResult | null> {
  const targets = [quotePosixPathArg(REMOTE_BASE), '"$HOME"', "/"];
  for (const target of targets) {
    const result = await runRemoteProbeCommand(backend, buildDfProbeCommand(target));
    if (!result || result.code !== 0) {
      continue;
    }
    const availableBytes = parseDfAvailableBytes(result.stdout);
    if (availableBytes != null) {
      return { availableBytes, probedPath: target };
    }
  }
  return null;
}

/**
 * 估算本次部署的资产字节数：优先 stat 本地 release 目录的必需文件；目录不可得
 * 回退 manifest 组件可选 sizeBytes 声明（发布管线登记字段）；都不可得返回 null。
 */
export async function estimateRemoteDeployAssetBytes(params: {
  releaseDir: string | null;
  requiredRelativePaths: readonly string[];
  manifestComponents?: readonly unknown[] | null;
}): Promise<number | null> {
  if (params.releaseDir) {
    let total = 0;
    let sawAnyFile = false;
    for (const relativePath of params.requiredRelativePaths) {
      try {
        const stats = await stat(join(params.releaseDir, relativePath));
        if (stats.isFile()) {
          total += stats.size;
          sawAnyFile = true;
        }
      } catch {
        // 缺失文件由部署阶段自然暴露；估算只累计实际存在的资产。
      }
    }
    if (sawAnyFile) {
      return total;
    }
  }

  let total = 0;
  let sawAnySize = false;
  for (const component of params.manifestComponents ?? []) {
    const size = (component as { sizeBytes?: unknown } | null)?.sizeBytes;
    if (typeof size === "number" && Number.isFinite(size) && size > 0) {
      total += size;
      sawAnySize = true;
    }
  }
  return sawAnySize ? total : null;
}

export interface PreflightRemoteDeployDiskSpaceParams {
  requiredRelativePaths: readonly string[];
  resolveReleaseDir: () => Promise<string | null>;
  manifestComponents?: readonly unknown[] | null;
  loggers: DeployLoggers;
}

/**
 * 部署前门禁：余量 < 7× 估算资产 → 抛 RemoteDeployDiskSpaceError（远端写入前）。
 * 预检自身异常（探测挂死、stat 失败等）不得成为新的部署失败源：warn 后放行。
 */
export async function preflightRemoteDeployDiskSpace(
  backend: IRemoteBackend,
  params: PreflightRemoteDeployDiskSpaceParams,
): Promise<void> {
  const { log, logWarn } = params.loggers;
  let probe: RemoteDiskProbeResult | null;
  try {
    probe = await probeRemoteDiskSpace(backend);
  } catch (error) {
    logWarn(`[deploy-disk] probe failed (continuing): ${String(error)}`);
    return;
  }
  if (!probe) {
    logWarn("[deploy-disk] remote df probe unavailable; skipping headroom preflight");
    return;
  }

  let estimatedBytes: number | null;
  try {
    // release 目录只在探测成功后才解析：避免探测不可用时白白触发 CDN 下载。
    estimatedBytes = await estimateRemoteDeployAssetBytes({
      releaseDir: await params.resolveReleaseDir(),
      requiredRelativePaths: params.requiredRelativePaths,
      manifestComponents: params.manifestComponents,
    });
  } catch (error) {
    logWarn(`[deploy-disk] asset estimate failed (continuing): ${String(error)}`);
    return;
  }
  if (estimatedBytes == null || estimatedBytes <= 0) {
    logWarn("[deploy-disk] asset size not estimable; skipping headroom comparison");
    return;
  }

  const requiredBytes = estimatedBytes * REMOTE_DEPLOY_DISK_HEADROOM_MULTIPLIER;
  if (probe.availableBytes < requiredBytes) {
    throw new RemoteDeployDiskSpaceError(
      `远端磁盘余量不足：可用 ${formatRemoteAssetBytes(probe.availableBytes)}（探测点 ${probe.probedPath}），` +
        `本次部署至少需要 ${formatRemoteAssetBytes(requiredBytes)}` +
        `（资产估算 ${formatRemoteAssetBytes(estimatedBytes)} × ${REMOTE_DEPLOY_DISK_HEADROOM_MULTIPLIER} 倍余量系数，覆盖下载、解包与版本目录并存）。` +
        `请清理远端磁盘后重试。`,
    );
  }
  log(
    `[deploy-disk] headroom ok: available=${formatRemoteAssetBytes(probe.availableBytes)} ` +
      `required=${formatRemoteAssetBytes(requiredBytes)} estimate=${formatRemoteAssetBytes(estimatedBytes)}`,
  );
}
