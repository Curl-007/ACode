import { SquareSlash } from "lucide-react";
import type { UserInputRow } from "@acode/shared/acode-protocol-v4";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type CustomCommandInvocation = NonNullable<UserInputRow["customCommand"]>;

const KNOWN_SCOPES = new Set(["user", "project", "system", "admin", "builtin"]);

/**
 * 用户气泡下方的「已触发命令」回显（spec: docs/specs/custom-command-invocation-echo.md）。
 * 只认 CLI 在展开成功时写入的 row.customCommand；气泡里的命令 chip 来自 Composer 文本，
 * 命令不存在时也会画出来，不能作为「是否触发」的依据。
 */
export function ConversationUserInputCommandEcho({
  command,
}: {
  command: CustomCommandInvocation | undefined;
}) {
  const { intl } = useZCodeIntl();
  if (!command) return null;

  const sourceLabel =
    command.source === "plugin"
      ? intl.formatMessage({ id: "chat.userInput.command.scope.plugin" })
      : KNOWN_SCOPES.has(command.scope)
        ? intl.formatMessage({ id: `chat.userInput.command.scope.${command.scope}` })
        : command.scope;
  const triggeredLabel = intl.formatMessage(
    { id: "chat.userInput.command.triggered" },
    { name: command.name },
  );
  const description = command.description?.trim();

  const line = (
    <div
      data-v4-user-input-command-echo={command.name}
      className="mt-1 flex min-w-0 max-w-full items-center gap-1.5 self-end text-ui-xs text-foreground-subtlest"
    >
      <SquareSlash aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="shrink-0 text-foreground-subtle">{triggeredLabel}</span>
      <span className="shrink-0" aria-hidden="true">
        ·
      </span>
      <span className="shrink-0">{sourceLabel}</span>
      {description ? (
        <>
          <span className="shrink-0" aria-hidden="true">
            ·
          </span>
          <span className="min-w-0 truncate">{description}</span>
        </>
      ) : null}
    </div>
  );

  if (!description) return line;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{line}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-sm whitespace-pre-wrap break-words">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

/** 用户行气泡下方的次级信息：命令回显在上，发送状态在下。 */
export function ConversationUserInputFooter({
  command,
  status,
}: {
  command: CustomCommandInvocation | undefined;
  status?: string;
}) {
  return (
    <>
      <ConversationUserInputCommandEcho command={command} />
      {status ? (
        <div
          data-v4-user-input-status="true"
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
          aria-live="polite"
        >
          {status}
        </div>
      ) : null}
    </>
  );
}
