import type {
  DynamicWorkflowRunPort,
  Logger,
  SessionId,
  SessionStorePort,
  TraceContext,
} from "@acode/contracts";
import type { AgentRuntime, AmendWorkflowRunSettingsInput } from "@acode/core";
import { createWorkflowRunCommandContext } from "@acode/workflow-run-command/contract";
import type {
  ListScriptWorkflowDefinitionsResult,
  ListScriptWorkflowRunsResult,
  ScriptWorkflowLogicalStatus,
} from "@acode/shared/acode-protocol-v4";
import type { ACodeApp, PrepareUserExecutionBoundary } from "./types.js";
import {
  isScriptWorkflowStore,
  isVisibleScriptWorkflowDefinition,
  replayScriptWorkflowRuns,
  toScriptWorkflowManagementDefinitionEntry,
  toScriptWorkflowManagementRunEntry,
  toScriptWorkflowRunSummary,
} from "@acode/cli-workflow/contract";

/** 管理面运行历史的缺省页大小（spec §4.1：缺省 50，协议 schema 上限 200）。 */
const SCRIPT_WORKFLOW_RUNS_DEFAULT_LIMIT = 50;

interface WorkflowAppFacadeDeps {
  getRuntime: () => Pick<
    AgentRuntime,
    "trackResumedDynamicWorkflowRun" | "startSavedWorkflowRun" | "amendWorkflowRunSettings"
  >;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  sessionStore: SessionStorePort;
  sessionId: SessionId;
  logger: Logger;
  traceContext: TraceContext;
}

type WorkflowAppFacade = Pick<
  ACodeApp,
  | "listDynamicWorkflowRunEvents"
  | "listDynamicWorkflowRunArtifacts"
  | "listDynamicWorkflowRunArtifactItems"
  | "readDynamicWorkflowRunArtifact"
  | "listDynamicWorkflowRunWorkspaceNodes"
  | "readDynamicWorkflowRunNodeResult"
  | "listDynamicWorkflowRuns"
  | "listScriptWorkflowRuns"
  | "listScriptWorkflowDefinitions"
  | "replayDynamicWorkflowRuns"
  | "resumeWorkflowRun"
  | "startSavedWorkflow"
  | "amendWorkflowRunSettings"
>;

export function createWorkflowAppFacade(deps: WorkflowAppFacadeDeps): WorkflowAppFacade {
  const {
    getRuntime,
    prepareUserExecutionBoundary,
    dynamicWorkflowRunPort,
    sessionStore,
    sessionId,
    logger,
    traceContext,
  } = deps;
  const commandContext = createWorkflowRunCommandContext({
    getRuntime,
    prepareUserExecutionBoundary,
    traceContext,
    ...(dynamicWorkflowRunPort !== undefined && typeof dynamicWorkflowRunPort.resume === "function"
      ? {
          resumePort: {
            resume: (runId: string) => dynamicWorkflowRunPort.resume!(runId),
          },
        }
      : {}),
  });
  return {
    // dwf 事件日志的读面。**可选能力**：journal 不可用时 run service 整个不构造，
    // 这个方法随之缺席，v4 网关据此回结构化的能力不支持错误——「没有事件」与
    // 「这个会话没有这个能力」必须能被 renderer 区分。
    ...(dynamicWorkflowRunPort === undefined
      ? {}
      : {
          listDynamicWorkflowRunEvents: async (input: {
            runId: string;
            afterSequence?: number;
            limit?: number;
          }) =>
            dynamicWorkflowRunPort.listEvents(input.runId, {
              ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            }),
        }),
    // workflow run 的**用户面产物**读面。三条一起注册、
    // 一起缺席：它们是同一个 journal 读面的三个切片，部分在场只会让 UI 拿到一张有卡片
    // 却打不开的侧板。三个端口成员都是可选的（stub 端口不陪跑），所以逐个探测。
    // ⚠ 术语：artifact = 脚本发布给用户看的产出，不是端口上的 `output`（顶层返回值）。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.listArtifacts !== "function" ||
    typeof dynamicWorkflowRunPort.listArtifactItems !== "function" ||
    typeof dynamicWorkflowRunPort.readArtifact !== "function"
      ? {}
      : {
          listDynamicWorkflowRunArtifacts: async (input: { runId: string }) =>
            dynamicWorkflowRunPort.listArtifacts!(input.runId),
          listDynamicWorkflowRunArtifactItems: async (input: {
            runId: string;
            artifactId: string;
            afterSequence?: number;
            limit: number;
          }) =>
            dynamicWorkflowRunPort.listArtifactItems!(input.runId, input.artifactId, {
              ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
              limit: input.limit,
            }),
          readDynamicWorkflowRunArtifact: async (input: {
            runId: string;
            artifactId: string;
            version: number;
          }) => dynamicWorkflowRunPort.readArtifact!(input.runId, input.artifactId, input.version),
        }),
    // workflow run 的工作区 transcript：两条一起
    // 注册、一起缺席，理由同产物的三条。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.listWorkspaceNodes !== "function" ||
    typeof dynamicWorkflowRunPort.readWorkspaceNodeResult !== "function"
      ? {}
      : {
          listDynamicWorkflowRunWorkspaceNodes: async (input: { runId: string }) =>
            dynamicWorkflowRunPort.listWorkspaceNodes!(input.runId),
          readDynamicWorkflowRunNodeResult: async (input: {
            runId: string;
            siteId: string;
            ordinal: number;
            maxBytes: number;
          }) =>
            dynamicWorkflowRunPort.readWorkspaceNodeResult!(
              input.runId,
              input.siteId,
              input.ordinal,
              { maxBytes: input.maxBytes },
            ),
        }),
    // workflow run 的会话级生命周期读面（在飞计数 + 结算订阅）。消费者是宿主的 provider registry
    // 安全边界：子代理共用本会话的 live adapter，在飞 run 期间不能 replace registry。缺席条件同上。
    // workflow run 的枚举面（重启后的发现查询）。**两个来源**合成一个能力，与下面的冷回放
    // 同一条理由：目录页是「这个会话跑过哪些工作流」的发现面，只列 dwf 就少一半。
    // 注册条件同样是「任一来源在场」，不再以 dwf 端口为准。
    ...(() => {
      const dwfList =
        dynamicWorkflowRunPort !== undefined &&
        typeof dynamicWorkflowRunPort.listRunsForSession === "function"
          ? dynamicWorkflowRunPort.listRunsForSession.bind(dynamicWorkflowRunPort)
          : undefined;
      const scriptStore = isScriptWorkflowStore(sessionStore) ? sessionStore : undefined;
      if (dwfList === undefined && scriptStore === undefined) return {};
      return {
        listDynamicWorkflowRuns: async (input: { limit?: number }) => {
          const [dwf, script] = await Promise.all([
            dwfList === undefined ? [] : dwfList(input.limit),
            scriptStore === undefined
              ? []
              : (
                  await scriptStore.listScriptWorkflowRuns({
                    ...(input.limit === undefined ? {} : { limit: input.limit }),
                    parentSessionId: sessionId,
                  })
                ).map(toScriptWorkflowRunSummary),
          ]);
          // 两个来源各自都是「最近更新在前」，但拼接之后就不是了。目录的时间列与
          // 「运行中 / 已结束」两段都依赖这个序，所以在这里按 updatedAt 归并一次再截断。
          // 缺席 updatedAt 的排最后（无从比较，不该抢占有时间的条目的位置）。
          const merged = [...dwf, ...script].sort(
            (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
          );
          return input.limit === undefined ? merged : merged.slice(0, input.limit);
        },
      };
    })(),
    // 脚本工作流管理面读数（spec script-workflow-management-surface.md §4.1/§4.2）。
    // 与上面的 dwf 枚举面**平行、不共用查询**：物理表（workflow_run vs dwf_run）、状态
    // 词表、owner 语义都不同，两套 journal 不混在同一列表里。能力探测用
    // isScriptWorkflowStore（sessionStore 无 ScriptWorkflowStorePort 的宿主 = stub/单测），
    // 缺席即两个方法**一起**缺席——v4 handler 据此回能力不支持，错误上行，绝不静默回空
    // （与 journal.ts:8-9 的纪律同一条：空列表和「读不到」是两个事实）。
    ...(() => {
      const scriptStore = isScriptWorkflowStore(sessionStore) ? sessionStore : undefined;
      if (scriptStore === undefined) return {};
      return {
        listScriptWorkflowRuns: async (input: {
          cwd: string;
          limit?: number;
          statuses?: readonly ScriptWorkflowLogicalStatus[];
        }): Promise<ListScriptWorkflowRunsResult> => {
          const limit = input.limit ?? SCRIPT_WORKFLOW_RUNS_DEFAULT_LIMIT;
          // statuses 过滤下推到 store 读面（P2 修复）：逻辑态闭集在物理层展开
          // （interrupted = cancelled + failure_json.code 命中；SQL 展开与
          // script-workflow-run-status.ts 唯一映射的一致性由 store 测试逐行互钉）。
          // 此前先取 limit+1 行、投影后才过滤：带 statuses 时物理页外的匹配行被静默
          // 隐藏、truncated 系统性 false——过滤必须在取数时生效，「多取一行」探到的
          // 才是第 limit+1 个匹配行。
          const rows = await scriptStore.listScriptWorkflowRuns({
            cwd: input.cwd,
            limit: limit + 1,
            ...(input.statuses !== undefined && input.statuses.length > 0
              ? { logicalStatuses: input.statuses }
              : {}),
          });
          // truncated 语义 = 「还有更多匹配」：匹配行数超过 limit（与 statuses 组合时
          // 也是匹配行的余量，不是物理行的余量），UI 据此显示「仅显示最近 N 条」。
          const truncated = rows.length > limit;
          // usageIncomplete 是 activity 级事实（markUsageIncomplete 写在 activity.result），
          // run 行不带；store 的存在性读面一次索引探测给一个布尔（P2 修复：此前逐 run
          // 全行拉取 activity，含 payload/result 大字段，默认 51、最大 201 次，只为算一个布尔）。
          const runs = await Promise.all(
            rows
              .slice(0, limit)
              .map(async (row) =>
                toScriptWorkflowManagementRunEntry(
                  row,
                  await scriptStore.hasScriptWorkflowUsageIncomplete({ runId: row.id }),
                ),
              ),
          );
          return {
            type: "listScriptWorkflowRuns",
            runs,
            truncated,
          };
        },
        listScriptWorkflowDefinitions: async (): Promise<ListScriptWorkflowDefinitionsResult> => {
          const records = await scriptStore.listScriptWorkflowDefinitions();
          return {
            type: "listScriptWorkflowDefinitions",
            // 可见性：builtin（预定义）恒可见；其余 scope 必须有实体脚本路径（§4.2）。
            definitions: records
              .filter(isVisibleScriptWorkflowDefinition)
              .map(toScriptWorkflowManagementDefinitionEntry),
          };
        },
      };
    })(),
    // workflow run 的冷回放。**两个来源**合成一个能力：
    //   - dwf：journal（端口的 replayProgressForSession，可选成员，缺席即无这一半）；
    //   - 脚本工作流：自己的 workflow_run / workflow_event 表（script-workflow-replay.ts）。
    // 注册条件从「dwf 端口在场」放宽成「任一来源在场」：两套 run 共用同一个投影与同一个
    // 消费者（v4-bridge.ts），只因为 dwf 端口缺席就把整个能力摘掉，会让脚本 run 也一起
    // 从冷启动的投影里消失——而它的真相明明在自己的表里。
    // 顺序是 dwf 在前、脚本在后：两边都按「最旧优先」各自排好，拼接不保证跨系统的全局时序，
    // 而 reducer 的序号是**每 run 各自**水位的，跨 run 的到达序只影响 8-run 上限的淘汰先后。
    ...(() => {
      const dwfReplay =
        dynamicWorkflowRunPort !== undefined &&
        typeof dynamicWorkflowRunPort.replayProgressForSession === "function"
          ? dynamicWorkflowRunPort.replayProgressForSession.bind(dynamicWorkflowRunPort)
          : undefined;
      const scriptStore = isScriptWorkflowStore(sessionStore) ? sessionStore : undefined;
      if (dwfReplay === undefined && scriptStore === undefined) return {};
      return {
        replayDynamicWorkflowRuns: async (input: { excludeRunIds: ReadonlySet<string> }) => {
          const [dwf, script] = await Promise.all([
            dwfReplay === undefined ? [] : dwfReplay(input),
            scriptStore === undefined
              ? []
              : replayScriptWorkflowRuns(
                  { logger, parentSessionId: sessionId, store: scriptStore },
                  input,
                ),
          ]);
          return [...dwf, ...script];
        },
      };
    })(),
    // dwf run 的恢复。能力缺席条件同上；此外
    // 端口的 resume 是可选成员（stub 端口不陪跑），方法缺席时本能力同样不注册——
    // 对 renderer「端口缺席」与「方法缺席」是同一个业务事实。
    ...(commandContext.resumeWorkflowRun === undefined
      ? {}
      : { resumeWorkflowRun: commandContext.resumeWorkflowRun }),
    // 中枢直接启动一个已保存的工作流。能力缺席条件与
    // resumeWorkflowRun 家族一致：dwf 端口整体缺席（stub / 单测宿主）时不注册——GUI 据此拿到
    // 能力不支持错误并原样显示，而不是把「不支持直接启动」误当成一次失败的启动。
    // 与 /goal 控制轮同构：先走统一用户执行边界（否则首次持久化前 shell selection 为空，
    // 冷恢复退回 legacy fallback），再由 runtime 解析 + 校验 + 编译 + 落启动轮 + submit。
    ...(dynamicWorkflowRunPort === undefined
      ? {}
      : {
          startSavedWorkflow: commandContext.startSavedWorkflow,
        }),
    // GUI「配置」。它
    // 沿用前驱的脚本，所以端口必须既能 amend 又能读回脚本；缺一就不注册，GUI 拿到能力不支持。
    // 与 startSavedWorkflow 同一条用户执行边界：冷恢复的会话先恢复 Session 边界再落设置轮。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.amend !== "function" ||
    typeof dynamicWorkflowRunPort.getScript !== "function"
      ? {}
      : {
          amendWorkflowRunSettings: commandContext.amendWorkflowRunSettings,
        }),
  };
}
