/**
 * BotsDialog 左侧 Bot 列表（批次 6 外迁）。
 *
 * 逐字迁移自 `BotsDialog.tsx` 的 `<aside>` 段，改为受控组件：Bot 列表、运行态、
 * 选中态与两个回调全部来自 props，组件自身无 state。`renderChannelName` 由宿主传入，
 * 保证渠道名与地区徽标的渲染只有一处实现。
 */
import type { BotConfig, BotServiceStatus } from "@acode/shared";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { formatBotDisplayName, ProviderIcon, runtimeDot } from "@/BotsDialog/shared.js";
import type { BotProviderEntryId } from "@/botsUi.js";
import { Plus } from "lucide-react";

export interface BotsDialogSidebarProps {
  bots: readonly BotConfig[];
  status: BotServiceStatus | null;
  selectedBotId: string | null;
  creatingBot: boolean;
  fallbackBotName: string;
  onBeginAddBot: () => void;
  onSelectBot: (botId: string) => void;
  renderChannelName: (provider: BotProviderEntryId) => ReactNode;
}

export function BotsDialogSidebar({
  bots,
  status,
  selectedBotId,
  creatingBot,
  fallbackBotName,
  onBeginAddBot,
  onSelectBot,
  renderChannelName,
}: BotsDialogSidebarProps) {
  const { intl } = useACodeIntl();
  return (
    <aside className="flex w-64 shrink-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={onBeginAddBot}
          className="mb-3 w-full justify-start gap-2 rounded-xl"
        >
          <Plus className="size-4" />
          <span className="min-w-0 truncate">{intl.formatMessage({ id: "bots.addBot" })}</span>
        </Button>
        {bots.length === 0 ? (
          <div className="p-4 text-ui-base text-foreground-subtle">
            {creatingBot
              ? intl.formatMessage({
                  id: "bots.newBot.selectProviderHint",
                })
              : intl.formatMessage({ id: "bots.empty" })}
          </div>
        ) : (
          bots.map((bot) => {
            const runtime = status?.botRuntime.find((item) => item.botId === bot.id);
            const selected = bot.id === selectedBotId;
            return (
              <button
                key={bot.id}
                type="button"
                onClick={() => {
                  onSelectBot(bot.id);
                }}
                className={cn(
                  "mb-1 w-full rounded-xl px-2.5 pr-4 py-3 text-left transition-colors",
                  selected
                    ? "bg-surface-hover text-foreground"
                    : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                )}
              >
                <div className="flex items-center gap-2">
                  <ProviderIcon
                    provider={bot.provider}
                    className="size-10 shrink-0 object-contain text-foreground-subtle"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-foreground truncate text-ui-base font-medium">
                      {formatBotDisplayName(bot.name, fallbackBotName)}
                    </span>
                    <span className="mt-0.5 flex min-w-0 text-ui-base text-foreground-subtle">
                      {renderChannelName(bot.provider)}
                    </span>
                  </span>
                  <span
                    className={cn("size-2 shrink-0 rounded-full", runtimeDot(runtime, bot.enabled))}
                  />
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
