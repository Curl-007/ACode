import { useMemo } from "react";
import {
  DEFAULT_AGENT_ENGINE_SETTING,
  normalizeAgentEngineSetting,
  type ACodeAgentEngineId,
} from "@acode/shared";
import { useSettings } from "@/hooks/useSettingService.js";

/**
 * 会话 agent 引擎的 renderer 侧唯一读取出口（spec: agent-engine-jcode-slot.md R7，
 * 2026-10-24 B 批：engineId 进 renderer 能力门控层）。
 *
 * 为什么需要它：引擎设置此前只被 processManager.getClient 消费（决定 spawn 哪个 agent），
 * renderer 的能力门控层完全不读它——composer 的 mode 列表、权限菜单、附件入口、Bot 引擎
 * 选项全部按 native 引擎渲染，导致 jcode 下「plan 可勾但发送报错」「mode 菜单谎报有审批
 * 回路」「附件按钮点了必失败」等误导面（2026-10-24 深度审计 P1-3/P1-4/P2）。
 *
 * 与 Settings 页同一数据源（useSettings → settingService 快照），落盘即真相；
 * 归一化与缺省回退 native 与 Host 侧 resolveAgentEngineSetting 同口径。
 */
export function useAgentEngine(): ACodeAgentEngineId {
  const { settings } = useSettings();
  const rawEngine = settings?.agentEngine;
  return useMemo(
    () => normalizeAgentEngineSetting(rawEngine) ?? DEFAULT_AGENT_ENGINE_SETTING,
    [rawEngine],
  );
}

/** 当前引擎是否为外部引擎（非 native）。外部引擎的能力面按 shim 已路由子集收敛。 */
export function useIsExternalAgentEngine(): boolean {
  const engine = useAgentEngine();
  return engine !== DEFAULT_AGENT_ENGINE_SETTING;
}
