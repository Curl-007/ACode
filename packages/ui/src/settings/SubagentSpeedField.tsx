import { CircleHelp, GaugeIcon, Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type SubagentSpeedFieldState =
  | { kind: "not-applicable" }
  | { kind: "unknown"; status: "loading" | "unavailable" }
  | { kind: "supported"; values: readonly string[] };

function speedLabel(value: string, intl: ReturnType<typeof useZCodeIntl>["intl"]): string {
  if (value === "fast") {
    return intl.formatMessage({ id: "chat.toolbar.speed.fast" });
  }
  if (value === "standard") {
    return intl.formatMessage({ id: "chat.toolbar.speed.standard" });
  }
  return value;
}

/**
 * 子智能体行内/批量的速度选择控件。带 speed spec 的模型在运行时必选 speed
 * （registry speed-missing 会直接拒绝派发），设置页此前只有推理档位控件，
 * speed 维度“看得见但选不到”。形态与 SubagentReasoningField 对齐。
 */
export function SubagentSpeedField({
  disabled,
  intl,
  labelVisibilityClassName,
  onValueCommit,
  state,
  value,
}: {
  disabled: boolean;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  labelVisibilityClassName: string;
  onValueCommit: (value: string) => void;
  state: SubagentSpeedFieldState;
  value: string | undefined;
}) {
  if (state.kind === "not-applicable") {
    return null;
  }

  const title = intl.formatMessage({ id: "chat.toolbar.speed.tooltip" });

  if (state.kind === "unknown") {
    const loading = state.status === "loading";
    const placeholderLabel = intl.formatMessage({ id: "common.loading" });
    return (
      <span
        aria-disabled="true"
        aria-label={placeholderLabel}
        className="inline-flex h-8 items-center gap-1 rounded-lg border border-input-border bg-input px-2 py-1.5 text-ui-base text-foreground-subtle"
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <CircleHelp className="size-4" aria-hidden="true" />
        )}
        <span className={labelVisibilityClassName}>{placeholderLabel}</span>
      </span>
    );
  }

  const values = state.values;
  const current = value && values.includes(value) ? value : "";

  return (
    <ControlHintTooltip title={title}>
      <Select
        value={current}
        onValueChange={(next) => {
          if (values.includes(next) && next !== current) {
            onValueCommit(next);
          }
        }}
        disabled={disabled}
      >
        <SelectTrigger
          className="h-8 gap-1 rounded-lg border border-input-border bg-input px-2 py-1.5 text-ui-base text-foreground hover:border-input-border-hover hover:bg-input"
          aria-label={`${title}${current ? `: ${speedLabel(current, intl)}` : ""}`}
        >
          <GaugeIcon className="size-3.5" aria-hidden="true" />
          <span className={labelVisibilityClassName}>
            {current ? speedLabel(current, intl) : title}
          </span>
        </SelectTrigger>
        <SelectContent position="popper" side="top" align="end" sideOffset={4} collisionPadding={8}>
          {values.map((speed) => (
            <SelectItem key={speed} value={speed}>
              {speedLabel(speed, intl)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </ControlHintTooltip>
  );
}
