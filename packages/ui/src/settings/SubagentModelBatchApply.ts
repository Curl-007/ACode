import type { AgentSummary, ModelSelection, SubAgentConfig } from "@acode/shared";

/**
 * 批量编辑的目标行。
 * 内置 general-purpose / Explore 与插件 agent 走行内覆盖路径（agents-state.json）；
 * 可编辑的自建/工作区 agent 走定义文件路径（updateAgent 重写 modelSelection）。
 * 只读 profile（不可编辑的自建行）不可批量。
 */
export function resolveBatchApplyTargets(agents: readonly AgentSummary[]): AgentSummary[] {
  return agents.filter((agent) => isBatchApplicableAgent(agent));
}

/** 单行是否可参与批量模型设置。 */
export function isBatchApplicableAgent(agent: AgentSummary): boolean {
  if (getBatchBuiltInAgentName(agent) !== null) return true;
  if (agent.source === "plugin") return true;
  return (
    (agent.scope === "user" || agent.scope === "workspace") &&
    agent.source === "user" &&
    agent.readOnly !== true
  );
}

/** 目标行落盘路径：覆盖（state 文件）还是定义文件重写。 */
export type BatchApplyWritePath = "override" | "definitionFile";

export function resolveBatchWritePath(agent: AgentSummary): BatchApplyWritePath {
  if (getBatchBuiltInAgentName(agent) !== null || agent.source === "plugin") {
    return "override";
  }
  return "definitionFile";
}

/**
 * 内置可覆盖行仅 general-purpose / Explore；与 SubagentsSection 的
 * getBuiltInSubagentName 保持同一判定（isBuiltInAgent + 名称白名单）。
 */
function getBatchBuiltInAgentName(agent: AgentSummary): "general-purpose" | "Explore" | null {
  const isBuiltIn = agent.scope === "built-in" || agent.source === "built-in";
  if (!isBuiltIn) return null;
  return agent.name === "general-purpose" || agent.name === "Explore" ? agent.name : null;
}

/** 批量分组头的全选状态：无任何可批量行时复选框整体禁用。 */
export function resolveGroupBatchSelectable(groupAgents: readonly AgentSummary[]): {
  selectable: AgentSummary[];
  selectableCount: number;
} {
  const selectable = resolveBatchApplyTargets(groupAgents);
  return { selectable, selectableCount: selectable.length };
}

/** 全选/全不选的三态：空选、半选、全选。 */
export type BatchGroupCheckState = "unchecked" | "checked" | "indeterminate";

export function resolveGroupBatchCheckState(
  groupAgents: readonly AgentSummary[],
  selectedIds: ReadonlySet<string>,
): { state: BatchGroupCheckState; selectable: AgentSummary[] } {
  const { selectable } = resolveGroupBatchSelectable(groupAgents);
  if (selectable.length === 0) {
    return { state: "unchecked", selectable };
  }
  const selectedCount = selectable.filter((agent) => selectedIds.has(agent.id)).length;
  if (selectedCount === 0) return { state: "unchecked", selectable };
  if (selectedCount === selectable.length) return { state: "checked", selectable };
  return { state: "indeterminate", selectable };
}

/**
 * 批量结果汇总：成功/失败计数与失败行名称列表，供操作条与弹层共用展示。
 * describeBatchResult 把结果投影为 i18n 参数，组件层只负责 formatMessage。
 */
export interface SubagentModelBatchResult {
  succeeded: string[];
  failed: Array<{ name: string; message: string }>;
}

export function createEmptyBatchResult(): SubagentModelBatchResult {
  return { succeeded: [], failed: [] };
}

export function describeBatchResult(result: SubagentModelBatchResult): {
  succeededCount: number;
  failedCount: number;
  failedNames: string[];
  firstFailureMessage: string | null;
} {
  return {
    succeededCount: result.succeeded.length,
    failedCount: result.failed.length,
    failedNames: result.failed.map((entry) => entry.name),
    firstFailureMessage: result.failed[0]?.message ?? null,
  };
}

/**
 * 批量目标值（模型 + 可选推理档位 + 可选速度）。modelSelection 为空时表示「恢复继承默认」：
 * 覆盖路径写 state 文件；定义文件路径移除 model/thoughtLevel/speed 字段。
 * modelSelection 必须是调用方已用 completeNewModelSelection 解析好的结构体——
 * 不能传 picker 的编码字符串再手写切分（custom: 形态无字面 /，切分会把整串
 * 同时当成 providerId 和 modelId 双重编码写盘，重载后徽标显示内部串）。
 * 带 speed spec 的模型必须带 speed（运行时 speed-missing 会拒绝派发）。
 */
export interface SubagentModelBatchValue {
  modelSelection?: ModelSelection;
  thoughtLevel?: string;
  speed?: string;
}

export function isBatchValueInherit(value: SubagentModelBatchValue): boolean {
  return !value.modelSelection?.modelId?.trim();
}

/**
 * 解析 speed 维度：模型无 speed spec 时 not-applicable；spec 存在但 Registry
 * 未就绪时 unknown；否则 supported（候选值列表）。判断依据与运行时校验
 * （validateModelSelectionOptions 的 speed-missing）同源，避免 UI 与运行时口径漂移。
 */
export function resolveSubagentSpeedOptionState(params: {
  modelSelectionView?: ModelSelectionViewLike | null;
  modelSelection?: ModelSelection | undefined;
  modelSelectionLoading: boolean;
}):
  | { kind: "not-applicable" }
  | { kind: "unknown"; status: "loading" | "unavailable" }
  | { kind: "supported"; values: readonly string[] } {
  const selection = params.modelSelection;
  if (!selection) {
    return { kind: "not-applicable" };
  }
  const model = params.modelSelectionView?.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!params.modelSelectionView) {
    return { kind: "unknown", status: params.modelSelectionLoading ? "loading" : "unavailable" };
  }
  const speedSpec = model?.config.optionSpecs.speed;
  if (!speedSpec || speedSpec.values.length === 0) {
    return { kind: "not-applicable" };
  }
  return { kind: "supported", values: speedSpec.values };
}

export function isSubagentSpeedInvalid(
  state: ReturnType<typeof resolveSubagentSpeedOptionState>,
  speed: string | undefined,
): boolean {
  return state.kind === "supported" && !state.values.includes(speed?.trim() ?? "");
}

interface ModelSelectionViewLike {
  providers: ReadonlyArray<{
    providerId: string;
    models: ReadonlyArray<{
      modelId: string;
      config: { optionSpecs: { speed?: { values: readonly string[] } } };
    }>;
  }>;
}

/**
 * 自建 agent 的定义文件重写载荷：以当前行投影为基线，仅替换 modelSelection。
 * 其余字段（tools/skills/systemPrompt/mcpServers 等）原样保留，避免批量改模型时丢失用户配置。
 *
 * 迁移适配（相对上游模块的两处口径修正，依据本仓 spec）：
 * 1. 不携带轮数上限声明——该 frontmatter 键已全链删除且禁止再引入
 *    （apps/acode-cli/specs/subagent-maxturns-policy.md R1/R2；另有全域扫描测试钉住
 *    packages/ui/src 零出现）。
 * 2. 透传声明键批②六键 isolation/observer/observerMessage/observeSubagents/initialPrompt/hooks
 *    （apps/acode-cli/specs/subagent-declarative-keys.md）：updateAgent 按 config 面序列化
 *    frontmatter，缺键即磁盘声明丢失，与单项编辑 buildSubagentSaveConfig 的透传语义对齐。
 */
export function buildUserAgentBatchConfig(
  agent: AgentSummary,
  value: SubagentModelBatchValue,
): SubAgentConfig {
  const inherit = isBatchValueInherit(value);
  const thoughtLevel = inherit ? undefined : value.thoughtLevel?.trim();
  const speed = inherit ? undefined : value.speed?.trim();
  const baseSelection = inherit ? undefined : value.modelSelection;
  const modelSelection = baseSelection
    ? {
        ...baseSelection,
        options: {
          ...baseSelection.options,
          ...(thoughtLevel ? { reasoningLevel: thoughtLevel } : {}),
          ...(speed ? { speed } : {}),
        },
      }
    : undefined;
  return {
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    color: agent.color,
    // 继承默认 = 从定义文件移除 model/thoughtLevel；否则写入目标 selection。
    modelSelection,
    tools: agent.tools,
    disallowedTools: agent.disallowedTools,
    injectAgentsMd: agent.injectAgentsMd,
    skills: agent.skills,
    permissionMode: agent.permissionMode,
    background: agent.background,
    mcpServers: agent.mcpServers,
    // 声明键批②六键：批量重写定义文件必须原样透传，禁止静默丢键。
    isolation: agent.isolation,
    observer: agent.observer,
    observerMessage: agent.observerMessage,
    observeSubagents: agent.observeSubagents,
    initialPrompt: agent.initialPrompt,
    hooks: agent.hooks,
  };
}
