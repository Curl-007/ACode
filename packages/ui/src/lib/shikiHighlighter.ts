import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from "shiki";
import { bundledLanguages, bundledLanguagesInfo, createHighlighter } from "shiki";
import { logger } from "@/logger.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

const bundledLanguageIds = new Set(Object.keys(bundledLanguages));
const bundledLanguageAliases = new Map(
  bundledLanguagesInfo.flatMap((info) =>
    (info.aliases ?? []).map((alias) => [alias, info.id] as const),
  ),
);
const FALLBACK_CODE_LANGUAGE: BundledLanguage = "log";
const PLAIN_TEXT_CODE_LANGUAGES = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "log",
  "output",
]);

export function shouldUseSyntaxHighlighting(language: string): boolean {
  const candidate = language.trim().toLowerCase();
  if (PLAIN_TEXT_CODE_LANGUAGES.has(candidate)) {
    return false;
  }

  return bundledLanguageIds.has(candidate) || bundledLanguageAliases.has(candidate);
}

/** 支持语法高亮的语言列表；streamdownCodePlugin 的 getSupportedLanguages 复用同一数据源。 */
export function getSupportedCodeLanguages(): BundledLanguage[] {
  return Array.from(bundledLanguageIds) as BundledLanguage[];
}

function normalizeCodeLanguage(language: string): BundledLanguage {
  const candidate = language.trim().toLowerCase();
  if (!candidate) {
    return FALLBACK_CODE_LANGUAGE;
  }

  const alias = bundledLanguageAliases.get(candidate);
  if (alias && bundledLanguageIds.has(alias)) {
    return alias as BundledLanguage;
  }

  if (bundledLanguageIds.has(candidate)) {
    return candidate as BundledLanguage;
  }

  return FALLBACK_CODE_LANGUAGE;
}

const tokensCache = new Map<string, TokenizedCode>();
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();

// ---------------------------------------------------------------------------
// 高亮引擎单例（spec: renderer-memory-budget 所有者表「高亮引擎实例」）：
// 过去每个 `theme:lang` 组合 `createHighlighter` 一个独立实例，各自持有 wasm 引擎与
// grammar 注册表且无上限，是 renderer 常驻内存的无界增长点。现在整个模块只创建一个
// 共享 highlighter 实例（共享 wasm 引擎），首次请求携带当时的 lang/theme 创建，后续
// 缺失的语言/主题在该实例上按需 loadLanguage/loadTheme。
// ---------------------------------------------------------------------------
let sharedHighlighterPromise:
  | Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
  | undefined;
/** 进行中的按需加载（含创建时的首载）：同一 load 只发一次，结束后移除以便失败重试。 */
const pendingLanguageLoads = new Map<BundledLanguage, Promise<void>>();
const pendingThemeLoads = new Map<BundledTheme, Promise<void>>();

// ---------------------------------------------------------------------------
// tokensCache 预算（spec: packages/ui/specs/renderer-memory-budget.md 规则 1/2）。
// 缓存键含 code.length，流式渲染时每个 delta 都会生成一个新键；过去这里只增不减，
// 是主窗口 renderer 堆一天 87MB→2GB OOM 的根因之一。上限常量导出供单测断言。
//
// 预算从 2000 条/40MB 下调到 400 条/8MB：二次命中策略下缓存只保留「同一内容键第二次
// 被请求」的稳定代码块，流式中间态一律不进入；实际会命中的稳定块数量远小于历史消息
// 总量，过剩预算只会放大驻留 token 数组、没有命中收益（spec 所有者表同口径）。
// ---------------------------------------------------------------------------
export const TOKENS_CACHE_MAX_ENTRIES = 400;
export const TOKENS_CACHE_MAX_BYTES = 8 * 1024 * 1024;
// seenKeys 条数同样按稳定块规模收敛：只需覆盖稳定内容键 + 少量流式尾键，
// 2048 足够且更早淘汰旧键。
/** seenKeys 只存键字符串（键长有界），条数上限独立于字节预算。 */
export const SEEN_KEYS_MAX_ENTRIES = 2048;

/** 当前 tokensCache 占用的估算字节数 = Σ(token.content.length) + 64×token 数。 */
let tokensCacheBytes = 0;
let tokensCacheEvictions = 0;
let tokensCacheHits = 0;
let tokensCacheMisses = 0;

/**
 * 二次命中策略的「键存在集合」：流式 delta 键几乎只出现一次，若首次就写 tokensCache，
 * 缓存即泄漏；首次只记入这个廉价的键集合，同一键第二次被请求（内容已稳定复现）才写
 * 入 tokensCache。这样中间态可以被 GC，稳定代码块仍保留缓存收益。
 */
const seenKeys = new Map<string, true>();

const estimateTokenizedBytes = (tokenized: TokenizedCode): number => {
  let contentChars = 0;
  let tokenCount = 0;
  for (const line of tokenized.tokens) {
    for (const token of line) {
      contentChars += token.content.length;
      tokenCount += 1;
    }
  }
  return contentChars + tokenCount * 64;
};

/** 记录 seenKeys 并维持 LRU 上限；Map 迭代序即插入序，最旧的在头部。 */
const touchSeenKey = (key: string): void => {
  if (seenKeys.has(key)) {
    // 刷新 recency：先删再插，让刚命中的键移动到尾部。
    seenKeys.delete(key);
  }
  seenKeys.set(key, true);
  while (seenKeys.size > SEEN_KEYS_MAX_ENTRIES) {
    const oldest = seenKeys.keys().next();
    if (oldest.done) {
      break;
    }
    seenKeys.delete(oldest.value);
  }
};

/** 按 LRU + 字节预算写入 tokensCache；同键重写视为一次 recency 刷新。 */
const writeTokensCache = (key: string, tokenized: TokenizedCode): void => {
  const entryBytes = estimateTokenizedBytes(tokenized);
  // 单条超过整个字节预算的条目没有缓存价值：写入后要么把其余条目全部挤掉，
  // 要么马上又要淘汰自己，等于白付一次复制的成本。
  if (entryBytes > TOKENS_CACHE_MAX_BYTES) {
    return;
  }

  const previous = tokensCache.get(key);
  if (previous) {
    tokensCacheBytes -= estimateTokenizedBytes(previous);
  }
  tokensCache.delete(key);
  tokensCache.set(key, tokenized);
  tokensCacheBytes += entryBytes;

  while (tokensCache.size > 0) {
    if (
      tokensCache.size <= TOKENS_CACHE_MAX_ENTRIES &&
      tokensCacheBytes <= TOKENS_CACHE_MAX_BYTES
    ) {
      break;
    }
    const oldest = tokensCache.keys().next();
    if (oldest.done) {
      break;
    }
    const oldestEntry = tokensCache.get(oldest.value);
    tokensCache.delete(oldest.value);
    if (oldestEntry) {
      tokensCacheBytes -= estimateTokenizedBytes(oldestEntry);
    }
    tokensCacheEvictions += 1;
  }
};

export interface ShikiTokenCacheStats {
  entries: number;
  bytes: number;
  evictions: number;
  hits: number;
  misses: number;
  seenKeys: number;
}

/** 读取缓存预算计数快照；诊断注册表与单测共用同一数据源。 */
export const getShikiTokenCacheStats = (): ShikiTokenCacheStats => ({
  entries: tokensCache.size,
  bytes: tokensCacheBytes,
  evictions: tokensCacheEvictions,
  hits: tokensCacheHits,
  misses: tokensCacheMisses,
  seenKeys: seenKeys.size,
});

// 内存诊断计数器：tokensCache 曾无淘汰、键含 code.length，是审计里
// renderer 最可疑的增长点；这里暴露条数、字节、淘汰与命中曲线供 60s 采样。
// highlighters 现在报告共享引擎实例数（应为 0/1；>1 即回归到按组合建实例）。
uiMemoryDiagnosticsRegistry.register("shiki", () => ({
  tokensCache: tokensCache.size,
  tokensCacheBytes,
  seenKeys: seenKeys.size,
  evictions: tokensCacheEvictions,
  hits: tokensCacheHits,
  misses: tokensCacheMisses,
  highlighters: getHighlighterInstanceCount(),
}));

// 供 streamdownCodePlugin 等消费方解析当前生效主题；无显式主题时跟随文档 dark class。
export const getResolvedCodeTheme = (theme?: BundledTheme): BundledTheme => {
  if (theme) {
    return theme;
  }

  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "github-dark";
  }

  return "github-light";
};

const getCodeTokensCacheKey = (code: string, language: BundledLanguage, theme: BundledTheme) => {
  const start = code.slice(0, 100);
  const end = code.length > 100 ? code.slice(-100) : "";
  return `${theme}:${language}:${code.length}:${start}:${end}`;
};
const ensureThemeLoaded = (
  highlighter: HighlighterGeneric<BundledLanguage, BundledTheme>,
  theme: BundledTheme,
): Promise<void> => {
  if (highlighter.getLoadedThemes().includes(theme)) {
    return Promise.resolve();
  }

  const pending = pendingThemeLoads.get(theme);
  if (pending) {
    return pending;
  }

  const load = highlighter.loadTheme(theme).finally(() => {
    pendingThemeLoads.delete(theme);
  });
  pendingThemeLoads.set(theme, load);
  return load;
};

const ensureLanguageLoaded = (
  highlighter: HighlighterGeneric<BundledLanguage, BundledTheme>,
  language: BundledLanguage,
): Promise<void> => {
  if (highlighter.getLoadedLanguages().includes(language)) {
    return Promise.resolve();
  }

  const pending = pendingLanguageLoads.get(language);
  if (pending) {
    return pending;
  }

  const load = highlighter.loadLanguage(language).finally(() => {
    pendingLanguageLoads.delete(language);
  });
  pendingLanguageLoads.set(language, load);
  return load;
};

const getHighlighter = (
  language: BundledLanguage,
  theme: BundledTheme,
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
  if (!sharedHighlighterPromise) {
    // 首次请求：携带当前 lang/theme 创建唯一实例；失败则清空引用，下次调用重新创建，
    // 避免一个被拒绝的 promise 永久毒化单例（错误本身由调用方 catch 记日志）。
    const creation = createHighlighter({
      langs: [language],
      themes: [theme],
    });
    sharedHighlighterPromise = creation;
    creation.catch(() => {
      if (sharedHighlighterPromise === creation) {
        sharedHighlighterPromise = undefined;
      }
    });
  }

  return sharedHighlighterPromise.then((highlighter) =>
    // 后续语言/主题在共享实例上按需补载（并发去重：同一 load 只发一次）；
    // 首载组合已在 createHighlighter 完成，这里立即通过。
    Promise.all([
      ensureLanguageLoaded(highlighter, language),
      ensureThemeLoaded(highlighter, theme),
    ]).then(() => highlighter),
  );
};

/** 当前共享 highlighter 实例数（0=未创建，1=已创建/创建中）；供测试与诊断确认单例。 */
export const getHighlighterInstanceCount = (): number =>
  sharedHighlighterPromise !== undefined ? 1 : 0;

const createRawCodeTokens = (code: string): TokenizedCode => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split("\n").map((line) =>
    line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
          } as ThemedToken,
        ],
  ),
});

// 带缓存的异步高亮入口；React 组件只应在 effect 中调用。
export const highlightCode = (
  code: string,
  language: string,
  theme?: BundledTheme,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null => {
  if (!shouldUseSyntaxHighlighting(language)) {
    // 文本/日志代码块没有语法高亮收益，却会在聊天流式渲染和历史恢复时进入
    // Shiki 的异步状态机。之前修掉了 render 阶段 setState，但这条纯文本路径仍可能把
    // CodeViewer 拖进 React #185；这里直接返回 raw tokens，避免启动高亮副作用。
    return createRawCodeTokens(code);
  }

  const resolvedTheme = getResolvedCodeTheme(theme);
  const resolvedLanguage = normalizeCodeLanguage(language);
  const tokensCacheKey = getCodeTokensCacheKey(code, resolvedLanguage, resolvedTheme);

  const cached = tokensCache.get(tokensCacheKey);
  if (cached) {
    tokensCacheHits += 1;
    // LRU recency 刷新：命中即移到尾部，让淘汰始终发生在最旧端。
    tokensCache.delete(tokensCacheKey);
    tokensCache.set(tokensCacheKey, cached);
    // 缓存命中时也需要通知 effect，但不能同步触发 setState。
    // 历史消息恢复时大量代码块会在同一次提交后挂载；同步 callback 会把 cache-hit 变成嵌套更新，
    // 和 Streamdown 的重渲染叠在一起时容易触发 React #185。推迟到微任务后再交给幂等 setter。
    if (callback) {
      queueMicrotask(() => callback(cached));
    }
    return cached;
  }
  tokensCacheMisses += 1;

  // 二次命中判定必须在发起异步 tokenize 前完成：异步回调只看「这是否第二次出现」，
  // 避免同一键并发请求在回调期互相改变缓存可见性。
  const isFirstRequest = !seenKeys.has(tokensCacheKey);
  touchSeenKey(tokensCacheKey);

  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set());
    }
    subscribers.get(tokensCacheKey)?.add(callback);
  }

  getHighlighter(resolvedLanguage, resolvedTheme)
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages();
      const langToUse = availableLangs.includes(resolvedLanguage)
        ? resolvedLanguage
        : FALLBACK_CODE_LANGUAGE;

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        theme: resolvedTheme,
      });

      const tokenized: TokenizedCode = {
        bg: "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      };

      // 为什么不总是写缓存：流式渲染每个 delta 的键含递增的 code.length，几乎只出现
      // 一次；这些键写入 tokensCache 后永远不会再被命中，等于每帧复制一份完整 token
      // 数组且永不淘汰（renderer OOM 根因）。只有同一键第二次被请求——内容已稳定
      // 复现（历史恢复、重渲染、滚动回看）——才值得占预算；首次仅留在 seenKeys。
      if (!isFirstRequest) {
        writeTokensCache(tokensCacheKey, tokenized);
      }

      const subs = subscribers.get(tokensCacheKey);
      if (subs) {
        for (const sub of subs) {
          sub(tokenized);
        }
      }
      subscribers.delete(tokensCacheKey);
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then), eslint-plugin-promise(prefer-await-to-callbacks)
    .catch((error) => {
      // Shiki 加载或 tokenize 失败，组件会停留在无高亮的 rawTokens 状态。
      logger.error(
        `[ShikiHighlighter] 代码高亮失败: language=${resolvedLanguage}, theme=${resolvedTheme}`,
        error,
      );
      subscribers.delete(tokensCacheKey);
    });

  return null;
};

// ---------------------------------------------------------------------------
// 仅测试使用：绕过异步 tokenize 直接驱动 LRU 写入/查询，用于确定性验证淘汰边界。
// 不改变生产路径行为；命名遵循仓库 `...ForTest` 约定。
// ---------------------------------------------------------------------------

export const buildTokensCacheKeyForTest = (
  code: string,
  language: string,
  theme?: BundledTheme,
): string =>
  getCodeTokensCacheKey(code, normalizeCodeLanguage(language), getResolvedCodeTheme(theme));

export const insertTokensCacheEntryForTest = (
  code: string,
  language: string,
  tokenized: TokenizedCode,
  theme?: BundledTheme,
): void => {
  writeTokensCache(buildTokensCacheKeyForTest(code, language, theme), tokenized);
};

export const hasTokensCacheEntryForTest = (
  code: string,
  language: string,
  theme?: BundledTheme,
): boolean => tokensCache.has(buildTokensCacheKeyForTest(code, language, theme));

/** 仅测试使用：清空缓存条目与字节计数（保留命中/淘汰统计，供按差值断言）。 */
export const clearTokensCacheForTest = (): void => {
  tokensCache.clear();
  tokensCacheBytes = 0;
};
