import {
  ProviderRegistryService,
  MutableAccountProviderConfigSource,
  createFailClosedAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type ProviderSource,
} from "@acode/provider";
import {
  NodeProviderConfigRuntime,
  type NodeProviderConfigRuntimeOptions,
} from "./provider-config-runtime.js";

export interface NodeProviderRegistryRuntimeOptions extends NodeProviderConfigRuntimeOptions {
  readonly accountSource?: ProviderSource<AccountProviderConfigSnapshot>;
  readonly createAccountSource?: (
    configService: NodeProviderConfigRuntime["configService"],
  ) => ProviderSource<AccountProviderConfigSnapshot>;
}

/** 一个 Node.js 进程内共享的 Config + Registry 生命周期。 */
export class NodeProviderRegistryRuntime {
  readonly configService: NodeProviderConfigRuntime["configService"];
  readonly registryService: ProviderRegistryService;
  readonly #configRuntime: NodeProviderConfigRuntime;
  readonly #accountSource: ProviderSource<AccountProviderConfigSnapshot>;
  #disposed = false;

  constructor(options: NodeProviderRegistryRuntimeOptions) {
    this.#configRuntime = new NodeProviderConfigRuntime(options);
    this.configService = this.#configRuntime.configService;
    this.#accountSource =
      options.createAccountSource?.(this.configService) ??
      options.accountSource ??
      new MutableAccountProviderConfigSource();
    this.registryService = new ProviderRegistryService({
      configSource: this.configService,
      accountSource: this.#accountSource,
      // 安全加固 P1-5：读写两侧必须注入**同一个** vault。options 已 extends
      // NodeProviderConfigRuntimeOptions，故写入侧（repository）自动拿到 providerApiKeyVault；
      // 若这里不透传，则 CLI 会「写了 ref 但永不 hydrate」，BYO provider 在 TUI/Agent 里静默失效。
      ...(options.providerApiKeyVault
        ? { providerApiKeyVault: options.providerApiKeyVault }
        : {}),
    });
  }

  async start(): Promise<void> {
    this.#assertNotDisposed();
    await this.#configRuntime.start();
    if (this.#accountSource instanceof MutableAccountProviderConfigSource) {
      const account = await this.#accountSource.read();
      if (account.basedOnACodeBuiltinRevision === "uninitialized") {
        this.#accountSource.replace(
          createFailClosedAccountProviderConfigSnapshot(await this.configService.read()),
          "initial-fail-closed",
        );
      }
    }
    return this.registryService.start();
  }

  get personalRepository(): NodeProviderConfigRuntime["personalRepository"] {
    return this.#configRuntime.personalRepository;
  }

  onDidCheckACodeBuiltin(listener: () => Promise<void>): () => void {
    return this.#configRuntime.onDidCheckACodeBuiltin(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.registryService.dispose();
    this.#configRuntime.dispose();
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodeProviderRegistryRuntime 已 dispose");
  }
}

export function createNodeProviderRegistryRuntime(
  options: NodeProviderRegistryRuntimeOptions,
): NodeProviderRegistryRuntime {
  return new NodeProviderRegistryRuntime(options);
}
