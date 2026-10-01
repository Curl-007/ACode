import type { BundledTheme } from "shiki";
import type { CodeHighlighterPlugin } from "streamdown";
import {
  getResolvedCodeTheme,
  getSupportedCodeLanguages,
  highlightCode,
  shouldUseSyntaxHighlighting,
} from "@/lib/shikiHighlighter.js";

/**
 * Streamdown 的代码高亮插件：委托本仓 `highlightCode`（wasm 引擎 + 预算化 LRU 缓存），
 * 不再加载 `@streamdown/code` 及其 JS 正则引擎（spec: renderer-memory-budget 状态所有者表）。
 *
 * 主题语义：原插件用 light/dark 双主题 token（靠 CSS 变量在两套颜色间切换）；这里改为
 * 单主题 token——`getThemes` 返回 `[t, t]`，`highlight` 忽略 options.themes，用
 * `getResolvedCodeTheme` 在调用时按文档 dark class 解析当前主题。代价是主题切换后必须
 * 重渲染并重新高亮（由 MessageResponse 的 streamdownRenderKey 含 codeBlockTheme 保证）。
 */
export const messageCodePlugin: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  supportsLanguage: (language) => shouldUseSyntaxHighlighting(language),
  getSupportedLanguages: () => getSupportedCodeLanguages(),
  getThemes: (): [BundledTheme, BundledTheme] => {
    const theme = getResolvedCodeTheme();
    return [theme, theme];
  },
  // 同步/回调语义与原 @streamdown/code 插件一致：缓存命中同步返回结果；
  // 未就绪返回 null，tokenize 完成后经 callback 异步送达。
  highlight: (options, callback) =>
    highlightCode(options.code, options.language, getResolvedCodeTheme(), callback),
};
