// M2-3 runtime preferences 推送面（spec apps/acode-cli/specs/m2-3-session-readwrite.md §2.8）：
// host→CLI 的 `v4/session/runtimePreferences` 推送处理器 + 进程级缓存。
//
// 为什么不是 pull：v4 topic 全是 CLI 发布面，装不下 host 权威数据；host→CLI 请求有
// connectionFlow 先例。host 在连接建立与每次会话物化（create/resume）前现读设置
// （含 desktop external authority 桥应答）后推送，CLI 缓存供
// server-operations.resolveSessionStartupPreferences 读取；缓存缺失回落到 legacy
// -32601/-32020 兼容分支的同一组缺省值（读取方承载，本叶只存不判）。
import {
  v4SessionRuntimePreferencesPushParamsSchema,
  type V4SessionRuntimePreferences,
} from "@acode/shared/acode-protocol-v4";
import {
  parseParams,
  type ACodeProtocolAgentServerContext,
} from "./server-types.js";

// 偏好是 app-global（scope 键控已由 host 侧合并为全量快照），进程级单槽缓存即可。
let cachedPreferences: V4SessionRuntimePreferences | undefined;

export async function handleSessionRuntimePreferencesPushV4(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<Record<string, never>> {
  const params = parseParams(v4SessionRuntimePreferencesPushParamsSchema, rawParams);
  cachedPreferences = params.preferences;
  context.logger?.debug("ACode Protocol runtime preferences push cached", {
    event: "acode_protocol.runtime_preferences.push_cached",
    module: "bootstrap.acode_protocol",
    memoryEnabled: params.preferences.memoryEnabled,
    nativeSearchEnhancementsEnabled: params.preferences.nativeSearchEnhancementsEnabled,
  });
  return {};
}

export function readCachedSessionRuntimePreferences(): V4SessionRuntimePreferences | undefined {
  return cachedPreferences;
}

// 测试隔离用：模块级缓存在同一进程的多用例间需要显式复位。
export function resetCachedSessionRuntimePreferencesForTest(): void {
  cachedPreferences = undefined;
}
