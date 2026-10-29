import type { ProviderDiagnosticsRequest } from "@acode/shared";
import {
  createAiSdkProviderDoctorModelPort,
  createBlockedProviderDoctorHttpPort,
  createFileProviderDoctorLedger,
  createNodeProviderDoctorHttpPort,
  createProviderDoctorCredentialPort,
  type ProviderDoctorCredentialPort,
  type ProviderDoctorHttpPort,
  type ProviderDoctorLedgerPort,
  type ProviderDoctorModelPort,
  type ProviderDoctorRegistrySnapshot,
  type DnsLookup,
} from "@acode/adapters/doctor";
import {
  createSharedCredentialStoreApiKeyVault,
  type SharedACodeCredentialStore,
} from "@acode/adapters/auth";
import type { Logger } from "@acode/contracts";

/**
 * U08 Provider 诊断的 **Doctor Port 装配**（specs/provider-diagnostics.md）。
 *
 * 从 provider-diagnostics.ts 拆出，避免单文件超 400 行门禁。拆分的内聚边界是：本文件只负责
 * 「把 ACode 真实的凭据库 / HTTP 客户端 / 模型客户端 / 账本接成 Doctor 的 Port」，
 * 与 `acode doctor --provider` 命令的接线同源（provider-doctor-command.ts），不另立一套；
 * 而「选载体、投影 DTO、管取消、单次执行」等编排逻辑留在 provider-diagnostics.ts。
 *
 * 这些 Port 全部读**进程级** provider 事实，不绑定任何 workspace（见调用方文件头）。
 */

/** 装配 Doctor Port 所需的输入（快照已投影成 doctor 白名单形态）。 */
export interface AssembleDoctorPortsInput {
  readonly request: ProviderDiagnosticsRequest;
  readonly offline: boolean;
  readonly doctorSnapshot: ProviderDoctorRegistrySnapshot;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly credentialStore: SharedACodeCredentialStore;
  readonly ledgerPath: string;
  readonly logger?: Logger;
}

/** 装配好的 Doctor Port 集合（交给 runProviderDoctor）。 */
export interface AssembledDoctorPorts {
  readonly credentials: ProviderDoctorCredentialPort;
  readonly http: ProviderDoctorHttpPort;
  readonly models: ProviderDoctorModelPort;
  readonly ledger: ProviderDoctorLedgerPort;
  /**
   * #7 出口校验用的 DNS 解析（可注入）。缺席时 Doctor 回落到 `defaultPublicDnsLookup()`
   * ——那是**真实** DNS 解析。留这个注入口是为了让 catalog/live 档的测试保持封闭
   * （不发真实解析），与 doctor 本体「所有 IO 经注入 Port」的纪律一致。
   */
  readonly dnsLookup?: DnsLookup;
}

/**
 * 默认 Port 装配：把 ACode 真实的凭据库 / HTTP 客户端 / 模型客户端 / 账本接上去。
 * offline 档注入 blocked transport，作为 Doctor tier guard 之外的第二道强制（provider-doctor.md R2）。
 */
export function assembleRealDoctorPorts(input: AssembleDoctorPortsInput): AssembledDoctorPorts {
  const { env, offline, doctorSnapshot, credentialStore, ledgerPath, logger } = input;
  return {
    credentials: createProviderDoctorCredentialPort({
      vault: createSharedCredentialStoreApiKeyVault(credentialStore),
      credentialsFilePath: credentialStore.filePath,
    }),
    // offline 档注入 blocked transport：任何出网尝试都变成可见失败并计数。
    http: offline
      ? createBlockedProviderDoctorHttpPort()
      : createNodeProviderDoctorHttpPort({ env: { ...env } }),
    models: createAiSdkProviderDoctorModelPort({
      snapshot: doctorSnapshot,
      env: { ...env },
      ...(logger ? { logger } : {}),
    }),
    ledger: createFileProviderDoctorLedger({ filePath: ledgerPath }),
  };
}
