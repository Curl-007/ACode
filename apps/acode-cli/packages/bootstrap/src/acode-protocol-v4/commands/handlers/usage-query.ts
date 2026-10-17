// /usage 命令族（desktop）薄宿主 leaf（specs/usage-statusbar.md「/usage 命令族」节）。
// 解析/取数/渲染全部在 @acode/core 的 usage-query 模块（单一实现，零 token 命令）；
// 本 leaf 只取宿主事实：进程级 session store（V4CommandCoreHost.getSessionStore，
// 与 usageStats / v4/conversation/usage 通道同源，SqliteSessionStore 同时实现
// UsageStorePort）、时区（命令 payload timeZone——客户端携带 IANA 时区，与
// v4/usage/stats 通道同惯例；缺席按 UTC 归桶）、locale（会话 app，回落 en-US）。
import type { ListSessionsInput, SessionStorePort, UsageStorePort } from "@acode/contracts";
import { executeUsageQuery, renderUsageQueryUnavailable } from "@acode/core";
import type { CommandEnvelope } from "@acode/shared/acode-protocol-v4";
import { resolveTzOffsetMs } from "../../../acode-protocol/usage-stats-builder.js";
import type { V4CommandCoreHost } from "../types.js";

/** shared commandPayloadSchemas.usage 同形。 */
export interface UsageQueryCommandPayload {
  args?: string | null;
  timeZone?: string | null;
}

/** ACK 形状：ok=false 时 text 是可读回执（非法参数/数据源缺席/取数失败），不是异常。 */
export interface UsageQueryCommandAck {
  type: "usage";
  ok: boolean;
  text: string;
  /** scope.kind（range/models/sessions/workspace/session/current）；非法参数 = null。 */
  scope: string | null;
}

type UsageQueryStore = Pick<UsageStorePort, "queryAppUsage" | "queryTaskUsage">;

function narrowUsageStore(store: SessionStorePort | undefined): UsageQueryStore | undefined {
  // 与 core/usage-observability 的 usageStoreFor 同款运行时收窄：port 接口分离，
  // 实际 store 同时实现两者。
  const candidate = store as Partial<UsageStorePort> | undefined;
  return candidate?.queryAppUsage && candidate.queryTaskUsage
    ? (candidate as UsageQueryStore)
    : undefined;
}

async function usageCommand(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<UsageQueryCommandAck> {
  const payload = (envelope.payload ?? {}) as UsageQueryCommandPayload;
  const record = envelope.sessionId ? host.getRecord(envelope.sessionId) : undefined;
  const locale = record?.app.getLocale() ?? "en-US";
  const store = host.getSessionStore?.();
  const usageStore = narrowUsageStore(store);
  if (!store || !usageStore) {
    // 数据源缺席不抛裸异常：与 usageStats 通道的空快照策略一致，回可读回执。
    return { type: "usage", ok: false, scope: null, text: renderUsageQueryUnavailable(locale) };
  }
  const now = Date.now();
  const timeZone = payload.timeZone?.trim() || "UTC";
  const result = await executeUsageQuery({
    args: payload.args ?? "",
    locale,
    deps: {
      usageStore,
      listSessions: (input?: ListSessionsInput) => store.listSessions(input),
      tzOffsetMs: resolveTzOffsetMs(timeZone, now),
      now,
    },
  });
  return {
    type: "usage",
    ok: result.ok,
    scope: result.scope?.kind ?? null,
    text: result.text,
  };
}

/** 命令组（对齐 handlers/ 目录「每组一个文件」形态；spread 进 NATIVE_HANDLERS）。 */
export const usageQueryHandlers = { usage: usageCommand };
