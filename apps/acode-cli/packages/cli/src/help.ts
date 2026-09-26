import { getACodeCopy, type SupportedLocale, type UiLocale } from "@acode/i18n";

export function formatCliHelp(
  version: string,
  locale?: UiLocale,
  detectedLocale?: SupportedLocale,
): string {
  return getACodeCopy(locale, detectedLocale).cli.help(version);
}
