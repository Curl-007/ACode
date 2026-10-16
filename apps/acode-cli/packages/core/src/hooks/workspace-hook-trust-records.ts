import type { WorkspaceHookBundleSnapshot, WorkspaceHookTrustRecord } from "@acode/contracts";
import { workspaceHookTrustRecordSchema } from "@acode/contracts";

// hook-pins 三态钉扎（第二轮 W2 起）不在本文件：pins 记录层与分类层按 400 行
// ratchet 拆分先例落在 workspace-hook-pins.ts / workspace-hook-pins-classify.ts，
// 经 workspace-hook-trust-domain.ts barrel 与本文件的公开导入路径同面再导出。
// 两记录层同属「授予时事实」：trust 记录按 bundleDigest/declarationDigest 谱系回答
// 「声明集合是否可信」，pins 回答「声明解析到的内容是否可钉/是否漂移」。
export function createWorkspaceHookTrustRecords(input: {
  snapshot: WorkspaceHookBundleSnapshot;
  reviewItemIds: readonly string[];
  grantedAt: string;
  appVersion?: string;
}): WorkspaceHookTrustRecord[] {
  const items = new Map(input.snapshot.hooks.map((entry) => [entry.reviewItemId, entry] as const));
  return unique(input.reviewItemIds).map((reviewItemId) => {
    const entry = items.get(reviewItemId);
    if (!entry) throw new Error(`Unknown Workspace Hook review item: ${reviewItemId}`);
    const source = input.snapshot.sourceFiles[entry.sourceFileIndex];
    if (!source) throw new Error(`Workspace Hook source is missing for ${reviewItemId}`);
    return workspaceHookTrustRecordSchema.parse({
      workspaceIdentity: input.snapshot.workspaceIdentity,
      hookDeclarationDigest: entry.hookDeclarationDigest,
      digestAlgorithm: "sha256",
      decision: "trusted",
      grantedAt: input.grantedAt,
      bundleDigestAtGrant: input.snapshot.bundleDigest,
      eventAtGrant: entry.event,
      displayCommandAtGrant:
        entry.type === "process" ? [entry.command, ...(entry.args ?? [])].join(" ") : entry.command,
      sourcePathAtGrant: entry.sourceRelativePath,
      sourceDiscoveryOrderAtGrant: source.discoveryOrder,
      matcherAtGrant: entry.matcher,
      matcherIndexAtGrant: entry.matcherIndex,
      hookIndexAtGrant: entry.hookIndex,
      ...(input.appVersion ? { appVersionAtGrant: input.appVersion } : {}),
    });
  });
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
