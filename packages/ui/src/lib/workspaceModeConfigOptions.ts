// workspace presentation → configOptions 的纯格式化（mode 单项）。
//
// 来历：原住 `lib/acodeSessionProjection.ts`（legacy 投影迁移桥）。2026-10-28 随 legacy M1
// 最后一个消费方收口搬到这里——它是**纯格式化函数**（输入一个 mode 值，输出一个 mode
// configOption），与 session 投影无关，留在投影桥里会让 M1「删掉 acodeSessionProjection」
// 被这唯一消费方无谓阻塞。
//
// **刻意复用 shared 的权威 helper，不再本地复制 mode 档位表**：桥里原本有一份 4 档的本地
// `ACODE_AGENT_MODE_OPTIONS`（build/edit/plan/yolo），而 shared 的权威表是 5 档
// （`acode-agent-model-state.ts:15-42`，多一个 P1 的 `dontAsk`）。两份已漂移——桥的
// `normalizeAvailableACodeMode("dontAsk")` 因 dontAsk 不在其 4 元素集合内而**静默回落 "build"**。
// 改用 shared 的 `getACodeAgentModeSelectOptions` / `normalizeAvailableACodeMode` 后，
// 本函数与 v4 composer 的 mode 选择器（`V4ComposerModeControls.tsx` 直接用 shared 的
// `getACodeAgentAvailableModes()`，5 档）对齐，消除重复实现与漂移（AGENTS.md：一个语义一份实现）。
//
// 为什么不用 modelSelectionService / workspace-config topic 作为「mode 的 v4 权威源」——
// 实测两者都不成立（docs/legacy-protocol-convergence-plan.md M1 节 2026-10-28 裁决）：
//   • ModelSelectionView 不含 mode/slashCommands（provider/src/facades.ts:220-224）；
//   • workspace-config topic 的种子在无 live session 时返回 null（v4-workspace-config.ts:49），
//     而本函数服务的 prepare 是预热路径（会话尚未建立）。
// 且 mode 从来不是协议事实：legacy readWorkspacePresentation 硬编码 `mode:"build"`
// （workspace-model-runtime.ts:26）。故这里保持纯格式化，mode 值由调用方（presentation）给。
import {
  getACodeAgentModeSelectOptions,
  normalizeAvailableACodeMode,
  type ACodeConfigOption,
  type ACodeSessionMode,
} from "@acode/shared";

const MODE_CONFIG_ID = "mode";

/** workspace presentation 的 mode → 单个 mode configOption（与 legacy 投影逐字同形，仅档位表改取 shared）。 */
export function acodeWorkspacePresentationToConfigOptions(
  mode: ACodeSessionMode,
): ACodeConfigOption[] {
  return [
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: normalizeAvailableACodeMode(mode),
      options: getACodeAgentModeSelectOptions(),
    },
  ];
}
