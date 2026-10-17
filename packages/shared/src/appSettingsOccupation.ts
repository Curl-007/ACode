/**
 * 设置页 onboarding 职业选项闭集。
 *
 * 独立叶子模块：protocol.ts 有 400 行闸，AppSettings.onboardingOccupation 的
 * 内联联合收敛到这里具名导出。运行时校验的同闭集 zod 枚举在
 * validationAppSettings.ts（appSettingsOccupationSchema）；两处调整必须同步。
 */
export type AppSettingsOccupation =
  | "office"
  | "developer"
  | "independent"
  | "infrastructure"
  | "product"
  | "design"
  | "student"
  | "creator"
  | "operations"
  | "marketing"
  | "finance"
  | "accounting"
  | "legal"
  | "other";
