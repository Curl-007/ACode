import type { ModelId, ProviderId } from "./config/index.js";
import {
  ProviderRegistry,
  type ModelSelection,
  type ModelSelectionValidation,
  type ProviderRegistryView,
} from "./registry.js";
import {
  ProviderConfigResolver,
  type ProviderConfigResolution,
  type Provider,
  type ProviderModel,
} from "./resolver.js";
import type {
  AccountProviderConfigSnapshot,
  ProviderConfigSnapshot,
  ProviderSource,
} from "./sources.js";
import {
  hydrateProviderConfigCredentialRefs,
  type ProviderApiKeyVault,
} from "./provider-api-key-vault.js";

export interface ProviderRegistryServiceSnapshot {
  readonly sourceRevisions: {
    readonly config: string;
    readonly account: string;
  };
  readonly config: ProviderConfigSnapshot;
  readonly account: AccountProviderConfigSnapshot;
  readonly resolution: ProviderConfigResolution;
  readonly registry: ProviderRegistryView;
}

export interface ProviderRegistryServiceChangedEvent {
  readonly snapshot: ProviderRegistryServiceSnapshot;
  readonly reasons: readonly string[];
}

export interface ProviderRegistryServiceRefreshErrorEvent {
  readonly error: unknown;
  readonly reasons: readonly string[];
}

export interface ProviderRegistryServiceDependencies {
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
  readonly accountSource: ProviderSource<AccountProviderConfigSnapshot>;
  readonly resolver?: ProviderConfigResolver;
  /**
   * BYO Provider API Key 的加密凭据库（安全加固 P1-5）。可选：未注入时 credentialRef 不 hydrate，
   * 文件里的明文 apiKey 照读（安全空操作，兼容纯 builtin / 测试 / 凭据库不可用）。
   * 由 services（桌面 host）或 CLI 注入，provider 不反向依赖它们。
   */
  readonly providerApiKeyVault?: ProviderApiKeyVault;
}

interface RefreshWaiter {
  readonly generation: number;
  readonly resolve: (snapshot: ProviderRegistryServiceSnapshot) => void;
  readonly reject: (error: unknown) => void;
}

export class ProviderRegistryService {
  readonly #configSource: ProviderSource<ProviderConfigSnapshot>;
  readonly #accountSource: ProviderSource<AccountProviderConfigSnapshot>;
  readonly #resolver: ProviderConfigResolver;
  readonly #providerApiKeyVault: ProviderApiKeyVault | undefined;
  readonly #registry = new ProviderRegistry();
  readonly #changeListeners = new Set<(event: ProviderRegistryServiceChangedEvent) => void>();
  readonly #errorListeners = new Set<(event: ProviderRegistryServiceRefreshErrorEvent) => void>();
  readonly #sourceDisposers: Array<() => void> = [];
  readonly #pendingReasons = new Set<string>();
  readonly #refreshWaiters: RefreshWaiter[] = [];
  #snapshot: ProviderRegistryServiceSnapshot | null = null;
  #requestedGeneration = 0;
  #completedGeneration = 0;
  #refreshInFlight: Promise<void> | null = null;
  #started = false;
  #disposed = false;

  constructor(dependencies: ProviderRegistryServiceDependencies) {
    this.#configSource = dependencies.configSource;
    this.#accountSource = dependencies.accountSource;
    this.#resolver = dependencies.resolver ?? new ProviderConfigResolver();
    this.#providerApiKeyVault = dependencies.providerApiKeyVault;
  }

  async start(): Promise<void> {
    this.#assertNotDisposed();
    if (!this.#started) {
      this.#started = true;
      this.#sourceDisposers.push(
        this.#configSource.onDidChange((reason) => this.#refreshFromSource("config", reason)),
        this.#accountSource.onDidChange((reason) => this.#refreshFromSource("account", reason)),
      );
      await this.#requestRefresh("start");
      return;
    }
    // 启动只负责就绪；业务读取必须使用 getSnapshot，不能长期保留首次启动快照。
    if (!this.#snapshot) await this.#requestRefresh("start");
  }

  refresh(reason = "explicit"): Promise<ProviderRegistryServiceSnapshot> {
    this.#assertNotDisposed();
    if (!this.#started) throw new Error("ProviderRegistryService 必须先 start() 再 refresh()");
    return this.#requestRefresh(reason);
  }

  getSnapshot(): ProviderRegistryServiceSnapshot | null {
    return this.#snapshot;
  }

  getView(): ProviderRegistryView {
    return this.#registry.getView();
  }

  listProviders(): readonly Provider[] {
    return this.#registry.listProviders();
  }

  getProvider(providerId: ProviderId): Provider | undefined {
    return this.#registry.getProvider(providerId);
  }

  getModel(providerId: ProviderId, modelId: ModelId): ProviderModel | undefined {
    return this.#registry.getModel(providerId, modelId);
  }

  validateSelection(selection: ModelSelection): ModelSelectionValidation {
    return this.#registry.validateSelection(selection);
  }

  onDidChange(listener: (event: ProviderRegistryServiceChangedEvent) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  onDidRefreshError(
    listener: (event: ProviderRegistryServiceRefreshErrorEvent) => void,
  ): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of this.#sourceDisposers.splice(0)) dispose();
    const error = new Error("ProviderRegistryService 已 dispose");
    for (const waiter of this.#refreshWaiters.splice(0)) waiter.reject(error);
    this.#changeListeners.clear();
    this.#errorListeners.clear();
  }

  #refreshFromSource(source: "config" | "account", reason: string): void {
    if (this.#disposed) return;
    void this.#requestRefresh(`${source}:${reason || "changed"}`).catch(() => {
      // Source 驱动的后台刷新通过 onDidRefreshError 报告；调用栈没有 Promise 消费者。
    });
  }

  #requestRefresh(reason: string): Promise<ProviderRegistryServiceSnapshot> {
    const generation = this.#requestedGeneration + 1;
    this.#requestedGeneration = generation;
    this.#pendingReasons.add(reason);
    const result = new Promise<ProviderRegistryServiceSnapshot>((resolve, reject) => {
      this.#refreshWaiters.push({ generation, resolve, reject });
    });
    this.#ensureRefreshLoop();
    return result;
  }

  #ensureRefreshLoop(): void {
    if (this.#refreshInFlight || this.#disposed) return;
    const refresh = this.#runRefreshLoop();
    this.#refreshInFlight = refresh;
    void refresh.then(
      () => this.#finishRefresh(refresh),
      (error: unknown) => {
        this.#rejectRefreshWaiters(this.#requestedGeneration, error);
        this.#finishRefresh(refresh);
      },
    );
  }

  #finishRefresh(refresh: Promise<void>): void {
    if (this.#refreshInFlight !== refresh) return;
    this.#refreshInFlight = null;
    if (this.#completedGeneration < this.#requestedGeneration) this.#ensureRefreshLoop();
  }

  async #runRefreshLoop(): Promise<void> {
    const reasons = new Set<string>();
    while (this.#completedGeneration < this.#requestedGeneration) {
      const generation = this.#requestedGeneration;
      for (const reason of this.#pendingReasons) reasons.add(reason);
      this.#pendingReasons.clear();

      let config: ProviderConfigSnapshot;
      let account: AccountProviderConfigSnapshot;
      try {
        [config, account] = await Promise.all([
          this.#configSource.read(),
          this.#accountSource.read(),
        ]);
      } catch (error) {
        if (generation < this.#requestedGeneration) continue;
        this.#completedGeneration = generation;
        this.#emitRefreshError(error, reasons);
        this.#rejectRefreshWaiters(generation, error);
        return;
      }

      if (generation < this.#requestedGeneration) continue;
      this.#assertNotDisposed();

      if (account.basedOnACodeBuiltinRevision !== config.acodeBuiltinRevision) {
        // Built-in 已变化但 Account 仍基于旧事实时，继续服务上一份完整 Registry。
        // 当前 generation 结束；等待 Account Source 的后续 change 再一次性发布最终组合。
        this.#completedGeneration = generation;
        if (this.#snapshot) this.#resolveRefreshWaiters(generation, this.#snapshot);
        reasons.clear();
        continue;
      }

      if (this.#hasSameSourceRevisions(config, account)) {
        this.#completedGeneration = generation;
        this.#resolveRefreshWaiters(generation, this.#snapshot!);
        reasons.clear();
        continue;
      }

      try {
        // 安全加固 P1-5：把 BYO provider 的 credentialRef 经凭据库 hydrate 回明文 apiKey。
        // 只喂给下面的 resolve()；**snapshot 仍存 ref 形态**——revision = sha256(encode(磁盘内容))，
        // 且 providerProvisioningSource.readProvisionablePersonalConfig 会重算磁盘 hash 并断言
        // 等于 revision。若把 hydrate 后的明文回灌进 snapshot，磁盘与 snapshot 就不一致，
        // 远程 provisioning 会抛「配置在读取期间发生变化」，且每次轮询都会误判变化并重写文件。
        //
        // hydrate 内部已对单个 provider 的凭据失败做了隔离（保留原 access、不抛错）；这里再包一层
        // 兜底：凭据库整体异常时退回未 hydrate 的 providers，宁可暂时用不到明文 Key，
        // 也不能让整个 registry 停止刷新（那会让所有 provider 当场失效）。
        let hydratedPersonalProviders = config.personalProviders;
        try {
          hydratedPersonalProviders = await hydrateProviderConfigCredentialRefs(
            config.personalProviders,
            this.#providerApiKeyVault,
          );
        } catch {
          hydratedPersonalProviders = config.personalProviders;
        }
        // hydrate 是新增的 await 点：期间 generation 可能已前进，此时不再发布这份过期组合，
        // 交由 while 循环按更新的 generation 重来（与上面读取 config/account 后的判定同源）。
        if (generation < this.#requestedGeneration) continue;

        const resolution = this.#resolver.resolve({
          acodeBuiltinProviders: config.acodeBuiltinProviders,
          acodeBuiltinProviderTemplates: config.acodeBuiltinProviderTemplates,
          personalProviders: hydratedPersonalProviders,
          acodeBuiltinModelRules: config.acodeBuiltinModelRules,
          personalModels: config.personalModels,
          accountProviders: account.providers,
          accountStates: account.states,
          personalProviderOrder: config.personalProviderOrder,
        });
        this.#registry.replace(resolution.registryProviders, [...reasons].join(","));
        const snapshot = Object.freeze({
          sourceRevisions: Object.freeze({
            config: config.revision,
            account: account.revision,
          }),
          config: Object.freeze({ ...config }),
          account: freezeAccountSnapshot(account),
          resolution,
          registry: this.#registry.getView(),
        });
        this.#snapshot = snapshot;
        this.#completedGeneration = generation;
        this.#resolveRefreshWaiters(generation, snapshot);
        this.#emitChanged(snapshot, reasons);
        reasons.clear();
      } catch (error) {
        this.#completedGeneration = generation;
        this.#emitRefreshError(error, reasons);
        this.#rejectRefreshWaiters(generation, error);
        return;
      }
    }
  }

  #resolveRefreshWaiters(generation: number, snapshot: ProviderRegistryServiceSnapshot): void {
    const remaining: RefreshWaiter[] = [];
    for (const waiter of this.#refreshWaiters) {
      if (waiter.generation <= generation) waiter.resolve(snapshot);
      else remaining.push(waiter);
    }
    this.#refreshWaiters.splice(0, this.#refreshWaiters.length, ...remaining);
  }

  #rejectRefreshWaiters(generation: number, error: unknown): void {
    const remaining: RefreshWaiter[] = [];
    for (const waiter of this.#refreshWaiters) {
      if (waiter.generation <= generation) waiter.reject(error);
      else remaining.push(waiter);
    }
    this.#refreshWaiters.splice(0, this.#refreshWaiters.length, ...remaining);
  }

  #hasSameSourceRevisions(
    config: ProviderConfigSnapshot,
    account: AccountProviderConfigSnapshot,
  ): boolean {
    return (
      this.#snapshot?.sourceRevisions.config === config.revision &&
      this.#snapshot.sourceRevisions.account === account.revision
    );
  }

  #emitChanged(snapshot: ProviderRegistryServiceSnapshot, reasons: ReadonlySet<string>): void {
    const event = Object.freeze({
      snapshot,
      reasons: Object.freeze([...reasons]),
    });
    for (const listener of this.#changeListeners) listener(event);
  }

  #emitRefreshError(error: unknown, reasons: ReadonlySet<string>): void {
    const event = Object.freeze({
      error,
      reasons: Object.freeze([...reasons]),
    });
    for (const listener of this.#errorListeners) listener(event);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("ProviderRegistryService 已 dispose");
  }
}

function freezeAccountSnapshot(
  snapshot: AccountProviderConfigSnapshot,
): AccountProviderConfigSnapshot {
  return Object.freeze({
    revision: snapshot.revision,
    basedOnACodeBuiltinRevision: snapshot.basedOnACodeBuiltinRevision,
    providers: snapshot.providers,
    ...(snapshot.states ? { states: snapshot.states } : {}),
  });
}
