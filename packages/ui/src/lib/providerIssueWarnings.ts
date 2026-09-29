import {
  isBlockingConfigIssue,
  type ConfigValidationIssue,
} from "@acode/provider";

/**
 * 设置页诊断展示的纯函数层（spec: packages/provider/specs/config-validation-severity.md R4/R5）。
 * blocking/warning 的判定统一复用 @acode/provider 的门控谓词（单一事实源，缺省 severity 为
 * error），这里只负责「选哪些诊断、显示什么文案、用什么颜色」，不持有任何状态。
 */

/**
 * 已知 code → i18n key 映射（spec R5）：UI 对已知 code 一律走 i18n，不直接渲染
 * 诊断 message（message 是硬编码中文，避免双语界面出现单语诊断）；
 * 未映射的 code 回退 issue.message，供日志式兜底展示。
 */
const CONFIG_ISSUE_I18N_KEYS: Partial<Record<ConfigValidationIssue["code"], string>> = {
  "plaintext-http-endpoint": "settings.modelProvider.baseUrlPlaintextHttpWarning",
};

/** 把 intl.formatMessage 收敛成单参数纯函数，便于模块保持无 React 依赖。 */
export type ConfigIssueMessageFormatter = (messageId: string) => string;

/** 过滤出非阻断（warning）诊断；缺省 severity 是 error，因此只有显式 warning 会通过。 */
export function selectProviderWarningIssues(
  issues: readonly ConfigValidationIssue[] | undefined,
): ConfigValidationIssue[] {
  return (issues ?? []).filter((issue) => !isBlockingConfigIssue(issue));
}

/** 已知 code 走 i18n key，未知 code 回退诊断自带的 message。 */
export function resolveConfigIssueText(
  issue: ConfigValidationIssue,
  formatMessage: ConfigIssueMessageFormatter,
): string {
  const i18nKey = CONFIG_ISSUE_I18N_KEYS[issue.code];
  return i18nKey ? formatMessage(i18nKey) : issue.message;
}

/** 诊断展示分流结果：blocking 用 destructive 色，warning 用 warning 色。 */
export interface ConfigIssueDisplay {
  readonly text: string;
  readonly tone: "destructive" | "warning";
}

/**
 * 把单条诊断解析成可直接渲染的文案与色调。无诊断时按既有兜底文案 + destructive 展示，
 * 保证「无 issue」与「error issue」两条路径的视觉行为与历史版本逐字一致。
 */
export function resolveConfigIssueDisplay(
  issue: ConfigValidationIssue | undefined,
  formatMessage: ConfigIssueMessageFormatter,
  fallbackText: string,
): ConfigIssueDisplay {
  if (!issue) {
    return { text: fallbackText, tone: "destructive" };
  }
  return {
    text: resolveConfigIssueText(issue, formatMessage),
    tone: isBlockingConfigIssue(issue) ? "destructive" : "warning",
  };
}
