import type { SubmitPromptOptions, ACodeApp } from "./types.js";
import type { ScriptWorkflowStorePort } from "@acode/contracts";
import {
  isScriptWorkflowStore,
  reconcileOrphanScriptWorkflowRuns,
  ScriptWorkflowRuntime,
  createScriptWorkflowToolPort,
  type ScriptWorkflowRuntimeDeps,
} from "@acode/cli-workflow/contract";

type ScriptWorkflowFacade = Pick<
  ACodeApp,
  | "listScriptWorkflows"
  | "resumeWorkflowScript"
  | "runWorkflowScript"
  | "scriptWorkflowStatus"
  | "validateWorkflowScript"
>;

interface ScriptWorkflowBridge extends ScriptWorkflowFacade {
  workflowPort: ReturnType<typeof createScriptWorkflowToolPort>;
}

type ScriptWorkflowBridgeDeps = Omit<ScriptWorkflowRuntimeDeps, "runtime"> & {
  getRuntime: () => ScriptWorkflowRuntimeDeps["runtime"];
};

type ScriptWorkflowRuntimeOptions = Pick<SubmitPromptOptions, "abortSignal" | "traceContext"> & {
  onEvent?: (event: unknown) => void | Promise<void>;
};

export function createScriptWorkflowBridge(deps: ScriptWorkflowBridgeDeps): ScriptWorkflowBridge {
  // 构造期收敛本会话的孤儿 run（与 dwf 的 reconcileOrphanRuns 同一个时机、同一套边界，
  // 理由与三条纪律见 script-workflow-reconcile.ts 文件头）。
  //
  // 这里是**发射后不管**：桥的构造是同步的，而 store 是异步的，等它会把一次 app 构造
  // 变成一次数据库往返。安全的前提有两条，缺一条都不成立：
  //   1. 那个函数自己把查询失败与单行写失败全部 catch 成 warn，永不 reject，
  //      所以不会有未处理的 promise 拒绝；
  //   2. 冷回放**不依赖收敛已经跑完**——它按行铸造结算，而行的状态词非终态时一律归到
  //      interrupted（script-workflow-replay.ts 的 settleEventTypeForRow）。
  //      于是「收敛前回放」与「收敛后回放」得到同一个投影状态，竞态是良性的。
  const ownerToken = deps.ownerToken ?? crypto.randomUUID();
  const ownerReady = deps.ownerReady ??
    (isScriptWorkflowStore(deps.sessionStore) && deps.sessionStore.claimWorkflowSessionOwner
      ? deps.sessionStore
          .claimWorkflowSessionOwner({ ownerToken, parentSessionId: deps.sessionId })
          .then((lease) =>
            lease === null
              ? null
              : { ownerGeneration: lease.ownerGeneration, ownerToken: lease.ownerToken },
          )
          .catch((error) => {
            deps.logger?.warn?.("Script workflow owner lease claim failed", {
              errorMessage: error instanceof Error ? error.message : String(error),
              event: "script_workflow.owner.claim_failed",
              module: "bootstrap.app",
            });
            return null;
          })
      : Promise.resolve(undefined));
  if (isScriptWorkflowStore(deps.sessionStore)) {
    void ownerReady.then((owner) => {
      // A foreign active owner must never be reconciled by this process.
      if (owner === null) return;
      void reconcileOrphanScriptWorkflowRuns({
        logger: deps.logger,
        parentSessionId: deps.sessionId,
        store: deps.sessionStore as unknown as ScriptWorkflowStorePort,
        ...(owner === undefined ? {} : owner),
      });
    });
  }

  let runtime: ScriptWorkflowRuntime | undefined;
  const getRuntime = () => {
    runtime ??= new ScriptWorkflowRuntime({
      ...deps,
      ownerReady,
      runtime: deps.getRuntime(),
    });
    return runtime;
  };
  return {
    listScriptWorkflows: (input) => getRuntime().list(input),
    resumeWorkflowScript: (input, options) => getRuntime().resume(input, toRuntimeOptions(options)),
    runWorkflowScript: (input, options) => getRuntime().run(input, toRuntimeOptions(options)),
    scriptWorkflowStatus: (input) => getRuntime().status(input),
    validateWorkflowScript: (input) => getRuntime().validate(input),
    workflowPort: createScriptWorkflowToolPort({
      fileSystemPort: deps.fileSystemPort,
      getRuntime,
      logger: deps.logger,
      sessionId: deps.sessionId,
      sessionStore: deps.sessionStore,
      remoteSessionId: deps.remoteSessionId,
      storageRoot: deps.storageRoot,
      traceContext: deps.traceContext,
      workspaceIdentity: deps.workspaceIdentity,
      workingDirectory: deps.workingDirectory,
    }),
  };
}

function createScriptWorkflowFacade(runtime: ScriptWorkflowRuntime): ScriptWorkflowFacade {
  return {
    listScriptWorkflows: runtime.list.bind(runtime),
    resumeWorkflowScript: (input, options) => runtime.resume(input, toRuntimeOptions(options)),
    runWorkflowScript: (input, options) => runtime.run(input, toRuntimeOptions(options)),
    scriptWorkflowStatus: runtime.status.bind(runtime),
    validateWorkflowScript: runtime.validate.bind(runtime),
  };
}

function toRuntimeOptions(
  options: Parameters<NonNullable<ACodeApp["runWorkflowScript"]>>[1],
): ScriptWorkflowRuntimeOptions | undefined {
  if (!options) return undefined;
  return {
    abortSignal: options.abortSignal,
    onEvent: options.onEvent as ((event: unknown) => void | Promise<void>) | undefined,
    traceContext: options.traceContext,
  };
}
