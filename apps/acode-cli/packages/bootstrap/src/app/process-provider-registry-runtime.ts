import {
  AccountProviderService,
  MutableAccountProviderConfigSource,
  parseAccountProviderConfigMap,
  type AccountProviderConfigSnapshot,
  type AccountProviderStates,
} from "@acode/provider";
import {
  isBuiltinModelProviderId,
  resolveRuntimeACodeEndpointOrigin,
  ACODE_VERSION,
} from "@acode/shared";
import { dirname, join } from "node:path";
import {
  NodeModelSelectionConfigRepository,
  NodeProviderRegistryRuntime,
  resolveNodeProviderRuntimePaths,
  downloadACodeBuiltinRelease,
  resolveACodeBuiltinClientPlatform,
  ACODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  type ACodeBuiltinRefreshEvent,
} from "@acode/provider-node";
import {
  createSharedACodeCredentialStore,
  createSharedCredentialStoreApiKeyVault,
  type SharedACodeCredentialStore,
} from "@acode/adapters/auth";
import { readLegacyCliPersonalProviderConfig } from "./legacy-cli-personal-provider-config-importer.js";
import {
  createStandaloneProviderRuntimeHeadersPort,
  readStandaloneAccountProviderConfigSnapshot,
} from "./standalone-account-provider-runtime.js";

export interface ProcessProviderRegistryRuntimeOptions {
  /** Standalone Prompt CLI / TUI 自己拥有账号凭据与旧配置的一次性导入。 */
  readonly standalone?: {
    readonly credentialStore?: SharedACodeCredentialStore;
    readonly legacyCliUserConfigFilePath?: string;
    readonly onAccountInitializationError?: (error: unknown) => void;
    readonly request?: typeof fetch;
    readonly onBuiltinRefreshError?: (error: unknown) => void;
    readonly onBuiltinRefreshResult?: (event: ACodeBuiltinRefreshEvent) => void;
  };
}

export async function startProcessProviderRegistryRuntime(
  env: Readonly<Record<string, string | undefined>>,
  options: ProcessProviderRegistryRuntimeOptions = {},
) {
  const paths = resolveNodeProviderRuntimePaths(env);
  if (!paths) {
    throw new Error("缺少进程 Provider Registry 的 ACode Built-in / Personal Config 路径");
  }

  const accountSource = new MutableAccountProviderConfigSource();
  // Standalone（Prompt CLI / TUI）自持账号凭据与旧配置；协议 worker（桌面 host 拉起的
  // app-server --stdio）不自持账号，账号事实由 Host 经 syncAccountProviderConfig 下发。
  const standaloneCredentialStore = options.standalone
    ? (options.standalone.credentialStore ?? createSharedACodeCredentialStore({ env: { ...env } }))
    : undefined;
  // 安全加固 P1-5 回归修复（R1）：「谁读 vault 化的 provider_config.json，谁就得有 vault」。
  // 协议 worker 与桌面 host 共用同一份 provider_config.json 与 credentials.json（路径由
  // ACODE_DATA_BASE_DIR / 默认 homedir 一致解析；cipher 惰性，构造无磁盘副作用）。
  // 此前 vault 只在 standalone 注入：桌面把文件迁成 credentialRef 形态后，worker 无法
  // hydrate，把 ref 字符串当 apiKey 用 → 桌面 BYO provider 全线静默 401。
  // 因此这里无条件注入；standalone 专属的账号管理仍以 standaloneCredentialStore 为门槛。
  const credentialStore =
    standaloneCredentialStore ?? createSharedACodeCredentialStore({ env: { ...env } });
  const providerApiKeyVault = createSharedCredentialStoreApiKeyVault(credentialStore);
  let standaloneAccount: AccountProviderService | undefined;
  const bundledFile = options.standalone
    ? env[ACODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]?.trim()
    : undefined;
  const runtime = new NodeProviderRegistryRuntime({
    ...paths,
    ...(bundledFile
      ? {
          acodeBuiltinFilePath: bundledFile,
          acodeBuiltinActiveFilePath: paths.acodeBuiltinFilePath,
          acodeBuiltinRemote: {
            controlFilePath: join(
              dirname(paths.acodeBuiltinFilePath),
              "acode-builtin-refresh.json",
            ),
            resolveEndpointKey: () => resolveRuntimeACodeEndpointOrigin(env),
            fetchRelease: (endpointOrigin, signal) =>
              downloadACodeBuiltinRelease({
                endpointOrigin,
                signal,
                appVersion: ACODE_VERSION,
                platform: resolveACodeBuiltinClientPlatform(),
                request: options.standalone?.request ?? globalThis.fetch,
              }),
            onRefreshResult: options.standalone?.onBuiltinRefreshResult,
          },
        }
      : {}),
    onACodeBuiltinRefreshError: options.standalone?.onBuiltinRefreshError,
    accountSource,
    providerApiKeyVault,
    ...(standaloneCredentialStore
      ? {
          createAccountSource(configService) {
            standaloneAccount = new AccountProviderService({
              configSource: configService,
              async resolve({ configRevision, configuredProviders }) {
                // 使用本轮捕获的 Built-in，而不是异步读另一份文件后仅贴上新 revision。
                const snapshot = await readStandaloneAccountProviderConfigSnapshot(
                  standaloneCredentialStore,
                  env,
                  { revision: configRevision, providers: configuredProviders },
                );
                return { providers: snapshot.providers, states: snapshot.states ?? {} };
              },
            });
            standaloneAccount.onDidRefreshError(({ error }) => {
              try {
                options.standalone?.onAccountInitializationError?.(error);
              } catch {
                /* 观测回调不能改变账号事实。 */
              }
            });
            return standaloneAccount;
          },
        }
      : {}),
    ...(options.standalone
      ? {
          importLegacy: () =>
            readLegacyCliPersonalProviderConfig({
              ...(options.standalone?.legacyCliUserConfigFilePath
                ? { filePath: options.standalone.legacyCliUserConfigFilePath }
                : {}),
            }),
        }
      : {}),
  });
  const disposeRecovery = standaloneAccount
    ? runtime.onDidCheckACodeBuiltin(async () => {
        const [config, account] = await Promise.all([
          runtime.configService.read(),
          standaloneAccount!.read(),
        ]);
        if (config.acodeBuiltinRevision !== account.basedOnACodeBuiltinRevision)
          await standaloneAccount!.refresh("builtin-account-recovery");
      })
    : undefined;
  // 复用 AccountService 的串行、过期结果丢弃机制，凭据变化与 Built-in 变化不能各自发布。
  // 协议 worker 没有 standaloneAccount：本进程 vault 写入（若 agent 侧保存 provider 配置）
  // 只需刷新 registry 重新 hydrate，不能假定 standalone 分支存在。
  const disposeCredentialSubscription = credentialStore.onDidChange?.(async () => {
    if (standaloneAccount) await standaloneAccount.refresh("standalone-credentials-changed");
    await runtime.registryService.refresh("standalone-credentials-barrier");
  });
  try {
    await runtime.start();
    const snapshot = runtime.registryService.getSnapshot()!;
    const modelSelectionConfigRepository = new NodeModelSelectionConfigRepository({
      personalRepository: runtime.personalRepository,
    });
    try {
      const configuredDefaultModelSelection = await modelSelectionConfigRepository.read();
      return Object.freeze({
        accountSource: standaloneAccount ?? accountSource,
        async syncAccountProviderConfig(next: AccountProviderConfigSnapshot): Promise<boolean> {
          if (standaloneAccount)
            throw new Error("Standalone Account 由本进程管理，不接收 Host 覆盖");
          const changed = accountSource.replace(next, "host-account-config");
          // Source 去重只证明收过，不证明上次刷新成功。重交时仍刷新；配套配置未到
          // 则由 Registry 保留完整旧快照，不能把接收确认冒充应用确认。
          await runtime.registryService.refresh("host-account-config");
          return changed;
        },
        dispose() {
          disposeCredentialSubscription?.();
          disposeRecovery?.();
          standaloneAccount?.dispose();
          modelSelectionConfigRepository.dispose();
          runtime.dispose();
        },
        ...(standaloneCredentialStore
          ? {
              providerRuntimeHeadersPort: createStandaloneProviderRuntimeHeadersPort(
                standaloneCredentialStore,
                env,
              ),
            }
          : {}),
        runtime,
        snapshot,
        modelSelectionConfigRepository,
        configuredDefaultModelSelection,
      });
    } catch (error) {
      disposeCredentialSubscription?.();
      modelSelectionConfigRepository.dispose();
      throw error;
    }
  } catch (error) {
    disposeCredentialSubscription?.();
    disposeRecovery?.();
    standaloneAccount?.dispose();
    runtime.dispose();
    throw error;
  }
}

/** 把协议信封解析为进程 Registry 使用的第三层 Account Config Overlay。 */
export function parseProcessAccountProviderConfigSnapshot(input: {
  readonly revision: string;
  readonly basedOnACodeBuiltinRevision: string;
  readonly providers: unknown;
  readonly states?: AccountProviderStates;
}): AccountProviderConfigSnapshot {
  const revision = input.revision.trim();
  if (!revision) throw new Error("Account Config revision 不能为空");
  const basedOnACodeBuiltinRevision = input.basedOnACodeBuiltinRevision.trim();
  if (!basedOnACodeBuiltinRevision) {
    throw new Error("Account Config Built-in revision 不能为空");
  }
  const providers = parseAccountProviderConfigMap(input.providers);
  for (const [providerId, provider] of providers.entries()) {
    // 仅约束托管 Worker 的普通账号信封；独立 CLI、API 和闲时不需要 current。
    if (
      isBuiltinModelProviderId(providerId) &&
      provider.access?.type === "zhipu-account" &&
      provider.access.entitled &&
      typeof input.states?.[providerId]?.current !== "boolean"
    ) {
      throw new Error(`Account State 缺少 current: ${providerId}`);
    }
  }
  return Object.freeze({
    revision,
    basedOnACodeBuiltinRevision,
    providers,
    // 与 Overlay 属于同一快照；不能只更新 revision 却丢掉当前连接事实。
    ...(input.states ? { states: input.states } : {}),
  });
}
