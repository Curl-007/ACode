/**
 * 子智能体设置页的纯展示子组件集合（split-plan settings/SubagentsSection.tsx 批次 2）。
 *
 * 从 `settings/SubagentsSection.tsx` 行 170–201、228–313 **逐字迁移**的 5 个展示原子：
 *   - `FormFieldLabel` / `AgentColorDot` / `AgentBadge`：表单与列表共用的样式原子；
 *   - `ToolCheckbox`：表单内工具勾选行；
 *   - `BatchRowCheckbox`：批量模式行复选框（specs/subagent-batch-edit.md R2）。
 *
 * 全部为**受控纯展示**：不持有 state、不读 store、不发 service 请求。`RISKY_TOOLS`
 * 与 `COLOR_DOT_CLASS` 从 `agentModel.ts` 单一来源 import，避免与表单/列表形成循环。
 *
 * 行为不变量（测试见 packages/ui/test/subagentSections.test.ts）：
 *  - `ToolCheckbox` 对 `RISKY_TOOLS` 集合内的 label 渲染 `bg-destructive` 危险标记点；
 *  - `BatchRowCheckbox` 的 `data-testid` 字面量与 `shared/test-ids.ts` 的
 *    `TID_SUBAGENT_BATCH_ROW_CHECKBOX` 契约一致（源仓 test-ids 属 packages/shared，
 *    本包用字面量保持同一契约，见 SubagentsSection.tsx 头注）。
 */
import { Check } from "lucide-react";
import { testId, type AgentColor } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { COLOR_DOT_CLASS, RISKY_TOOLS } from "@/settings/subagents/agentModel.js";

// 源仓新增的批量 test id 定义在 packages/shared/src/test-ids.ts；批次 2 与主文件保持一致，
// 继续用局部字面量保持同一 data-testid 契约（E2E 可按字面量选取）。
const TID_SUBAGENT_BATCH_ROW_CHECKBOX = "subagent-batch-row-checkbox";

export function FormFieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1.5 block text-ui-base font-medium text-foreground-subtle">
      {children}
    </label>
  );
}

export function AgentColorDot({ color }: { color?: AgentColor }) {
  return (
    <span
      className={cn(
        "inline-flex size-2 shrink-0 rounded-full",
        color ? COLOR_DOT_CLASS[color] : "bg-foreground-subtlest",
      )}
      aria-hidden="true"
    />
  );
}

export function AgentBadge({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-5 items-center rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ToolCheckbox({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "hover:bg-surface-hover",
      )}
    >
      <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
        <span
          className={cn(
            "flex size-4 items-center justify-center rounded-sm border transition-colors",
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input-border bg-input text-transparent",
          )}
        >
          <Check className="size-3.5" />
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
        {label}
      </span>
      {RISKY_TOOLS.has(label) ? (
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
      ) : null}
    </button>
  );
}

/** 批量模式行复选框：仅可批量行渲染（specs/subagent-batch-edit.md R2）。 */
export function BatchRowCheckbox({
  checked,
  label,
  agentName,
  disabled,
  onToggle,
}: {
  checked: boolean;
  label: string;
  agentName: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId(TID_SUBAGENT_BATCH_ROW_CHECKBOX, agentName)}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "hover:bg-hover",
      )}
    >
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded-sm border transition-colors",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input-border bg-input text-transparent",
        )}
      >
        {checked ? <Check className="size-3" /> : null}
      </span>
    </button>
  );
}
