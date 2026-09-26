import { join } from "node:path";
import {
  NodeProviderConfigRuntime,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  type PersonalProviderConfigRecoveryEvent,
  type NodeProviderConfigRuntimeOptions,
} from "@acode/provider-node";
import type { ModelProviderConfig } from "./legacyModelProviderSerialized.js";
import { getAppConfigDir } from "../paths.js";
import { importLegacyPersonalProviderConfig } from "./legacyPersonalProviderConfigImporter.js";

export interface ProviderConfigRuntimeOptions {
  readonly acodeBuiltinFilePath: string;
  readonly acodeBuiltinActiveFilePath?: string;
  readonly acodeBuiltinRemote?: NodeProviderConfigRuntimeOptions["acodeBuiltinRemote"];
  readonly acodeBuiltinEnvironment?: NodeProviderConfigRuntimeOptions["acodeBuiltinEnvironment"];
  readonly onACodeBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath?: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly readLegacyProviders?: () => Promise<readonly ModelProviderConfig[]>;
  readonly watch?: boolean;
}

/**
 * Services 装配层：提供 App 配置目录和已发布旧配置的一次性迁移入口。
 * 配置迁移保留 ACode 用户的供应商数据，文件运行时由 @acode/provider-node 唯一实现。
 */
export class ProviderConfigRuntime {
  readonly configService: NodeProviderConfigRuntime["configService"];
  readonly #runtime: NodeProviderConfigRuntime;

  constructor(options: ProviderConfigRuntimeOptions) {
    const runtimeOptions: NodeProviderConfigRuntimeOptions = {
      acodeBuiltinFilePath: options.acodeBuiltinFilePath,
      acodeBuiltinActiveFilePath: options.acodeBuiltinActiveFilePath,
      acodeBuiltinRemote: options.acodeBuiltinRemote,
      acodeBuiltinEnvironment: options.acodeBuiltinEnvironment,
      onACodeBuiltinRefreshError: options.onACodeBuiltinRefreshError,
      onPersonalConfigRecovery: options.onPersonalConfigRecovery,
      onPersonalConfigPollingError: options.onPersonalConfigPollingError,
      personalFilePath:
        options.personalFilePath ?? join(getAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
      personalPollingIntervalMs: options.personalPollingIntervalMs,
      watch: options.watch,
      ...(options.readLegacyProviders
        ? {
            importLegacy: async () =>
              importLegacyPersonalProviderConfig({
                legacyProviders: await options.readLegacyProviders!(),
              }),
          }
        : {}),
    };
    this.#runtime = new NodeProviderConfigRuntime(runtimeOptions);
    this.configService = this.#runtime.configService;
  }

  start(): Promise<void> {
    return this.#runtime.start();
  }

  get personalRepository(): NodeProviderConfigRuntime["personalRepository"] {
    return this.#runtime.personalRepository;
  }

  resolveACodeBuiltinActiveFilePath(): Promise<string> {
    return this.#runtime.resolveACodeBuiltinActiveFilePath();
  }

  refreshACodeBuiltin(options?: { readonly force?: boolean }) {
    return this.#runtime.refreshACodeBuiltin(options);
  }

  onDidCheckACodeBuiltin(listener: () => Promise<void>): () => void {
    return this.#runtime.onDidCheckACodeBuiltin(listener);
  }

  dispose(): void {
    this.#runtime.dispose();
  }
}

export function createProviderConfigRuntime(
  options: ProviderConfigRuntimeOptions,
): ProviderConfigRuntime {
  return new ProviderConfigRuntime(options);
}
