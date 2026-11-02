import type { SettingsSyncMcpVariableReferenceWarning } from "@acode/shared";
import { useACodeIntl } from "@/i18n/IntlProvider.js";

/**
 * MCP 变量引用告警（docs/specs/provider-config-import.md R7.6）：
 * `${VAR}` / `${input:…}` / `{env:VAR}` / `{file:…}` 原样保留不展开，此处只显示
 * **位置 + 键名**，绝不显示 env/header 的值（R7.7 明文边界）。
 */
export function McpVariableReferenceWarnings({
  warnings,
}: {
  warnings: readonly SettingsSyncMcpVariableReferenceWarning[];
}) {
  const { intl } = useACodeIntl();
  if (warnings.length === 0) return null;
  const text = warnings
    .map((warning) =>
      warning.keys.length === 0
        ? intl.formatMessage(
            { id: "settings.mcpServers.import.variableReference.titleNoKeys" },
            {
              location: intl.formatMessage({
                id: `settings.mcpServers.import.variableReference.location.${warning.location}`,
              }),
            },
          )
        : intl.formatMessage(
            { id: "settings.mcpServers.import.variableReference.title" },
            {
              location: intl.formatMessage({
                id: `settings.mcpServers.import.variableReference.location.${warning.location}`,
              }),
              keys: warning.keys.join(", "),
            },
          ),
    )
    .join(" · ");
  return (
    <span
      className="shrink-0 text-ui-xs text-foreground-subtle"
      title={text}
      data-mcp-variable-reference-warning="true"
    >
      {text}
    </span>
  );
}