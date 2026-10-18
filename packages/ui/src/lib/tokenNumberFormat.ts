// token 数值 compact 格式化的唯一所有者（specs/usage-statusbar.md「排版一致性」节）：
// 全部消费方（用量状态栏/上下文环/设置页用量/Start Plan）统一走这里，zh 系 locale
// 的万/亿形态只在本文件裁决一次，禁止各消费方自行 K/M 或强制 en。

/** zh 系 locale 的量级字符：Intl zh 输出以 万/亿（繁体 萬/億）结尾。 */
const ZH_MAGNITUDE_SUFFIX = /([\d.,])([万亿萬億])$/;

function isZhLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith("zh");
}

export function formatCompactTokenNumber(
  locale: string,
  value: number,
  options: { maximumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  const maximumFractionDigits = options.maximumFractionDigits ?? 1;
  const absValue = Math.abs(value);

  // token 数值仍应走本地化 compact；中文展示万/亿，英文展示 K/M/B。
  // 之前为了修 Start Plan 的英文 long unit 误把所有 locale 都强制成 K/M/B。
  const formatted = new Intl.NumberFormat(locale || undefined, {
    notation: absValue >= 1_000 ? "compact" : "standard",
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);

  // zh 排版统一（specs/usage-statusbar.md「排版一致性」）：数字与量级字符之间补一个
  // 空格（1.2 万 / 1.2 亿），数字部分（含千分位/小数点）原样保留。非 zh（K/M/B 结尾）
  // 不加空格；locale 为空串时按运行时默认 locale 的输出形态自适应（万/亿结尾同样补格）。
  if (isZhLocale(locale) || ZH_MAGNITUDE_SUFFIX.test(formatted)) {
    return formatted.replace(ZH_MAGNITUDE_SUFFIX, "$1 $2");
  }
  return formatted;
}

export function formatModelContextWindowLabel(contextWindow: number, _locale = "en-US"): string {
  // 模型列表的容量 badge 是技术规格，不应随中文 locale 变成“万/亿”。
  return formatCompactTokenNumber("en-US", contextWindow);
}
