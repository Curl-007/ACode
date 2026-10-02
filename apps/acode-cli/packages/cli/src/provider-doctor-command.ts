// ============================================================
// `acode doctor --provider` 的 CLI 薄接线（J3-1）
// ============================================================
//
// 诊断本体在 `@acode/adapters/doctor`（规格 apps/acode-cli/specs/provider-doctor.md）。
// 这里只做四件事：解析本命令的 argv、准备 provider runtime env、把 ACode 真实的
// registry / 凭据库 / 模型客户端 / HTTP 客户端接成 Port、渲染并按 verdict 决定退出码。
//
// 不承载判定逻辑：任何「检查点该怎么判」的改动都属于 adapters/doctor 与 spec。

import { parseArgs } from "node:util";
import {
  createRootTraceContext,
  createSessionId,
  type ModelInvocationContext,
} from "@acode/contracts";
import type { RunContext } from "@acode/shared-types";
import { getRuntimeInfo, supportsColor } from "@acode/core";
import {
  createSharedACodeCredentialStore,
  createSharedCredentialStoreApiKeyVault,
} from "@acode/adapters/auth";
import {
  PROVIDER_DOCTOR_TIERS,
  createAiSdkProviderDoctorModelPort,
  createBlockedProviderDoctorHttpPort,
  createFileProviderDoctorLedger,
  createNodeProviderDoctorHttpPort,
  createProviderDoctorCredentialPort,
  formatCoverageLines,
  formatProviderDoctorRun,
  isProviderDoctorTier,
  projectProviderRegistryServiceSnapshot,
  providerDoctorJsonPayload,
  readProviderDoctorLedgerFile,
  resolveProviderDoctorLedgerPath,
  runProviderDoctor,
  summarizeProviderDoctorCoverage,
  type ProviderDoctorAccountAuthPort,
  type ProviderDoctorRunnerInfo,
  type ProviderDoctorTier,
} from "@acode/adapters/doctor";
import {
  ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ACODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@acode/provider-node";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv, prepareCliRuntimeEnv } from "./env.js";
import {
  createCliProviderRefreshReporter,
  prepareCliProviderRuntimeEnv,
} from "./provider-runtime-env.js";
import type { RunDependencies } from "./cli-types.js";

const USAGE =
  "Usage: acode doctor --provider[=<id>] [--model=<id>] [--tier=offline|catalog|live] [--coverage] [--json]";

/** 诊断调用不属于任何会话，但既有 header port 的签名要求 session/trace 事实。 */
const DOCTOR_SESSION_ID = createSessionId("provider-doctor");
const DOCTOR_TRACE_CONTEXT = createRootTraceContext({
  sessionId: DOCTOR_SESSION_ID,
  attributes: { "acode.command": "doctor --provider" },
});

type RuntimeHeadersRefreshInput = Parameters<
  NonNullable<ModelInvocationContext["refreshRuntimeHeadersBeforeAttempt"]>
>[0];

/** `doctor --provider…` 才走本命令；裸 `doctor` 保持既有静态输出不变。 */
export function isProviderDoctorInvocation(argv: readonly string[]): boolean {
  const command = argv.find((arg) => !arg.startsWith("-"));
  if (command !== "doctor") return false;
  return argv.some((arg) => arg === "--provider" || arg.startsWith("--provider="));
}

interface ProviderDoctorCliRequest {
  readonly tier: ProviderDoctorTier;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly coverage: boolean;
  readonly json: boolean;
  readonly noColor: boolean;
  readonly verbose: boolean;
}

export async function runProviderDoctorCommand(
  ctx: RunContext,
  deps: RunDependencies,
  version: string,
  argv: readonly string[],
): Promise<number> {
  let request: ProviderDoctorCliRequest;
  try {
    request = parseProviderDoctorRequest(argv);
  } catch (error) {
    ctx.stderr.write(`${errorMessage(error)}\n\n${USAGE}\n`);
    return 1;
  }

  const colors = supportsColor(ctx.stdout, request.noColor);
  const env = prepareCliRuntimeEnv(deps.env ?? process.env, [...argv]);
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({ cwd: workingDirectory, env });
  if (dotenvResult.error) {
    ctx.stderr.write(`Failed to load environment file: ${dotenvResult.path}\n`);
    return 1;
  }

  const ledgerPath = resolveProviderDoctorLedgerPath({ env });

  try {
    if (request.coverage) {
      return await runCoverageView(ctx, ledgerPath, request, colors);
    }
    return await runDiagnostic(ctx, deps, version, argv, env, ledgerPath, request, colors);
  } catch (error) {
    ctx.stderr.write(`Error: ${errorMessage(error)}\n`);
    if (request.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

async function runCoverageView(
  ctx: RunContext,
  ledgerPath: string,
  request: ProviderDoctorCliRequest,
  colors: boolean,
): Promise<number> {
  // `--coverage` 只读本地账本：不启动 registry runtime、不触网、不花费。
  const { events, corruptLines } = await readProviderDoctorLedgerFile(ledgerPath);
  const coverage = summarizeProviderDoctorCoverage({ events, corruptLines });
  if (request.json) {
    ctx.stdout.write(formatDoctorJson({ ledgerPath, coverage }));
    return 0;
  }
  ctx.stdout.write(`${formatCoverageLines(coverage, ledgerPath, { colors }).join("\n")}\n`);
  return 0;
}

async function runDiagnostic(
  ctx: RunContext,
  deps: RunDependencies,
  version: string,
  argv: readonly string[],
  env: Record<string, string | undefined>,
  ledgerPath: string,
  request: ProviderDoctorCliRequest,
  colors: boolean,
): Promise<number> {
  // Built-in / Personal Provider 配置路径与 login/tui 同源解析；main.ts 已准备过时是幂等的。
  const providerEnv = env[ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]
    ? {}
    : await prepareCliProviderRuntimeEnv({ argv: [...argv], env, appVersion: version });
  const runtimeEnv = { ...env, ...providerEnv };

  const startRuntime =
    deps.startProcessProviderRegistryRuntime ??
    (await loadBootstrapModule()).startProcessProviderRegistryRuntime;
  if (!startRuntime) throw new Error("Provider Registry runtime is unavailable.");

  const offline = request.tier === "offline";
  let blockedUpstreamFetchCalls = 0;
  const runtime = await startRuntime(runtimeEnv, {
    standalone: {
      // offline 档刻意不接 Built-in 刷新播报：这一档**禁止**出网，CDN 刷新拿不到结果属于
      // 预期状态，播报「missing」只会让人误判成配置坏了；被拦截的次数由本命令自己报。
      ...(offline ? {} : createCliProviderRefreshReporter(ctx.stderr)),
      // offline 档的零网络由构造保证：ACode Built-in 的 CDN 刷新拿到的是拒绝型 fetch
      // （spec R2 ②）；诊断层的 blocked transport 是第二道防线（spec R2 ①）。
      request: offline
        ? createBlockedUpstreamFetch(() => {
            blockedUpstreamFetchCalls += 1;
          })
        : globalThis.fetch,
      ...(deps.skipUserConfig
        ? {}
        : deps.userConfigPath
          ? { legacyCliUserConfigFilePath: deps.userConfigPath }
          : {}),
    },
  });

  try {
    // catalog/live 档先刷新一次 registry（本地重读配置源），之后全程用同一份快照，
    // 避免「诊断用的模型客户端」与「诊断结论」基于两份不同的 provider 事实。
    if (!offline) await runtime.runtime.registryService.refresh("provider-doctor");
    const snapshot = runtime.runtime.registryService.getSnapshot() ?? runtime.snapshot;
    const credentialStore = createSharedACodeCredentialStore({ env: { ...runtimeEnv } });
    const doctorSnapshot = projectSnapshot(snapshot, runtimeEnv, credentialStore.filePath);

    const headersPort = runtime.providerRuntimeHeadersPort;
    // 用端口契约本身标注包装器（不复制一份结构类型）：input.accountAccess 由 doctor 从
    // registry 的 providerConfig.access 取出并下发，接线只负责透传给 headers port。
    const accountAuth: ProviderDoctorAccountAuthPort | undefined = headersPort
      ? {
          resolve: async (input) =>
            (
              await headersPort.refreshBeforeModelRequest({
                providerId: input.providerId,
                modelId: input.modelId ?? "",
                reason: "model-request",
                sessionId: DOCTOR_SESSION_ID,
                traceContext: DOCTOR_TRACE_CONTEXT,
                // 评审 J3 修复：账号型 provider 的请求身份必须随诊断一起下发。
                // standalone headers port 在缺 accountAccess 时直接抛「请求身份无效」
                // （bootstrap/src/app/standalone-account-provider-runtime.ts:180-183），
                // 于是「已登录且凭据可解密」被报成「凭据解密失败，请重新登录」，
                // credential_available 永远 blocked 并连带 skip 掉 catalog/live 的 #8-#12。
                // 真实模型路径每次都带这个事实（adapters/src/model/runner.ts:151/216/242/254），
                // 诊断接线与它同源。
                ...(input.accountAccess ? { accountAccess: input.accountAccess } : {}),
                ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
              })
            ).requestAuth,
        }
      : undefined;
    const invocationContext: ModelInvocationContext | undefined = headersPort
      ? {
          refreshRuntimeHeadersBeforeAttempt: (input: RuntimeHeadersRefreshInput) =>
            headersPort.refreshBeforeModelRequest({
              providerId: input.providerId,
              modelId: input.modelId,
              reason: "model-request",
              sessionId: DOCTOR_SESSION_ID,
              traceContext: DOCTOR_TRACE_CONTEXT,
              ...(input.accountAccess ? { accountAccess: input.accountAccess } : {}),
              ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
            }),
        }
      : undefined;
    // off-peak 账号模型走 runner 的 requestDependencies 路径（runner.ts:163-180）。
    // 对抗复核 F9：与上方 accountAuth / invocationContext 两处对齐，请求身份
    // accountAccess 一并透传（contracts 的 ModelRequestAuthSourceInput 目前没有该字段，
    // runner 对 off-peak Source 也不传它——这里的分支在今天不会触发，属接线一致性兜底）。
    // 注意：standalone headers port 目前只支持 individual-coding-plan 身份；off-peak
    // 真正在 doctor 生效前需要换鉴权源（off-peak Model 走创建时注入的执行作用域
    // Source，不依赖账号服务），不能直接复用本包装。
    const requestDependencies = headersPort
      ? {
          requestAuth: {
            source: {
              resolve: async (input: {
                providerId: string;
                modelId: string;
                accountAccess?: RuntimeHeadersRefreshInput["accountAccess"];
              }) =>
                (
                  await headersPort.refreshBeforeModelRequest({
                    providerId: input.providerId,
                    modelId: input.modelId,
                    reason: "model-request",
                    sessionId: DOCTOR_SESSION_ID,
                    traceContext: DOCTOR_TRACE_CONTEXT,
                    ...(input.accountAccess ? { accountAccess: input.accountAccess } : {}),
                  })
                ).requestAuth,
            },
          },
        }
      : undefined;

    const result = await runProviderDoctor({
      tier: request.tier,
      registry: { loadLocalSnapshot: async () => doctorSnapshot },
      credentials: createProviderDoctorCredentialPort({
        vault: createSharedCredentialStoreApiKeyVault(credentialStore),
        ...(accountAuth ? { accountAuth } : {}),
        credentialsFilePath: credentialStore.filePath,
      }),
      // offline 档：blocked transport，任何出网尝试都变成可见失败并计数。
      http: offline
        ? createBlockedProviderDoctorHttpPort()
        : createNodeProviderDoctorHttpPort({ env: runtimeEnv }),
      models: createAiSdkProviderDoctorModelPort({
        snapshot: doctorSnapshot,
        env: runtimeEnv,
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...(requestDependencies ? { requestDependencies } : {}),
      }),
      ledger: createFileProviderDoctorLedger({ filePath: ledgerPath }),
      ledgerPath,
      ...(request.providerId ? { providerId: request.providerId } : {}),
      ...(request.modelId ? { modelId: request.modelId } : {}),
      ...(runtime.configuredDefaultModelSelection
        ? { defaultModelSelection: runtime.configuredDefaultModelSelection }
        : {}),
      ...(accountAuth ? { accountAuth } : {}),
      ...(invocationContext ? { invocationContext } : {}),
      runner: buildRunnerInfo(version),
      ...(deps.logger ? { logger: deps.logger } : {}),
    });

    if (blockedUpstreamFetchCalls > 0) {
      ctx.stderr.write(
        `警告: offline 档拦截到 ${blockedUpstreamFetchCalls} 次 Built-in 配置远端刷新尝试\n`,
      );
    }

    if (request.json) {
      ctx.stdout.write(formatDoctorJson(providerDoctorJsonPayload(result)));
    } else {
      ctx.stdout.write(formatProviderDoctorRun(result, { colors, verbose: request.verbose }));
    }

    // 所选档未通过 → 非零退出，可直接当 CI 门禁（spec R1）。
    return result.reports.length > 0 && result.reports.every((report) => report.tierPassed)
      ? 0
      : 1;
  } finally {
    runtime.dispose();
  }
}

function projectSnapshot(
  snapshot: Parameters<typeof projectProviderRegistryServiceSnapshot>[0],
  env: Record<string, string | undefined>,
  credentialsFilePath: string,
) {
  const acodeBuiltinFilePath = env[ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const personalFilePath = env[ACODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  return projectProviderRegistryServiceSnapshot(snapshot, {
    ...(acodeBuiltinFilePath ? { acodeBuiltinFilePath } : {}),
    ...(personalFilePath ? { personalFilePath } : {}),
    credentialsFilePath,
  });
}

/**
 * `--json` 输出：与 core 的 formatJson 逐字同构（两空格缩进 + 换行），但入参是诊断的
 * 只读白名单载荷（含 undefined 的可选字段、readonly 数组），不满足 JsonValue 的形状约束。
 * JSON.stringify 本身就会丢掉 undefined 字段，因此这里不需要额外裁剪，也不用类型断言。
 */
function formatDoctorJson(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function buildRunnerInfo(version: string): ProviderDoctorRunnerInfo {
  const runtime = getRuntimeInfo();
  return {
    actor: isReleaseEvidence(version, runtime.sea) ? "user" : "developer",
    cliVersion: version,
    platform: runtime.platform,
    arch: runtime.arch,
    node: runtime.node,
    sea: runtime.sea,
    pid: process.pid,
  };
}

/** 账本要能区分「真实用户证据」与「开发者本机证据」（spec R6）。 */
function isReleaseEvidence(version: string, sea: boolean): boolean {
  if (sea) return true;
  if (version.trim().length === 0 || version === "0.0.0") return false;
  return !/dev|dirty|snapshot|canary|nightly/i.test(version);
}

function createBlockedUpstreamFetch(
  onBlocked: () => void,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (): Promise<Response> => {
    onBlocked();
    throw new Error("provider doctor offline 档禁止网络请求（ACode Built-in 远端刷新被拦截）");
  };
}

/**
 * `--provider` 允许裸标志（= 全部 provider）与带值两种写法，而全局 parseArgs 是 strict 的，
 * 所以本命令在 run.ts 的早分支里自己解析（与 hooks 命令同构），先把裸标志归一成带值形态。
 */
function parseProviderDoctorRequest(argv: readonly string[]): ProviderDoctorCliRequest {
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "doctor" && args.length === 0) continue;
    if (arg === "--provider") {
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        args.push(`--provider=${next}`);
        index += 1;
      } else {
        args.push("--provider=*");
      }
      continue;
    }
    args.push(arg);
  }

  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      tier: { type: "string" },
      coverage: { type: "boolean" },
      json: { type: "boolean" },
      "no-color": { type: "boolean" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (parsed.values.help) throw new Error(USAGE);

  const tier = parsed.values.tier?.trim().toLowerCase() ?? "offline";
  if (!isProviderDoctorTier(tier)) {
    throw new Error(
      `--tier 只支持 ${PROVIDER_DOCTOR_TIERS.join(" | ")}（收到: ${parsed.values.tier}）`,
    );
  }

  const rawProvider = parsed.values.provider;
  if (rawProvider !== undefined && rawProvider.trim().length === 0) {
    throw new Error("--provider 需要非空的 provider id，或省略值以诊断全部 provider");
  }
  const providerId = rawProvider?.trim();
  const rawModel = parsed.values.model;
  if (rawModel !== undefined && rawModel.trim().length === 0) {
    throw new Error("--model 需要非空的模型 id");
  }

  return {
    tier,
    ...(providerId && providerId !== "*" ? { providerId } : {}),
    ...(rawModel?.trim() ? { modelId: rawModel.trim() } : {}),
    coverage: parsed.values.coverage === true,
    json: parsed.values.json === true,
    noColor: parsed.values["no-color"] === true,
    verbose: parsed.values.verbose === true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
