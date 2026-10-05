// K6「Ambient 预算感知调度」quota 端口绑定（specs/ambient-budget-scheduler.md R3/附录 A1）：
// AdaptiveSchedulerDeps.getQuotaSnapshot 的真实数据源——GLM/ZAI 套餐余额面。
//
// 依赖方向结论（接线批探测）：余额接口 fetchZaiStartPlanBalanceEnvelope 位于
// @acode/services（packages/services/src/model-provider/zaiStartPlanBilling.ts），而 CLI
// agent 进程的装配链（cli → bootstrap → core）零包依赖 services（各自 package.json 均
// 无 @acode/services；services 侧调用还需要 ICredentialService /
// IAccountRequestAuthService 这两个 services 内部构造）。因此这里以「同 URL + 同
// envelope 形状」的最小 GET 实现承载绑定：URL 用 @acode/shared 的
// buildRuntimeACodeEndpointUrls().acodePlanBillingBalanceUrl + app_version 参数（与
// services 的 buildZaiStartPlanBalanceUrl 等价），账号上下文从 provider 装配面取
// （registry 的 zhipu-account access + providerRuntimeHeadersPort 刷出的请求凭据）。
// server/desktop 形态将来若要直接复用 services 面，经本文件的端口缝替换注入即可。
//
// 降级语义（spec A1）：端口缺席（装配面不完整）或运行期任一步取不到 → null/undefined，
// 引擎按「额度 +∞、interval 钉 MAX、启动 warn 一次」的降级模式处理，不静默。
import {
  ACODE_VERSION,
  buildRuntimeACodeEndpointUrls,
  normalizeOfficialGlmModelId,
} from "@acode/shared";
import type { AmbientQuotaSnapshot, ProviderRuntimeHeadersPort } from "@acode/core";
import type { ModelSelection, SessionId, TraceContext } from "@acode/contracts";

/**
 * unit → token 折算率：**1:1**（spec 附录登记，需产品确认）。
 * 套餐余额的计量单位是 entitlement 的 unit（按 meter 折算），不是纯 token；在产品给出
 * 正式折算表之前按 1:1 记账——预算公式的方向语义（余量约束）不受折算精度影响，
 * 绝对值的偏差由 AMBIENT_USER_BUDGET_RESERVE 的保守系数吸收。
 */
export const AMBIENT_QUOTA_UNIT_TO_TOKENS = 1;

/** 与 services ZaiStartPlanBalanceEnvelope 的 balances 元素同形状（本地结构镜像，避免依赖 services）。 */
export interface AmbientQuotaBalanceLike {
  bucket_id?: string;
  show_name?: string | null;
  capabilities?: string[];
  meter?: string | null;
  unit_type?: string | null;
  total_units?: number | string | null;
  used_units?: number | string | null;
  reserved_units?: number | string | null;
  remaining_units?: number | string | null;
  available_units?: number | string | null;
  period_start?: number | string | null;
  period_end?: number | string | null;
}

export interface AmbientQuotaBalanceEnvelopeLike {
  code?: number;
  success?: boolean;
  msg?: string;
  data?: {
    balances?: AmbientQuotaBalanceLike[];
  };
}

/** registry provider 的 access 结构面（@acode/provider ZhipuAccountAccessConfig 的鸭子形状）。 */
export interface AmbientQuotaProviderAccessLike {
  type?: string;
  accountType?: "zai" | "bigmodel";
  mode?: "start-plan" | "individual-coding-plan" | "team-coding-plan" | "off-peak";
  entitled?: boolean;
}

export interface AmbientQuotaProviderLike {
  config: { access?: AmbientQuotaProviderAccessLike };
}

export interface AmbientQuotaBindingDeps {
  providerRegistry: {
    getProvider(providerId: string): AmbientQuotaProviderLike | undefined;
  };
  /** provider 装配面的账号刷新端口（CLI 形态为 standalone coding plan 面）；缺席则端口整体缺席。 */
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  /** 当前会话模型选择（决定取哪个 provider 的余额）。 */
  getSelection(): ModelSelection | undefined;
  sessionId: SessionId;
  traceContext: TraceContext;
  env?: Record<string, string | undefined>;
  now?(): number;
  /** 测试注入；缺省全局 fetch。 */
  fetchImpl?: typeof fetch;
}

const AMBIENT_QUOTA_REQUEST_TIMEOUT_MS = 15_000;

/** 与 services buildZaiStartPlanBalanceUrl 等价的 URL（shared 端点 + 真实 app_version）。 */
export function buildAmbientQuotaBalanceUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const url = new URL(buildRuntimeACodeEndpointUrls(env).acodePlanBillingBalanceUrl);
  url.searchParams.set("app_version", ACODE_VERSION);
  return url.toString();
}

function readFiniteNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function matchesModelCapability(balance: AmbientQuotaBalanceLike, normalizedModelId: string): boolean {
  if (!normalizedModelId) return false;
  return (balance.capabilities ?? []).some((capability) => {
    const trimmed = capability.trim().toLowerCase();
    return trimmed.startsWith("model:")
      ? normalizeOfficialGlmModelId(trimmed.slice("model:".length).trim()) === normalizedModelId
      : false;
  });
}

/**
 * envelope → 配额快照的折算纯函数。
 *
 * 桶选择：capabilities 匹配当前模型的桶优先（套餐多桶按模型分桶计量）；无匹配取
 * period_end 最晚的桶（当前有效窗口最长——预算公式的「窗口剩余」分母语义）。
 * 无 period_end 的桶跳过（算不出 interval 分母）；窗口已收口（剩余 <= 0）按不可得
 * 处理（下个窗口的滚动重算会恢复）。
 */
export function pickAmbientQuotaSnapshot(
  balances: readonly AmbientQuotaBalanceLike[],
  input: { modelId?: string; nowMs: number },
): AmbientQuotaSnapshot | null {
  const candidates = balances.flatMap((balance) => {
    const remainingUnits = readFiniteNumber(balance.remaining_units ?? balance.available_units);
    const periodEndSeconds = readFiniteNumber(balance.period_end);
    if (remainingUnits === null || remainingUnits < 0 || periodEndSeconds === null) return [];
    return [{ balance, remainingUnits, periodEndMs: periodEndSeconds * 1000 }];
  });
  if (candidates.length === 0) return null;
  const normalizedModelId = input.modelId ? normalizeOfficialGlmModelId(input.modelId) : "";
  const picked =
    candidates.find((candidate) => matchesModelCapability(candidate.balance, normalizedModelId)) ??
    candidates.reduce((latest, candidate) =>
      candidate.periodEndMs > latest.periodEndMs ? candidate : latest,
    );
  const windowRemainingMs = Math.max(0, picked.periodEndMs - input.nowMs);
  if (windowRemainingMs <= 0) return null;
  return {
    remainingTokens: picked.remainingUnits * AMBIENT_QUOTA_UNIT_TO_TOKENS,
    windowRemainingMs,
  };
}

/**
 * 绑定 getQuotaSnapshot 端口。装配面不完整（无 registry / 无 providerRuntimeHeadersPort）
 * → 返回 undefined（端口缺席降级，spec A1）；在场则返回查询函数，运行期任一步取不到
 * （非账号 provider、凭据缺失、HTTP 失败、envelope 异常）→ null（本轮不可得）。
 * 不做缓存：scheduler 只在每个唤醒边界调用一次，频率可忽略。
 */
export function createAmbientQuotaSnapshotPort(
  deps: AmbientQuotaBindingDeps,
): (() => Promise<AmbientQuotaSnapshot | null>) | undefined {
  // 局部收窄：后续闭包内 TS 无法保持可选属性的判空结论。
  const headersPort = deps.providerRuntimeHeadersPort;
  if (!headersPort) return undefined;
  return async () => {
    try {
      const selection = deps.getSelection();
      if (!selection) return null;
      const access = deps.providerRegistry.getProvider(selection.providerId)?.config?.access;
      // 只取 zhipu-account 家族的余额（GLM 套餐面）；off-peak 桶的计量语义不同不混入。
      if (
        !access ||
        access.type !== "zhipu-account" ||
        !access.mode ||
        access.mode === "off-peak" ||
        access.entitled !== true
      ) {
        return null;
      }
      const refresh = await headersPort.refreshBeforeModelRequest({
        accountAccess: {
          accountType: access.accountType ?? "zai",
          entitled: true,
          mode: access.mode,
          type: "zhipu-account",
        },
        modelId: selection.modelId,
        providerId: selection.providerId,
        reason: "model-request",
        sessionId: deps.sessionId,
        traceContext: deps.traceContext,
      });
      if (!refresh.headersApplied) return null;
      const apiKey = refresh.requestAuth?.apiKey?.trim();
      if (!apiKey) return null;
      // 与 services resolveStartPlanAuthorization 同口径：已带 Bearer 前缀的不重复加。
      const authorization = /^Bearer\s/i.test(apiKey) ? apiKey : `Bearer ${apiKey}`;
      const doFetch = deps.fetchImpl ?? fetch;
      const response = await doFetch(buildAmbientQuotaBalanceUrl(deps.env), {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(AMBIENT_QUOTA_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const envelope = (await response.json()) as AmbientQuotaBalanceEnvelopeLike;
      if (envelope?.code !== 0) return null;
      return pickAmbientQuotaSnapshot(envelope.data?.balances ?? [], {
        modelId: selection.modelId,
        nowMs: deps.now?.() ?? Date.now(),
      });
    } catch {
      // 查询失败 = 本轮不可得：交给引擎的降级模式（warn 一次 + interval 钉 MAX），
      // 不让配额面的抖动终结 runner。
      return null;
    }
  };
}
