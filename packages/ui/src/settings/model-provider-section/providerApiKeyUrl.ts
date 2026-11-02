/**
 * 打开 Provider API Key 申请页（自 ModelProviderSection.tsx 迁出的纯决策，语义逐字不变）：
 * 先 trim，空值不触发外部打开（避免打开空白页）。平台能力经依赖注入传入，
 * 保持该上帝组件不直接持有平台副作用分支，同时控制其行数 ratchet 不增长。
 */
export function openProviderApiKeyUrl(
  url: string,
  platform: { openExternal: (url: string) => unknown },
): void {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    return;
  }
  void platform.openExternal(normalizedUrl);
}