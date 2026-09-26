import type { UiLocale, SupportedLocale } from "@acode/contracts";
import { enUS } from "./locales/en-US.js";
import { zhCN } from "./locales/zh-CN.js";
import {
  DEFAULT_LOCALE,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "./locale.js";
import type { ACodeCopy } from "./types.js";

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
};
export type { LocaleDetectionInput } from "./locale.js";
export type { CliCopy, TuiCopy, UiLocale, SupportedLocale, ACodeCopy } from "./types.js";

const CATALOGS: Record<SupportedLocale, ACodeCopy> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

export function getACodeCopy(locale?: UiLocale | string, detected?: string | null): ACodeCopy {
  return CATALOGS[resolveLocale(locale, detected)];
}
