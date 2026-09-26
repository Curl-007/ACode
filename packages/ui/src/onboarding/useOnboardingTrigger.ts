/**
 * 审计版：官方引导（欢迎页 + 职业调研问卷）已整体移除。
 * 这里保留原导出签名并固定返回“不需要引导”，调用方无需改动；
 * 依赖原实现（本地记录判定 / RPC 认领）的逻辑一并移除。
 */
export function useOnboardingTrigger(_options: {
  onboardingRecord: unknown;
  userId: string | null;
  hasStoredOccupation: boolean;
  update: (...args: never[]) => unknown;
}): [boolean | null, () => void] {
  return [false, () => {}];
}
