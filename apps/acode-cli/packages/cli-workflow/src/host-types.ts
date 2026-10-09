// ============================================================
// 宿主类型解耦（W1-R3，specs/cli-workflow-package-boundary.md 规则 1/2）
// ============================================================
// 引擎不得反向依赖 bootstrap：宿主侧类型在本文件以窄结构化类型定义，
// bootstrap 的 `types.ts`（PrepareUserExecutionBoundary）改为 re-export 本文件，
// 保持全仓单一定义；bootstrap 的 `ACodeAppOptions` 与 `ScriptWorkflowHostOptions`
// 保持结构化兼容（可赋值），不改 bootstrap 字段。

import type {
  ContextSourcePort,
  ExecutionPort,
  FileSystemPort,
  HttpClientPort,
  SkillPort,
  TraceContext,
} from "@acode/contracts";
import type { ACodeToolExecResource } from "@acode/shared";
import type { EffectiveModelSelectionResult, ModelSelection } from "@acode/shared/model-selection";

/**
 * 统一用户执行边界准备（spec 规则 1）：首次真实用户执行 / cold-resume fallback 前
 * 由宿主完成一次性准备。全仓唯一定义在此；bootstrap `app/types.ts` re-export 本类型，
 * 既有消费面（input-facade / session-facade / workflow facades / create-app）形状不变。
 */
export type PrepareUserExecutionBoundary = (options?: {
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
}) => Promise<void>;

/**
 * Script Workflow child runtime 实际读取的宿主配置窄面（spec 规则 2）。
 * 只声明 `script-workflow-child-runtime.ts` 消费的字段（contextSourcePort/env/
 * executionPort/fileSystemPort/httpClientPort/onToolExecResource/
 * resolveEffectiveModelSelection/skillPort）；bootstrap 的 `ACodeAppOptions`
 * 必须保持可赋值（结构化兼容）。
 */
export interface ScriptWorkflowHostOptions {
  contextSourcePort?: ContextSourcePort;
  env?: NodeJS.ProcessEnv;
  executionPort?: ExecutionPort;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  /** 资源遥测旁路；由协议宿主注入，主任务和 workflow 的执行适配器共用。 */
  onToolExecResource?: (sample: ACodeToolExecResource) => void;
  resolveEffectiveModelSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  skillPort?: SkillPort;
}
