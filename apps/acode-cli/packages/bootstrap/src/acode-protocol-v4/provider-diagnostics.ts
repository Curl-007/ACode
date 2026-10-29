import {
  PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS,
  parseProviderDiagnosticsRequest,
  parseProviderDiagnosticsResult,
  type ProviderDiagnosticsCancelResult,
  type ProviderDiagnosticsReasonCode,
  type ProviderDiagnosticsRequest,
  type ProviderDiagnosticsResult,
} from "@acode/shared";
import {
  projectProviderDiagnosticsResult,
  projectProviderRegistryServiceSnapshot,
  resolveProviderDoctorLedgerPath,
  runProviderDoctor,
  type ProviderDoctorRunResult,
  type ProviderDoctorSpend,
} from "@acode/adapters/doctor";
import { createSharedACodeCredentialStore } from "@acode/adapters/auth";
import {
  ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ACODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@acode/provider-node";
import type { ProviderRegistryServiceSnapshot } from "@acode/provider";
import type { Logger } from "@acode/contracts";
import {
  assembleRealDoctorPorts,
  type AssembleDoctorPortsInput,
  type AssembledDoctorPorts,
} from "./provider-diagnostics-ports.js";

/**
 * U08 Provider 诊断的 CLI 侧适配（specs/provider-diagnostics.md）。
 *
 * **不重写任何检查点**：判定、档位门控、offline 零网络三重强制、脱敏、花费统计全部由既有
 * `runProviderDoctor`（adapters/doctor，规格 apps/acode-cli/specs/provider-doctor.md）负责。
 * 本模块只做四件事：装 Port、选载体、投影成白名单 DTO、管取消。
 *
 * 无 workspace 的关键事实（提案 §3.2 的顾虑在此不成立）：Doctor 的 Port 全部读**进程级**
 * provider 事实——Registry 快照来自 worker 启动时就已拉起的进程级 runtime
 * （acode-protocol-entrypoint.ts:174），凭据来自 `~/.acode/v2/credentials.json`，账本落用户
 * 数据目录。因此诊断**不需要** workspace ACodeApp，也不经过 `createWorkspaceACodeApp`；
 * 首次配置尚无 workspace 时同样可跑 offline 档。
 */

/** worker 进程级 Registry runtime 的结构子集（由 entrypoint 注入，避免本模块自己起 runtime）。 */
export interface ProviderDiagnosticsRegistrySource {
  /** 重读配置源并等待 Registry 发布（catalog/live 档用；offline 档不调用）。 */
  refresh(reason: string): Promise<void>;
  /** 取当前 Registry 快照；worker 未就绪时为 null（照 ProviderRegistryService.getSnapshot 签名）。 */
  getSnapshot(): ProviderRegistryServiceSnapshot | null;
}

export interface ProviderDiagnosticsExecutorDeps {
  readonly registry: ProviderDiagnosticsRegistrySource;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger?: Logger;
  /**
   * Doctor Port 装配点（可注入，默认 `assembleRealDoctorPorts`）。
   *
   * 抽成注入点的唯一理由是**可测性**：「offline 档零网络」是本项的承重性质（U08-A1），
   * 必须能用计数 Port 从**本适配器的真实代码路径**证明，而不是只在 doctor 自己的测试里
   * 证明（doctor 测试证明不了这里的接线没漏注入 blocked transport）。
   * 与 doctor 本体同样的纪律：所有 IO 经注入 Port，性质才可被测试证明而非承诺。
   */
  readonly assemblePorts?: (input: AssembleDoctorPortsInput) => AssembledDoctorPorts;
}

export interface ProviderDiagnosticsProtocolExecutor {
  run(params: unknown, signal?: AbortSignal): Promise<ProviderDiagnosticsResult>;
  cancel(params: unknown): ProviderDiagnosticsCancelResult;
}

/** live 档含三次真实模型调用；与 Doctor 的 probeTimeoutMs 缺省值对齐（spec R10）。 */
const DIAGNOSTICS_PROBE_TIMEOUT_MS = 30_000;

/**
 * 创建协议侧诊断执行器。载体与 Port 都在这里装配，判定逻辑一律不在此。
 */
export function createProviderDiagnosticsProtocolExecutor(
  deps: ProviderDiagnosticsExecutorDeps,
): ProviderDiagnosticsProtocolExecutor {
  const assemblePorts = deps.assemblePorts ?? assembleRealDoctorPorts;
  // requestId → AbortController：取消只中止该 requestId 的那一次执行（spec R4）。
  const controllers = new Map<string, AbortController>();

  return {
    async run(rawParams: unknown, outerSignal?: AbortSignal): Promise<ProviderDiagnosticsResult> {
      // 跨进程边界的入参必须运行时校验（CLI AGENTS.md：schema 而非仅 TS 类型）。
      const request = parseProviderDiagnosticsRequest(rawParams);
      const startedAt = new Date().toISOString();

      // live 档需要显式 opt-in：缺 opt-in 直接终态失败，**零**模型调用（spec R9）。
      // 服务侧编排器已挡一道；这里是执行方的第二道，不依赖调用方自律。
      if (request.tier === "live" && request.liveOptIn !== true) {
        return buildTerminalFailure({ request, errorCode: "live-opt-in-required", startedAt });
      }

      // 先取快照再判 provider 是否存在：用结构化事实判 provider-unknown，
      // 绝不去匹配 runProviderDoctor 抛的中文错误文本（根 AGENTS.md）。
      //
      // offline 档刻意**不** refresh：refresh 会重读配置源，而 Built-in 配置源的重读路径
      // 可能触发远端刷新（provider-doctor.md「offline 档零网络不是免费的」）。与 CLI 命令
      // 同款门控（provider-doctor-command.ts:188 `if (!offline) … refresh`），
      // offline 直接用 worker 已发布的本地快照。
      const offline = request.tier === "offline";
      if (!offline) {
        await deps.registry.refresh(`provider-diagnostics:${request.tier}`);
      }
      const registrySnapshot = deps.registry.getSnapshot();
      if (!registrySnapshot) {
        // worker Registry 尚未发布快照：无法判定 provider 是否存在，归一为 provider-unknown。
        // 不猜测、不伪造空目录（provider-doctor.md：目录来自 Registry 快照）。
        return buildTerminalFailure({ request, errorCode: "provider-unknown", startedAt });
      }
      const knownIds = registrySnapshot.registry.providers.map((provider) => provider.providerId);
      if (!knownIds.includes(request.providerId)) {
        return buildTerminalFailure({ request, errorCode: "provider-unknown", startedAt });
      }

      const controller = new AbortController();
      controllers.set(request.requestId, controller);
      // 外层 signal（协议层取消/连接断开）与本次 requestId 取消汇合成一个信号。
      const abortAll = () => controller.abort(new DOMException("provider diagnostics cancelled", "AbortError"));
      outerSignal?.addEventListener("abort", abortAll);

      try {
        const env = { ...deps.env };
        const credentialStore = createSharedACodeCredentialStore({ env });
        const doctorSnapshot = projectProviderRegistryServiceSnapshot(registrySnapshot, {
          ...(env[ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim()
            ? { acodeBuiltinFilePath: env[ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]!.trim() }
            : {}),
          ...(env[ACODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim()
            ? { personalFilePath: env[ACODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]!.trim() }
            : {}),
          credentialsFilePath: credentialStore.filePath,
        });

        const ledgerPath = resolveProviderDoctorLedgerPath({ env });
        // Port 装配走注入点：默认接 ACode 真实凭据库/HTTP/模型客户端；测试注入计数 Port
        // 才能从本适配器的真实代码路径证明「offline 档零网络」（U08-A1）。
        const ports = assemblePorts({
          request,
          offline,
          doctorSnapshot,
          env,
          credentialStore,
          ledgerPath,
          ...(deps.logger ? { logger: deps.logger } : {}),
        });
        const run = await runProviderDoctor({
          tier: request.tier,
          // 快照已在内存：loadLocalSnapshot 零网络、零磁盘（offline 档的承重性质）。
          registry: { loadLocalSnapshot: async () => doctorSnapshot },
          credentials: ports.credentials,
          http: ports.http,
          models: ports.models,
          ledger: ports.ledger,
          ledgerPath,
          providerId: request.providerId,
          ...(request.modelId ? { modelId: request.modelId } : {}),
          probeTimeoutMs: DIAGNOSTICS_PROBE_TIMEOUT_MS,
          signal: controller.signal,
          // 缺席时 Doctor 用真实 DNS 解析；测试注入 fake 以保持封闭（见 AssembledDoctorPorts）。
          ...(ports.dnsLookup ? { dnsLookup: ports.dnsLookup } : {}),
          ...(deps.logger ? { logger: deps.logger } : {}),
        });

        // 取消判定必须放在 runProviderDoctor **正常返回之后**，不能只靠下面的 catch：
        // doctor 的探针把 AbortError 归一成检查点 failed（catalog-probe.ts:100-107、
        // live-probe.ts:89-91 等一律 catch 后返回 failed，不上抛），因此被取消的运行会
        // **正常 resolve**，带着一份「检查点 failed」的报告。若直接投影成 completed，
        // 用户点了取消却看到「配置有问题」的结论——把取消误报成配置故障。
        // 这里以 signal 为唯一事实源：一旦已请求取消，一律回 cancelled 终态，丢弃该报告。
        if (controller.signal.aborted || outerSignal?.aborted === true) {
          return buildTerminalFailure({
            request,
            errorCode: "cancelled",
            startedAt,
            status: "cancelled",
            // 取消前可能已发出计费请求：如实回传 spend，绝不填 0（否则等于声称退费，R4）。
            spend: sumSpendFromRun(run),
          });
        }

        const report = run.reports.find((item) => item.providerId === request.providerId);
        if (!report) {
          return buildTerminalFailure({ request, errorCode: "execution-failed", startedAt });
        }
        // 投影后**出口自校验**（spec 契约叶子设计要点：跨进程边界两侧都 parse）。
        // 既让「投影漏字段/形状漂移」在 CLI 侧 fail-loud，也把 readonly 投影归一成 schema
        // 推断的可变 DTO 形状，host 侧无需再处理 readonly/mutable 差异。
        return parseProviderDiagnosticsResult(
          projectProviderDiagnosticsResult({
            report,
            requestId: request.requestId,
            // revision 逐字回显请求值（spec R2）：worker 的 sourceRevisions.config 与 host 的
            // ProviderSettingsView.revision 是两套独立计数器，不可比较、更不可替换。
            revision: request.revision,
            run,
          }),
        );
      } catch {
        // 用户取消归一成 cancelled 终态；其余异常转成带稳定码的失败终态（错误是一等对象，
        // 但诊断失败 != 保存失败，UI 需要结构化终态而非抛出）。
        const cancelled = controller.signal.aborted || outerSignal?.aborted === true;
        if (cancelled) {
          return buildTerminalFailure({
            request,
            errorCode: "cancelled",
            startedAt,
            status: "cancelled",
          });
        }
        // 刻意**不**传 error 对象、也不记录 error.message：provider/HTTP 层拼出的异常文本
        // 可能带出请求头或 API Key（adapters/src/doctor/credential-probe.ts:200-205 已登记
        // 同一风险）。隐私门槛（spec R8）优先于原始异常细节——失败原因由 12 检查点的稳定码
        // 与 errorCode 结构化承载，而不是靠回显异常文本。
        deps.logger?.error("provider 诊断执行失败", undefined, {
          errorCode: "execution-failed",
          providerId: request.providerId,
          requestId: request.requestId,
          revision: request.revision,
          tier: request.tier,
        });
        return buildTerminalFailure({ request, errorCode: "execution-failed", startedAt });
      } finally {
        outerSignal?.removeEventListener("abort", abortAll);
        if (controllers.get(request.requestId) === controller) {
          controllers.delete(request.requestId);
        }
      }
    },

    cancel(rawParams: unknown): ProviderDiagnosticsCancelResult {
      const requestId = parseCancelRequestId(rawParams);
      const controller = controllers.get(requestId);
      if (!controller) {
        // 不在飞（已完成/未知）不是错误（spec R4）。spend 缺席 = 花费未知，绝不填 0 冒充没花钱。
        return { requestId, cancelled: false };
      }
      controller.abort(new DOMException("provider diagnostics cancelled", "AbortError"));
      controllers.delete(requestId);
      return { requestId, cancelled: true };
    },
  };
}

function parseCancelRequestId(rawParams: unknown): string {
  const parsed = rawParams as { requestId?: unknown };
  const requestId = typeof parsed?.requestId === "string" ? parsed.requestId.trim() : "";
  if (!requestId) throw new Error("provider-diagnostics-cancel-invalid");
  return requestId;
}

/**
 * 构造「没有可用 Doctor 报告」的终态 DTO（与服务侧编排器同形，两处都必须满足契约叶子的
 * 12 点 + superRefine 约束）。
 *
 * spend 的处理是 R4 的诚实基线：
 * - **取消**时 Doctor 已跑过一部分，花费是已知事实 → 传入 spend 如实回传；
 * - 其它终态（没跑起来 / 抛错 / provider 不存在）花费是**未知** → spend 缺席。
 *   绝不填 0：填 0 等于告诉用户「没花钱」，而 live 档可能已经发出过计费请求。
 */
function buildTerminalFailure(input: {
  readonly request: ProviderDiagnosticsRequest;
  readonly errorCode: ProviderDiagnosticsReasonCode;
  readonly startedAt: string;
  readonly status?: "failed" | "cancelled";
  readonly spend?: ProviderDoctorSpend;
  readonly blockedNetworkCalls?: number;
}): ProviderDiagnosticsResult {
  const finishedAt = new Date().toISOString();
  return {
    requestId: input.request.requestId,
    providerId: input.request.providerId,
    revision: input.request.revision,
    tier: input.request.tier,
    status: input.status ?? "failed",
    errorCode: input.errorCode,
    checkpoints: PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS.map((id) => ({
      id,
      status: "skipped" as const,
      reasonCode: input.errorCode,
    })),
    // 所有终态失败都给「重试 + 稍后验证」：重试不重新创建 provider（spec R3），
    // 「稍后验证」对齐提案 §3.6「失败不清空已保存 provider」。
    remediationActions: ["retry-diagnostics", "verify-later"],
    nextStepCommands: [],
    ...(input.spend ? { spend: input.spend } : {}),
    blockedNetworkCalls: input.blockedNetworkCalls ?? 0,
    startedAt: input.startedAt,
    finishedAt,
  };
}

/**
 * 汇总本次运行各报告的花费。取消发生在检查点之间时，已发生的调用仍要如实回传（R4）。
 * token 只取 provider 返回的 usage，不估算、不编造（doctor R6）。
 */
function sumSpendFromRun(run: ProviderDoctorRunResult): ProviderDoctorSpend {
  const total = {
    billableCalls: 0,
    catalogCalls: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    hasTokenData: false,
  };
  for (const report of run.reports) {
    total.billableCalls += report.spend.billableCalls;
    total.catalogCalls += report.spend.catalogCalls;
    total.promptTokens += report.spend.promptTokens;
    total.outputTokens += report.spend.outputTokens;
    total.totalTokens += report.spend.totalTokens;
    total.hasTokenData ||= report.spend.hasTokenData;
  }
  return total;
}

/** worker 进程级 Registry runtime 的结构子集（只用到 registryService 两个方法）。 */
export interface ProviderDiagnosticsRegistryRuntimeLike {
  readonly runtime: {
    readonly registryService: {
      refresh(reason: string): Promise<unknown>;
      getSnapshot(): ProviderRegistryServiceSnapshot | null;
    };
  };
}

/**
 * 用 worker 进程级 Registry runtime 装配协议侧诊断执行器。
 *
 * 抽成 helper 而不写在 entrypoint 里，有两个理由：① entrypoint 已贴近 400 行门禁，装配细节
 * 不该继续堆在那；② 「用哪个 runtime 当载体」是诊断的所有权边界，应与其判定/投影同住一个模块。
 */
export function createProtocolProviderDiagnostics(
  registryRuntime: ProviderDiagnosticsRegistryRuntimeLike,
  env: Readonly<Record<string, string | undefined>>,
  logger?: Logger,
): ProviderDiagnosticsProtocolExecutor {
  return createProviderDiagnosticsProtocolExecutor({
    registry: {
      refresh: async (reason) => {
        await registryRuntime.runtime.registryService.refresh(reason);
      },
      getSnapshot: () => registryRuntime.runtime.registryService.getSnapshot(),
    },
    env,
    ...(logger ? { logger } : {}),
  });
}
