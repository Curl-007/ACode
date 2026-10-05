/**
 * Host 存储启动的 cwd 候选降级裁决（specs/host-startup-storage-cwd.md R1/R3/R4）。
 * 叶子模块零跨包依赖：cwd 选择规则本体仍归 services/resolveACodeAgentSpawnCwd，
 * 由调用方注入，这里只裁决「跳过失效候选、全灭时保持 fail-loud」。
 */
export interface SessionStorageCwdResolution {
  cwd: string;
  usedFallback: boolean;
  cwdExists: boolean;
}

export async function resolveSessionStorageStartupDirectories(options: {
  candidates: readonly string[];
  fallbackCwd: string;
  resolveCwd: (candidate: string) => Promise<SessionStorageCwdResolution>;
}): Promise<{ directories: string[]; skipped: string[] }> {
  const directories = new Set<string>();
  const skipped: string[] = [];
  for (const candidate of options.candidates) {
    const { cwd, cwdExists } = await options.resolveCwd(candidate);
    // R3：worker 对 --cwd 做严格可访问校验，死 cwd 必然 transport_closed；
    // 已删除的历史项目不得拖累其他存活目录的准备。
    if (cwdExists) directories.add(cwd);
    else skipped.push(candidate);
  }
  // R4：全灭时不得静默跳过准备——仍以 fallback 进入一次 prepareSessionStorage，
  // 宁可显式失败暴露存储不可用，也不能让会话库未经迁移准备就进入服务。
  if (directories.size === 0) directories.add(options.fallbackCwd);
  return { directories: [...directories], skipped };
}
