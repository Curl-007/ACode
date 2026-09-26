import {
  ProviderConfigService,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@acode/provider";
import { NodeACodeBuiltinProviderConfigSource } from "./acode-builtin-provider-config-source.js";
import {
  EndpointScopedACodeBuiltinSource,
  type EndpointScopedACodeBuiltinSourceOptions,
} from "./endpoint-scoped-acode-builtin-source.js";
import {
  ACodeBuiltinRemoteSynchronizer,
  type ACodeBuiltinRemoteSynchronizerOptions,
  type ACodeBuiltinRefreshResult,
} from "./acode-builtin-remote-synchronizer.js";
import {
  NodePersonalProviderConfigRepository,
  type PersonalProviderConfigRecoveryEvent,
} from "./personal-provider-config-repository.js";

export interface NodeProviderConfigRuntimeOptions {
  readonly acodeBuiltinFilePath: string;
  readonly acodeBuiltinActiveFilePath?: string;
  readonly acodeBuiltinRemote?: Omit<ACodeBuiltinRemoteSynchronizerOptions, "source">;
  readonly acodeBuiltinEnvironment?: Omit<
    EndpointScopedACodeBuiltinSourceOptions,
    "bundledFilePath"
  >;
  readonly onACodeBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly importLegacy?: (
    acodeBuiltin: ProviderConfigLayerSnapshot,
  ) => Promise<ProviderConfigLayerUpdate | null>;
  readonly watch?: boolean;
}

/** 组装一个 Node.js 进程内共享的 ACode Built-in/Personal Config 运行边界。 */
export class NodeProviderConfigRuntime {
  readonly configService: ProviderConfigService;
  readonly #acodeBuiltinSource:
    | NodeACodeBuiltinProviderConfigSource
    | EndpointScopedACodeBuiltinSource;
  readonly #personalRepository: NodePersonalProviderConfigRepository;
  readonly #remoteSynchronizer?: ACodeBuiltinRemoteSynchronizer;
  readonly #onRemoteRefreshError?: (error: unknown) => void;
  #startPromise: Promise<void> | null = null;
  #disposed = false;
  readonly #checkListeners = new Set<() => Promise<void>>();
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #checkInFlight: Promise<void> | null = null;

  constructor(options: NodeProviderConfigRuntimeOptions) {
    this.#acodeBuiltinSource = options.acodeBuiltinEnvironment
      ? new EndpointScopedACodeBuiltinSource({
          bundledFilePath: options.acodeBuiltinFilePath,
          ...options.acodeBuiltinEnvironment,
        })
      : new NodeACodeBuiltinProviderConfigSource({
          bundledFilePath: options.acodeBuiltinFilePath,
          activeFilePath: options.acodeBuiltinActiveFilePath,
          watch: options.watch,
        });
    this.#remoteSynchronizer =
      options.acodeBuiltinRemote &&
      this.#acodeBuiltinSource instanceof NodeACodeBuiltinProviderConfigSource
        ? new ACodeBuiltinRemoteSynchronizer({
            source: this.#acodeBuiltinSource,
            ...options.acodeBuiltinRemote,
          })
        : undefined;
    this.#onRemoteRefreshError = options.onACodeBuiltinRefreshError;
    this.#personalRepository = new NodePersonalProviderConfigRepository({
      filePath: options.personalFilePath,
      onRecovery: options.onPersonalConfigRecovery,
      onPollingError: options.onPersonalConfigPollingError,
      pollingIntervalMs: options.personalPollingIntervalMs,
      ...(options.importLegacy
        ? {
            importLegacy: async () => options.importLegacy!(await this.#acodeBuiltinSource.read()),
          }
        : {}),
    });
    this.configService = new ProviderConfigService({
      acodeBuiltinSource: this.#acodeBuiltinSource,
      personalRepository: this.#personalRepository,
    });
  }

  resolveACodeBuiltinActiveFilePath(): Promise<string> {
    return this.#acodeBuiltinSource instanceof NodeACodeBuiltinProviderConfigSource
      ? Promise.resolve(this.#acodeBuiltinSource.activeFilePath)
      : this.#acodeBuiltinSource.resolveActiveFilePath();
  }

  get personalRepository(): import("@acode/provider").PersonalProviderConfigRepository {
    return this.#personalRepository;
  }

  /** Environment 同一周期检查中恢复未对齐依赖，不被下载 TTL 或失败挡住。 */
  onDidCheckACodeBuiltin(listener: () => Promise<void>): () => void {
    this.#checkListeners.add(listener);
    return () => this.#checkListeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.#disposed) throw new Error("NodeProviderConfigRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    const startPromise = this.configService.read().then(() => {
      if (this.#disposed) return;
      void this.#checkBackground();
      // Managed Worker 无下载配置也无恢复 owner，不建立周期任务。
      if (
        this.#remoteSynchronizer ||
        this.#acodeBuiltinSource instanceof EndpointScopedACodeBuiltinSource ||
        this.#checkListeners.size > 0
      ) {
        this.#checkTimer = setInterval(() => {
          void this.#checkBackground();
        }, 60_000);
        this.#checkTimer.unref?.();
      }
    });
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  refreshACodeBuiltin(options?: { readonly force?: boolean }): Promise<ACodeBuiltinRefreshResult> {
    if (this.#disposed) return Promise.resolve("disposed");
    if (this.#acodeBuiltinSource instanceof EndpointScopedACodeBuiltinSource) {
      return this.#acodeBuiltinSource.refresh(options);
    }
    return this.#remoteSynchronizer?.refresh(options) ?? Promise.resolve("skipped");
  }

  #checkBackground(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#checkInFlight) return this.#checkInFlight;
    const check = Promise.allSettled([
      this.refreshACodeBuiltin(),
      ...[...this.#checkListeners].map((listener) => Promise.resolve().then(listener)),
    ])
      .then((results) => {
        if (this.#disposed) return;
        for (const result of results)
          if (result.status === "rejected") this.#onRemoteRefreshError?.(result.reason);
      })
      .finally(() => {
        if (this.#checkInFlight === check) this.#checkInFlight = null;
      });
    this.#checkInFlight = check;
    return check;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#checkTimer = null;
    this.#checkListeners.clear();
    this.#remoteSynchronizer?.dispose();
    this.configService.dispose();
    this.#personalRepository.dispose();
    this.#acodeBuiltinSource.dispose();
  }
}

export function createNodeProviderConfigRuntime(
  options: NodeProviderConfigRuntimeOptions,
): NodeProviderConfigRuntime {
  return new NodeProviderConfigRuntime(options);
}
