/**
 * 错误徽标（apps/acode-cli/specs/usage-statusbar-port.md §2.1 工具段）。
 *
 * 「感叹号 + 数字」的 destructive 14% 胶囊，替代「· N 错误」文字：
 * 只占图标 + 1~3 位数字，扫读成本低。0 错误时不渲染（由模型层保证 badge 不存在）。
 */
import { CircleAlertIcon } from "lucide-react";
import { TID_V4_COMPOSER_USAGE_BAR_ERROR_BADGE } from "@acode/shared";
import type { UsageBarErrorBadge as UsageBarErrorBadgeShape } from "./usageBarModel.js";

/** 徽标数字上限：超过 99 只显示 `99+`，避免长数字把段行撑开。 */
const BADGE_DISPLAY_MAX = 99;

export function UsageBarErrorBadge({ badge }: { badge: UsageBarErrorBadgeShape }) {
  return (
    <span
      data-testid={TID_V4_COMPOSER_USAGE_BAR_ERROR_BADGE}
      data-error-count={badge.count}
      role="img"
      aria-label={badge.label}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-destructive/14 pr-1.5 pl-1 text-destructive"
    >
      <CircleAlertIcon aria-hidden className="size-3 shrink-0" />
      <span className="text-ui-xs leading-4 font-semibold tabular-nums">
        {badge.count > BADGE_DISPLAY_MAX ? `${BADGE_DISPLAY_MAX}+` : badge.count}
      </span>
    </span>
  );
}
