import type { IConversationExportService } from "@acode/services";
import { useOptionalServices } from "@/hooks/useServices.js";

/**
 * 导出服务的取数入口。
 *
 * 组件不得直接 import 服务：`AGENTS.md`「组件通过 packages/ui/src/hooks/ 访问服务」。
 * 服务在 IServiceAccessor 上是可选的（旧 host / 未装配的宿主不提供），
 * 因此这里返回 null 而不是抛错，由消费方决定隐藏入口（而不是点了没反应）。
 */
export function useConversationExportService(): IConversationExportService | null {
  const services = useOptionalServices();
  return services?.conversationExportService ?? null;
}
