// U07 目录视图（带缓存）：把 turn 轻量索引投影成面板可直接消费的目录。
//
// 从 conversationIndexFocusController.ts 拆出，使焦点状态机本体留在 400 行以内。
// 本模块**只读**：不发任何 rowsRange 请求、不扫描正文（spec 规则 1 / U07-A1 门槛），
// 因此「打开目录」的成本是一次索引遍历，且结果按内容键缓存。
import { resolveIndexDirectory, type IndexDirectory } from "@/v4/conversationIndexNavigation.js";
import {
  EMPTY_INDEX_DIRECTORY,
  sameIndexDirectoryCacheKey,
  type IndexDirectoryCacheKey,
} from "@/v4/conversationIndexFocusTypes.js";
import type { IndexFocusHost } from "@/v4/conversationIndexFocusTypes.js";

export { EMPTY_INDEX_DIRECTORY };

/**
 * 目录视图。直接消费 IndexFocusHost（与控制器同一个只读事实面），
 * 不再另立一份适配对象——避免出现两条目录数据源接线。
 */
export class ConversationIndexDirectoryView {
  private cache: { key: IndexDirectoryCacheKey; value: IndexDirectory } | null = null;
  private fallbackSummary = "";

  constructor(private readonly host: IndexFocusHost) {}

  /**
   * 空摘要文案由 i18n 侧注入（store/视图都不持有词典）。
   * 文案变化必须失效缓存，否则语言切换后目录仍显示旧语言的占位文案。
   */
  setFallbackSummary(summary: string): void {
    if (this.fallbackSummary === summary) return;
    this.fallbackSummary = summary;
    this.cache = null;
  }

  /**
   * 求目录。缓存键 = (索引条数, 淘汰数, 索引字节, 内容 revision, 尾部首行 rowId)——
   * 覆盖「索引内容变了」「realUser query 增删了」「尾部前插改变了 inWindow 判定」
   * 三类失效原因；命中时返回同一引用，避免无谓重渲染。
   */
  resolve(): IndexDirectory {
    const host = this.host;
    const tailFirstRowId = host.snapshot?.rows.window[0]?.rowId ?? null;
    const key: IndexDirectoryCacheKey = {
      size: host.turnIndexSize(),
      evictions: host.turnIndexEvictionCount(),
      bytes: host.turnIndexByteEstimate(),
      revision: host.directoryRevision,
      tailFirstRowId,
    };
    if (sameIndexDirectoryCacheKey(this.cache?.key ?? null, key)) {
      return this.cache?.value ?? EMPTY_INDEX_DIRECTORY;
    }
    const value = resolveIndexDirectory(host.turnIndexEntries(), key.evictions, {
      tailFirstRowId,
      maxEntries: host.maxIndexEntries,
      fallbackSummary: this.fallbackSummary,
    });
    this.cache = { key, value };
    return value;
  }

  /** 索引或权威裁剪后失效（rewind/edit、logEpoch 换代）。 */
  invalidate(): void {
    this.cache = null;
  }
}
