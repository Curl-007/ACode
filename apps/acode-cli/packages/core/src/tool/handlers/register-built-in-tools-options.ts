// ============================================================
// registerBuiltInTools 注册选项（从 handlers/index.ts 拆出）
// ============================================================
// 拆分原因：architecture:check 的 legacy max-file-lines ratchet 对 index.ts
// 只减不增（上限 400 行），tool-search wave 1a 的注册门注释使文件超限。
// 选项语义、注释与默认值全部原样保留，仅移动声明位置；index.ts 的
// registerBuiltInTools / resolveBuiltInToolEntryForBranch 继续消费同一类型。

import type { JsonSchema } from "@acode/contracts";
import type { AgentProfile } from "../../subagent/profile.js";
import type { BashTimeoutPolicy } from "../bash-timeout-policy.js";
import type { OpenPlatformPort } from "./open.js";
import type { SwarmPlanPort } from "../../swarm/port.js";
import type { AmbientScheduleQueue, ScheduledItem } from "../../ambient/queue.js";

export interface RegisterBuiltInToolsOptions {
  bashTimeoutPolicy?: BashTimeoutPolicy;
  includeSkill?: boolean;
  includeAgent?: boolean;
  includeSendMessage?: boolean;
  includeRespondToCoordinator?: boolean;
  includeSubmitResult?: boolean;
  /**
   * 在场时 submit_result 以 typed 声明注册（`{ result: <schema> }`，strict 资格），供 dwf mono
   * 子代理；缺席即通用声明。只在 includeSubmitResult 为真时有意义。
   */
  submitResultSchema?: JsonSchema;
  /** actor 的升级通道；门与 includeSubmitResult 同款（注入了 WorkflowEscalatePort 才注册）。 */
  includeEscalate?: boolean;
  /**
   * 脚本工作流（RunWorkflow）的**端口门**：注入了 `WorkflowPort` 才注册。极性是「只有显式
   * true 才注册」，与 includeOffPeak / includeAutomation 同族，所以 embedded-search-branch.ts
   * 那个精简入口省略它是安全的（省略 = 不注册，与首次装配同结论）。
   * 这个选项曾长期是死代码（它匹配的 `"Workflow"` 条目早已移出 builtInTools）；RunWorkflow
   * 落地后重新生效，判据仍是 `Boolean(deps.workflowPort)`。与 includeDynamicWorkflow 是
   * **两道独立的门**（能力 vs 可用性），都放行才注册。
   */
  includeWorkflow?: boolean;
  includeAutomation?: boolean;
  /** Off-Peak 会话内创建工具面；由 host 的 offPeakToolEnabled flag（灰度/远程门）驱动。 */
  includeOffPeak?: boolean;
  /** 开箱（Open 工具）平台端口；在场即注册，缺席不注册（K9 R2 的 port 门控）。 */
  platformOpenPort?: OpenPlatformPort;
  /**
   * K2 swarm plan 工具族的注册门（specs/swarm-task-graph.md R5）：端口在场即注册
   * PlanSeed/PlanExpand/PlanCompleteGate/PlanStatus/PlanControl（工具工厂闭包 store，
   * plan-shared.ts 头注释的 2b 接线位）。只读推导在调用方（runtime-tools.ts 按
   * taskType，includeAutomation 同款先例），本层不做 runtime 配置推断。
   */
  swarmPlanPort?: SwarmPlanPort;
  /** 在场为 true 时只注册 PlanStatus（workflow 子会话的只读面，R5「防 worker 自改图」）。 */
  swarmPlanReadOnly?: boolean;
  /**
   * K6 ambient Schedule 工具的注册门（specs/ambient-budget-scheduler.md R2/场景 10）：
   * flag 推导在调用方（runtime-tools.ts 按 config.ambient.enabled && 非封闭子会话
   * ——subagent_child/workflow_child/nested_workflow_child，F10 批次C 收紧），
   * includeAutomation 同款先例，本层不做 runtime 配置推断——与 swarmPlanPort 的
   * 门分工一致。
   */
  includeAmbientSchedule?: boolean;
  /**
   * K6：Schedule 工具的依赖闭包。queue 是 ambient 域装配面注入的磁盘队列实例（不能进
   * 静态数组的原因与 Open/swarm 相同：handler 闭包依赖装配态）；sessionId 标记创建
   * 来源会话（target=session 提醒的投递目标）；onScheduleCreated 是创建成功后的
   * runner nudge/重启缝。
   */
  ambientSchedule?: {
    queue: AmbientScheduleQueue;
    sessionId?: string;
    onScheduleCreated?(item: ScheduledItem): void;
  };
  /**
   * 动态工作流可用性门（dwf 总闸）。**只有显式 false 才下架** GATED_WORKFLOW_TOOL_NAMES：
   * 缺席代表调用方不参与灰度（TUI、headless、workflow_child），必须保留全部工具面；档位的
   * 唯一所有者是 shared 的 dynamic-workflow-feature.ts。两道门的合取语义见 workflow-tool-names.ts。
   */
  includeDynamicWorkflow?: boolean;
  /** 脚本工作流门（只管 RunWorkflow，与上门合取）：只有显式 false 才下架；推导在 tool-allowlist.ts。 */
  includeScriptWorkflow?: boolean;
  /** node_repl（js）默认关闭，由官方 browser-use 插件启用。 */
  includeNodeRepl?: boolean;
  /**
   * U11 工具图片外置引用（specs/tool-media-attachment-ref.md R10.1）的生产门：**默认关闭**。
   *
   * 只有显式 true 才把 node-repl 工具图片写进 artifact store，并让 `node_repl_images` display
   * 发 ref 形态（字节按需读取）；缺席/false 时行为与 U11 之前逐字一致（全 inline base64）。
   * 极性沿用同族 `include*` 门（`includeBrowserUse` / `includeOffPeak`：只有显式 true 才开）。
   *
   * 门开时运行期还要过两道判据（`shouldEmitToolMediaRefs`）：`clientMode === "desktop-continuous"`
   * 与 artifact store 在场。为什么默认关闭而不做 capability 协商：安全的协商方向是 host→client
   * （`hello.capabilities`），而本项需要的是 client→host，而 `clientHello.capabilities` 是
   * `.strict()` 的——加键会让老 Host 整条握手失败（spec §6.4）。
   */
  nodeReplMediaRefs?: boolean;
  /**
   * 工具按需检索（specs/tool-search.md R3/R4）：runtime 启动选项 toolSearchMode
   * 非 off 才为 true（推导在 runtime-tools.ts）。控制工具被作用域禁用时 exposure
   * 会降级 off；这里管的是注册面——off 时两个控制工具不进 registry。
   */
  includeToolSearch?: boolean;
  /** browser-use 说明和 agent.browsers 注入由官方 browser-use 插件 + 宿主 browser bridge 共同启用。 */
  includeBrowserUse?: boolean;
  embeddedSearchEnabled?: boolean;
  agentProfiles?: readonly AgentProfile[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  silentDuplicateWarnings?: boolean;
}
