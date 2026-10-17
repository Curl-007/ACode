import type { AgentColor, AgentSummary, ModelSelection, SubAgentConfig } from "@acode/shared";

/**
 * SubagentForm 保存载荷的唯一构造点（纯函数；断言测试 test/subagentFormSaveConfig.test.ts）。
 *
 * 存在原因：编辑表单只渲染部分字段（名称/描述/颜色/模型/推理强度/injectAgentsMd/工具/
 * systemPrompt），其余键必须在保存时从打开编辑时的 AgentSummary 快照原样透传，否则
 * GUI 一次「编辑并保存」就会把它们静默丢掉（services subagentMarkdown 按 config 序列化
 * frontmatter，config 面缺键即磁盘声明丢失）。
 *
 * 其中声明键批②六键 isolation/observer/observerMessage/observeSubagents/initialPrompt/hooks
 * 是 GUI 往返保真面（apps/acode-cli/specs/subagent-declarative-keys.md 接线需求 3）：
 * 表单不呈现（GUI 呈现另议），但构造路径必须保留；解析语义单点在 CLI
 * core/subagent/profile-declarative.ts，本面不做任何归并/校验，只透传原键面。
 */
export function buildSubagentSaveConfig(params: {
  /** 编辑对象快照；新建表单为 undefined（此时透传键全部缺席，与既有行为一致）。 */
  initial?: AgentSummary;
  /** 已完成 trim/校验的表单值。 */
  name: string;
  description: string;
  systemPrompt: string;
  color: AgentColor;
  injectAgentsMd: boolean;
  /** 模型选择归一结果；undefined = inherit，不写键（沿用既有条件展开语义）。 */
  modelSelection?: ModelSelection;
  /** 工具选择合并结果；undefined = 继承全部工具（沿用既有条件语义）。 */
  tools?: string[];
}): SubAgentConfig {
  const { initial } = params;
  return {
    name: params.name,
    description: params.description,
    systemPrompt: params.systemPrompt,
    color: params.color,
    injectAgentsMd: params.injectAgentsMd,
    ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
    tools: params.tools,
    // 表单未渲染的既有透传键（迁移前 handleSubmit 原样保留，形状不变）。
    disallowedTools: initial?.disallowedTools,
    skills: initial?.skills,
    permissionMode: initial?.permissionMode,
    ...(initial?.background !== undefined ? { background: initial.background } : {}),
    mcpServers: initial?.mcpServers,
    // 声明键批②六键（本批增量）：不呈现但必须透传，保证 GUI 往返不丢声明。
    isolation: initial?.isolation,
    observer: initial?.observer,
    observerMessage: initial?.observerMessage,
    observeSubagents: initial?.observeSubagents,
    initialPrompt: initial?.initialPrompt,
    hooks: initial?.hooks,
  };
}
