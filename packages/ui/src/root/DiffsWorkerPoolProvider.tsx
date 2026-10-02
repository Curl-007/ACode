import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  WorkerPoolContext,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import {
  getOrCreateWorkerPoolSingleton,
  terminateWorkerPoolSingleton,
  type SetupWorkerPoolProps,
  type WorkerPoolManager,
} from "@pierre/diffs/worker";
import { createDiffsWorkerHighlighterOptions } from "@/lib/diffsHighlighterEngine.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";
import { logger } from "@/logger.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/store/index.js";
import { useACodeStore } from "@/store/StoreProvider.js";

function createDiffsWorker(): Worker {
  return new Worker(new URL("../workers/diffs.worker.ts", import.meta.url), {
    type: "module",
    name: "acode-diffs-worker",
  });
}

function resolveWorkerPoolSize(): number {
  if (typeof navigator === "undefined") {
    return 2;
  }

  const hardwareConcurrency = navigator.hardwareConcurrency;
  if (!Number.isFinite(hardwareConcurrency) || hardwareConcurrency <= 0) {
    return 2;
  }

  return Math.max(1, Math.min(4, Math.floor(hardwareConcurrency / 2)));
}

/**
 * Diffs worker 池懒启动状态机(spec `renderer-memory-budget.md` 规则 6 / 所有者表「Diffs worker 池」行)。
 *
 * 背景:`WorkerPoolManager` 的构造函数尾部就会 `queueInitialization()` 一次性 spawn 整个
 * worker 池(每个 worker 含 828KB bundle + shiki 引擎,冷启动实测多占 16-32MB 进程内存),
 * 而绝大多数启动会话在首个 diff 渲染前完全不需要它们。因此不再在 Root 挂载时创建池,
 * 而是把「物化真实池」收敛到本控制器,由首个 diff 渲染触发;创建逻辑通过工厂注入,
 * 单测用 stub 即可验证「未触发前不初始化、触发一次后幂等」。
 */
export interface DiffsWorkerPoolLazyController {
  /** 幂等物化:未创建则同步创建,已创建直接复用。物化失败返回 undefined 且不缓存失败,可重试。 */
  materializeDiffsWorkerPool(): WorkerPoolManager | undefined;
  /**
   * 异步幂等入口,渲染组件在 effect 首次调用渲染 API 之前 await;永不 reject,
   * 失败只返回 undefined,由调用方回落主线程路径。
   */
  ensureDiffsWorkers(): Promise<WorkerPoolManager | undefined>;
  getMaterializedDiffsWorkerPool(): WorkerPoolManager | undefined;
  isDiffsWorkerPoolMaterialized(): boolean;
  /** 终止并重置状态,下一次物化会重新创建池。 */
  terminateDiffsWorkerPool(): void;
  /** 订阅物化完成事件;订阅时若已物化则立即回调一次。 */
  subscribeToDiffsWorkerPoolMaterialization(
    listener: (manager: WorkerPoolManager) => void,
  ): () => void;
}

export interface DiffsWorkerPoolLazyControllerDeps {
  /** 创建真实池(manager 构造即 spawn 全部 worker,生产实现为 `getOrCreateWorkerPoolSingleton`)。 */
  createPoolManager: () => WorkerPoolManager;
  /** 终止池;缺省直接调 `manager.terminate()`。 */
  terminatePoolManager?: (manager: WorkerPoolManager) => void;
  /** 物化/终止失败时的上报钩子;缺省静默(诊断路径不能影响渲染)。 */
  onControllerError?: (error: unknown) => void;
}

export function createDiffsWorkerPoolLazyController(
  deps: DiffsWorkerPoolLazyControllerDeps,
): DiffsWorkerPoolLazyController {
  let materialized: WorkerPoolManager | undefined;
  const materializedListeners = new Set<(manager: WorkerPoolManager) => void>();

  function materializeDiffsWorkerPool(): WorkerPoolManager | undefined {
    if (materialized) {
      return materialized;
    }

    try {
      materialized = deps.createPoolManager();
    } catch (error) {
      deps.onControllerError?.(error);
      return undefined;
    }

    for (const listener of materializedListeners) {
      listener(materialized);
    }
    return materialized;
  }

  function ensureDiffsWorkers(): Promise<WorkerPoolManager | undefined> {
    // 物化本身同步完成(构造即 spawn);包成 promise 供 effect await,
    // 重复调用命中同一份物化结果,不产生第二次 spawn。
    return Promise.resolve(materializeDiffsWorkerPool());
  }

  function terminateDiffsWorkerPool(): void {
    const manager = materialized;
    materialized = undefined;
    if (!manager) {
      return;
    }
    try {
      if (deps.terminatePoolManager) {
        deps.terminatePoolManager(manager);
      } else {
        manager.terminate();
      }
    } catch (error) {
      deps.onControllerError?.(error);
    }
  }

  function subscribeToDiffsWorkerPoolMaterialization(
    listener: (manager: WorkerPoolManager) => void,
  ): () => void {
    materializedListeners.add(listener);
    // 已物化:让晚注册的订阅者(如 Provider 后挂载)立即拿到当前池。
    if (materialized) {
      listener(materialized);
    }
    return () => {
      materializedListeners.delete(listener);
    };
  }

  return {
    materializeDiffsWorkerPool,
    ensureDiffsWorkers,
    getMaterializedDiffsWorkerPool: () => materialized,
    isDiffsWorkerPoolMaterialized: () => materialized != null,
    terminateDiffsWorkerPool,
    subscribeToDiffsWorkerPoolMaterialization,
  };
}

/**
 * 物化时要传给池的配置(poolOptions + 主题)。Provider 每次渲染刷新;
 * 首个 diff 渲染一定晚于 Provider 首渲染,物化时读到的即当前主题。
 */
let latestDiffsWorkerPoolSetupProps: SetupWorkerPoolProps | undefined;

const diffsWorkerPoolController = createDiffsWorkerPoolLazyController({
  createPoolManager: () => {
    const setupProps = latestDiffsWorkerPoolSetupProps;
    if (!setupProps) {
      throw new Error("DiffsWorkerPoolProvider: worker pool materialized before provider render");
    }
    return getOrCreateWorkerPoolSingleton(setupProps);
  },
  // 与库内单例一起清理:terminateWorkerPoolSingleton 会终止并释放模块级单例,
  // Provider 重新挂载后下一次物化重建整池。
  terminatePoolManager: () => {
    terminateWorkerPoolSingleton();
  },
  onControllerError: (error) => {
    logger.warn("[DiffsWorkerPoolProvider] 物化/终止 worker 池失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  },
});

/**
 * 幂等 ensure:渲染组件在首个 diff 渲染前 await。冷启动 worker 池多占 16-32MB
 * (4 worker × 828KB bundle + shiki 引擎),只应由首个真正需要 diff 的路径触发。
 */
export const ensureDiffsWorkers = diffsWorkerPoolController.ensureDiffsWorkers;

// 诊断(spec 规则 1 / 所有者表「Diffs worker 池」行):暴露池是否已初始化,
// 60s 采样曲线应显示懒启动前恒为 0、首个 diff 渲染后翻转为 1 并保持平台。
uiMemoryDiagnosticsRegistry.register("diffsWorkerPool", () => ({
  initialized: diffsWorkerPoolController.isDiffsWorkerPoolMaterialized() ? 1 : 0,
}));

/**
 * 惰性池代理:放进 `WorkerPoolContext` 的值。@pierre/diffs 的渲染实例
 * (File / FileDiff / UnresolvedFile)只在首个 diff/file 渲染时才会调用池方法,
 * Proxy 把第一次方法访问转换为真实池的物化——应用挂载阶段零调用即零 spawn,
 * 且无需改动 diff-viewer / code-viewer 等消费入口。
 */
function createLazyDiffsWorkerPoolManager(): WorkerPoolManager {
  return new Proxy({} as WorkerPoolManager, {
    get(_target, property) {
      const manager = diffsWorkerPoolController.materializeDiffsWorkerPool();
      if (!manager) {
        // 物化失败(如 Worker 构造抛错):返回 undefined 让 `isWorkingPool() !== true`
        // 判定走 @pierre/diffs 内建的主线程兜底渲染,不额外抛错。
        return undefined;
      }
      const value: unknown = (manager as unknown as Record<string | symbol, unknown>)[property];
      return typeof value === "function" ? value.bind(manager) : value;
    },
  });
}

function useMaterializedDiffsWorkerPool(): WorkerPoolManager | undefined {
  const [manager, setManager] = useState<WorkerPoolManager | undefined>(() =>
    diffsWorkerPoolController.getMaterializedDiffsWorkerPool(),
  );

  useEffect(
    () => diffsWorkerPoolController.subscribeToDiffsWorkerPoolMaterialization(setManager),
    [],
  );

  return manager;
}

function WorkerRenderOptionsSync({
  highlighterOptions,
}: {
  highlighterOptions: WorkerInitializationRenderOptions;
}) {
  // 注意:这里订阅的是「已物化的真实池」,而不是 context 里的惰性代理。
  // setRenderOptions 内部会强制 initialize,若在挂载期对代理调用,
  // 懒启动会被挂载 effect 立即击穿(旧实现的根因)。
  const workerPool = useMaterializedDiffsWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    void workerPool
      .setRenderOptions({
        theme: highlighterOptions.theme,
        lineDiffType: highlighterOptions.lineDiffType,
        maxLineDiffLength: highlighterOptions.maxLineDiffLength,
        tokenizeMaxLineLength: highlighterOptions.tokenizeMaxLineLength,
        useTokenTransformer: highlighterOptions.useTokenTransformer,
      })
      .catch((error: unknown) => {
        logger.warn("[DiffsWorkerPoolProvider] 同步渲染参数失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [highlighterOptions, workerPool]);

  return null;
}

/** 对齐 @pierre/diffs 原版 `WorkerPoolContextProvider` 的卸载语义:最后一个实例卸载时终止池。 */
let diffsWorkerPoolProviderMountCount = 0;

export function DiffsWorkerPoolProvider({ children }: { children: ReactNode }) {
  const codePreviewSettings = useACodeStore(
    (state) => state.codePreviewSettings ?? DEFAULT_CODE_PREVIEW_SETTINGS,
  );

  const highlighterOptions = useMemo<WorkerInitializationRenderOptions>(
    () =>
      createDiffsWorkerHighlighterOptions({
        lightTheme: codePreviewSettings.lightTheme,
        darkTheme: codePreviewSettings.darkTheme,
      }),
    [codePreviewSettings.darkTheme, codePreviewSettings.lightTheme],
  );

  const poolSize = useMemo(() => resolveWorkerPoolSize(), []);
  const canUseWorkerPool = typeof window !== "undefined" && typeof Worker !== "undefined";

  const poolOptions = useMemo<WorkerPoolOptions>(
    () => ({
      workerFactory: createDiffsWorker,
      poolSize,
    }),
    [poolSize],
  );

  // 惰性代理保持引用稳定:context 值变化会让整棵消费子树重渲染。
  const lazyWorkerPool = useMemo(() => createLazyDiffsWorkerPoolManager(), []);

  // 渲染期间刷新物化配置:值来自 store(当前主题等),幂等且无 DOM 副作用;
  // 首个 diff 渲染(以及其触发的物化)必然晚于本组件的首次渲染。
  if (canUseWorkerPool) {
    latestDiffsWorkerPoolSetupProps = { poolOptions, highlighterOptions };
  }

  useEffect(() => {
    diffsWorkerPoolProviderMountCount += 1;
    return () => {
      diffsWorkerPoolProviderMountCount -= 1;
      if (diffsWorkerPoolProviderMountCount === 0) {
        diffsWorkerPoolController.terminateDiffsWorkerPool();
      }
    };
  }, []);

  if (!canUseWorkerPool) {
    return <>{children}</>;
  }

  return (
    <WorkerPoolContext.Provider value={lazyWorkerPool}>
      <WorkerRenderOptionsSync highlighterOptions={highlighterOptions} />
      {children}
    </WorkerPoolContext.Provider>
  );
}
