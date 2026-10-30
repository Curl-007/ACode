// ============================================================
// launch 的类型面（从 dynamic-workflow-run-launch.ts 拆出）
// ============================================================
// 一次编译的产物（CompiledDynamicWorkflowScript）与 launch 入参（LaunchDynamicWorkflowRunInput）。
// 独立成叶：launch 主体只留执行编排，类型消费者（compile / submit / resume）与本叶直连，
// 不经过执行体。

import {
  type ActorSubmitProfile,
  type AskSpec,
  type Caps,
  type ImportedRunCache,
} from "@acode/dynamic-workflow";
import type { RunLaunch } from "./dynamic-workflow-run-launch-anchor.js";
import type { ActorSessionQuiescence } from "./workflow-driver-types.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import type { WorkflowRunControl } from "./workflow-run-control.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-deps.js";

/** 一次编译的全部产物。四个消费者共用同一个 ts.Program（编译一次，见 run service 不变式 2）。 */
export interface CompiledDynamicWorkflowScript {
  lowered: string;
  scriptHash: string;
  askSpecs: Map<string, AskSpec>;
  /** world.run 的已批准命令集（编译期字面量收集）。 */
  declaredRunCommands: ReadonlySet<string>;
  /** 每个 actor 站点的 submit profile。 */
  actorSubmitProfiles: ReadonlyMap<string, ActorSubmitProfile>;
}

export interface LaunchDynamicWorkflowRunInput {
  caps: Caps;
  compiled: CompiledDynamicWorkflowScript;
  cwd: string;
  deps: DynamicWorkflowRunServiceDeps;
  /** run 的展示名（`CreateWorkflow` 的可选 `input.name`）：随 EngineConfig 在 createRun 时落 dwf_run.name。 */
  name?: string;
  /**
   * 本次 run 的实参（saved workflow 的已校验实参袋）。两个去处：随 EngineConfig 落
   * `dwf_run.args_json`，以及进 spawn payload 注入沙箱的 `args` 全局。
   *
   * resume 分支传的是**从 journal 读回的那一份**，不是调用方新给的——见 run service 的
   * resume 注释。
   */
  args?: Record<string, unknown>;
  parentSessionId?: string;
  runId: string;
  scriptText: string;
  signal: AbortSignal;
  toolCallId?: string;
  /**
   * 修订续跑的 lineage 指针（`dwf_run.resumed_from`）与导入缓存。两者**成对**出现：
   * 指针是行级事实（UI 的「续自 run X」、崩溃后 resume 据它重建），缓存是本次执行的加速结构。
   *
   * 与其余元数据同一条路——launch → harness → EngineConfig，中途零加工。构建（读前驱 journal、
   * 走 `resumed_from` 链、解析转录源）全部发生在 run service：这里已经是执行侧，把构建放进来
   * 就等于让 resume 与 submit 各构建一次（而它们必须是同一个纯函数的两次调用）。
   */
  resumedFrom?: string;
  importedCache?: ImportedRunCache;
  /**
   * 建 run 时的用量起点：前驱结算后的 `spentTokens`。
   * 与 lineage 指针同一条路——launch → harness → EngineConfig，中途零加工；amend 路径给出，
   * 全新 submit 与 resume 缺席（后者的用量从既有行恢复）。
   */
  inheritedTokens?: number;
  /**
   * 发起 run 那一轮的锚点。submit 路径给出（引擎在建 run
   * 那一世记 `run-launched`）；resume 路径缺席，本函数从 journal 读回——两条路径都用同一个值给
   * `actor-created` / `run-settled` 进度事件派生 `launchInputId`。submit 路径还随车带脚本声明的
   * 阶段表（`phaseNames`）与本 run 的子代理模型（`subagentModel`，规范 picker 串），三者同样
   * 只在建 run 那一世落 journal，resume 路径一概从那条事件读回。
   */
  launch?: RunLaunch;
  /**
   * 升级问答的停驻注册表。由 run service 持有一张、
   * 跨它名下所有在飞 run，两条入口（submit / resume）传的是**同一个对象**——注册表按完整 qid
   * 索引，两条入口各持一张会让 resume 之后的 run 作答不到自己刚提的问题。
   */
  escalationRegistry: WorkflowEscalationRegistry;
  /**
   * 本 run 的活体控制面。由 run
   * service 按**注册表条目**造一个（submit / amend / resume 三条入口都造），本函数在这里把它的
   * 两端接上：harness 负责 `bind(engine)`，本函数负责 `bindSeatGate`。
   *
   * 缺席即这次启动没有控制面（如 snippet 执行）——run 照常跑完，只是上界中途改不了。
   */
  control?: WorkflowRunControl;
  /**
   * 接住本次 launch 造出来的 driver 的**会话静默探针**（workflow-driver-quiescence.ts）。
   * 三条入口都传同一件事：把它挂到这个 run 的注册表条目上，好让将来修订它的那次 amend
   * 问得着「前驱的会话写完了没有」。原样下传，本文件不读它。
   */
  onQuiescenceProbe?: (probe: ActorSessionQuiescence) => void;
}
