import type { SubmitPromptOptions, ACodeApp } from "./types.js";
import type { ScriptWorkflowStorePort } from "@acode/contracts";
import {
  createWorkflowOwnerLeaseManager,
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
  // 桥自己的 fallback（仅 deps.ownerReady 缺席的宿主触发；桌面 wiring 恒传共享 owner）
  // 同样走 lease manager：claim/renew/心跳/惰性重试只有一份实现
  // （specs/workflow-owner-lease.md），这里不再留第二份「一次性 claim 失败即缓存成
  // 进程级判决」的租约逻辑。
  const ownerClaimPort = (() => {
    if (deps.ownerReady !== undefined) return undefined;
    if (!isScriptWorkflowStore(deps.sessionStore)) return undefined;
    const claimMethod = deps.sessionStore.claimWorkflowSessionOwner;
    if (claimMethod === undefined) return undefined;
    const store = deps.sessionStore;
    return (input: { leaseMs?: number; ownerToken: string }) =>
      claimMethod.call(store, {
        ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
        ownerToken: input.ownerToken,
        parentSessionId: deps.sessionId,
      });
  })();
  const fallbackLease =
    ownerClaimPort === undefined
      ? undefined
      : createWorkflowOwnerLeaseManager({
          claim: ownerClaimPort,
          logger: deps.logger,
          ownerToken,
          parentSessionId: deps.sessionId,
        });
  const ownerReady =
    deps.ownerReady ?? fallbackLease?.ownerReady ?? Promise.resolve(undefined);
  // 构造期收敛（script workflow 侧）。claim 失败（null）时跳过并挂起 deferred 标记：
  // 首次 reclaim 成功后补跑一次（spec R5）。安全论证与 dwf 侧构造期收敛相同：
  // 本进程此前从未持有所有权 ⇒ 名下零在飞 script run ⇒ 非终态行只可能是死进程遗物。
  let deferredScriptReconcile = false;
  if (isScriptWorkflowStore(deps.sessionStore)) {
    void ownerReady.then((owner) => {
      // A foreign active owner must never be reconciled by this process.
      if (owner === null) {
        deferredScriptReconcile = true;
        return;
      }
      void reconcileOrphanScriptWorkflowRuns({
        logger: deps.logger,
        parentSessionId: deps.sessionId,
        store: deps.sessionStore as unknown as ScriptWorkflowStorePort,
        ...(owner === undefined ? {} : owner),
      });
    });
  }
  const baseReclaim = deps.ownerReclaim ?? fallbackLease?.reclaim;
  const ownerReclaim =
    baseReclaim === undefined
      ? undefined
      : async () => {
          const owner = await baseReclaim();
          if (owner !== null && owner !== undefined && deferredScriptReconcile) {
            deferredScriptReconcile = false;
            void reconcileOrphanScriptWorkflowRuns({
              logger: deps.logger,
              parentSessionId: deps.sessionId,
              store: deps.sessionStore as unknown as ScriptWorkflowStorePort,
              ...owner,
            });
          }
          return owner;
        };

  let runtime: ScriptWorkflowRuntime | undefined;
  const getRuntime = () => {
    runtime ??= new ScriptWorkflowRuntime({
      ...deps,
      ownerReady,
      ...(ownerReclaim === undefined ? {} : { ownerReclaim }),
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
