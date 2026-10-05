import type { ExternalSessionSummary } from "#src/session/external-import/types.js";

/**
 * R7 repo_ranking：按「仓库 git 活跃度」给发现结果排序的可选子项。
 * 缺省不启用（feature flag）——探测成本与价值需 UI 联动评估，本文件先落纯函数与测试。
 */
export const EXTERNAL_IMPORT_REPO_RANKING_ENABLED = false;

/** 单个 cwd 的 git 活跃度探测结果（毫秒 epoch）；null 表示探测失败/不是 git 仓库。 */
export interface ExternalRepoGitActivity {
  /** 最近一次提交时间；拿不到时退化为 .git 目录 mtime。 */
  lastCommitTs?: number;
  /** .git 目录 mtime，作为提交频率的粗代理。 */
  gitDirMtimeMs?: number;
}

/**
 * 活跃度排序 key：最近提交时间为主序，.git mtime 为次序。
 * 纯函数——探测 IO 由调用方注入（flag 打开时才发生），单测只喂合成数据。
 */
export function computeExternalRepoRankHint(
  activity: ExternalRepoGitActivity | null | undefined,
): number {
  if (!activity) {
    return 0;
  }
  const lastCommitTs = activity.lastCommitTs ?? 0;
  const gitDirMtimeMs = activity.gitDirMtimeMs ?? 0;
  // 主序用秒级避免毫秒抖动；次序保留 mtime 小时桶，频率代理只在同主序内生效。
  return Math.trunc(Math.max(lastCommitTs, 0) / 1000) * 1_000_000 + Math.trunc(gitDirMtimeMs / 3_600_000);
}

/**
 * 给 summaries 附加 rankHint 并按活跃度降序排序（同 rankHint 时按 lastActivityTs 降序稳定排序）。
 * probes 的 key 由调用方统一归一化（win32 大小写不敏感比较等）。
 */
export function rankExternalSessionSummaries(
  summaries: readonly ExternalSessionSummary[],
  probes: ReadonlyMap<string, ExternalRepoGitActivity | null>,
  normalizeCwdKey: (cwd: string) => string = (cwd) => cwd,
): ExternalSessionSummary[] {
  const ranked = summaries.map((summary) => {
    if (!summary.cwd) {
      return summary;
    }
    const activity = probes.get(normalizeCwdKey(summary.cwd));
    if (!activity) {
      return summary;
    }
    return { ...summary, rankHint: computeExternalRepoRankHint(activity) };
  });
  ranked.sort((left, right) => {
    const leftRank = left.rankHint ?? 0;
    const rightRank = right.rankHint ?? 0;
    if (leftRank !== rightRank) {
      return rightRank - leftRank;
    }
    return right.lastActivityTs - left.lastActivityTs;
  });
  return ranked;
}
