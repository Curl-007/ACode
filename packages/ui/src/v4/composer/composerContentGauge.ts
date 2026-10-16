/**
 * live composer 内容块数的窗口级 gauge（诊断-only，specs/main-stall-diagnostics.md R11）。
 *
 * 为什么需要 gauge：内容状态面包屑在 interval 里采样，采样函数既不能进 React 树
 * （拿不到组件态），也不能读 localStorage 草稿（同步 IO 本身就是要归因的卡顿源）。
 * composer 在既有 Lexical onChange 路径上把当前正文推给本模块，采样侧做纯内存读。
 *
 * 已知近似（登记）：分屏多 composer 并存时最后写入者胜；composer 卸载不清零，
 * 由采样侧按 route kind 归零（非 chat 面不读 gauge）。桶粒度 zero/few/many 下可接受。
 */

/** Lexical 正文以换行分隔块；空行不计入（与「有内容的块」直觉一致）。 */
export function countComposerTextBlocks(text: string): number {
  if (!text.trim()) {
    return 0;
  }
  let blocks = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) {
      blocks += 1;
    }
  }
  return blocks;
}

let composerBlockCount = 0;

/** composer onChange 路径调用：把当前正文折算成块数存进 gauge。 */
export function publishComposerContentGauge(text: string): void {
  composerBlockCount = countComposerTextBlocks(text);
}

/** 采样侧纯内存读；从未写入过则为 0。 */
export function readComposerContentGauge(): number {
  return composerBlockCount;
}

/** 测试钩子：清零 gauge。 */
export function resetComposerContentGaugeForTest(): void {
  composerBlockCount = 0;
}
