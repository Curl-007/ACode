// 编译校验的消费示例（架构 context 阅读包展示；不执行任何 IO——不触网、不落盘、
// 不起子进程）：只演示 shared contract.ts 公开面的典型用法，全部为纯函数/类型。
import {
  DEFAULT_LOCALE,
  acodeProviderAccountAccessSchema,
  commandTypeSchema,
  modelSelectionSchema,
  type ACodeProviderAccountAccess,
  type AppSettings,
  type ModelSelection,
} from "./contract.js";

/** schema 运行时校验：账号访问类别是 strict object，未知字段在进程边界即失败。 */
export function exampleParseAccountAccess(input: unknown): ACodeProviderAccountAccess | null {
  const parsed = acodeProviderAccountAccessSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** v4 命令类型是封闭枚举：未知命令在 wire 边界校验失败，不做静默透传。 */
export function exampleIsCommandType(value: string): boolean {
  return commandTypeSchema.safeParse(value).success;
}

/** 模型选择 schema：UI/CLI/services 共用同一词表，解析失败返回 null 而非抛错。 */
export function exampleParseModelSelection(input: unknown): ModelSelection | null {
  const parsed = modelSelectionSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** 类型级消费：AppSettings 作为设置快照类型跨模块传递；locale 为必填字段。 */
export function examplePickLocale(settings: AppSettings): string {
  return settings.locale ?? DEFAULT_LOCALE;
}
