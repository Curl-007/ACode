// 宿主团队唤醒配置物化（apps/acode-cli/specs/host-team-wake.md R7）。
//
// 三级默认链（EI-152）：硬编码回落（DefaultRuntimeConfig.agentTeams.hostWake）→ config 文件层
// → call-level runtimeConfig 覆盖。**逐字段落默认**——段整体或部分缺失（旧配置文件、未设置该段
// 的环境、测试夹具）时不得直接下钻 `.hostWake`（会 TypeError，违反「旧配置直接可读」纪律）；
// 非法值（非布尔/非正数）由 core `resolveTeamWakeConfig` 收窄回默认。
import type { ConfigResult } from "@acode/adapters/config";
import type { AgentRuntimeConfig } from "@acode/core";
import { DefaultRuntimeConfig } from "@acode/contracts";

export function resolveHostWakeRuntimeConfig(
  configFileLayer: ConfigResult["config"],
  callLayer: AgentRuntimeConfig | undefined,
): AgentRuntimeConfig["agentTeams"] {
  return {
    hostWake: {
      ...DefaultRuntimeConfig.agentTeams.hostWake,
      ...configFileLayer.agentTeams?.hostWake,
      ...callLayer?.agentTeams?.hostWake,
    },
  };
}