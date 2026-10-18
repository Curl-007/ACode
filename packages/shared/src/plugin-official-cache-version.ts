/**
 * 官方插件 cache 版本目录名的解析、比较与组内择优（判据单点）。
 *
 * 规格与消费方（三处共享同一判据，防漂移）：
 * - specs/plugin-official-cache-authority-m1.md 规则 V2/V3：M1 权威分片缺失回退
 *   readdir 全扫后，官方 cache 按插件名分组做组内 semver 择优（adapters
 *   `scanOfficialCache` 回退分支与 services `scanOfficialPluginCacheRoots` 回退分支）。
 * - specs/official-plugin-cache-cleanup.md §R1 条件 3 / §R4：清理线「更旧」判定
 *   （`compareOfficialPluginVersionDirNames(ref, v) > 0`）。
 * - 两份 spec 的表驱动一致性测试共用同一组样本（M1 择优测试与 D2 清理测试）。
 *
 * 为什么不给 shared 引入 semver 依赖：shared 主入口跨端（CLI / services / desktop
 * 共同依赖），本判据只是「数值三元组 + semver.coerce 兼容语义」的极小子集；与 semver
 * 的一致性（`0.2.0 < 0.3.0`、`0.10.0 > 0.9.0`、coerce 失败 = 不可解析）由 shared 侧
 * 表驱动测试钉住。adapters `version-compare.ts`（更新状态 UX）保持 semver 不动，
 * 其与判据单点的一致性同样由该样本组钉住。
 */

/** 数值三元组（semver.coerce 兼容：缺省段补 0）。 */
export type OfficialPluginVersionTriple = readonly [number, number, number];

/**
 * 解析官方插件 cache 的版本目录名为数值三元组；不可解析 → undefined。
 *
 * 可解析形态（全串锚定）：可选小写 `v` 前缀 + 1-3 段十进制数字，缺省段补 0
 * （`"1"` → [1,0,0]，`"1.2"` → [1,2,0]，允许前导零，与 semver.coerce 一致）。
 *
 * 刻意不用 semver.coerce 的子串扫描语义：
 * - `.backup-*`/`.tmp-*`/`.seed-lock*` 等事务过渡目录以 "." 开头，形状上即不可解析
 *   （specs/official-plugin-cache-cleanup.md §R1 条件 4「形状上即不满足」，与
 *   条件 3「不可解析的版本名永不删除」构成双重排除）；子串 coerce 会把
 *   `.tmp-1.2.3` 误判成 1.2.3，必须拒绝。
 * - 带预发布/构建后缀的目录名（`0.2.0-beta.1`）不解析 → 不产出候选根、清理永不删，
 *   失败方向一律保守。
 */
export function parseOfficialPluginVersionDirName(
  dirName: string,
): OfficialPluginVersionTriple | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(dirName);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareOfficialPluginVersionTriples(
  [aMajor, aMinor, aPatch]: OfficialPluginVersionTriple,
  [bMajor, bMinor, bPatch]: OfficialPluginVersionTriple,
): number {
  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  return aPatch - bPatch;
}

/**
 * 比较两个版本目录名：a 旧于 b → 负数，相等 → 0，a 新于 b → 正数。
 * 任一目录名不可解析 → undefined：调用方必须视为「不参与比较」
 * （清理线由此保证不可解析目录永不删除；择优线由此保证不可解析目录不产出候选根）。
 */
export function compareOfficialPluginVersionDirNames(a: string, b: string): number | undefined {
  const left = parseOfficialPluginVersionDirName(a);
  const right = parseOfficialPluginVersionDirName(b);
  if (!left || !right) return undefined;
  return compareOfficialPluginVersionTriples(left, right);
}

/**
 * 规则 V2 组内择优：仅保留可解析为版本的目录名中 semver 最高者；
 * 同版本并列取目录名字典序较大者（保证两条管线对同一磁盘状态输出确定且一致）；
 * 全部不可解析（含空数组）→ undefined。
 */
export function selectBestOfficialPluginVersionDirName(
  dirNames: readonly string[],
): string | undefined {
  let bestName: string | undefined;
  let bestTriple: OfficialPluginVersionTriple | undefined;
  for (const candidate of dirNames) {
    const triple = parseOfficialPluginVersionDirName(candidate);
    if (!triple) continue;
    if (!bestTriple || !bestName) {
      bestName = candidate;
      bestTriple = triple;
      continue;
    }
    const ordering = compareOfficialPluginVersionTriples(triple, bestTriple);
    if (ordering > 0 || (ordering === 0 && candidate > bestName)) {
      bestName = candidate;
      bestTriple = triple;
    }
  }
  return bestName;
}
