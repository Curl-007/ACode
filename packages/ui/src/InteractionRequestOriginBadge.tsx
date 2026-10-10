import type { ACodeInteractionRequestOrigin } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";

export function InteractionRequestOriginBadge({
  className,
  origin,
}: {
  className?: string;
  origin?: ACodeInteractionRequestOrigin;
}) {
  const { intl } = useACodeIntl();
  if (origin?.kind !== "subagent") {
    return null;
  }

  const label = intl.formatMessage({ id: "chat.interactionOrigin.subagent" });
  // 谱系展示（subagent-interaction-origin-lineage spec R5 登记「归 P2b」的收口）：
  // depth≥2 时 title 显示祖先链（根侧在前），客户端可见的归属不再断在中间层会话。
  const ancestors = origin.ancestors ?? [];
  const title =
    ancestors.length > 0
      ? intl.formatMessage(
          { id: "chat.interactionOrigin.subagent.nestedTitle" },
          {
            agentType: origin.agentType,
            chain: [...ancestors]
              .reverse()
              .map((ancestor) => ancestor.agentType)
              .join(" → "),
          },
        )
      : origin.agentType
        ? intl.formatMessage(
            { id: "chat.interactionOrigin.subagent.title" },
            { agentType: origin.agentType },
          )
        : label;

  return (
    <Badge
      variant="outline"
      title={title}
      data-interaction-origin-badge="subagent"
      className={cn("max-w-40 align-baseline text-ui-base truncate", className)}
    >
      {label}
    </Badge>
  );
}
