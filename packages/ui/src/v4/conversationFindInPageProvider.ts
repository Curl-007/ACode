/**
 * 页内查找二期：ConversationTimeline 虚拟化列表 provider（WI-E2b 接线；
 * specs: packages/desktop/specs/find-in-page.md R11/R15）。
 *
 * 把 @tanstack/react-virtual 虚拟化会话列表接入 find-in-page provider 双路：
 * - 搜索腿：只对**已物化进 DOM** 的渲染窗口做应用级 DOM 搜索（复用
 *   find-in-page/findInPageDomSearch.ts 纯核心），未渲染区不报假命中；
 * - loadRest：请求宿主把 overscan 按批增长（每批 FIND_TIMELINE_MOUNT_BATCH_SIZE 个
 *   unit、逐 commit 步进），直到全部 unit 挂载（封顶 = 全量）；协调器仅在本轮
 *   total=0 时触发并等待（自身 4s 封顶兜底）；
 * - 封顶边界：unit 总数超过 FIND_TIMELINE_FULL_MOUNT_CAP 时不提供 loadRest——
 *   一次性全挂载的 commit 成本不可控，转而由 hasUnrenderedContent()=true 让协调器
 *   申报 hasUnsearchableRegions（诚实收口：计数只反映可搜区，不作假命中）。
 *
 * 高亮纪律（find-in-page 目录只读复用，本文件不修改契约）：
 * - 协调器每轮先 env.clearHighlights()（删除整个命名 Highlight）再
 *   applyMatchHighlight(dom 腿 ranges)，然后逐腿 provider.show()——本 provider 必须
 *   **追加**进共享的全部命中层（registry.get(FIND_HIGHLIGHT_NAME).add），不能调
 *   applyMatchHighlight（它会先 clear，把先画的 dom 腿高亮抹掉）；
 * - active 层全局唯一（一轮只有一条腿拿到 activeInScope >= 0），直接用导出的
 *   applyActiveHighlight 画/清；
 * - ::highlight 规则 sheet：findInPageHighlight.ts 的 sheet 是模块私有，且 dom 腿
 *   零命中时其 sheet 不会 adopt 到 document——本文件自管一份同规则的 sheet 按需
 *   adopt，保证「只有 provider 腿有命中」时高亮同样着色（双 sheet 同规则叠加无害）。
 *
 * DOM 触面全部经 deps 注入——纯编排 node 可测；React 生命周期（注册/注销、overscan
 * 状态、commit 放行）在 useConversationFindInPageProvider.ts。
 */
import {
  collectSearchableText,
  createDomCollectEnv,
  findTextMatchIntervals,
  mapMatchesToRanges,
} from "@/find-in-page/findInPageDomSearch.js";
import {
  applyActiveHighlight,
  FIND_HIGHLIGHT_ACTIVE_NAME,
  FIND_HIGHLIGHT_NAME,
} from "@/find-in-page/findInPageHighlight.js";
import type { FindInPageScopeProvider } from "@/find-in-page/findInPageProvider.js";

/** loadRest 批增长步长：每批把 overscan 目标推进 N 个 unit（逐 commit 一批）。 */
const FIND_TIMELINE_MOUNT_BATCH_SIZE = 400;
/**
 * 一次性全挂载的 unit 总数封顶：超过即不提供 loadRest，未渲染区按「不可搜」
 * 诚实申报（hasUnsearchableRegions），不用不可控的巨型 commit 换完整性。
 */
export const FIND_TIMELINE_FULL_MOUNT_CAP = 2000;

/** provider 的宿主环境触面（浏览器 = ConversationTimeline hook；测试 = stub）。 */
export interface ConversationFindInPageProviderDeps {
  /** scope 根元素（message layer）；null = 未挂载/已卸载。 */
  getScopeEl(): Element | null;
  /** 在 scope 子树的已渲染 DOM 内搜索，返回文档序命中 range（浏览器=DOM 搜索适配）。 */
  searchScopeRanges(text: string): readonly unknown[];
  /** 当前已挂载的虚拟行数（virtualizer 窗口 + overscan）。 */
  getRenderedUnitCount(): number;
  /** 虚拟化 unit 总数（live tail 恒定挂载，不计入）。 */
  getTotalUnitCount(): number;
  /** 请求宿主把 overscan 目标扩展到 target（只增不减，直到全量）。 */
  requestExpandedMount(target: number): void;
  /** 撤销扩展（overscan 回到窗口默认值），并放行所有 commit 等待者让在途批增长退出。 */
  resetExpandedMount(): void;
  /** 等一次 React commit（批增长步进信号；宿主每次 commit 后放行一批）。 */
  awaitCommitted(): Promise<void>;
  /** 批增长步长（测试可注入小值）。 */
  mountBatchSize?: number;
  /** 全挂载封顶（测试可注入小值）。 */
  fullMountCap?: number;
}

interface HighlightEntryLike {
  add(range: unknown): void;
  delete?(range: unknown): void;
}

interface HighlightRegistryLike {
  get(name: string): HighlightEntryLike | undefined;
  set(name: string, highlight: HighlightEntryLike): void;
}

interface ScopeViewLike {
  CSS?: { highlights?: HighlightRegistryLike };
  Highlight?: new () => HighlightEntryLike;
  CSSStyleSheet?: new () => CSSStyleSheet;
}

interface ScopeDocumentLike {
  defaultView: ScopeViewLike | null;
  adoptedStyleSheets?: readonly CSSStyleSheet[];
}

interface ScopeRangeLike {
  startContainer: {
    getRootNode(): unknown;
    parentElement?: { scrollIntoView?(options: { block: string }): void } | null;
  };
}

/** per-document 自管 sheet 缓存（文档回收即消亡；规则与 findInPageHighlight 一致）。 */
const scopeSheets = new WeakMap<ScopeDocumentLike, CSSStyleSheet>();

function ensureScopeSheet(doc: ScopeDocumentLike): CSSStyleSheet | null {
  const view = doc.defaultView;
  if (!view || typeof view.CSSStyleSheet !== "function") {
    return null;
  }
  let sheet = scopeSheets.get(doc);
  if (!sheet) {
    sheet = new view.CSSStyleSheet();
    sheet.insertRule(
      `::highlight(${FIND_HIGHLIGHT_NAME}) { background-color: var(--color-find-highlight, #fde68a); }`,
      sheet.cssRules.length,
    );
    sheet.insertRule(
      "::highlight(acode-find-in-page-active) { background-color: var(--color-find-highlight-active, #facc15); }",
      sheet.cssRules.length,
    );
    scopeSheets.set(doc, sheet);
  }
  return sheet;
}

/** 把 sheet adopt 到 range 起点所在的根（document 或 open shadow root）。 */
function adoptSheetForRange(
  doc: ScopeDocumentLike,
  sheet: CSSStyleSheet,
  range: ScopeRangeLike,
): void {
  const root = range.startContainer.getRootNode() as ScopeDocumentLike | null;
  const target = root && "adoptedStyleSheets" in root ? root : doc;
  const current = target.adoptedStyleSheets ?? [];
  if (!current.includes(sheet)) {
    target.adoptedStyleSheets = [...current, sheet];
  }
}

function resolveScopeDocument(scope: Element | null): ScopeDocumentLike | null {
  return (scope?.ownerDocument as ScopeDocumentLike | undefined) ?? null;
}

/**
 * 浏览器 DOM 搜索适配：在 scope 子树内跑 findInPageDomSearch 纯核心
 * （排除规则沿用：script/style/不可见子树跳过、块级哨兵防跨块假命中）。
 * 返回的 range 只覆盖已物化内容——未渲染虚拟行不在 DOM，天然不参与计数。
 */
export function createConversationScopeDomSearch(): (
  scope: Element,
  text: string,
) => readonly unknown[] {
  return (scope, text) => {
    const doc = scope.ownerDocument;
    if (!doc) {
      return [];
    }
    const buffer = collectSearchableText(scope, new Set(), createDomCollectEnv());
    const matches = findTextMatchIntervals(buffer.haystack, text);
    return mapMatchesToRanges<Range>(buffer.entries, matches, {
      createRange: () => doc.createRange(),
    });
  };
}

/**
 * 创建 ConversationTimeline 的 scope provider。注册/注销由 hook 负责；
 * 本工厂只做搜索/绘制/loadRest 编排（协调器 safe-call 包裹全部同步方法）。
 */
export function createConversationFindInPageProvider(
  deps: ConversationFindInPageProviderDeps,
): FindInPageScopeProvider {
  const batchSize = deps.mountBatchSize ?? FIND_TIMELINE_MOUNT_BATCH_SIZE;
  const fullMountCap = deps.fullMountCap ?? FIND_TIMELINE_FULL_MOUNT_CAP;

  /**
   * 不做跨轮查询缓存：行数据流式变动会让同 text 的 DOM 搜索结果跨轮失效
   * （live tail 在 scope 内持续增长，rendered/total 数不变内容也变）。count/show
   * 每轮各自现搜——范围限 scope 子树、频率是防抖后的按键级，代价可接受。
   * lastPainted 只记「本腿上一轮画进共享高亮层的 ranges」，供 clear 时 surgical 撤除。
   */
  let lastPainted: { doc: ScopeDocumentLike; ranges: readonly unknown[] } | null = null;
  /** 批增长代际：clear/卸载即作废在途循环。 */
  let generation = 0;
  /** 在途 loadRest：重入直接复用（目标态相同——继续向全量批增长）。 */
  let inFlight: Promise<void> | null = null;
  /**
   * 本腿画 active 时所在的 active 层 Highlight 对象。clear 只在注册表当前 entry
   * 仍是同一对象时才清 active 层——协调器每轮 registry.delete 重建 entry，对象
   * 同一性即「active 层仍持有本腿 range」的精确判据，不清其他腿新一轮画的 active。
   */
  let paintedActiveEntry: { doc: ScopeDocumentLike; entry: unknown } | null = null;

  const searchScope = (text: string): readonly unknown[] => {
    return deps.getScopeEl() === null ? [] : deps.searchScopeRanges(text);
  };

  /** 追加绘制：全部命中层只 add 不 clear（dom 腿先画，本腿追加，见文件头纪律）。 */
  const paint = (ranges: readonly unknown[], activeIndexInScope: number): void => {
    const doc = resolveScopeDocument(deps.getScopeEl());
    lastPainted = doc === null ? null : { doc, ranges };
    const activeRange =
      activeIndexInScope >= 0
        ? (ranges[activeIndexInScope] as ScopeRangeLike | undefined)
        : undefined;
    if (doc) {
      const view = doc.defaultView;
      const registry = view?.CSS?.highlights;
      if (registry && typeof view?.Highlight === "function") {
        const sheet = ensureScopeSheet(doc);
        let all = registry.get(FIND_HIGHLIGHT_NAME);
        if (!all) {
          // 防御面：协调器本轮先画过 dom 腿（entry 必在）；entry 缺席=顺序外的调用，自建兜底。
          all = new view.Highlight();
          registry.set(FIND_HIGHLIGHT_NAME, all);
        }
        for (const range of ranges) {
          if (sheet) {
            adoptSheetForRange(doc, sheet, range as ScopeRangeLike);
          }
          all.add(range);
        }
        if (activeRange) {
          // active 层全局唯一：active 落在本腿时直接画（导出函数自带 sheet adopt）。
          applyActiveHighlight(doc as never, activeRange as never);
          paintedActiveEntry = {
            doc,
            entry: registry.get(FIND_HIGHLIGHT_ACTIVE_NAME) ?? null,
          };
        }
      }
    }
    // provider 腿的 active 协调器不代滚（内置腿才 scrollRangeIntoView）——本腿自滚。
    activeRange?.startContainer.parentElement?.scrollIntoView?.({ block: "nearest" });
  };

  /**  Surgical 清理：只删本腿追加进共享层的 ranges；active 层只在自己画过时清。 */
  const unpaint = (): void => {
    if (lastPainted !== null) {
      const all = lastPainted.doc.defaultView?.CSS?.highlights?.get(FIND_HIGHLIGHT_NAME);
      for (const range of lastPainted.ranges) {
        all?.delete?.(range);
      }
    }
    if (paintedActiveEntry !== null) {
      const registry = paintedActiveEntry.doc.defaultView?.CSS?.highlights;
      // 对象同一性校验：entry 已被协调器换过（新一轮别的腿画了 active）就不清。
      if (registry?.get(FIND_HIGHLIGHT_ACTIVE_NAME) === paintedActiveEntry.entry) {
        applyActiveHighlight(paintedActiveEntry.doc as never, null);
      }
    }
    lastPainted = null;
    paintedActiveEntry = null;
  };

  /** 批增长：overscan 目标按 batchSize 步进，逐 commit 一批，直到全部 unit 挂载。 */
  const loadRestImpl = (): Promise<void> => {
    if (inFlight !== null) {
      return inFlight;
    }
    const gen = generation;
    inFlight = (async () => {
      while (gen === generation) {
        const total = deps.getTotalUnitCount();
        if (deps.getRenderedUnitCount() >= total) {
          return;
        }
        const target = Math.min(deps.getRenderedUnitCount() + batchSize, total);
        deps.requestExpandedMount(target);
        await deps.awaitCommitted();
      }
    })().finally(() => {
      if (gen === generation) {
        inFlight = null;
      }
    });
    return inFlight;
  };

  return {
    getScopeEl: () => deps.getScopeEl(),
    count: (text) => searchScope(text).length,
    show: (text, activeIndexInScope, _epoch) => {
      // epoch 守卫由协调器承担（失配轮次的结果 main 侧直接丢弃）；本腿画最新一轮即可。
      paint(searchScope(text), activeIndexInScope);
    },
    clear: () => {
      generation += 1;
      inFlight = null;
      unpaint();
      deps.resetExpandedMount();
    },
    // 命中全部来自已物化 DOM（未渲染区不计数、不作假命中），天然在已渲染窗口内。
    isMatchRendered: () => true,
    get loadRest() {
      // 封顶语义：unit 总数超过全挂载帽 → 不提供加载能力，协调器按
      // hasUnrenderedContent()=true 申报 hasUnsearchableRegions（spec R15）。
      return deps.getTotalUnitCount() <= fullMountCap ? loadRestImpl : undefined;
    },
    hasUnrenderedContent: () => deps.getRenderedUnitCount() < deps.getTotalUnitCount(),
    surface: "conversation-timeline",
  };
}
