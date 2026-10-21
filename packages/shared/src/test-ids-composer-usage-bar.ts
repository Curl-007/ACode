// 输入框「用量状态栏」与回答末尾速率行的测试 id（apps/acode-cli/specs/usage-statusbar-port.md §3.5）。
// test-ids.ts 已顶到 max-lines 上限（400 行），按 test-ids-workflow.ts 的先例拆出；
// 仍从 @acode/shared 桶文件导出，消费方 import 路径不变。

/** v4 composer 用量状态栏容器 */
export const TID_V4_COMPOSER_USAGE_BAR = "v4-composer-usage-bar";
/** 用量状态栏内的单个段（data-segment 区分 speed/turnUsage/context/session/tools/today/subagents） */
export const TID_V4_COMPOSER_USAGE_BAR_SEGMENT = "v4-composer-usage-bar-segment";
/** 用量状态栏右端齿轮与开关弹层 */
export const TID_V4_COMPOSER_USAGE_BAR_SETTINGS = "v4-composer-usage-bar-settings";
/** 段值 / 明细行上的错误徽标（感叹号 + 数字，destructive 14% 胶囊） */
export const TID_V4_COMPOSER_USAGE_BAR_ERROR_BADGE = "v4-composer-usage-bar-error-badge";
/** 子智能体任务级面板（点段打开的固定浮层） */
export const TID_V4_COMPOSER_USAGE_BAR_SUBAGENT_PANEL = "v4-composer-usage-bar-subagent-panel";
/** 回答末尾速率行 */
export const TID_V4_TURN_RATE_FOOTER = "v4-turn-rate-footer";
/** 常规设置中的「用量状态栏」开关组（data-usage-bar-key 区分各项） */
export const TID_SETTINGS_COMPOSER_USAGE_BAR_SWITCH = "settings-composer-usage-bar-switch";
