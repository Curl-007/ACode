/**
 * 子智能体设置页的纯决策模型（split-plan `settings/SubagentsSection.tsx` 批次 1：helper 外迁）。
 *
 * 本模块是从 `settings/SubagentsSection.tsx` 行 128–423 **逐字迁移**的纯函数与常量集合，
 * 不含 React / hooks / 闭包状态。集中 export `TOOL_OPTIONS` / `TOOL_OPTION_SET` /
 * `RISKY_TOOLS` 是为了避免「helper + 表单组件共用」时的循环 import（调研报告
 * docs/reviews/2026-10-28/god-component-batch-1.md §3.③ 风险点）。
 *
 * 行为不变量（测试见 packages/ui/test/subagentModel.test.ts）：
 *  - 能力矩阵：user/workspace scope、user source、readOnly、bundled 预置的判定路径互不串扰；
 *  - 工具合并：known / preserved 分桶，mergeTools 去重后空数组归一为 undefined；
 *  - 模型档位：registry 无 spec / 加载中 / 失效模型 各走各的 kind；
 *  - 表单初值 key：initial 任何字段变化都改变 key（SubagentForm 按 key 回灌字段）。
 */
import {
  isBuiltInSubagentName,
  type AgentColor,
  type AgentsListResult,
  type AgentSummary,
  type BuiltInSubagentName,
  type ModelSelection,
} from "@acode/shared";
import type { ModelSelectionView } from "@acode/services";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import type { SubagentReasoningFieldState } from "@/settings/SubagentReasoningField.js";
import { SUBAGENT_COLORS, SUBAGENT_COLOR_CLASS } from "@/lib/subagentColors.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { resolveModelDisplayName } from "@/lib/modelSelectionGroups.js";
import { parseModelPickerValue } from "@/lib/modelPickerValue.js";
import { encodeCustomModelValue } from "@/lib/acodeCustomModelValue.js";

export const AGENT_COLORS: AgentColor[] = [...SUBAGENT_COLORS];
export const COLOR_DOT_CLASS: Record<AgentColor, string> = SUBAGENT_COLOR_CLASS;
export const INHERIT_MODEL_VALUE = "inherit";
export const TOOL_OPTIONS = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "Edit",
  "Write",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const;
export const TOOL_OPTION_SET = new Set<string>(TOOL_OPTIONS);
export const RISKY_TOOLS = new Set<string>(["Bash", "Edit", "Write"]);

interface AgentGroups {
  builtIn: AgentSummary[];
  plugin: AgentSummary[];
  user: AgentSummary[];
}

export function projectSettingsSubagents(result: AgentsListResult): AgentSummary[] {
  // result.agents 是运行时调用投影，插件 agent 可能同时有规范名称与裸名称别名；
  // 设置页按已安装资源展示，插件部分必须改用一文件一条的 pluginAgents 投影。
  return [...result.agents.filter((agent) => agent.source !== "plugin"), ...result.pluginAgents];
}

export interface SubagentFormInitialState {
  name: string;
  description: string;
  color: AgentColor;
  model: string;
  thoughtLevel?: string;
  speed?: string;
  injectAgentsMd: boolean;
  inheritAllTools: boolean;
  selectedTools: string[];
  preservedTools: string[];
  systemPrompt: string;
}

export function isEditableUserAgent(agent: AgentSummary): boolean {
  return (
    (agent.scope === "user" || agent.scope === "workspace") &&
    agent.source === "user" &&
    agent.readOnly !== true
  );
}

/**
 * R7 展示别名前缀：bundled 预置成员的 path 形态是 `bundled:<name>`（唯一产出点是
 * services 的 loadBundledAgentSummaries；核心二内置的别名是 `built-in:<name>`）。
 */
export const BUNDLED_AGENT_PATH_PREFIX = "bundled:";

export function isBundledPresetAgent(agent: AgentSummary): boolean {
  return agent.path?.startsWith(BUNDLED_AGENT_PATH_PREFIX) === true;
}

// disabledAgentIds 只作用于 user markdown 与 bundled 文件成员（CLI bootstrap 的
// isDisabledUserProfile：source "user"，或 source "built-in" 且带 path，R5），workspace
// profile 的 source 是 "project"、不参与禁用。因此 workspace agent 不能展示启用开关——
// 点了会静默回弹，还会往 user 级 agents-state.json 写入永不生效的记录；bundled 预置
// 成员则两端（bootstrap 装配过滤 + 服务端 attachEnabledState）都尊重其 state id，
// 开关是真实生效的控件（R7：bundled 卡片仅比核心内置多一个启停开关）。
export function supportsEnabledToggle(agent: AgentSummary): boolean {
  if (isBundledPresetAgent(agent)) {
    return true;
  }
  return isEditableUserAgent(agent) && agent.scope === "user";
}

export function isBuiltInAgent(agent: AgentSummary): boolean {
  return agent.scope === "built-in" || agent.source === "built-in";
}

/**
 * 内置目录成员（核心 general-purpose / Explore + bundled 预置 Plan / Verify / Review）
 * 与插件 agent 都是只读 profile，配置入口统一为行内 model / effort 覆盖控件；
 * 插件 md 属于插件安装目录，升级会覆写，所以不能像 user agent 那样改文件。
 */
export function supportsModelOverride(agent: AgentSummary): boolean {
  return getBuiltInSubagentName(agent) !== null || agent.source === "plugin";
}

export function getBuiltInSubagentName(agent: AgentSummary): BuiltInSubagentName | null {
  if (!isBuiltInAgent(agent)) {
    return null;
  }
  // R5/R7（builtin-subagent-catalog.md）：内置名单成员判定的单一事实源是 shared 的
  // BUILT_IN_SUBAGENT_NAMES（经 isBuiltInSubagentName）。旧实现硬编码二名判定，会让
  // bundled 预置 Plan/Verify/Review 拿不到模型覆盖控件（验收场景 6 的 GUI 侧通道）。
  return isBuiltInSubagentName(agent.name) ? agent.name : null;
}

export function getKnownTools(values: readonly string[] | undefined): string[] {
  return values?.filter((tool) => TOOL_OPTION_SET.has(tool)) ?? [];
}

export function getPreservedTools(values: readonly string[] | undefined): string[] {
  return values?.filter((tool) => !TOOL_OPTION_SET.has(tool)) ?? [];
}

export function mergeTools(
  selectedTools: readonly string[],
  preservedTools: readonly string[],
): string[] | undefined {
  const result = [...selectedTools, ...preservedTools].filter(
    (tool, index, tools) => tool.length > 0 && tools.indexOf(tool) === index,
  );
  return result.length > 0 ? result : undefined;
}

export function allowsAllTools(tools: readonly string[] | undefined): boolean {
  // 通配符 * 表示全部工具，不能按数组长度显示成 1 个工具。
  return !tools || tools.length === 0 || tools.some((tool) => tool.trim() === "*");
}

export function toPersistedModel(model: string): string | undefined {
  const trimmedModel = model.trim();
  return trimmedModel && trimmedModel !== INHERIT_MODEL_VALUE ? trimmedModel : undefined;
}

export function toSubagentModelValue(selection: ModelSelection | undefined): string {
  return selection
    ? encodeCustomModelValue(selection.providerId, selection.modelId)
    : INHERIT_MODEL_VALUE;
}

export function toSubagentModelSelection(
  model: string | undefined,
  thoughtLevel?: string,
  speed?: string,
): ModelSelection | undefined {
  const persistedModel = model ? toPersistedModel(model) : undefined;
  if (!persistedModel) return undefined;
  const selection = parseModelPickerValue(persistedModel);
  const reasoningLevel = thoughtLevel?.trim();
  const normalizedSpeed = speed?.trim();
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(reasoningLevel || normalizedSpeed
      ? {
          options: {
            ...(reasoningLevel ? { reasoningLevel } : {}),
            ...(normalizedSpeed ? { speed: normalizedSpeed } : {}),
          },
        }
      : {}),
  };
}

export type SubagentThoughtOptionState = SubagentReasoningFieldState;

export function resolveSubagentThoughtOptionState(params: {
  model: string;
  modelAvailable: boolean;
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  thoughtLevel?: string;
}): SubagentThoughtOptionState {
  const persistedModel = toPersistedModel(params.model);
  if (!persistedModel || !params.modelAvailable) {
    return { kind: "not-applicable" };
  }
  const modelSelection = parseModelPickerValue(persistedModel);
  const explicitThoughtLevel = params.thoughtLevel?.trim();

  // Settings 只管理 Local Environment，模型能力与候选统一来自 Local Host View。
  // Workspace presentation 的 configOptions 不是第二份模型目录，也不参与 reasoning 判断。
  const metadataOption = params.modelSelectionView
    ? resolveModelThoughtOption({
        modelSelectionView: params.modelSelectionView,
        providerId: modelSelection.providerId,
        modelId: modelSelection.modelId,
        currentValue: explicitThoughtLevel,
      })
    : null;
  if (metadataOption) {
    return {
      kind: "supported",
      option: metadataOption,
    };
  }
  if (params.modelSelectionLoading) {
    return { kind: "unknown", status: "loading" };
  }
  return { kind: "unsupported" };
}

export function isSubagentThoughtLevelAvailable(
  state: SubagentThoughtOptionState,
  thoughtLevel: string | undefined,
): boolean {
  const normalizedThoughtLevel = thoughtLevel?.trim();
  if (!normalizedThoughtLevel) {
    return true;
  }
  if (state.kind === "unknown" || state.kind === "not-applicable") {
    return true;
  }
  if (state.kind === "unsupported") {
    return false;
  }
  return Boolean(
    state.option.type === "select" &&
    state.option.options?.some((entry) => entry.value === normalizedThoughtLevel),
  );
}

export function resolvedSubagentThoughtLevel(
  state: SubagentThoughtOptionState,
): string | undefined {
  return state.kind === "supported" && typeof state.option.currentValue === "string"
    ? state.option.currentValue
    : undefined;
}

export function isSubagentModelAvailable(
  modelGroups: readonly ModelSelectGroup[],
  model: string | undefined,
  modelSelectionLoading = false,
): boolean {
  const trimmedModel = model?.trim();
  if (!trimmedModel || trimmedModel === INHERIT_MODEL_VALUE) {
    return true;
  }
  if (modelSelectionLoading) {
    return true;
  }
  return modelGroups.some((group) => group.items.some((item) => item.value === trimmedModel));
}

export function createSubagentFormInitialState(
  initial?: Pick<
    AgentSummary,
    | "name"
    | "description"
    | "color"
    | "modelSelection"
    | "tools"
    | "systemPrompt"
    | "injectAgentsMd"
  >,
): SubagentFormInitialState {
  return {
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    color: initial?.color ?? "yellow",
    model: toSubagentModelValue(initial?.modelSelection),
    thoughtLevel: initial?.modelSelection?.options?.reasoningLevel,
    speed: initial?.modelSelection?.options?.speed,
    injectAgentsMd: initial?.injectAgentsMd ?? true,
    inheritAllTools: initial?.tools === undefined || initial.tools.length === 0,
    selectedTools: getKnownTools(initial?.tools),
    preservedTools: getPreservedTools(initial?.tools),
    systemPrompt: initial?.systemPrompt ?? "",
  };
}

export function createSubagentFormInitialStateKey(initial?: AgentSummary): string {
  return JSON.stringify({
    id: initial?.id ?? null,
    ...createSubagentFormInitialState(initial),
  });
}

export function resolveSubagentModelLabel(params: {
  inheritLabel: string;
  modelGroups: readonly ModelSelectGroup[];
  model: string | undefined;
}): string {
  const trimmedModel = params.model?.trim();
  if (!trimmedModel || trimmedModel === INHERIT_MODEL_VALUE) {
    return params.inheritLabel;
  }
  // Registry 只包含当前可选模型，但历史 Subagent 配置仍需展示原模型身份，
  // 方便用户理解并修复失效配置。候选列表与保存校验继续以 Registry 为准。
  return resolveModelDisplayName(params.modelGroups, trimmedModel) ?? trimmedModel;
}

// 仅本模块内部使用的分组类型占位——AgentGroups 供将来批次使用，本批不外迁
// groupAgentsByScope / groupPluginAgentsById（属「列表分组」接缝，下一批处理）。
export type { AgentGroups };
