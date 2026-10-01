import type { Locale } from "@acode/shared";
import { logger } from "@/logger.js";

/** 单语言词典表：id → 翻译文案 */
export type LocaleMessages = Record<string, string>;

/**
 * 词典懒加载资源（spec：renderer-memory-budget 规则 7 —— i18n 词典只驻留当前语言）。
 *
 * zh-CN / en-US 两份词典各约 400KB。之前 IntlProvider 静态 import 两份并放进常驻
 * MESSAGES 记录，启动即全部求值常驻；改为按语言动态 import 后，启动只求值当前语言
 * 一份，切换语言时换载另一份（未用到的语言不进入启动求值链）。
 *
 * ErrorBoundary.tsx 曾静态 import 两份词典（错误兜底 UI 必须同步取词），使懒加载退化为
 * 无效分包；现已迁移到内嵌精简中文兜底文案，prod 产物中 zh-CN/en-US 各自独立成 chunk、
 * 主包零词典泄漏（2026-10-01 构建实测：词典 chunk 359.5KB/365.7KB，启动 preload 不含词典）。
 */
export type LocaleMessagesResource =
  | { state: "pending"; promise: Promise<LocaleMessages> }
  | { state: "fulfilled"; messages: LocaleMessages };

const localeMessagesByLocale = new Map<Locale, LocaleMessagesResource>();

function startLocaleMessagesLoad(locale: Locale): LocaleMessagesResource {
  const loaders: Record<Locale, () => Promise<{ default: LocaleMessages }>> = {
    "zh-CN": () => import("./locales/zh-CN.js"),
    "en-US": () => import("./locales/en-US.js"),
  };
  const resource: LocaleMessagesResource = {
    state: "pending",
    promise: loaders[locale]().then((module) => {
      const messages = module.default;
      localeMessagesByLocale.set(locale, { state: "fulfilled", messages });
      return messages;
    }),
  };
  // 拒绝态（本地 chunk 加载失败属极端场景）只记日志不吞语义：
  // Provider 冷启动路径会把该 promise 抛给上层错误边界，切换路径则保持旧语言可用。
  void resource.promise.catch((error) => {
    logger.error("[i18n] 词典加载失败，保持当前可用语言", { locale, error });
  });
  localeMessagesByLocale.set(locale, resource);
  return resource;
}

/**
 * 获取（必要时启动）指定语言的词典资源。幂等：同一语言只会发起一次 import，
 * 完成后同一资源对象常驻缓存，重复请求与切换回退都是同步命中。
 */
export function getLocaleMessagesResource(locale: Locale): LocaleMessagesResource {
  return localeMessagesByLocale.get(locale) ?? startLocaleMessagesLoad(locale);
}
